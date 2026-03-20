import readline from "readline";
import { getConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AudioController } from "./audioController.js";
import { MagmaBot } from "./magmaBot.js";
import { DiscordController } from "./discordController.js";

const logger = createLogger("main");

async function main() {
  const command = process.argv[2] || "run";

  if (command === "help") {
    printHelp();
    return;
  }

  const config = getConfig();
  const audioController = new AudioController(config.audio);
  let magmaBot = null;
  const discordController = new DiscordController(config.discord, (cmd, arg) =>
    handleControlCommand({ audioController, magmaBot }, cmd, arg, true)
  );

  if (command === "check") {
    runChecks(config);
    return;
  }

  if (command === "play") {
    await discordController.start();
    await audioController.start();
    startControlShell(audioController, null);
    setupShutdownHandlers(async () => {
      logger.info("Shutting down...");
      await discordController.stop();
      await audioController.stop();
      process.exit(0);
    });
    return;
  }

  if (command === "run") {
    magmaBot = new MagmaBot(config.magma, audioController);
    setupShutdownHandlers(async () => {
      logger.info("Shutting down...");
      await discordController.stop();
      await magmaBot.shutdown();
      process.exit(0);
    });

    await discordController.start();
    startControlShell(audioController, magmaBot);
    await magmaBot.run();
    return;
  }

  logger.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

function runChecks(config) {
  const summary = {
    magma: {
      email: maskEmail(config.magma.email),
      canvasLink: config.magma.canvasLink,
      headless: config.magma.headless,
      chatCommandsEnabled: config.magma.chatCommandsEnabled,
      botHandle: config.magma.botHandle,
      autoStartAudio: config.magma.autoStartAudio,
      chatPollMs: config.magma.chatPollMs,
      waitForStartCommand: config.magma.waitForStartCommand
    },
    audio: {
      mode: config.audio.mode,
      source: config.audio.source,
      playlistSize: config.audio.playlist.length,
      fakeMicWav: config.audio.fakeMicWav,
      ffplayPath: config.audio.ffplayPath,
      initialVolume: config.audio.initialVolume
    },
    discord: {
      enabled: config.discord.enabled,
      guildId: config.discord.guildId,
      channelId: config.discord.channelId,
      commandPrefix: config.discord.commandPrefix,
      useSlashCommands: config.discord.useSlashCommands,
      allowPrefixCommands: config.discord.allowPrefixCommands
    }
  };

  logger.info("Configuration is valid.", summary);
}

function startControlShell(audioController, magmaBot) {
  if (!process.stdin.isTTY) {
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const printPrompt = () => {
    rl.prompt();
  };

  logger.info("Interactive controls ready: status | pause | next | volume <0-1> | play | stop | start [canvas] | canvas <url> | stopbot | botstatus | help");
  rl.setPrompt("bot> ");
  printPrompt();

  rl.on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/, 2);
    try {
      switch ((cmd || "").toLowerCase()) {
        case "status":
        case "pause":
        case "next":
        case "volume":
        case "stop":
        case "play":
        case "join":
        case "start":
        case "canvas":
        case "stopbot":
        case "botstatus":
        case "help": {
          const response = await handleControlCommand({ audioController, magmaBot }, cmd, arg, false);
          if (response) {
            logger.info(response);
          }
          break;
        }
        case "": {
          break;
        }
        default: {
          logger.warn(`Unknown command: ${cmd}`);
        }
      }
    } catch (error) {
      logger.error("Control command failed.", error.message || error);
    }

    printPrompt();
  });
}

async function handleControlCommand(runtime, rawCmd, arg, forDiscord) {
  const { audioController, magmaBot } = runtime;
  const cmd = (rawCmd || "").toLowerCase();

  switch (cmd) {
    case "status": {
      const status = audioController.status;
      const statusText = `running=${status.running}, paused=${status.paused}, volume=${status.volume.toFixed(2)}, current=${status.currentTrack || "none"}`;
      if (forDiscord) {
        return `Audio status: ${statusText}`;
      }
      logger.info("Audio status", status);
      return "";
    }
    case "pause": {
      await audioController.pauseToggle();
      return "Toggled pause/resume.";
    }
    case "next": {
      await audioController.next();
      return "Skipped to next track.";
    }
    case "volume": {
      const value = Number(arg);
      if (!Number.isFinite(value)) {
        return "Usage: volume <0-1>";
      }
      await audioController.setVolume(value);
      return `Volume updated to ${Math.max(0, Math.min(1, value)).toFixed(2)}.`;
    }
    case "stop": {
      await audioController.stop();
      return "Stopped playback.";
    }
    case "play": {
      await audioController.start();
      return "Started playback.";
    }
    case "help": {
      return "Commands: status | pause | next | volume <0-1> | play | stop | join <canvas-url> | start [canvas] | canvas <url> | stopbot | botstatus | help";
    }
    case "join": {
      if (!magmaBot) {
        return "Join command works in run mode only.";
      }
      const canvas = String(arg || "").trim();
      if (!canvas.startsWith("http")) {
        return "Usage: join <https://magma.com/d/...>";
      }
      await magmaBot.startAutomation(canvas);
      return `Joining canvas: ${canvas}`;
    }
    case "start": {
      if (!magmaBot) {
        return "Start command works in run mode only.";
      }
      const canvas = String(arg || "").trim();
      await magmaBot.startAutomation(canvas || undefined);
      return canvas ? `Bot started on canvas: ${canvas}` : "Bot started with current canvas.";
    }
    case "canvas": {
      if (!magmaBot) {
        return "Canvas command works in run mode only.";
      }
      const canvas = String(arg || "").trim();
      if (!canvas.startsWith("http")) {
        return "Usage: canvas <https://magma.com/d/...>";
      }
      await magmaBot.setCanvasLink(canvas);
      return `Canvas updated: ${canvas}`;
    }
    case "stopbot": {
      if (!magmaBot) {
        return "Stopbot command works in run mode only.";
      }
      await magmaBot.stopAutomation();
      return "Bot automation stopped.";
    }
    case "botstatus": {
      if (!magmaBot) {
        return "Botstatus command works in run mode only.";
      }
      const status = magmaBot.getRuntimeStatus();
      return `Bot status: active=${status.active}, sessionAlive=${status.sessionAlive}, canvas=${status.canvasLink}`;
    }
    default: {
      return forDiscord ? "Unknown command. Try !help" : "";
    }
  }
}

function setupShutdownHandlers(onShutdown) {
  let alreadyShuttingDown = false;

  const wrapped = async () => {
    if (alreadyShuttingDown) return;
    alreadyShuttingDown = true;
    await onShutdown();
  };

  process.on("SIGINT", wrapped);
  process.on("SIGTERM", wrapped);
}

function maskEmail(email) {
  const [name, domain] = email.split("@");
  if (!domain) return "***";
  if (name.length < 3) return `***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function printHelp() {
  console.log(`
Usage:
  node src/index.js run    Run Magma bot automation + audio controls
  node src/index.js play   Run audio playback only
  node src/index.js check  Validate and print configuration

Interactive commands (during run/play):
  status
  pause
  next
  volume <0-1>
  play
  stop
  start [canvas-url]
  canvas <canvas-url>
  stopbot
  botstatus
  help
`);
}

main().catch((error) => {
  logger.error("Fatal error.", error.message || error);
  process.exit(1);
});