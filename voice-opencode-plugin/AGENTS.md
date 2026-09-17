# OpenCode Voice Plugin

Voice control plugin for OpenCode supporting local (Whisper.cpp/Vosk/Python) and cloud (OpenAI Whisper API) backends, push-to-talk recording, and audio file transcription.

## Architecture & Entrypoints

- **Plugin Entrypoint**: `src/index.ts` (also linked to `.opencode/plugins/index.ts` for local loading via `opencode.json`).
- **Configuration & Env**: `src/lib/config.ts` (`OPENCODE_VOICE_BACKEND`, `OPENAI_API_KEY`, `OPENCODE_VOICE_LANGUAGE`, etc.). Mic auto-recovery on empty recordings: `OPENCODE_VOICE_AUTO_RECOVER` (default `1`), `WSL_EXE`, `OPENCODE_VOICE_RECOVER_WAIT_WESTON`/`_PULSE` (see `recoverMic` in `src/lib/recorder.ts`).
- **STT Transcription**: `src/lib/stt.ts` (`openai` SDK for `api` backend; `faster-whisper`/whisper.cpp for `local`). Default model: `medium` (`ggml-medium.bin` for whisper.cpp, `faster-whisper` medium on CPU). Device selection via `OPENCODE_VOICE_DEVICE` (`auto`|`gpu`|`cpu`) or `/voice device`: `auto` uses whisper.cpp+CUDA when `libcuda` is present, otherwise falls back to `faster-whisper` on CPU. `OPENCODE_VOICE_STT_BACKEND=whispercpp|faster-whisper` is kept as an alias.
- **Audio Recording**: `src/lib/recorder.ts` (`startPushToTalk`/`waitPushToTalkEnd`/`stopPushToTalk`/`pttFileSize`; arecord/ffmpeg, mono 16 kHz S16_LE). `/voice` records a fixed 30 s window: start the recorder, wait for it to finish, then transcribe. Recordings go to RAM (`/dev/shm/opencode-voice`, tmpfs) and are auto-deleted after `OPENCODE_VOICE_RETAIN_SECONDS` (default 300 s).

## Commands (`/voice`)

- `/voice` - Records 30 seconds from the mic, transcribes it, and inserts the text into the prompt (the recognized text is also set as the command output so no empty request is sent). Short beeps play on start/stop (`beep()` in `src/lib/beep.ts`, aplay/paplay/ffplay). The hook blocks for the whole recording (OpenCode always calls the model after `command.execute.before`, so a non-blocking start would send an empty prompt or, if it throws, log an error) — hence no live on-screen timer. On failure the hook throws to avoid the empty prompt. Service markers (`[музыка]`, `(смех)`, `♪`) are stripped (`stripNonSpeech` in `src/lib/stt.ts`, `_strip_non_speech` in `stt_server.py`).
- `/voice <file.wav>` - Transcribe a local audio file.
- `/voice backend [local|api]` - View/switch STT backend.
- `/voice lang [ru|en|auto]` - View/change recognition language.
- `/voice device [auto|gpu|cpu]` - View/change local device (GPU whisper.cpp / CPU faster-whisper).

## Development & Testing

- **Env required**: `OPENCODE_VOICE_BACKEND` (`local`/`api`), `OPENAI_API_KEY` (if `api`), `OPENCODE_VOICE_LANGUAGE` (default `ru`). See `src/lib/config.ts`.

- **Plugin loader quirk**: `src/index.ts` uses dynamic `import()` for config/STT/recorder (line 22). Do NOT add top-level non-function exports; `getLegacyPlugins` throws.
- **Hook trick**: `command.execute.before` suppresses the markdown command template by setting `output.parts.length = 0` and pushing `{type:"text",text:""}` (line 64-65). Without this, `UnknownError` occurs from an empty array; without the push, the prompt is invalid.
- **Dev Script**: `npm run dev` (`opencode --plugin .`). No build script; TypeScript runs via plugin loader.
- **Testing**: No automated test suite. Verify via `opencode.json` plugin path + `/voice backend/lang` through the TUI/HTTP API. Push-to-talk requires a real `/dev/snd` device (untested in sandbox).
- **WSL2 / Microphone (verified)**: `/dev/snd` отсутствует в WSL2 по дизайну (`no soundcards found`). Рабочий путь — `PulseAudio` (`PULSE_SERVER=/mnt/wslg/PulseServer`). Для контейнера: `libasound2-plugins alsa-utils`, mount `/mnt/wslg/`, переменная `PULSE_SERVER`. USB-микрофон возможен (`usbipd-win`), но требует ядро с `snd-usb-audio`. Не проверять `/proc/asound/cards` — в WSL2 пуст. См. `.opencode/skills/voice-stt/SKILL.md`.
- **Subagents**: `voice-builder`, `voice-stt` (configured in `opencode.json`).
- **Skills**: `voice-debug`, `voice-stt`.
