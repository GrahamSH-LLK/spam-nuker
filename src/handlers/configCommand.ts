import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";

import {
  getDefaultConfig,
  getStoredGuildConfig,
  mergeGuildConfig,
  resetGuildConfig,
  setGuildConfigValue,
  NUMERIC_SETTINGS,
} from "../config.js";
import type { GuildConfig } from "../config.js";

export const CONFIG_COMMAND_NAME = "spam-config";

const settingChoices = NUMERIC_SETTINGS.map((setting) => ({
  name: setting.choice,
  value: setting.choice,
}));

export const configCommand = new SlashCommandBuilder()
  .setName(CONFIG_COMMAND_NAME)
  .setDescription("Configure spam detection for this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub.setName("view").setDescription("Show the current configuration"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Change a detection setting for this server")
      .addStringOption((opt) =>
        opt
          .setName("setting")
          .setDescription("Setting to change")
          .setRequired(true)
          .addChoices(...settingChoices),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("value")
          .setDescription("New value")
          .setRequired(true)
          .setMinValue(0),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("log-channel")
      .setDescription("Set the alert channel (omit to disable alerts)")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel for spam alerts")
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("Reset settings to the bot defaults")
      .addStringOption((opt) =>
        opt
          .setName("setting")
          .setDescription("Setting to reset (omit to reset everything)")
          .addChoices(...settingChoices, {
            name: "log-channel",
            value: "log-channel",
          }),
      ),
  );

function settingKeyFromChoice(choice: string): keyof GuildConfig | null {
  if (choice === "log-channel") return "logChannelId";
  return NUMERIC_SETTINGS.find((s) => s.choice === choice)?.key ?? null;
}

async function replyWithConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
) {
  const stored = await getStoredGuildConfig(guildId);
  const config = mergeGuildConfig(getDefaultConfig(), stored);

  const lines = NUMERIC_SETTINGS.map((setting) => {
    const suffix = setting.key in stored ? "" : " (default)";
    return `• \`${setting.choice}\`: **${config[setting.key]}${setting.unit ?? ""}**${suffix} — ${setting.description}`;
  });

  const logSuffix = "logChannelId" in stored ? "" : " (default)";
  const logValue = config.logChannelId
    ? `<#${config.logChannelId}>`
    : "disabled";
  lines.push(`• \`log-channel\`: ${logValue}${logSuffix} — Channel for spam alerts`);

  await interaction.reply({
    content: `**Spam detection settings**\n${lines.join("\n")}`,
    ephemeral: true,
  });
}

/**
 * Handles the /spam-config command. Returns true when the interaction was for
 * this command (whether or not it succeeded).
 */
export async function handleConfigCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (interaction.commandName !== CONFIG_COMMAND_NAME) return false;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You need the Manage Server permission to configure the bot.",
      ephemeral: true,
    });
    return true;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "view") {
    await replyWithConfig(interaction, guildId);
    return true;
  }

  if (subcommand === "set") {
    const choice = interaction.options.getString("setting", true);
    const value = interaction.options.getInteger("value", true);
    const setting = NUMERIC_SETTINGS.find((s) => s.choice === choice);
    if (!setting) {
      await interaction.reply({
        content: `Unknown setting \`${choice}\`.`,
        ephemeral: true,
      });
      return true;
    }

    if (value < setting.min || (setting.max !== undefined && value > setting.max)) {
      const range =
        setting.max !== undefined
          ? `between ${setting.min} and ${setting.max}`
          : `at least ${setting.min}`;
      await interaction.reply({
        content: `\`${setting.choice}\` must be ${range}.`,
        ephemeral: true,
      });
      return true;
    }

    await setGuildConfigValue(guildId, setting.key, String(value));
    await interaction.reply({
      content: `Set \`${setting.choice}\` to **${value}${setting.unit ?? ""}** for this server.`,
      ephemeral: true,
    });
    return true;
  }

  if (subcommand === "log-channel") {
    const channel = interaction.options.getChannel("channel");
    if (channel) {
      await setGuildConfigValue(guildId, "logChannelId", channel.id);
      await interaction.reply({
        content: `Spam alerts will be posted in <#${channel.id}>.`,
        ephemeral: true,
      });
    } else {
      // Empty string marks alerts as explicitly disabled for this guild.
      await setGuildConfigValue(guildId, "logChannelId", "");
      await interaction.reply({
        content: "Spam alerts are now disabled for this server.",
        ephemeral: true,
      });
    }
    return true;
  }

  if (subcommand === "reset") {
    const choice = interaction.options.getString("setting");
    if (choice) {
      const key = settingKeyFromChoice(choice);
      if (!key) {
        await interaction.reply({
          content: `Unknown setting \`${choice}\`.`,
          ephemeral: true,
        });
        return true;
      }
      await resetGuildConfig(guildId, key);
      await interaction.reply({
        content: `Reset \`${choice}\` to the bot default.`,
        ephemeral: true,
      });
    } else {
      await resetGuildConfig(guildId);
      await interaction.reply({
        content: "Reset all settings to the bot defaults.",
        ephemeral: true,
      });
    }
    return true;
  }

  return true;
}
