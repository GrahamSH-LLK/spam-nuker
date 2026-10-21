import { randomBytes } from "node:crypto";
import * as chrono from "chrono-node";
import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Client, Message } from "discord.js";
import { getRedisClient } from "../redis.js";

const REMINDERS_KEY = "reminders:due";
const DELIVERY_LEASE_MS = 2 * 60_000;
const NO_MENTIONS = { parse: [] as [], repliedUser: false };
const EASTERN_ZONE = "America/New_York";
const CLAIM_REMINDER_SCRIPT = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score or tonumber(score) > tonumber(ARGV[2]) then return 0 end
if not redis.call('SET', KEYS[2], '1', 'PX', ARGV[4], 'NX') then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
`;
const CANCEL_REMINDER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw).userId ~= ARGV[2] then return 2 end
if redis.call('EXISTS', KEYS[3]) == 1 then return 3 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;

export function parseReminderTime(
  input: string,
  now = new Date(),
): Date | null {
  const parsed = chrono.parse(
    input,
    { instant: now, timezone: "ET" },
    { forwardDate: true },
  )[0];
  if (!parsed) return null;
  const due = parsed.start.isCertain("timezoneOffset")
    ? parsed.date()
    : easternDate(parsed.start);
  if (!due) return null;
  const max = new Date(now);
  max.setUTCFullYear(max.getUTCFullYear() + 5);
  return due.getTime() > now.getTime() && due.getTime() <= max.getTime()
    ? due
    : null;
}

function easternOffsetMinutes(date: Date) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_ZONE,
    timeZoneName: "shortOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? "");
  if (!match) throw new Error(`Unexpected Eastern timezone offset: ${name}`);
  return (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function easternDate(start: ReturnType<typeof chrono.parse>[number]["start"]): Date | null {
  const wall = Date.UTC(
    start.get("year")!, start.get("month")! - 1, start.get("day")!,
    start.get("hour")!, start.get("minute")!, start.get("second")!, start.get("millisecond")!,
  );
  let due = new Date(wall - easternOffsetMinutes(new Date(wall)) * 60_000);
  due = new Date(wall - easternOffsetMinutes(due) * 60_000);
  // Reject wall times skipped by the spring DST transition.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_ZONE, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(due);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  if (value("year") !== start.get("year") || value("month") !== start.get("month") ||
      value("day") !== start.get("day") || value("hour") !== start.get("hour") ||
      value("minute") !== start.get("minute") || value("second") !== start.get("second")) return null;
  return due;
}

export function reminderTimeUsesDefaultTimezone(
  input: string,
  now = new Date(),
): boolean {
  const parsed = chrono.parse(
    input,
    { instant: now, timezone: "ET" },
    { forwardDate: true },
  )[0];
  if (!parsed) return false;
  // Elapsed delays describe a duration from now, so they need no local clock.
  const relative =
    /^(?:in\s+)?\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)(?:\s+from\s+now)?$/i;
  return (
    !relative.test(parsed.text.trim()) &&
    !parsed.start.isCertain("timezoneOffset")
  );
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
      .setDescription("What to remind you about (optional)")
      .setMaxLength(1500),
  );

export const cancelReminderCommand = new SlashCommandBuilder()
  .setName("cancel")
  .setDescription("Cancel one of your reminders")
  .addStringOption((option) =>
    option
      .setName("id")
      .setDescription("Reminder ID from its confirmation")
      .setRequired(true)
      .setMaxLength(36),
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
  const parsed = chrono.parse(
    body,
    { instant: now, timezone: "ET" },
    { forwardDate: true },
  )[0];
  if (!parsed) return { due: null, message: "", usesDefaultTimezone: false };

  const due = parseReminderTime(parsed.text, now);
  const usesDefaultTimezone = reminderTimeUsesDefaultTimezone(parsed.text, now);
  const before = body.slice(0, parsed.index);
  const after = body.slice(parsed.index + parsed.text.length);
  const message = `${before} ${after}`
    .trim()
    .replace(/^(?:me\s+)?(?:to\s+)?/i, "")
    .trim() || "It’s time.";
  return { due, message, usesDefaultTimezone };
}

async function saveReminder(
  userId: string,
  channelId: string,
  message: string,
  dueAt: number,
) {
  const redis = getRedisClient();
  while (true) {
    const reminder: Reminder = {
      id: randomBytes(6).toString("hex"),
      userId,
      channelId,
      message,
    };
    if (await redis.set(`reminder:${reminder.id}`, JSON.stringify(reminder), "NX") !== "OK") continue;
    await redis.zadd(REMINDERS_KEY, dueAt, reminder.id);
    return reminder.id;
  }
}

export async function cancelReminder(id: string, userId: string) {
  if (!/^(?:[\da-f]{12}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(id))
    return 0;
  const redis = getRedisClient();
  return (await redis.eval(
    CANCEL_REMINDER_SCRIPT,
    3,
    `reminder:${id}`,
    REMINDERS_KEY,
    `reminder:processing:${id}`,
    id,
    userId,
  )) as number;
}

function cancelReply(result: number) {
  if (result === 1) return "Reminder canceled.";
  if (result === 3)
    return "That reminder is already being delivered and can’t be canceled.";
  return "Reminder not found or it wasn’t created by you.";
}

export function reminderConfirmation(
  dueAt: number,
  id: string,
  usesDefaultTimezone: boolean,
  command: "chat" | "slash" = "chat",
) {
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  })
    .formatToParts(new Date(dueAt))
    .find((part) => part.type === "timeZoneName")?.value;
  const cancel = command === "slash" ? `/cancel id:${id}` : `v?cancel ${id}`;
  const when = usesDefaultTimezone
    ? `${new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(dueAt))} (<t:${Math.floor(dueAt / 1000)}:R>)`
    : `<t:${Math.floor(dueAt / 1000)}:f>`;
  const lines = [`I’ll remind you on ${when} in this channel.`];
  if (usesDefaultTimezone) {
    lines.push(`I used Eastern Time (${zone}) since you didn’t give a timezone. To change it, cancel and try again with an explicit timezone.`);
  }
  lines.push(`ID: \`${id}\` · Cancel: \`${cancel}\``);
  return lines.join("\n");
}

