# OpenCode Voice Plugin

Voice control plugin for OpenCode supporting local (Whisper.cpp/Vosk/Python) and cloud (OpenAI Whisper API) backends, push-to-talk recording, and audio file transcription.

## Architecture & Entrypoints

- **Plugin Entrypoint**: `src/index.ts` (also linked to `.opencode/plugins/index.ts` for local loading via `opencode.json` — that whole `.opencode/` tree is gitignored; regenerate with `bash sync-plugin.sh` after cloning or editing `src/index.ts`).
- **Configuration & Env**: `src/lib/config.ts` (`OPENCODE_VOICE_BACKEND`, `OPENAI_API_KEY`, `OPENCODE_VOICE_LANGUAGE`, etc.). Mic auto-recovery on empty recordings: `OPENCODE_VOICE_AUTO_RECOVER` (default `1`), `WSL_EXE`, `OPENCODE_VOICE_RECOVER_WAIT_WESTON`/`_PULSE` (see `recoverMic` in `src/lib/recorder.ts`).
- **STT Transcription**: `src/lib/stt.ts` (`openai` SDK for `api` backend; `faster-whisper`/whisper.cpp for `local`). Default model: `medium` (`ggml-medium.bin` for whisper.cpp, `faster-whisper` medium on CPU). Device selection via `OPENCODE_VOICE_DEVICE` (`auto`|`gpu`|`cpu`) or `/voice device`: `auto` uses whisper.cpp+CUDA when `libcuda` is present, otherwise falls back to `faster-whisper` on CPU. `OPENCODE_VOICE_STT_BACKEND=whispercpp|faster-whisper` is kept as an alias.
- **Audio Recording**: `src/lib/recorder.ts` (`startPushToTalk`/`waitPushToTalkAuto`/`waitPushToTalkEnd`/`pttFileSize`/`recoverMic`; arecord/ffmpeg, mono 16 kHz S16_LE, pinned `OPENCODE_VOICE_SOURCE`). `/voice` records until ~1.5 s of silence after speech (hard cap 60 s of audio) and stops the recorder gracefully (SIGINT) so the WAV header is always finalized — the old SIGKILL truncated long recordings and left a stale header. Recordings go to RAM (`/dev/shm/opencode-voice`, tmpfs) and are auto-deleted after `OPENCODE_VOICE_RETAIN_SECONDS` (default 300 s).
- **Server & autostart**: `src/lib/server-launcher.ts` starts `stt-server/stt_server.py` on plugin load (`ensureSttServer`) and keeps it alive (`startServerWatchdog`). Env: `OPENCODE_VOICE_SERVER` (default `1`), `_SERVER_SCRIPT`, `_PORT` (8765), `_SERVER_LOG` (`/tmp/opencode/stt_server.log`), `_SERVER_WATCHDOG_MS` (120000). Auto-sets `PULSE_SERVER=unix:/mnt/wslg/PulseServer` when that socket exists. The server binds `127.0.0.1` and answers CORS only for local origins; optional `OPENCODE_VOICE_TOKEN` protects every endpoint except `/health`.
- **Doctor**: `doctor.sh` (also `/voice doctor [--fix]`) checks server/port/health, the CORS preflight for `X-Voice-Source`/`X-Voice-Token`, a stuck recording, a mic probe (delivery ratio) and log freshness; `--fix` restarts the server via the watchdog, clears `/record/*`, and runs `fix-mic.sh`.

## Commands (`/voice`)

- `/voice` - Records from the mic until you stop speaking (~1.5 s of silence, hard cap 60 s), transcribes it, and inserts the text into the prompt (the recognized text is also set as the command output so no empty request is sent). Every recognized text is appended to `OPENCODE_VOICE_RECOGNIZED_LOG` (default `/tmp/opencode/voice-recognized.log`) with its source: `source=command` for `/voice`, `source=button` for extension uploads (`X-Voice-Source` header), plus backend/model/language/duration. Short beeps play on start/stop (`beep()` in `src/lib/beep.ts`, aplay/paplay/ffplay). The hook blocks for the whole recording (OpenCode always calls the model after `command.execute.before`, so a non-blocking start would send an empty prompt or, if it throws, log an error) — hence no live on-screen timer. On failure the hook throws to avoid the empty prompt. Service markers (`[музыка]`, `(смех)`, `♪`) are stripped (`stripNonSpeech` in `src/lib/stt.ts`, `_strip_non_speech` in `stt_server.py`). Audio below the silence thresholds (`OPENCODE_VOICE_SILENCE_PEAK`/`OPENCODE_VOICE_SILENCE_RMS`, via `isSilentWav`/`_is_silent`) is rejected as "no speech" before Whisper; whisper.cpp runs with `-mc 0 -sns` to reduce hallucinations.
- `/voice <file.wav>` - Transcribe a local audio file.
- `/voice backend [local|api]` - View/switch STT backend.
- `/voice lang [ru|en|auto]` - View/change recognition language.
- `/voice device [auto|gpu|cpu]` - View/change local device (GPU whisper.cpp / CPU faster-whisper).
- `/voice doctor [--fix]` - Runs `doctor.sh` (server process/port/health, CORS for `X-Voice-Source`, stuck recording, mic probe with delivery ratio, log freshness) and shows the tail in the prompt. `--fix` also repairs: restarts the server via the watchdog, clears a stuck recording (`POST /record/stop`), runs `fix-mic.sh`. Use it when the extension button shows `Failed to fetch` / 401 / 409.

