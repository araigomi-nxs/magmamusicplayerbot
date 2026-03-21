import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";

export class MagmaBot {
  constructor(config, audioController) {
    this.config = config;
    this.audioController = audioController;
    this.logger = createLogger("magma");
    this.browser = null;
    this.context = null;
    this.page = null;
    this.heartbeatTimer = null;
    this.shuttingDown = false;
    this.lastChatCommandKey = null;
    this.lastHeartbeatCheckAt = 0;
    this.currentCanvasLink = config.canvasLink;
    this.automationEnabled = !config.waitForStartCommand;
    this.suppressPageCloseWarning = false;
    this.rejoinRequested = false;
    this.voiceConfiguredForSession = false;
    this.lastVoiceConfigureAttemptAt = 0;
    this.commandsArmed = false;
    this.commandsArmedAt = 0;
    this.fakeMicPrepared = false;
  }

  async run() {
    while (!this.shuttingDown) {
      if (!this.automationEnabled) {
        await wait(500);
        continue;
      }

      try {
        await this.startSession();
        if (this.config.autoStartAudio) {
          await this.audioController.start();
        } else {
          this.logger.info("Audio autostart disabled; waiting for Magma chat command.");
        }
        await this.runHeartbeat();
      } catch (error) {
        if (String(error?.message || "").includes("Session restart requested for fake-mic track change.")) {
          this.logger.info("Session restart requested for fake-mic track change.");
        } else {
        this.logger.error("Session failed; scheduling reconnect.", error.message || error);
        }
      }

      await this.cleanupBrowser();

      if (!this.shuttingDown) {
        if (this.automationEnabled && this.rejoinRequested) {
          this.rejoinRequested = false;
          continue;
        }
        await wait(this.config.retryDelayMs);
      }
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    this.automationEnabled = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.audioController.stop();
    await this.cleanupBrowser();
  }

  async startSession() {
    this.voiceConfiguredForSession = false;
    this.lastVoiceConfigureAttemptAt = 0;
    this.commandsArmed = false;
    this.commandsArmedAt = 0;
    this.lastChatCommandKey = null;

    if (this.audioController.config.mode === "fake-mic") {
      await this.prepareFakeMicAudio();
    }

    this.logger.info(`Launching browser (preferred channel: ${this.config.browserChannel || "chrome"})...`);
    this.browser = await this.launchBrowser();

    this.context = await this.browser.newContext({
      permissions: ["microphone", "camera", "notifications"]
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(20000);

    this.page.on("close", () => {
      if (!this.shuttingDown && !this.suppressPageCloseWarning) {
        this.logger.warn("Page was closed unexpectedly.");
      }
    });

    await this.login();
    await this.joinCanvas();

    const ready = await this.waitForJoinAndVoiceSetup();
    if (!ready) {
      this.logger.warn("Join/input setup not ready at startup; continuing and allowing commands while retrying in heartbeat.");
    }

    await this.ensureChatOpen();
    this.commandsArmed = true;
    this.commandsArmedAt = Date.now();
    this.logger.info("Command listener armed after join + input-device setup.");
  }

  async launchBrowser() {
    const args = this.buildChromiumArgs();
    const preferredChannel = String(this.config.browserChannel || "chrome").trim();
    const executablePath = String(this.config.browserExecutablePath || "").trim();

    const launchOptions = {
      headless: this.config.headless,
      args
    };

    if (executablePath) {
      this.logger.info(`Launching browser via executable path: ${executablePath}`);
      return chromium.launch({
        ...launchOptions,
        executablePath
      });
    }

    try {
      return await chromium.launch({
        ...launchOptions,
        channel: preferredChannel
      });
    } catch (error) {
      this.logger.warn(
        `Preferred channel '${preferredChannel}' unavailable; falling back to Playwright bundled Chromium. ${error?.message || ""}`
      );
      return chromium.launch(launchOptions);
    }
  }

  async waitForJoinAndVoiceSetup() {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const joined = await this.joinCall();
      if (joined) {
        if (this.voiceConfiguredForSession) {
          return true;
        }

        const configured = await this.ensureVoiceConfigured("startup");
        if (configured) {
          return true;
        }
      }

      await wait(1500);
    }

    return false;
  }

  buildChromiumArgs() {
    const args = [
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required"
    ];

    if (this.audioController.config.mode === "fake-mic") {
      if (!this.audioController.config.fakeMicWav) {
        throw new Error("AUDIO_MODE=fake-mic requires FAKE_MIC_WAV to be set.");
      }

      args.push("--use-fake-device-for-media-stream");
      args.push(`--use-file-for-fake-audio-capture=${this.audioController.config.fakeMicWav}`);
      this.logger.info("Using fake microphone file capture mode.");
    }

    return args;
  }

  async prepareFakeMicAudio() {
    if (this.fakeMicPrepared) {
      return;
    }

    const target = String(this.audioController.config.fakeMicWav || "").trim();
    if (!target) {
      throw new Error("AUDIO_MODE=fake-mic requires FAKE_MIC_WAV to be set.");
    }

    const source = this.pickFakeMicSource();
    if (!source) {
      this.logger.warn("No AUDIO_SOURCE/AUDIO_PLAYLIST found for fake-mic generation. Using existing FAKE_MIC_WAV if available.");
      this.fakeMicPrepared = true;
      return;
    }

    const ffmpegPath = this.resolveFfmpegPath();
    if (!ffmpegPath) {
      this.logger.warn("Could not resolve ffmpeg path from FFPLAY_PATH. Using existing FAKE_MIC_WAV if available.");
      this.fakeMicPrepared = true;
      return;
    }

    const targetPath = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    this.logger.info(`Preparing fake mic WAV from source: ${source}`);
    const args = [
      "-y",
      "-i",
      source,
      "-t",
      "900",
      "-ac",
      "2",
      "-ar",
      "48000",
      targetPath
    ];

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk || "");
      });

