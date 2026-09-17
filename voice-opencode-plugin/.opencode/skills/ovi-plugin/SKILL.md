---
name: ovi-plugin
description: Use when editing or debugging the OpenCode Voice plugin itself — src/index.ts hook, /voice subcommands, recorder (auto-stop by silence, graceful SIGINT, RAM tmp dir, retention), beeps, logRecognized, server launcher, sync-plugin.sh and the loader quirk. Triggers src/index.ts, recorder.ts, stt.ts, /voice command, push-to-talk.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: implementation
---

# OpenCode Voice — plugin internals

Entry: `src/index.ts`. **What OpenCode actually loads** is the synced copy
`.opencode/plugins/index.ts` (wired by the global config as
`file:///mnt/c/temp/openvi/voice-opencode-plugin/.opencode/plugins/index.ts`).
After every change run `bash sync-plugin.sh` or the running install stays stale.

## Hook: `command.execute.before`

- Reset the markdown template: `output.parts.length = 0` then push one text part (an empty
  array makes OpenCode error out). The plugin then **sets `output.parts` to the final text**
  so the model receives the transcript, not an empty prompt.
- OpenCode always calls the model after this hook — you cannot cancel it. Therefore on failure
  (no speech / transcribe error / empty recording) the hook **throws**: the command fails visibly
  instead of sending an empty prompt. Trade-off: OpenCode logs `level=ERROR` for these.
- Hooks run strictly sequentially, so a second `/voice` cannot interrupt a running recording.

## Subcommands

| Command | Behaviour |
| --- | --- |
| `/voice` | Record (auto-stop ~1.5 s after speech, hard cap 60 s) → transcribe → insert text |
| `/voice <file.wav\|mp3\|m4a\|ogg\|flac>` | Transcribe an existing file (`source=command-file`) |
| `/voice backend [local\|api]` | STT backend (in-memory state) |
| `/voice lang [ru\|en\|auto]` | Language (in-memory state) |
| `/voice device [auto\|gpu\|cpu]` | Local device selection |
| `/voice doctor [--fix]` | Runs `doctor.sh` and shows the tail (see `ovi-debug`) |
| `/voice help` | Prints the list |

State is **not persisted** between OpenCode restarts; use env vars to pin values.
Info subcommands set a service message (`svc(...)`) as parts so no empty prompt is sent.

## Recording (`src/lib/recorder.ts`)

- `startPushToTalk($, { maxSeconds })` — detached `arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav`
  (ffmpeg fallback), returns `{ file, pid, backend }` immediately. Files:
  `${OPENCODE_VOICE_TMP_DIR:-/dev/shm/opencode-voice}/voice-ptt-*.wav` (RAM), auto-deleted
  after `OPENCODE_VOICE_RETAIN_SECONDS` (default 300 s) unless `OPENCODE_VOICE_KEEP_AUDIO`.
- `waitPushToTalkAuto(session, opts)` — polls the growing WAV and stops after
  `silenceMs` (1500 ms) of silence once speech was seen, or at `maxAudioSeconds` (60 s) /
  wall-clock limit. Reasons: `ended | silence | maxAudio | wall`.
- `stopGracefully(pid)` — **SIGINT** so arecord finalizes the WAV header, SIGKILL only as a fallback.
  Never SIGKILL: it left a stale header and truncated long recordings.
- Pinned source: `PULSE_SOURCE` is set from `OPENCODE_VOICE_SOURCE` (default `RDPSource`) so a dead
  audin channel cannot silently switch the capture to `RDPSink.monitor` (system sound).
- `recoverMic($)` — recreates the WSLg audio channel via `wsl.exe --system` (weston, then pulseaudio),
  used once when the recording comes back empty.

## STT (`src/lib/stt.ts`)

- `transcribe({ backend, language, file, $, device, source })` → string; logs every result via
  `logRecognized()` into `OPENCODE_VOICE_RECOGNIZED_LOG` (default `/tmp/opencode/voice-recognized.log`)
  as `source= backend= model= lang= dur= text="..."`.
- Device: `OPENCODE_VOICE_DEVICE` (`auto|gpu|cpu`); `OPENCODE_VOICE_STT_BACKEND=whispercpp|faster-whisper` is a legacy alias.
- Order: whisper.cpp (GPU, `-mc 0 -sns`) → faster-whisper CPU → whisper.cpp CPU (small) → CLI in PATH → python-whisper → vosk.
- `isSilentWav()` rejects silence before Whisper; `stripNonSpeech()` removes `[музыка]`, `(смех)`, `♪` markers.

## Other libs

- `beep.ts` — generates a cached WAV in `/tmp` and plays it via `aplay -D pulse` → `paplay` → `ffplay` (880 Hz start, 520 Hz stop, 660 Hz done).
- `server-launcher.ts` — `ensureSttServer()` + `startServerWatchdog()`: starts `python3 -u stt_server.py --port ${OPENCODE_VOICE_PORT:-8765}` detached with stdout/stderr to `${OPENCODE_VOICE_SERVER_LOG:-/tmp/opencode/stt_server.log}`.
- `config.ts` — reads `OPENCODE_VOICE_BACKEND`, `OPENCODE_VOICE_LANGUAGE`, `OPENCODE_VOICE_MODEL`, `OPENAI_API_KEY`.

## Rules

- Do **not** add top-level non-function exports to `src/index.ts` — the plugin loader (`getLegacyPlugins`) throws.
- Keep `src/index.ts` and `.opencode/plugins/index.ts` in sync (`sync-plugin.sh` rewrites `./lib/` → `../../src/lib/`); lib files are imported directly and need no sync.
- Config-time changes are not hot-reloaded: restart OpenCode.
