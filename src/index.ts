import "dotenv/config";

import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  handleCrossChannelImageSpam,
  handleStoreImageHashesButton,
} from "./handlers/imageSpam.js";
import { handleCrossChannelSpam } from "./handlers/crossChannelSpam.js";
import {
  configCommand,
  handleConfigCommand,
} from "./handlers/configCommand.js";
import { getGuildConfig } from "./config.js";
import { handleJevModeration } from "./handlers/jevModeration.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("[spam-nuker] DISCORD_TOKEN is not set. Please configure .env");
  process.exit(1);
}

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

client.once("ready", async () => {
  console.log(`[spam-nuker] Logged in as ${client.user?.tag}`);

  try {
    await client.application?.commands.set([configCommand.toJSON()]);
    console.log("[spam-nuker] Registered slash commands");
  } catch (err: any) {
    console.error(
      "[spam-nuker] Failed to register slash commands:",
      err?.message ?? err,
    );
  }
});

client.on("messageCreate", async (message) => {
  // Ignore bots, DMs, and system messages
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.system) return;

  const config = await getGuildConfig(message.guild.id);
  const opts = {
    timeoutMs: config.timeoutDuration * 1000,
    logChannelId: config.logChannelId,
  };

  const crossChannelImageFlagged = await handleCrossChannelImageSpam(message, {
    ...opts,
    imageThreshold: config.imageThreshold,
    channelThreshold: config.imageChannelThreshold,
    maxDistance: config.imageMaxDistance,
    window: config.imageWindow,
  });

  if (crossChannelImageFlagged) return;

  const crossChannelSpamFlagged = await handleCrossChannelSpam(message, {
    ...opts,
    threshold: config.messageThreshold,
    window: config.messageWindow,
  });
  if (crossChannelSpamFlagged) return;

  try {
    await handleJevModeration(message, config.logChannelId);
  } catch (err: any) {
    console.error("[spam-nuker] Jev moderation failed:", err?.message ?? err);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleConfigCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleStoreImageHashesButton(interaction);
    }
  } catch (err: any) {
    console.error(
      "[spam-nuker] Failed to handle interaction:",
      err?.message ?? err,
    );

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction
        .reply({ content: "Something went wrong.", ephemeral: true })
        .catch(() => {});
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

client.login(TOKEN).catch((err) => {
  console.error("[spam-nuker] Failed to log in:", err.message);
  process.exit(1);
});
