import { Client, GatewayIntentBits, SlashCommandBuilder } from "discord.js";
import { createLogger } from "./logger.js";

export class DiscordController {
  constructor(config, onCommand) {
    this.config = config;
    this.onCommand = onCommand;
    this.logger = createLogger("discord");
    this.client = null;
  }

  async start() {
    if (!this.config.enabled) {
      this.logger.info("Discord integration is disabled.");
      return;
    }

    if (!this.config.token) {
      this.logger.warn("DISCORD_ENABLED=true but DISCORD_BOT_TOKEN is not set; Discord controller will not start.");
      return;
    }

    const intents = [GatewayIntentBits.Guilds];
    if (this.config.allowPrefixCommands) {
      intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    }

    this.client = new Client({ intents });

    this.client.once("ready", () => {
      this.logger.info(`Connected as ${this.client.user?.tag || "unknown"}`);
    });

    this.client.on("ready", async () => {
      if (!this.config.useSlashCommands) {
        return;
      }

      try {
        const commands = this.buildSlashCommands();
        if (this.config.guildId) {
          await this.client.application.commands.set(commands, this.config.guildId);
          this.logger.info(`Registered slash commands for guild ${this.config.guildId}.`);
        } else {
          await this.client.application.commands.set(commands);
          this.logger.info("Registered global slash commands.");
        }
      } catch (error) {
        this.logger.error("Failed to register slash commands.", error.message || error);
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      if (this.config.guildId && interaction.guildId !== this.config.guildId) return;
      if (this.config.channelId && interaction.channelId !== this.config.channelId) return;

      const command = interaction.commandName.toLowerCase();
      const arg = this.getInteractionArg(interaction, command);

      try {
        const reply = await this.onCommand(command, arg);
        await interaction.reply(reply || "Done.");
      } catch (error) {
        this.logger.error("Failed to process slash command.", error.message || error);
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp("Command failed. Check bot logs.");
        } else {
          await interaction.reply("Command failed. Check bot logs.");
        }
      }
    });

    this.client.on("messageCreate", async (message) => {
      if (!this.config.allowPrefixCommands) return;
      if (message.author.bot) return;
      if (this.config.channelId && message.channelId !== this.config.channelId) return;
      if (this.config.guildId && message.guildId !== this.config.guildId) return;

      const content = message.content.trim();
      if (!content.startsWith(this.config.commandPrefix)) return;

      const raw = content.slice(this.config.commandPrefix.length).trim();
      const [command = "", arg = ""] = raw.split(/\s+/, 2);

      if (!command) {
        return;
      }

      try {
        const reply = await this.onCommand(command.toLowerCase(), arg);
        if (reply) {
          await message.reply(reply);
        }
      } catch (error) {
        this.logger.error("Failed to process Discord command.", error.message || error);
        await message.reply("Command failed. Check bot logs.");
      }
    });

    try {
      await this.client.login(this.config.token);
    } catch (error) {
      this.logger.error("Discord login failed; continuing without Discord controls.", error.message || error);
      if (this.client) {
        this.client.removeAllListeners();
        this.client = null;
      }
    }
  }

  async stop() {
    if (!this.client) {
      return;
    }
    await this.client.destroy();
    this.client = null;
  }

  buildSlashCommands() {
    return [
      new SlashCommandBuilder()
        .setName("join")
        .setDescription("Join a Magma canvas URL and auto-join voice call")
        .addStringOption((option) =>
          option
            .setName("canvas")
            .setDescription("Magma canvas URL")
            .setRequired(true)
        )
    ].map((command) => command.toJSON());
  }

  getInteractionArg(interaction, command) {
    if (command === "join") {
      return interaction.options.getString("canvas") || "";
    }

    return "";
  }
}