## Skill routing

Load the matching skill (tool `skill`) **before** working on an area. Skills live in `.opencode/skills/` and are versioned (the rest of `.opencode/` is generated and git-ignored); OpenCode discovers them via `skills.paths` in the global config, so a restart is needed after adding one. How to add/register/diagnose skills: [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md).

| Task / area | Skill |
| --- | --- |
| Product overview, "what is this / which component" | `ovi-overview` |
| Plugin internals: `src/index.ts`, `/voice` subcommands, recorder | `ovi-plugin` |
| STT HTTP server: `stt_server.py`, endpoints, token, CORS, autostart, logs | `ovi-server` |
| Extension / 🎤 button, popup token, sounds, versions | `ovi-extension` |
| Models, GPU/CUDA, quality/speed tuning | `ovi-models` |
| Microphone / audio path: silence, audin, formats, auto-stop, `fix-mic.sh` | `ovi-audio` |
| Security & privacy: token, CORS, bind, retention, secrets hygiene | `ovi-security` |
| "It does not work": Failed to fetch, silence, 401/409, slow channel, mic repair | `ovi-debug` |
| Build/test/commit/release/docs (`AGENTS.md`, README, AUDIT, TEST_PLAN) | `ovi-dev` |

## Development & Testing

- **Env required**: `OPENCODE_VOICE_BACKEND` (`local`/`api`), `OPENAI_API_KEY` (if `api`), `OPENCODE_VOICE_LANGUAGE` (default `ru`). See `src/lib/config.ts`.
- **Server security**: `stt_server.py` binds `127.0.0.1` by default (`OPENCODE_VOICE_HOST` overrides) and answers CORS only for local origins; no auth. `faster_whisper` is imported lazily, so the server runs in whisper.cpp/GPU mode without it.

- **Plugin loader quirk**: `src/index.ts` uses dynamic `import()` for config/STT/recorder. Do NOT add top-level non-function exports; `getLegacyPlugins` throws.
- **Hook trick**: `command.execute.before` suppresses the markdown command template via `setParts()` (clears `output.parts`, pushes one text part). OpenCode always calls the model afterwards, so parts are never empty: PTT/file success carries the transcript, info subcommands (`backend`/`lang`/`device`/`help`) carry a service text `svc(...)` saying no answer is needed, and failure paths throw so no request is sent (OpenCode logs it as an error — known SDK limitation). An empty parts array triggers an API error.
- **Dev Script**: `npm run dev` (`opencode --plugin .`). No build script; TypeScript runs via plugin loader.
- **Sync check**: `bash sync-plugin.sh --check` (add `--check` in CI) verifies `.opencode/plugins/index.ts` matches `src/index.ts` — the global OpenCode config loads the synced copy, so both must stay in sync.
- **TUI/web plugins**: `.opencode/tui/voice.ts` (keybind `<leader>v` → `/voice`) and `.opencode/web/voice.tsx` (optional 🎤 button in the prompt; not wired by default — add it to your TUI config's `plugin` list). JSX must live in `.tsx`.
- **Testing**: hermetic `pytest` (`stt-server/tests/`, 30 tests, no mic/model: `pip install -r stt-server/requirements-dev.txt && pytest`), `npm run typecheck`, `bash sync-plugin.sh --check`; CI in `.github/workflows/ci.yml`. Plus live `/voice` checks through the TUI. Push-to-talk requires a real mic/PulseAudio.
- **Logs**: `/tmp/opencode/stt_server.log` (server startup + every transcription), `voice-recognized.log` (source-tagged transcripts written by `logRecognized`/`_log_recognized`), `voice-stt.log` (plugin backend + audio levels), `voice-requests.log` (button HTTP calls), `/dev/shm/opencode-voice/` (recordings, RAM, auto-deleted).
- **WSL2 / Microphone (verified)**: `/dev/snd` отсутствует в WSL2 по дизайну (`no soundcards found`). Рабочий путь — `PulseAudio` (`PULSE_SERVER=/mnt/wslg/PulseServer`). Для контейнера: `libasound2-plugins alsa-utils`, mount `/mnt/wslg/`, переменная `PULSE_SERVER`. USB-микрофон возможен (`usbipd-win`), но требует ядро с `snd-usb-audio`. Не проверять `/proc/asound/cards` — в WSL2 пуст. См. `.opencode/skills/ovi-models/SKILL.md`.
- **Subagents**: `voice-builder`, `voice-stt` (configured in `opencode.json`).
- **Skills**: `ovi-overview`, `ovi-plugin`, `ovi-server`, `ovi-extension`, `ovi-models`, `ovi-debug`, `ovi-dev` — in `.opencode/skills/` (**versioned**; the rest of `.opencode/` is git-ignored). Names must match `^[a-z0-9]+(-[a-z0-9]+)*$` (no underscores), and `name:` must equal the folder name. Discovery happens at OpenCode startup via `skills.paths` in the global config.
