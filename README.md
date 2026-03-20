# Magma Music Player Bot

Automates a dedicated bot account that:

1. Logs into Magma with Playwright.
2. Opens a canvas invite link.
3. Joins the call.
4. Unmutes and attempts to set the input microphone device to virtual cable.
5. Streams audio either via a virtual cable setup or Chromium fake-mic mode.

## What this project includes

- Automated login and canvas join flow.
- Handles public jam pre-join prompt (checkbox + join) before entering canvas.
- Call join automation with fallback button matching.
- Reconnect heartbeat loop if session drops or UI refreshes.
- Environment-driven configuration.
- Optional interactive controls (`pause`, `next`, `volume`) for playback.
- Optional Discord slash controls for bot start/canvas routing.
- Optional Magma chat mention commands for playback control.

## Prerequisites

- Node.js 20+
- Playwright browser runtime (installed with dependencies)
- Optional for virtual audio mode:
  - FFmpeg/ffplay on PATH
  - VB-CABLE (Windows) or equivalent loopback virtual audio device

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment template:

```bash
copy .env.example .env
```

3. Edit `.env` values:

- `MAGMA_EMAIL`
- `MAGMA_PASSWORD`
- `MAGMA_CANVAS_LINK`
- `AUDIO_MODE`
- `AUDIO_SOURCE` (or `AUDIO_PLAYLIST`)

Optional Magma chat controls:

- `MAGMA_CHAT_COMMANDS_ENABLED=true`
- `MAGMA_BOT_HANDLE=NexLofi-Bot`
- `MAGMA_AUTOSTART_AUDIO=false`
- `MAGMA_CHAT_POLL_MS=2000`
- `MAGMA_PREFERRED_MIC_NAME=CABLE Output`

Optional Discord config:

- `DISCORD_ENABLED=true`
- `DISCORD_BOT_TOKEN=...`
- `DISCORD_GUILD_ID=...` (optional filter)
- `DISCORD_CHANNEL_ID=...` (optional filter)
- `DISCORD_COMMAND_PREFIX=!`
- `DISCORD_USE_SLASH_COMMANDS=true`
- `DISCORD_ALLOW_PREFIX_COMMANDS=false`
- `MAGMA_WAIT_FOR_START_COMMAND=true` (optional; wait for Discord `start` command)

## Audio modes

### Mode 1: `virtual-cable` (recommended for live sources)

This mode starts `ffplay` and sends audio to your system output.

Typical Windows routing with VB-CABLE:

1. Set app/player output to `CABLE Input`.
2. In browser/mic settings, select `CABLE Output` as microphone.
3. Start bot.

Notes:

- If Magma defaults to another mic, manually switch once and keep site settings persisted.
- `AUDIO_SOURCE` can be local media file or stream URL supported by ffplay.
- Use `AUDIO_PLAYLIST` for multiple comma-separated sources.

### Mode 2: `fake-mic`

Use Chromium flag-based fake microphone input:

- Set `AUDIO_MODE=fake-mic`
- Set `FAKE_MIC_WAV=./audio/loop.wav`

Good for deterministic testing and unattended runs.

## Commands

Run full bot:

```bash
npm run run
```

Validate config:

```bash
npm run check
```

Run only audio playback:

```bash
npm run play
```

## Interactive controls

When running `run` or `play`, type in terminal:

- `status`
- `pause`
- `next`
- `volume 0.6`
- `play`
- `stop`
- `help`

## Magma chat command controls

When running `npm run run`, the bot reads Magma chat and handles music controls from mention messages.

Use messages like:

- `@NexLofi-Bot play`
- `@NexLofi-Bot next`
- `@NexLofi-Bot stop`

Behavior:

- With `MAGMA_AUTOSTART_AUDIO=false`, audio waits for `play` command.
- `next` skips to the next item in your configured playlist.
- `stop` halts playback until the next `play` command.
- Chat polling interval is controlled by `MAGMA_CHAT_POLL_MS`.

Voice behavior:

- After joining/rejoining a call, bot attempts to unmute itself.
- Bot opens voice settings and tries to set Input Device to `MAGMA_PREFERRED_MIC_NAME`.

## Discord command controls (optional)

If `DISCORD_ENABLED=true` and a bot token is provided, the bot registers slash commands.

Example slash commands:

- `/join canvas:https://magma.com/d/your-canvas`

If `DISCORD_GUILD_ID` or `DISCORD_CHANNEL_ID` is set, commands are accepted only from those scopes.

Bot lifecycle via Discord:

- `/join <canvas>` starts automation loop, opens that canvas, and auto-joins voice call.

Music controls are intentionally Magma-chat-only (`@NexLofi-Bot play|next|stop`).

## Resilience behavior

- Bot runs in a reconnect loop.
- On page close, unexpected URL change, or disconnect prompt, it retries.
- Retry delay and heartbeat interval are configurable:
  - `RETRY_DELAY_MS`
  - `HEARTBEAT_MS`

## Selector tuning (important)

Magma UI labels can change. If login/join fails:

1. Inspect current button text in DevTools.
2. Update selector candidates in:

- `src/magmaBot.js` (`login`, `joinCall`, `safeClickBySelectors`).

## Safety and account guidance

- Use a dedicated bot account with explicit permission from your team.
- Respect Magma Terms of Service and workspace rules.
- Keep credentials in `.env` only.

## Optional next Discord enhancements

- Push Magma session notifications (joined/rejoined/disconnected) into Discord.
