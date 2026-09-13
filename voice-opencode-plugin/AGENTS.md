# OpenCode Voice Plugin

Voice control plugin for OpenCode supporting local (Whisper.cpp/Vosk/Python) and cloud (OpenAI Whisper API) backends, push-to-talk recording, and audio file transcription.

## Architecture & Entrypoints

- **Plugin Entrypoint**: `src/index.ts` (also linked to `.opencode/plugins/index.ts` for local loading via `opencode.json`).
- **Configuration & Env**: `src/lib/config.ts` (`OPENCODE_VOICE_BACKEND`, `OPENAI_API_KEY`, `OPENCODE_VOICE_LANGUAGE`, etc.).
- **STT Transcription**: `src/lib/stt.ts` (`openai` SDK for `api` backend; `faster-whisper` model required for `local`; CLI fallbacks `whisper.cpp`/`vosk`).
- **Audio Recording**: `src/lib/recorder.ts` (`ffmpeg`/`arecord`/`sox`/`sounddevice` for push-to-talk). Needs `OPENAI_API_KEY` for cloud, or `ffmpeg` + faster-whisper model + ALSA mic for local.

## Commands (`/voice`)

- `/voice` - Push-to-talk recording & transcription into active prompt.
- `/voice <file.wav>` - Transcribe a local audio file.
- `/voice backend [local|api]` - View/switch STT backend.
- `/voice lang [ru|en|auto]` - View/change recognition language.

## Development & Testing

- **Env required**: `OPENCODE_VOICE_BACKEND` (`local`/`api`), `OPENAI_API_KEY` (if `api`), `OPENCODE_VOICE_LANGUAGE` (default `ru`). See `src/lib/config.ts`.

- **Plugin loader quirk**: `src/index.ts` uses dynamic `import()` for config/STT/recorder (line 22). Do NOT add top-level non-function exports; `getLegacyPlugins` throws.
- **Hook trick**: `command.execute.before` suppresses the markdown command template by setting `output.parts.length = 0` and pushing `{type:"text",text:""}` (line 64-65). Without this, `UnknownError` occurs from an empty array; without the push, the prompt is invalid.
- **Dev Script**: `npm run dev` (`opencode --plugin .`). No build script; TypeScript runs via plugin loader.
- **Testing**: No automated test suite. Verify via `opencode.json` plugin path + `/voice backend/lang` through the TUI/HTTP API. Push-to-talk requires a real `/dev/snd` device (untested in sandbox).
- **WSL2 / Microphone (verified)**: `/dev/snd` отсутствует в WSL2 по дизайну (`no soundcards found`). Рабочий путь — `PulseAudio` (`PULSE_SERVER=/mnt/wslg/PulseServer`). Для контейнера: `libasound2-plugins alsa-utils`, mount `/mnt/wslg/`, переменная `PULSE_SERVER`. USB-микрофон возможен (`usbipd-win`), но требует ядро с `snd-usb-audio`. Не проверять `/proc/asound/cards` — в WSL2 пуст. См. `.opencode/skills/voice-stt/SKILL.md`.
- **Subagents**: `voice-builder`, `voice-stt` (configured in `opencode.json`).
- **Skills**: `voice-debug`, `voice-stt`.
