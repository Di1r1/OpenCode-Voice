# OpenCode Voice Plugin

Voice control plugin for OpenCode supporting local (Whisper.cpp/Vosk/Python) and cloud (OpenAI Whisper API) backends, push-to-talk recording, and audio file transcription.

## Architecture & Entrypoints

- **Plugin Entrypoint**: `src/index.ts` (also linked to `.opencode/plugins/index.ts` for local loading via `opencode.json`).
- **Configuration & Env**: `src/lib/config.ts` (`OPENCODE_VOICE_BACKEND`, `OPENAI_API_KEY`, `OPENCODE_VOICE_LANGUAGE`, etc.).
- **STT Transcription**: `src/lib/stt.ts` (`openai` SDK for API backend, local CLI tools/scripts for local backend).
- **Audio Recording**: `src/lib/recorder.ts` (`ffmpeg`, `arecord`, `sox`, or Python `sounddevice`).

## Commands (`/voice`)

- `/voice` - Push-to-talk recording & transcription into active prompt.
- `/voice <file.wav>` - Transcribe a local audio file.
- `/voice backend [local|api]` - View/switch STT backend.
- `/voice lang [ru|en|auto]` - View/change recognition language.

## Development & Testing

- **Dev Script**: `npm run dev` (`opencode --plugin .`).
- **Subagents**: `voice-builder`, `voice-stt` (configured in `opencode.json`).
- **Skills**: `voice-debug`, `voice-stt`.
