import "dotenv/config";

import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  handleCrossChannelImageSpam,
  handleStoreImageHashesButton,
} from "./handlers/imageSpam.js";
import { handleCrossChannelSpam } from "./handlers/crossChannelSpam.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("[spam-nuker] DISCORD_TOKEN is not set. Please configure .env");
  process.exit(1);
}

const TIMEOUT_DURATION = parseInt(process.env.TIMEOUT_DURATION ?? "600", 10);
const CROSS_CHANNEL_IMAGE_THRESHOLD = parseInt(
  process.env.CROSS_CHANNEL_IMAGE_THRESHOLD ?? "2",
  10,
);
const CROSS_CHANNEL_IMAGE_CHANNEL_THRESHOLD = parseInt(
  process.env.CROSS_CHANNEL_IMAGE_CHANNEL_THRESHOLD ?? "2",
  10,
);
const CROSS_CHANNEL_IMAGE_MAX_DISTANCE = parseInt(
  process.env.CROSS_CHANNEL_IMAGE_MAX_DISTANCE ?? "6",
  10,
);
const CROSS_CHANNEL_IMAGE_WINDOW = parseInt(
  process.env.CROSS_CHANNEL_IMAGE_WINDOW ?? "60",
  10,
);
const CROSS_CHANNEL_THRESHOLD = parseInt(
  process.env.CROSS_CHANNEL_THRESHOLD ?? "3",
  10,
);
const CROSS_CHANNEL_WINDOW = parseInt(
  process.env.CROSS_CHANNEL_WINDOW ?? "60",
  10,
);
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;

const timeoutMs = TIMEOUT_DURATION * 1000;

// ── Discord client ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged intent – must be enabled in the Developer Portal
    GatewayIntentBits.GuildMembers, // needed to call member.timeout()
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ── Event handlers ─────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`[spam-nuker] Logged in as ${client.user?.tag}`);
});

client.on("messageCreate", async (message) => {
  // Ignore bots, DMs, and system messages
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.system) return;
  const opts = {
    timeoutMs,
    logChannelId: LOG_CHANNEL_ID,
  };

  const crossChannelImageFlagged = await handleCrossChannelImageSpam(message, {
    ...opts,
    imageThreshold: CROSS_CHANNEL_IMAGE_THRESHOLD,
    channelThreshold: CROSS_CHANNEL_IMAGE_CHANNEL_THRESHOLD,
    maxDistance: CROSS_CHANNEL_IMAGE_MAX_DISTANCE,
    window: CROSS_CHANNEL_IMAGE_WINDOW,
  });

  if (crossChannelImageFlagged) return;

  await handleCrossChannelSpam(message, {
    ...opts,
    threshold: CROSS_CHANNEL_THRESHOLD,
    window: CROSS_CHANNEL_WINDOW,
  });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    await handleStoreImageHashesButton(interaction);
  } catch (err: any) {
    console.error(
      "[spam-nuker] Failed to handle button interaction:",
      err?.message ?? err,
    );

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Failed to store image hashes.",
        ephemeral: true,
      });
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

client.login(TOKEN).catch((err) => {
  console.error("[spam-nuker] Failed to log in:", err.message);
  process.exit(1);
});
