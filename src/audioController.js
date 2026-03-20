import { spawn } from "child_process";
import { createLogger } from "./logger.js";

export class AudioController {
  constructor(config) {
    this.config = config;
    this.logger = createLogger("audio");
    this.process = null;
    this.running = false;
    this.paused = false;
    this.currentIndex = 0;
    this.volume = config.initialVolume;
    this.manuallyStopped = false;

    this.queue = config.playlist.length > 0 ? [...config.playlist] : [config.source].filter(Boolean);
  }

  get status() {
    return {
      mode: this.config.mode,
      running: this.running,
      paused: this.paused,
      volume: this.volume,
      queueLength: this.queue.length,
      currentTrack: this.queue[this.currentIndex] || null
    };
  }

  async start() {
    if (this.config.mode === "fake-mic") {
      this.logger.info("fake-mic mode selected; no external player process will be started.");
      return;
    }

    if (!this.queue.length) {
      this.logger.warn("No AUDIO_SOURCE or AUDIO_PLAYLIST configured; audio playback skipped.");
      return;
    }

    if (this.running) {
      return;
    }

    this.running = true;
    this.manuallyStopped = false;
    this.spawnCurrentTrack();
  }

  async stop() {
    this.manuallyStopped = true;
    this.running = false;
    this.paused = false;
    if (this.process) {
      this.process.stdin?.write("q");
      this.process.kill();
      this.process = null;
    }
  }

  async pauseToggle() {
    if (!this.process || !this.running) {
      this.logger.warn("Cannot pause/resume because player is not running.");
      return;
    }

    this.process.stdin?.write("p");
    this.paused = !this.paused;
    this.logger.info(this.paused ? "Paused playback." : "Resumed playback.");
  }

  async next() {
    if (!this.queue.length) {
      this.logger.warn("Cannot skip: queue is empty.");
      return;
    }

    this.currentIndex = (this.currentIndex + 1) % this.queue.length;
    this.paused = false;

    if (this.running) {
      await this.restartCurrentTrack();
    }
  }

  async setVolume(level) {
    if (!Number.isFinite(level)) {
      this.logger.warn("Volume must be a number from 0 to 1.");
      return;
    }

    this.volume = Math.max(0, Math.min(1, level));
    this.logger.info(`Volume set to ${(this.volume * 100).toFixed(0)}%`);

    if (this.running && this.config.mode === "virtual-cable") {
      await this.restartCurrentTrack();
    }
  }

  spawnCurrentTrack() {
    const source = this.queue[this.currentIndex];
    if (!source) {
      this.logger.warn("No source available for current track index.");
      this.running = false;
      return;
    }

    const args = [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "warning",
      "-volume",
      String(Math.round(this.volume * 100)),
      source
    ];

    this.logger.info(`Starting ffplay track ${this.currentIndex + 1}/${this.queue.length}: ${source}`);
    const child = spawn(this.config.ffplayPath, args, {
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true
    });

    this.process = child;

    child.on("error", (error) => {
      this.logger.error("ffplay failed to start. Check FFMPEG install and FFPLAY_PATH.", error.message);
      this.process = null;
      this.running = false;
    });

    child.on("exit", () => {
      this.process = null;
      if (!this.running || this.manuallyStopped) {
        return;
      }

      this.currentIndex = (this.currentIndex + 1) % this.queue.length;
      this.spawnCurrentTrack();
    });
  }

  async restartCurrentTrack() {
    if (this.process) {
      this.process.stdin?.write("q");
      this.process.kill();
      this.process = null;
    }

    if (this.running) {
      this.spawnCurrentTrack();
    }
  }
}