# OpenCode Voice Plugin

Voice control plugin for OpenCode supporting local (Whisper.cpp/Vosk/Python) and cloud (OpenAI Whisper API) backends, push-to-talk recording, and audio file transcription.

## Architecture & Entrypoints

- **Plugin Entrypoint**: `src/index.ts` (also linked to `.opencode/plugins/index.ts` for local loading via `opencode.json`).
- **Configuration & Env**: `src/lib/config.ts` (`OPENCODE_VOICE_BACKEND`, `OPENAI_API_KEY`, `OPENCODE_VOICE_LANGUAGE`, etc.). Mic auto-recovery on empty recordings: `OPENCODE_VOICE_AUTO_RECOVER` (default `1`), `WSL_EXE`, `OPENCODE_VOICE_RECOVER_WAIT_WESTON`/`_PULSE` (see `recoverMic` in `src/lib/recorder.ts`).
- **STT Transcription**: `src/lib/stt.ts` (`openai` SDK for `api` backend; `faster-whisper`/whisper.cpp for `local`). Default model: `medium` (`ggml-medium.bin` for whisper.cpp, `faster-whisper` medium on CPU). Device selection via `OPENCODE_VOICE_DEVICE` (`auto`|`gpu`|`cpu`) or `/voice device`: `auto` uses whisper.cpp+CUDA when `libcuda` is present, otherwise falls back to `faster-whisper` on CPU. `OPENCODE_VOICE_STT_BACKEND=whispercpp|faster-whisper` is kept as an alias.
- **Audio Recording**: `src/lib/recorder.ts` (`startPushToTalk`/`waitPushToTalkAuto`/`waitPushToTalkEnd`/`pttFileSize`/`recoverMic`; arecord/ffmpeg, mono 16 kHz S16_LE, pinned `OPENCODE_VOICE_SOURCE`). `/voice` records until ~1.5 s of silence after speech (hard cap 60 s of audio) and stops the recorder gracefully (SIGINT) so the WAV header is always finalized — the old SIGKILL truncated long recordings and left a stale header. Recordings go to RAM (`/dev/shm/opencode-voice`, tmpfs) and are auto-deleted after `OPENCODE_VOICE_RETAIN_SECONDS` (default 300 s).

## Commands (`/voice`)

- `/voice` - Records from the mic until you stop speaking (~1.5 s of silence, hard cap 60 s), transcribes it, and inserts the text into the prompt (the recognized text is also set as the command output so no empty request is sent). Every recognized text is appended to `OPENCODE_VOICE_RECOGNIZED_LOG` (default `/tmp/opencode/voice-recognized.log`) with its source: `source=command` for `/voice`, `source=button` for extension uploads (`X-Voice-Source` header), plus backend/model/language/duration. Short beeps play on start/stop (`beep()` in `src/lib/beep.ts`, aplay/paplay/ffplay). The hook blocks for the whole recording (OpenCode always calls the model after `command.execute.before`, so a non-blocking start would send an empty prompt or, if it throws, log an error) — hence no live on-screen timer. On failure the hook throws to avoid the empty prompt. Service markers (`[музыка]`, `(смех)`, `♪`) are stripped (`stripNonSpeech` in `src/lib/stt.ts`, `_strip_non_speech` in `stt_server.py`). Audio below the silence thresholds (`OPENCODE_VOICE_SILENCE_PEAK`/`OPENCODE_VOICE_SILENCE_RMS`, via `isSilentWav`/`_is_silent`) is rejected as "no speech" before Whisper; whisper.cpp runs with `-mc 0 -sns` to reduce hallucinations.
- `/voice <file.wav>` - Transcribe a local audio file.
- `/voice backend [local|api]` - View/switch STT backend.
- `/voice lang [ru|en|auto]` - View/change recognition language.
- `/voice device [auto|gpu|cpu]` - View/change local device (GPU whisper.cpp / CPU faster-whisper).
- `/voice doctor [--fix]` - Runs `doctor.sh` (server process/port/health, CORS for `X-Voice-Source`, stuck recording, mic probe with delivery ratio, log freshness) and shows the tail in the prompt. `--fix` also repairs: restarts the server via the watchdog, clears a stuck recording (`POST /record/stop`), runs `fix-mic.sh`. Use it when the extension button shows `Failed to fetch` / 401 / 409.

## Development & Testing

- **Env required**: `OPENCODE_VOICE_BACKEND` (`local`/`api`), `OPENAI_API_KEY` (if `api`), `OPENCODE_VOICE_LANGUAGE` (default `ru`). See `src/lib/config.ts`.
- **Server security**: `stt_server.py` binds `127.0.0.1` by default (`OPENCODE_VOICE_HOST` overrides) and answers CORS only for local origins; no auth. `faster_whisper` is imported lazily, so the server runs in whisper.cpp/GPU mode without it.

- **Plugin loader quirk**: `src/index.ts` uses dynamic `import()` for config/STT/recorder. Do NOT add top-level non-function exports; `getLegacyPlugins` throws.
- **Hook trick**: `command.execute.before` suppresses the markdown command template via `setParts()` (clears `output.parts`, pushes one text part). OpenCode always calls the model afterwards, so parts are never empty: PTT/file success carries the transcript, info subcommands (`backend`/`lang`/`device`/`help`) carry a service text `svc(...)` saying no answer is needed, and failure paths throw so no request is sent (OpenCode logs it as an error — known SDK limitation). An empty parts array triggers an API error.
- **Dev Script**: `npm run dev` (`opencode --plugin .`). No build script; TypeScript runs via plugin loader.
- **Sync check**: `bash sync-plugin.sh --check` (add `--check` in CI) verifies `.opencode/plugins/index.ts` matches `src/index.ts` — the global OpenCode config loads the synced copy, so both must stay in sync.
- **TUI/web plugins**: `.opencode/tui/voice.ts` (keybind `<leader>v` → `/voice`) and `.opencode/web/voice.tsx` (optional 🎤 button in the prompt; not wired by default — add it to your TUI config's `plugin` list). JSX must live in `.tsx`.
- **Testing**: hermetic `pytest` (`stt-server/tests/`, 30 tests, no mic/model: `pip install -r stt-server/requirements-dev.txt && pytest`), `npm run typecheck`, `bash sync-plugin.sh --check`; CI in `.github/workflows/ci.yml`. Plus live `/voice` checks through the TUI. Push-to-talk requires a real mic/PulseAudio.
- **WSL2 / Microphone (verified)**: `/dev/snd` отсутствует в WSL2 по дизайну (`no soundcards found`). Рабочий путь — `PulseAudio` (`PULSE_SERVER=/mnt/wslg/PulseServer`). Для контейнера: `libasound2-plugins alsa-utils`, mount `/mnt/wslg/`, переменная `PULSE_SERVER`. USB-микрофон возможен (`usbipd-win`), но требует ядро с `snd-usb-audio`. Не проверять `/proc/asound/cards` — в WSL2 пуст. См. `.opencode/skills/voice-stt/SKILL.md`.
- **Subagents**: `voice-builder`, `voice-stt` (configured in `opencode.json`).
- **Skills**: `voice-debug`, `voice-stt`.
