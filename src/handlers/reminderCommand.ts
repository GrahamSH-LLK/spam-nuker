import { randomUUID } from "node:crypto";
import * as chrono from "chrono-node";
import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, Message } from "discord.js";
import { getRedisClient } from "../redis.js";

const REMINDERS_KEY = "reminders:due";
const DELIVERY_LEASE_MS = 2 * 60_000;
const CLAIM_REMINDER_SCRIPT = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) > tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
`;

export function parseReminderTime(
  input: string,
  now = new Date(),
): Date | null {
  const due = chrono.parseDate(input, now, { forwardDate: true });
  const max = new Date(now);
  max.setFullYear(max.getFullYear() + 5);
  return due && due.getTime() > now.getTime() && due.getTime() <= max.getTime()
    ? due
    : null;
}

export const reminderCommand = new SlashCommandBuilder()
  .setName("remind")
  .setDescription("Remind yourself in this channel")
  .addStringOption((option) =>
    option
      .setName("when")
      .setDescription(
        'When? e.g. "in 2 hours", "tomorrow at 9am", "next Friday"',
      )
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("message")
      .setDescription("What to remind you about")
      .setRequired(true)
      .setMaxLength(1500),
  );

type Reminder = {
  id: string;
  userId: string;
  channelId: string;
  message: string;
};

export function parseChatReminder(input: string, now = new Date()) {
  const command = /^v[?‽](?:remind|rem)(?:\s+|$)/i.exec(input);
  if (!command) return null;

  const body = input.slice(command[0].length).trim();
  const parsed = chrono.parse(body, now, { forwardDate: true })[0];
  if (!parsed) return { due: null, message: "" };

  const due = parseReminderTime(parsed.text, now);
  const before = body.slice(0, parsed.index);
  const after = body.slice(parsed.index + parsed.text.length);
  const message = `${before} ${after}`.trim().replace(/^(?:me\s+)?(?:to\s+)?/i, "").trim();
  return { due, message };
}

async function saveReminder(userId: string, channelId: string, message: string, dueAt: number) {
  const reminder: Reminder = { id: randomUUID(), userId, channelId, message };
  const redis = getRedisClient();
  await redis.set(`reminder:${reminder.id}`, JSON.stringify(reminder));
  await redis.zadd(REMINDERS_KEY, dueAt, reminder.id);
}

export async function handleChatReminderCommand(message: Message) {
  const parsed = parseChatReminder(message.content);
  if (!parsed) return false;

  if (!parsed.due || !parsed.message || parsed.message.length > 1500) {
    await message.reply({
      content: 'Use `v?remind in 2 hours` or `v‽rem do something tomorrow at 9am` (up to five years ahead).',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  try {
    const dueAt = parsed.due.getTime();
    await saveReminder(message.author.id, message.channelId, parsed.message, dueAt);
    await message.reply({
      content: `I’ll remind you <t:${Math.floor(dueAt / 1000)}:R> in this channel.`,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.error("[spam-nuker] Failed to create chat reminder:", error);
    await message.reply({
      content: "Something went wrong creating that reminder.",
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  }
  return true;
}

export async function handleReminderCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (interaction.commandName !== "remind") return false;

  const when = interaction.options.getString("when", true);
  const message = interaction.options.getString("message", true).trim();
  const due = parseReminderTime(when);
  if (!due || !message || message.length > 1500) {
    await interaction.reply({
      content:
        'Enter a message and a future time within five years, such as "in 2 hours" or "tomorrow at 9am".',
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const dueAt = due.getTime();
  await saveReminder(interaction.user.id, interaction.channelId, message, dueAt);
  await interaction.editReply(
    `I’ll remind you <t:${Math.floor(dueAt / 1000)}:R> in this channel.`,
  );
  return true;
}

export async function deliverDueReminders(client: Client) {
  const redis = getRedisClient();
  const ids = await redis.zrangebyscore(
    REMINDERS_KEY,
    "-inf",
    Date.now(),
    "LIMIT",
    0,
    50,
  );
  for (const id of ids) {
    // Lease the reminder atomically so a restart can retry interrupted deliveries.
    const now = Date.now();
    const claimed = await redis.eval(
      CLAIM_REMINDER_SCRIPT,
      1,
      REMINDERS_KEY,
      id,
      now,
      now + DELIVERY_LEASE_MS,
    );
    if (claimed !== 1) continue;
    const raw = await redis.get(`reminder:${id}`);
    if (!raw) {
      await redis.zrem(REMINDERS_KEY, id);
      continue;
    }
    const reminder = JSON.parse(raw) as Reminder;
    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (!channel?.isSendable()) throw new Error("Channel is unavailable");
      await channel.send({
        content: `<@${reminder.userId}> Reminder: ${reminder.message}`,
        allowedMentions: { users: [reminder.userId] },
      });
      await redis.zrem(REMINDERS_KEY, id);
      await redis.del(`reminder:${id}`);
    } catch (error) {
      // The lease remains queued if the bot stops before this retry is scheduled.
      await redis.zadd(REMINDERS_KEY, Date.now() + 60_000, id);
      console.error("[spam-nuker] Failed to deliver reminder:", error);
    }
  }
}