export async function handleChatCancelReminderCommand(message: Message) {
  const match = /^v[?‽]cancel(?:\s+|$)/i.exec(message.content);
  if (!match) return false;
  const id = message.content.slice(match[0].length).trim();
  const content = id
    ? cancelReply(await cancelReminder(id, message.author.id))
    : "Use `v?cancel <reminder-id>` or `v‽cancel <reminder-id>`.";
  await message.reply({ content, allowedMentions: NO_MENTIONS });
  return true;
}

export async function handleCancelReminderCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (interaction.commandName !== "cancel") return false;
  const id = interaction.options.getString("id", true).trim();
  const result = await cancelReminder(id, interaction.user.id);
  await interaction.reply({
    content: cancelReply(result),
    ephemeral: true,
    allowedMentions: NO_MENTIONS,
  });
  return true;
}

export async function handleChatReminderCommand(message: Message) {
  const parsed = parseChatReminder(message.content);
  if (!parsed) return false;

  if (!parsed.due || !parsed.message || parsed.message.length > 1500) {
    await message.reply({
      content:
        "Use `v?remind in 2 hours to do something` or `v‽rem do something tomorrow at 9am` (up to five years ahead).",
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  try {
    const dueAt = parsed.due.getTime();
    const id = await saveReminder(
      message.author.id,
      message.channelId,
      parsed.message,
      dueAt,
    );
    await message.reply({
      content: reminderConfirmation(dueAt, id, parsed.usesDefaultTimezone),
      allowedMentions: NO_MENTIONS,
    });
  } catch (error) {
    console.error("[spam-nuker] Failed to create chat reminder:", error);
    await message
      .reply({
        content: "Something went wrong creating that reminder.",
        allowedMentions: NO_MENTIONS,
      })
      .catch(() => {});
  }
  return true;
}

export async function handleReminderCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (interaction.commandName !== "remind") return false;

  const when = interaction.options.getString("when", true);
  const message = interaction.options.getString("message")?.trim() || "It’s time.";
  const due = parseReminderTime(when);
  if (!due || !message || message.length > 1500) {
    await interaction.reply({
      content:
        'Enter a message and a future time within five years, such as "in 2 hours" or "tomorrow at 9am". Times without a timezone use Eastern Time (EST/EDT).',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });
  const dueAt = due.getTime();
  const id = await saveReminder(
    interaction.user.id,
    interaction.channelId,
    message,
    dueAt,
  );
  await interaction.editReply({
    content: reminderConfirmation(
      dueAt,
      id,
      reminderTimeUsesDefaultTimezone(when),
      "slash",
    ),
    allowedMentions: NO_MENTIONS,
  });
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
      2,
      REMINDERS_KEY,
      `reminder:processing:${id}`,
      id,
      now,
      now + DELIVERY_LEASE_MS,
      DELIVERY_LEASE_MS,
    );
    if (claimed !== 1) continue;
    const raw = await redis.get(`reminder:${id}`);
    if (!raw) {
      await redis.zrem(REMINDERS_KEY, id);
      await redis.del(`reminder:processing:${id}`);
      continue;
    }
    const reminder = JSON.parse(raw) as Reminder;
    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (!channel?.isSendable()) throw new Error("Channel is unavailable");
      await channel.send({
        content: `<@${reminder.userId}> Reminder: ${reminder.message}`,
        allowedMentions: {
          parse: [],
          users: [reminder.userId],
          roles: [],
          repliedUser: false,
        },
      });
      await redis.zrem(REMINDERS_KEY, id);
      await redis.del(`reminder:${id}`);
      await redis.del(`reminder:processing:${id}`);
    } catch (error) {
      // The lease remains queued if the bot stops before this retry is scheduled.
      await redis.zadd(REMINDERS_KEY, Date.now() + 60_000, id);
      await redis.del(`reminder:processing:${id}`);
      console.error("[spam-nuker] Failed to deliver reminder:", error);
    }
  }
}
