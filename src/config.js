import dotenv from "dotenv";

dotenv.config();

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseNumber(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getConfig() {
  const audioMode = process.env.AUDIO_MODE || "virtual-cable";
  const audioPlaylist = (process.env.AUDIO_PLAYLIST || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    magma: {
      email: required("MAGMA_EMAIL"),
      password: required("MAGMA_PASSWORD"),
      canvasLink: required("MAGMA_CANVAS_LINK"),
      baseUrl: process.env.MAGMA_BASE_URL || "https://magma.com",
      loginPath: process.env.LOGIN_PATH || "/login",
      headless: parseBoolean(process.env.HEADLESS, false),
      browserChannel: process.env.BROWSER_CHANNEL || "chrome",
      browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH || "",
      retryDelayMs: parseNumber(process.env.RETRY_DELAY_MS, 10000),
      heartbeatMs: parseNumber(process.env.HEARTBEAT_MS, 15000),
      chatCommandsEnabled: parseBoolean(process.env.MAGMA_CHAT_COMMANDS_ENABLED, true),
      botHandle: process.env.MAGMA_BOT_HANDLE || "NexLofi-Bot",
      autoStartAudio: parseBoolean(process.env.MAGMA_AUTOSTART_AUDIO, false),
      chatPollMs: parseNumber(process.env.MAGMA_CHAT_POLL_MS, 2000),
      preferredMicName: process.env.MAGMA_PREFERRED_MIC_NAME || "CABLE Output",
      waitForStartCommand: parseBoolean(process.env.MAGMA_WAIT_FOR_START_COMMAND, false)
    },
    audio: {
      mode: audioMode,
      source: process.env.AUDIO_SOURCE || "",
      playlist: audioPlaylist,
      ffplayPath: process.env.FFPLAY_PATH || "ffplay",
      initialVolume: Math.max(0, Math.min(1, parseNumber(process.env.INITIAL_VOLUME, 0.65))),
      fakeMicWav: process.env.FAKE_MIC_WAV || ""
    },
    discord: {
      enabled: parseBoolean(process.env.DISCORD_ENABLED, false),
      token: process.env.DISCORD_BOT_TOKEN || "",
      guildId: process.env.DISCORD_GUILD_ID || "",
      channelId: process.env.DISCORD_CHANNEL_ID || "",
      commandPrefix: process.env.DISCORD_COMMAND_PREFIX || "!",
      useSlashCommands: parseBoolean(process.env.DISCORD_USE_SLASH_COMMANDS, true),
      allowPrefixCommands: parseBoolean(process.env.DISCORD_ALLOW_PREFIX_COMMANDS, false)
    }
  };
}