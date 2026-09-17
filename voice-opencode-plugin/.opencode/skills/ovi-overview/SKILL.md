---
name: ovi-overview
description: Use when the question is about OpenCode Voice as a whole — what it is, which components exist (plugin, STT server, browser extension/button, TUI/web UI), how audio and text flow, where files live, or which ovi-* skill to open next. Triggers "OpenCode Voice", "voice plugin", "voice button", "how does voice work", architecture.
license: MIT
compatibility: opencode
metadata:
  audience: both
  workflow: orientation
---

# OpenCode Voice — overview

Voice control for OpenCode: you speak, the text lands in the prompt. Local STT by default
(whisper.cpp on GPU, faster-whisper on CPU), optional OpenAI Whisper API.

## Components

| Component | Path | Role |
| --- | --- | --- |
| Plugin (server-side) | `voice-opencode-plugin/src/index.ts` | `/voice` command hook: records, transcribes, inserts text |
| Plugin libs | `voice-opencode-plugin/src/lib/{stt,recorder,beep,server-launcher,config}.ts` | STT, recording, beeps, server autostart, config |
| Loaded plugin copy | `voice-opencode-plugin/.opencode/plugins/index.ts` | Synced from `src/index.ts`; this file is what OpenCode loads |
| STT HTTP server | `voice-opencode-plugin/stt-server/stt_server.py` | `/transcribe`, `/record/*`, `/beep`, `/health`; GPU/CPU Whisper |
| Chrome extension (button) | `voice-opencode-plugin/extension/` | Mic button in the web UI; uploads audio to the server |
| TUI plugin | `voice-opencode-plugin/.opencode/tui/voice.ts` | Keybind `<leader>v` → runs `/voice` |
| Web plugin (optional) | `voice-opencode-plugin/.opencode/web/voice.tsx` | 🎤 button in the prompt (not wired by default) |
| Scripts | `sync-plugin.sh`, `fix-mic.sh`, `doctor.sh` | Sync copy, repair WSLg audio, diagnose button/server |
| Docs | `README.md` / `README.ru.md`, `AGENTS.md`, `AUDIT.md`, `TEST_PLAN.md` | User docs, agent guide, backlog, manual test plan |

## Two capture paths (the most important distinction)

1. **`/voice` (plugin)** — `arecord -D pulse` in WSL → Whisper CLI/Python → text set as the command output.
   Audio goes through WSLg PulseAudio → RDP **audin** when you are on a remote session.
2. **Button (extension)** — the browser captures the mic on the Windows side, POSTs WebM/Opus to
   `http://127.0.0.1:8765/transcribe`; the server converts with ffmpeg and transcribes.

Consequence: the button bypasses WSLg/RDP audio entirely and therefore stays high quality even over RDP,
while `/voice` over RDP depends on the audin channel quality (see `ovi-debug`).

## Where to look next

| Question | Skill |
| --- | --- |
| Plugin internals, `/voice` subcommands, recorder behaviour | `ovi-plugin` |
| Server API, token, CORS, logs, autostart | `ovi-server` |
| Button/extension, sounds, token in popup, versions | `ovi-extension` |
| Models, CUDA/GPU, quality/speed tuning | `ovi-models` |
| Microphone/audio path: silence, audin, formats, auto-stop, fix-mic | `ovi-audio` |
| Security/privacy: token, CORS, bind, retention, secrets | `ovi-security` |
| "It does not work": Failed to fetch, silence, 401/409, slow channel | `ovi-debug` |
| Build/test/commit/release/docs | `ovi-dev` |

## Glossary

- **audin** — RDP Audio Input Redirection channel; WSLg exposes it as PulseAudio source `RDPSource`.
- **RDPSink.monitor** — loopback of system sound; must NOT be the mic source (pinned via `OPENCODE_VOICE_SOURCE`).
- **Silence gate** — audio below `OPENCODE_VOICE_SILENCE_PEAK`/`_RMS` is treated as "no speech" (Whisper hallucinates on silence).
- **source=command / source=button** — tag in `/tmp/opencode/voice-recognized.log` telling where a transcript came from.
- **Retention** — recordings live in RAM (`/dev/shm/opencode-voice`, tmpfs) and are deleted after `OPENCODE_VOICE_RETAIN_SECONDS` (default 300 s).