      child.on("error", (error) => {
        reject(new Error(`ffmpeg launch failed: ${error.message || error}`));
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg exited with code ${code}. ${stderr.trim()}`));
      });
    });

    this.fakeMicPrepared = true;
    this.logger.info(`Fake mic WAV ready: ${targetPath}`);
  }

  pickFakeMicSource() {
    const queue = Array.isArray(this.audioController?.queue)
      ? this.audioController.queue.filter(Boolean)
      : [];
    if (queue.length > 0) {
      const rawIndex = Number(this.audioController?.currentIndex || 0);
      const safeIndex = ((rawIndex % queue.length) + queue.length) % queue.length;
      return queue[safeIndex];
    }

    const source = String(this.audioController?.config?.source || "").trim();
    return source || "";
  }

  resolveFfmpegPath() {
    const ffplay = String(this.audioController?.config?.ffplayPath || "").trim();
    if (!ffplay) {
      return "";
    }

    if (/ffplay(\.exe)?$/i.test(ffplay)) {
      return ffplay.replace(/ffplay(\.exe)?$/i, "ffmpeg$1");
    }

    return "";
  }

  async login() {
    const loginUrl = new URL(this.config.loginPath, this.config.baseUrl).toString();
    this.logger.info(`Navigating to login page: ${loginUrl}`);
    await this.page.goto(loginUrl, { waitUntil: "domcontentloaded" });

    await this.fillFirst([
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]'
    ], this.config.email, "email");

    await this.fillFirst([
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      'input[id*="password" i]',
      'input[placeholder*="password" i]'
    ], this.config.password, "password");

    let submitted = await this.clickFirst([
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button[type="submit"]'
    ]);

    if (!submitted) {
      const passwordField = await this.firstVisible([
        'input[type="password"]',
        'input[name="password"]',
        'input[autocomplete="current-password"]'
      ]);

      if (passwordField) {
        await passwordField.press("Enter");
        submitted = true;
      }
    }

    if (!submitted) {
      throw new Error("Could not submit login form.");
    }

    await this.page.waitForLoadState("networkidle");
    this.logger.info("Login flow submitted.");
  }

  async joinCanvas() {
    this.logger.info("Opening canvas invite link.");
    await this.page.goto(this.currentCanvasLink, { waitUntil: "domcontentloaded" });

    try {
      await this.page.waitForLoadState("networkidle", { timeout: 15000 });
      await this.handlePublicJamPromptIfPresent();
      return;
    } catch (error) {
      if (this.page && !this.page.isClosed()) {
        throw error;
      }
    }

    const replacementPage = await this.pickActivePage();
    if (!replacementPage) {
      throw new Error("Canvas navigation closed the page and no active replacement tab was found.");
    }

    this.page = replacementPage;
    this.page.setDefaultTimeout(20000);
    await this.page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    this.logger.info("Switched to replacement page after canvas handoff.");
    await this.handlePublicJamPromptIfPresent();
  }

  async handlePublicJamPromptIfPresent() {
    const hasPublicJamPrompt = await this.page.evaluate(() => {
      return Boolean(document.querySelector("button.sm.square.btn.switch-loud.tgl.off"));
    });

    if (!hasPublicJamPrompt) {
      this.logger.info("No public jam prompt detected; treating canvas as private.");
      return;
    }

    this.logger.info("Public jam prompt detected. Accepting prompt before entering canvas.");

    const checked = await this.safeClickBySelectors([
      "button.sm.square.btn.switch-loud.tgl.off",
      "button.switch-loud.tgl.off",
      '[class*="switch-loud"][class*="tgl"][class*="off"]'
    ]);

    if (!checked) {
      this.logger.warn("Public jam checkbox not found or could not be toggled.");
    }

    await wait(250);

    const joined = await this.safeClickBySelectors([
      "button.md.btn.primary.ng-star-inserted",
      "button.md.btn.primary",
      '[role="button"].md.btn.primary',
      'button:has-text("Join")',
      '[role="button"]:has-text("Join")'
    ]);

    if (joined) {
      this.logger.info("Public jam prompt accepted.");
      await wait(500);
      return;
    }

    this.logger.warn("Public jam join button not found after checkbox step.");
  }

  async joinCall() {
    this.logger.info("Attempting to join voice call...");
    let joined = false;

    if (await this.isInCallState()) {
      this.logger.info("Detected in-call UI state before join attempts.");
      joined = true;
    }

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      if (joined) {
        break;
      }

      if (attempt === 1 || attempt % 5 === 0) {
        this.logger.info(`Join attempt ${attempt}/20`);
      }

      let clicked = await this.clickExactStartCallButton();
      if (!clicked) {
        clicked = await this.attemptJoinCallIfDisconnected();
      }

      if (clicked) {
        await wait(700);
        joined = await this.isInCallState();
        if (joined) {
          this.logger.info("Join confirmed by in-call UI markers.");
        }
      }

      await wait(1000);
    }

    if (!joined) {
      this.logger.warn("Join call button not found or not in join state. Trying force-click fallback.");
      const fallbackClicked = await this.forceJoinCallClick();
      if (fallbackClicked) {
        await wait(900);
        joined = await this.isInCallState();
        if (joined) {
          this.logger.info("Fallback click confirmed in-call state.");
        }
      }
    }

    if (!joined) {
      const candidates = await this.collectCallButtonCandidates();
      this.logger.warn("Join call still failed. Visible call-like candidates:", JSON.stringify(candidates, null, 2));
      return false;
    }

    this.logger.info("Join call action triggered.");
    await this.ensureVoiceConfigured("join");

    return true;
  }

  async isInCallState() {
    return this.hasVisibleSelectorAcrossFrames([
      "#toggle-mute-button",
      "#toggle-camera-button",
      '[id*="toggle-mute" i]',
      'button[aria-label*="mute" i]',
      '[role="button"][aria-label*="mute" i]',
      'button[aria-label*="voice settings" i]',
      '[role="button"][aria-label*="voice settings" i]',
      "select.device.control",
      "select.device.control.thin-dark.k-scrollbar.ng-pristine.ng-valid.md.ng-star-inserted"
    ]);
  }

  async hasVisibleSelectorAcrossFrames(selectors) {
    const frames = this.getCurrentPageFrames();
    for (const frame of frames) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        try {
          if ((await locator.count()) && (await locator.isVisible())) {
            return true;
          }
        } catch {
          continue;
        }
      }
    }
    return false;
  }

  async runHeartbeat() {
    this.logger.info("Heartbeat monitor started.");
    this.lastHeartbeatCheckAt = 0;

    await new Promise((resolve, reject) => {
      const tickMs = Math.max(500, Math.min(this.config.chatPollMs, this.config.heartbeatMs));

      this.heartbeatTimer = setInterval(async () => {
        if (this.shuttingDown) {
          resolve();
          return;
        }

        try {
          if (!this.page || this.page.isClosed()) {
            throw new Error("Page closed");
          }

          const url = this.page.url();
          if (!url.includes("magma")) {
            throw new Error(`Unexpected URL: ${url}`);
          }

          const now = Date.now();
          if (now - this.lastHeartbeatCheckAt >= this.config.heartbeatMs) {
            this.lastHeartbeatCheckAt = now;
            const rejoin = await this.attemptJoinCallIfDisconnected();
            if (rejoin) {
              this.logger.warn("Detected disconnected state and attempted rejoin.");
              this.voiceConfiguredForSession = false;
              this.commandsArmed = false;
            }

            const shouldRetryVoiceConfig = !this.voiceConfiguredForSession && now - this.lastVoiceConfigureAttemptAt >= 5000;
            if (shouldRetryVoiceConfig && (await this.isInCallState())) {
              const configured = await this.ensureVoiceConfigured("heartbeat");
              if (configured && !this.commandsArmed) {
                await this.ensureChatOpen();
                this.commandsArmed = true;
                this.commandsArmedAt = Date.now();
                this.lastChatCommandKey = null;
                this.logger.info("Command listener re-armed after voice configuration recovery.");
              }
            }
          }

          if (this.commandsArmed) {
            await this.pollChatCommands();
          }
        } catch (error) {
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
          }
          reject(error);
        }
      }, tickMs);
    });
  }

  async ensureChatOpen() {
    if (!this.config.chatCommandsEnabled) {
      return;
    }

    // Attempt to open chat panel if it is collapsed.
    await this.safeClickBySelectors([
      "button#open-chat-button",
      "#open-chat-button",
      'button[aria-label*="chat" i]',
      '[role="button"][aria-label*="chat" i]',
      'button[data-tooltip*="chat" i]'
    ]);
  }

  async configureVoiceSettings() {
    if (this.audioController?.config?.mode === "virtual-cable") {
      this.logger.info("Virtual-cable mode: enforcing in-app input-device selection to Virtual Cable after join.");
    }

    let configured = false;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      configured = await this.setPreferredMicDevice();
      if (configured) {
        break;
      }
      await wait(350);
    }

    if (!configured) {
      this.logger.warn("Could not confirm input device switch after join.");
      return false;
    }

    await this.unmuteIfMuted();
    return true;
  }

  async unmuteIfMuted() {
    let unmuted = false;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      unmuted = await this.safeClickBySelectors([
        "button#toggle-mute-button[aria-pressed='true']",
        "#toggle-mute-button[aria-pressed='true']",
        "button#toggle-mute-button.muted",
        "#toggle-mute-button.muted",
        "button[aria-pressed='true'][id*='mute' i]",
        "[role='button'][aria-pressed='true'][id*='mute' i]",
        "button[aria-pressed='true'][aria-label*='mute' i]",
        "[role='button'][aria-pressed='true'][aria-label*='mute' i]",
        'button[aria-label*="unmute" i]',
        '[role="button"][aria-label*="unmute" i]'
      ]);

      if (unmuted) {
        break;
      }

      unmuted = await this.clickMutedToggleNearCamera();
      if (unmuted) {
        break;
      }

      unmuted = await this.clickLikelyMuteNearCamera();
      if (unmuted) {
        break;
      }

      await wait(350);
    }

    if (unmuted) {
      this.logger.info("Microphone unmuted.");
      return;
    }

    this.logger.info("Mute state not explicitly detected as muted; skipping unmute click.");
  }

  async setPreferredMicDevice() {
    const dropdownSelectors = [
      "select.device.control.thin-dark.k-scrollbar.ng-pristine.ng-valid.md.ng-star-inserted",
      "select.device.control",
      'label:has-text("Input Device") + * select',
      'label:has-text("Input Device") + * [role="combobox"]',
      'select[aria-label*="input" i]',
      '[role="combobox"][aria-label*="input" i]'
    ];

    const voiceSettingsSelectors = [
      'button.md.square.btn.neutral',
      "button#voice-settings-button",
      "#voice-settings-button",
      'button[aria-label*="voice settings" i]',
      '[role="button"][aria-label*="voice settings" i]',
      'button[data-tooltip*="voice settings" i]',
      'button[title*="voice settings" i]',
      'button[aria-label*="settings" i]',
      '[role="button"][aria-label*="settings" i]'
    ];

    // Open settings first, then try to switch input device.
    const openedSettings = await this.openVoiceSettingsPanel(voiceSettingsSelectors, dropdownSelectors);
    if (!openedSettings) {
      this.logger.warn("Voice settings button not found; could not set microphone device.");
      return false;
    }

    let inputDropdown = await this.firstVisibleAcrossFrames(dropdownSelectors);

    if (!inputDropdown) {
      this.logger.warn("Input Device selector not found in voice settings.");
      await this.closeVoiceSettingsIfOpen();
      return false;
    }

    const changed = await this.trySelectMicOption(inputDropdown, this.config.preferredMicName);
    if (changed) {
      this.logger.info(`Input device set to preferred microphone: ${this.config.preferredMicName}`);
    } else {
      this.logger.warn(`Preferred microphone not found in Input Device options: ${this.config.preferredMicName}`);
    }

    await this.closeVoiceSettingsIfOpen();
    return changed;
  }

  async openVoiceSettingsPanel(voiceSettingsSelectors, dropdownSelectors) {
    if (await this.hasVisibleSelectorAcrossFrames(dropdownSelectors)) {
      return true;
    }

    const clickedBySelector = await this.safeClickBySelectors(voiceSettingsSelectors);
    if (clickedBySelector) {
      await wait(500);
      if (await this.hasVisibleSelectorAcrossFrames(dropdownSelectors)) {
        return true;
      }
    }

    const clickedNearCamera = await this.clickSettingsButtonNearCamera();
    if (clickedNearCamera) {
      await wait(500);
      if (await this.hasVisibleSelectorAcrossFrames(dropdownSelectors)) {
        return true;
      }
    }

    return false;
  }

  async trySelectMicOption(inputDropdown, preferredName) {
    const tagName = await inputDropdown.evaluate((el) => el.tagName.toLowerCase());

    if (tagName === "select") {
      const options = await inputDropdown.locator("option").allTextContents();
      const preferred = String(preferredName || "").toLowerCase();
      const fallbackHints = ["vb", "cable output", "virtual cable", "vb-audio"];
      let match = options.find((text) => text.toLowerCase().includes(preferred));
      if (!match) {
        match = options.find((text) => fallbackHints.some((hint) => text.toLowerCase().includes(hint)));
      }
      if (!match) {
        return false;
      }
      await inputDropdown.selectOption({ label: match });
      return true;
    }

    await inputDropdown.click();
    await wait(200);
    const option = this.page.locator(`[role=\"option\"]:has-text(\"${escapeForHasText(preferredName)}\")`).first();
    if (!(await option.count())) {
      return false;
    }
    await option.click();
    return true;
  }

  async closeVoiceSettingsIfOpen() {
    await this.safeClickBySelectors([
      "button#close-voice-settings-button",
      "#close-voice-settings-button",
      'button[aria-label*="close" i]',
      '[role="button"][aria-label*="close" i]'
    ]);
  }

  async clickMutedToggleNearCamera() {
    const frames = this.getCurrentPageFrames();
    for (const frame of frames) {
      try {
        const clicked = await frame.evaluate(() => {
          const camera = document.querySelector("#toggle-camera-button");
          if (!camera) {
            return false;
          }

          const parent = camera.parentElement;
          if (!parent) {
            return false;
          }

          const isVisible = (node) => Boolean(node && node.getClientRects().length);
          if (!isVisible(camera)) {
            return false;
          }

          // Prefer an explicit muted mic toggle next to camera controls.
          const siblingButtons = Array.from(parent.querySelectorAll("button, [role='button']"));
          const mutedSibling = siblingButtons.find((node) => {
            if (node === camera) return false;
            if (!isVisible(node)) return false;

            const id = (node.id || "").toLowerCase();
            const cls = (node.className || "").toLowerCase();
            const aria = (node.getAttribute("aria-label") || "").toLowerCase();
            const title = (node.getAttribute("title") || "").toLowerCase();
            const tooltip = (node.getAttribute("data-tooltip") || "").toLowerCase();
            const pressed = (node.getAttribute("aria-pressed") || "").toLowerCase();

            if (id.includes("camera") || aria.includes("camera") || aria.includes("video")) {
              return false;
            }

            const looksLikeMic = id.includes("mute") || aria.includes("mute") || title.includes("mute") || tooltip.includes("mute");
            const looksLikeControl = cls.includes("w-full") && cls.includes("square") && cls.includes("btn");
            const looksMuted = pressed === "true" || cls.includes("muted");

            return looksMuted && (looksLikeMic || looksLikeControl);
          });

          if (!mutedSibling) {
            return false;
          }

          mutedSibling.click();
          return true;
        });

        if (clicked) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  async clickLikelyMuteNearCamera() {
    const frames = this.getCurrentPageFrames();
    for (const frame of frames) {
      try {
        const clicked = await frame.evaluate(() => {
          const camera = document.querySelector("#toggle-camera-button");
          if (!camera || camera.getClientRects().length === 0) {
            return false;
          }

          const parent = camera.parentElement;
          if (!parent) {
            return false;
          }

          const controls = Array.from(parent.querySelectorAll("button, [role='button']")).filter((node) => {
            if (node === camera) return false;
            if (node.getClientRects().length === 0) return false;

            const id = (node.id || "").toLowerCase();
            const aria = (node.getAttribute("aria-label") || "").toLowerCase();
            const cls = (node.className || "").toLowerCase();

            if (id.includes("camera") || aria.includes("camera") || aria.includes("video")) {
              return false;
            }

            return cls.includes("w-full") && cls.includes("square") && cls.includes("btn") && cls.includes("neutral");
          });

          if (!controls.length) {
            return false;
          }

          if (controls.length === 1) {
            controls[0].click();
            return true;
          }

          const cameraIndex = controls.findIndex((node) => node.compareDocumentPosition(camera) & Node.DOCUMENT_POSITION_FOLLOWING);
          const preferred = cameraIndex >= 1 ? controls[cameraIndex - 1] : controls[0];
          preferred.click();
          return true;
        });

        if (clicked) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  async clickSettingsButtonNearCamera() {
    const frames = this.getCurrentPageFrames();
    for (const frame of frames) {
      try {
        const clicked = await frame.evaluate(() => {
          const camera = document.querySelector("#toggle-camera-button");
          if (!camera || camera.getClientRects().length === 0) {
            return false;
          }

          const parent = camera.parentElement;
          if (!parent) {
            return false;
          }

          const controls = Array.from(parent.querySelectorAll("button, [role='button']")).filter((node) => {
            if (node === camera) return false;
            if (node.getClientRects().length === 0) return false;
            return true;
          });

          const cameraRect = camera.getBoundingClientRect();
          const cameraCenterY = cameraRect.top + cameraRect.height / 2;

          // Primary strategy: use the control immediately above camera button.
          const aboveCandidates = controls
            .map((node) => {
              const rect = node.getBoundingClientRect();
              const centerY = rect.top + rect.height / 2;
              const distance = cameraCenterY - centerY;
              const id = (node.id || "").toLowerCase();
              const aria = (node.getAttribute("aria-label") || "").toLowerCase();
              const cls = (node.className || "").toLowerCase();

              // Exclude obvious non-settings controls.
              if (id.includes("camera") || aria.includes("camera") || aria.includes("video")) return null;
              if (id.includes("mute") || aria.includes("mute")) return null;
              if (id.includes("leave") || aria.includes("leave") || aria.includes("disconnect")) return null;

              // This is the style you identified in your UI.
              const looksLikeSettingsButton = cls.includes("md") && cls.includes("square") && cls.includes("btn") && cls.includes("neutral");
              if (!looksLikeSettingsButton) return null;

              if (distance <= 0) return null;
              return { node, distance };
            })
            .filter(Boolean)
            .sort((a, b) => a.distance - b.distance);

          if (aboveCandidates.length >= 2) {
            // User-confirmed layout: settings is one more above the nearest control.
            aboveCandidates[1].node.click();
            return true;
          }

          if (aboveCandidates.length === 1) {
            aboveCandidates[0].node.click();
            return true;
          }

          let best = null;
          let bestScore = 0;

          for (const node of controls) {
            const id = (node.id || "").toLowerCase();
            const cls = (node.className || "").toLowerCase();
            const aria = (node.getAttribute("aria-label") || "").toLowerCase();
            const title = (node.getAttribute("title") || "").toLowerCase();
            const tooltip = (node.getAttribute("data-tooltip") || "").toLowerCase();
            const text = (node.textContent || "").toLowerCase();
            const merged = `${id} ${cls} ${aria} ${title} ${tooltip} ${text}`;

            let score = 0;
            if (/(settings|device|input|output|audio|voice settings)/.test(merged)) score += 12;
            if (/md\s*square\s*btn\s*neutral/.test(merged)) score += 4;
            if (/(camera|video|mute|unmute|leave|disconnect)/.test(merged)) score -= 10;

            if (score > bestScore) {
              bestScore = score;
              best = node;
            }
          }

          if (!best || bestScore <= 0) {
            return false;
          }

          best.click();
          return true;
        });

        if (clicked) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  async pollChatCommands() {
    if (!this.config.chatCommandsEnabled || !this.page) {
      return;
    }

    const result = await this.page.evaluate(({ botHandle }) => {
      const mentionToken = `@${String(botHandle || "").trim().toLowerCase()}`;
      if (!mentionToken || mentionToken === "@") {
        return null;
      }

      const selectors = [
        '[data-testid*="chat" i] *',
        '[id*="chat" i] *',
        '[class*="chat" i] *',
        '[role="log"] *'
      ];

      const entries = [];
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          const text = node.textContent?.trim();
          if (!text) continue;
          if (text.length > 300) continue;
          entries.push({ text, source: "chat" });
        }
      }

      // Fallback: include visible page text lines in case chat DOM selectors change.
      const bodyLines = (document.body?.innerText || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.length <= 300)
        .slice(-200);
      for (const line of bodyLines) {
        entries.push({ text: line, source: "body" });
      }

      const recentEntries = entries.slice(-300);
      for (let i = recentEntries.length - 1; i >= 0; i -= 1) {
        const original = recentEntries[i].text;
        const lower = original.toLowerCase();
        if (!lower.includes(mentionToken)) {
          continue;
        }

        const hasPlay = /\bplay\b/i.test(original);
        const hasNext = /\bnext\b|\bskip\b/i.test(original);
        const hasStop = /\bstop\b|\bend\b/i.test(original);

        if (hasPlay || hasNext || hasStop) {
          const command = hasStop ? "stop" : hasNext ? "next" : "play";
          const normalized = original.trim().toLowerCase();
          const source = recentEntries[i].source;

          // Count occurrences of the same normalized command text up to this point.
          // This lets repeated identical commands be treated as new events.
          let occurrence = 0;
          for (let j = 0; j <= i; j += 1) {
            if (recentEntries[j].source !== source) continue;
            if (recentEntries[j].text.trim().toLowerCase() !== normalized) continue;
            occurrence += 1;
          }

          return {
            key: `${mentionToken}:${command}:${source}:${normalized}:#${occurrence}`,
            command,
            text: original
          };
        }
      }

      return null;
    }, { botHandle: this.config.botHandle });

    if (!result || !result.command) {
      return;
    }

    // Prime cursor shortly after arming to avoid replaying old chat commands.
    if (!this.lastChatCommandKey && this.commandsArmedAt && Date.now() - this.commandsArmedAt < 15000) {
      this.lastChatCommandKey = result.key;
      this.logger.info("Chat command cursor primed; waiting for new commands.");
      return;
    }

    if (result.key === this.lastChatCommandKey) {
      return;
    }

    this.lastChatCommandKey = result.key;
    if (result.command === "play") {
      const joined = await this.joinCall();
      if (!joined) {
        this.logger.warn("Play command received while join is not confirmed yet; starting audio anyway and heartbeat will continue join/setup retries.");
      } else {
        await this.ensureVoiceConfigured("play");
      }

      await this.audioController.start();
      this.logger.info(`Magma chat command received: play (${result.text})`);
      return;
    }

    if (result.command === "next") {
      if (this.audioController?.config?.mode === "fake-mic") {
        await this.audioController.next();
        this.fakeMicPrepared = false;
        this.rejoinRequested = true;
        this.commandsArmed = false;
        this.commandsArmedAt = 0;
        this.logger.info(`Magma chat command received: next (${result.text}) - restarting session to load next fake-mic track.`);
        await this.cleanupBrowser();
        throw new Error("Session restart requested for fake-mic track change.");
      }

      await this.audioController.next();
      this.logger.info(`Magma chat command received: next (${result.text})`);
      return;
    }

    if (result.command === "stop") {
      await this.audioController.stop();
      this.logger.info(`Magma chat command received: stop (${result.text})`);
    }
  }

  async attemptJoinCallIfDisconnected() {
    if (await this.isInCallState()) {
      return false;
    }
    return this.clickExactStartCallButton();
  }

  async isVoiceControlsReady() {
    return this.hasVisibleSelectorAcrossFrames([
      "#toggle-mute-button",
      '[id*="toggle-mute" i]',
      'button[aria-label*="mute" i]',
      '[role="button"][aria-label*="mute" i]',
      "button#voice-settings-button",
      "#voice-settings-button",
      'button[aria-label*="voice settings" i]',
      '[role="button"][aria-label*="voice settings" i]',
      "select.device.control",
      "select.device.control.thin-dark.k-scrollbar.ng-pristine.ng-valid.md.ng-star-inserted"
    ]);
  }

  async ensureVoiceConfigured(trigger) {
    if (this.voiceConfiguredForSession) {
      return true;
    }

    this.lastVoiceConfigureAttemptAt = Date.now();

    if (!(await this.isInCallState())) {
      this.logger.warn(`Not in call during ${trigger}; will retry voice setup.`);
      return false;
    }

    const configured = await this.configureVoiceSettings();
    this.voiceConfiguredForSession = this.voiceConfiguredForSession || configured;
    if (!this.voiceConfiguredForSession) {
      this.logger.warn(`Voice setup attempt during ${trigger} did not complete; will retry.`);
    }
    return this.voiceConfiguredForSession;
  }

  async clickExactStartCallButton() {
    const selectors = [
      "button#start-call-button.md.square.btn.neutral.ng-star-inserted",
      "button#start-call-button",
      "#start-call-button",
      "button.md.square.btn.success.ng-star-inserted",
      "button.md.square.btn.success"
    ];

    const frames = this.getCurrentPageFrames();
    for (const frame of frames) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (!(await locator.count())) {
          continue;
        }

        try {
          if (!(await locator.isVisible())) {
            continue;
          }
          await locator.scrollIntoViewIfNeeded();
        } catch {
          // Non-blocking: continue to click attempt.
        }

        try {
          await locator.click({ timeout: 1200, force: true });
          this.logger.info(`Clicked strict start-call selector: ${selector}`);
          return true;
        } catch {
          continue;
        }
      }
    }

    return false;
  }

  async forceJoinCallClick() {
    // Fallback still limited to exact start-call selectors to avoid clicking unrelated controls.
    return this.clickExactStartCallButton();
  }

  async collectCallButtonCandidates() {
    const frames = this.getCurrentPageFrames();
    const allCandidates = [];

    for (const frame of frames) {
      try {
        const frameCandidates = await frame.evaluate(() => {
          const selectors = ["button", "[role='button']"];
          const candidates = [];
          const seen = new Set();

          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              if (node.getClientRects().length === 0) continue;
              const text = (node.textContent || "").trim();
              const aria = (node.getAttribute("aria-label") || "").trim();
              const title = (node.getAttribute("title") || "").trim();
              const id = (node.id || "").trim();
              const cls = (node.className || "").trim();
              const key = `${id}|${cls}|${text}|${aria}|${title}`;
              if (seen.has(key)) continue;
              seen.add(key);

              candidates.push({ id, className: cls, text, aria, title });
              if (candidates.length >= 6) return candidates;
            }
          }

          return candidates;
        });

        if (frameCandidates.length) {
          allCandidates.push({ frameUrl: frame.url(), candidates: frameCandidates });
        }
      } catch {
        // Ignore cross-origin or detached frame errors.
      }
    }

    return allCandidates;
  }

  async fillFirst(selectors, value, fieldName = "field") {
    for (const selector of selectors) {
      const handle = this.page.locator(selector).first();
      if ((await handle.count()) && (await handle.isVisible())) {
        await handle.click({ timeout: 2000 });
        await handle.fill("");
        await handle.type(String(value), { delay: 20 });
        return;
      }
    }
    throw new Error(`Could not find visible ${fieldName} field among selectors: ${selectors.join(", ")}`);
  }

  async clickFirst(selectors) {
    for (const selector of selectors) {
      const handle = this.page.locator(selector).first();
      if ((await handle.count()) && (await handle.isVisible())) {
        await handle.click({ timeout: 3000 });
        return true;
      }
    }
    return false;
  }

  async safeClickBySelectors(selectors) {
    const frames = this.getCurrentPageFrames();

    for (const frame of frames) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (!(await locator.count())) {
          continue;
        }

        try {
          if (!(await locator.isVisible())) {
            continue;
          }
          await locator.click({ timeout: 3000, force: true });
          return true;
        } catch {
          continue;
        }
      }
    }

    return false;
  }

  async firstVisible(selectors) {
    for (const selector of selectors) {
      const locator = this.page.locator(selector).first();
      if ((await locator.count()) && (await locator.isVisible())) {
        return locator;
      }
    }
    return null;
  }

  async firstVisibleAcrossFrames(selectors) {
    const frames = this.getCurrentPageFrames();

    for (const frame of frames) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        try {
          if ((await locator.count()) && (await locator.isVisible())) {
            return locator;
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  getCurrentPageFrames() {
    if (!this.page || this.page.isClosed()) {
      return [];
    }
    return this.page.frames();
  }

  async pickActivePage() {
    const pages = this.context?.pages() || [];
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      const candidate = pages[i];
      if (!candidate.isClosed()) {
        return candidate;
      }
    }
    return null;
  }

  async cleanupBrowser() {
    this.suppressPageCloseWarning = true;
    try {
      if (this.context) {
        await this.context.close();
      }
      if (this.browser) {
        await this.browser.close();
      }
    } catch (error) {
      this.logger.warn("Browser cleanup encountered an issue.", error.message || error);
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
      this.voiceConfiguredForSession = false;
      this.lastVoiceConfigureAttemptAt = 0;
      this.commandsArmed = false;
      this.commandsArmedAt = 0;
      this.lastChatCommandKey = null;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.suppressPageCloseWarning = false;
    }
  }

  async startAutomation(canvasLink) {
    if (canvasLink) {
      this.currentCanvasLink = canvasLink;
    }

    this.automationEnabled = true;
    this.rejoinRequested = true;
    this.logger.info(`Automation started. Target canvas: ${this.currentCanvasLink}`);

    if (this.page && !this.page.isClosed()) {
      await this.cleanupBrowser();
    }
  }

  async stopAutomation() {
    this.automationEnabled = false;
    this.rejoinRequested = false;
    await this.audioController.stop();
    await this.cleanupBrowser();
    this.logger.info("Automation stopped.");
  }

  async setCanvasLink(canvasLink) {
    this.currentCanvasLink = canvasLink;
    this.rejoinRequested = true;
    this.logger.info(`Canvas link updated: ${canvasLink}`);

    if (this.automationEnabled) {
      await this.cleanupBrowser();
    }
  }

  getRuntimeStatus() {
    return {
      active: this.automationEnabled,
      canvasLink: this.currentCanvasLink,
      sessionAlive: Boolean(this.page && !this.page.isClosed())
    };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeForHasText(value) {
  return String(value).replace(/"/g, '\\"');
}
