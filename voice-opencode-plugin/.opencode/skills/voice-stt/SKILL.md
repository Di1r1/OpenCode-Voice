---
name: voice-stt
description: Guide for using and configuring the opencode-voice plugin (speech-to-text backends, recording, and command syntax)
license: MIT
compatibility: opencode
metadata:
  audience: users
  workflow: voice-control
---
# Voice STT Skill

Use this skill when the user wants to configure, use, or troubleshoot the `opencode-voice` plugin.

## Commands

- `/voice` — push-to-talk: record from microphone, transcribe, insert text into prompt.
- `/voice <file.wav|mp3|m4a|ogg|flac>` — transcribe a local audio file and insert text.
- `/voice backend [local|api]` — show or switch the STT backend.
- `/voice lang [ru|en|auto]` — show or set the recognition language.

## Backends

- **api** (default): OpenAI Whisper API. Requires `OPENAI_API_KEY`. Model configurable via `OPENCODE_VOICE_MODEL` (default `whisper-1`).
- **local**: tries `whisper-cli`/`main`/`whisper`, then Python `openai-whisper`, then `vosk`. Set `WHISPER_MODEL_PATH` / `VOSK_MODEL_PATH` as needed.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENCODE_VOICE_BACKEND` | `local` or `api` | `api` |
| `OPENCODE_VOICE_LANGUAGE` | `ru`, `en`, `auto` | `ru` |
| `OPENAI_API_KEY` | OpenAI API key (api backend) | — |
| `OPENCODE_VOICE_MODEL` | Whisper model id | `whisper-1` |
| `OPENCODE_VOICE_SAMPLE_RATE` | Mic sample rate | `16000` |
| `OPENCODE_VOICE_CHANNELS` | Mic channels | `1` |
| `OPENCODE_VOICE_PTT_KEY` | Push-to-talk keybind | `ctrl+shift+v` |

## Troubleshooting

- If `/voice` hangs on recording: ensure `ffmpeg`, `arecord`, `sox`, or Python `sounddevice` is installed.
- If the api backend fails: verify `OPENAI_API_KEY` is set and the account has Whisper access.
- If local backend fails: install one of whisper.cpp, `openai-whisper`, or `vosk`.