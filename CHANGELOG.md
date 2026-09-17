# Changelog

All notable changes to OpenCode Voice are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version in code: `PLUGIN_VERSION` (`voice-opencode-plugin/src/lib/config.ts`), `SERVER_VERSION`
(`voice-opencode-plugin/stt-server/stt_server.py`), `package.json` and `/health` (field `version`).
The Chrome extension is versioned independently (`voice-opencode-plugin/extension/manifest.json`).

## [0.3.1] - 2026-09-17

### Fixed
- **Extension: `Failed to fetch` on Windows.** `popup.js` used a hardcoded `http://localhost:8765`
  and `content.js` derived the host from the page URL. On Windows `localhost` often resolves to
  IPv6 `::1` while the STT server listens on `127.0.0.1` only, so the request died before reaching
  the server (nothing in the server log). The local case now always uses `127.0.0.1`; LAN/IP hosts
  are still taken from the page. Extension `1.0.10`.

### Added
- **Portable whisper/CUDA discovery** (`src/lib/whisper.ts`, mirrored in `stt_server.py`): no hardcoded
  toolkit version or paths. Base dir `OPENCODE_VOICE_HOME` (default `~/.local/share/opencode-voice`),
  CLI/model auto-detected in `OPENCODE_VOICE_WHISPER_DIR`, CUDA directories discovered via `cuda-*`
  globs plus `CUDA_HOME`/`CUDA_PATH`.
- **Adaptive model size:** `WHISPER_MODEL`/`WHISPER_CPP_MODEL_SIZE` override the default, which is
  now `medium` on GPU and `small` on CPU (previously always `medium`).
- `OPENCODE_VOICE_MAX_RECORD_SECONDS` (default `300`) — configurable hard cap for `/voice`
  recordings; recording still stops on silence (~1.5 s), the cap only bounds long monologues.
- This `CHANGELOG.md`.

## [0.3.0] - 2026-09-17

Production-hardening batch (code still reported `0.2.0` until now).

### Added
- **Server overload protection:** upload size limit (`OPENCODE_VOICE_MAX_UPLOAD_MB`, 413), audio
  duration limit (`OPENCODE_VOICE_MAX_AUDIO_SECONDS`, 400), single-transcription semaphore
  (`OPENCODE_VOICE_MAX_CONCURRENT` → 429/504), per-IP token-bucket rate limit
  (`OPENCODE_VOICE_RATE_LIMIT`, 429 + `Retry-After`), `Origin` guard for non-GET requests (403) and a
  periodic RAM purge thread (`OPENCODE_VOICE_PURGE_INTERVAL`).
- **TypeScript tests** for `stripNonSpeech` (12 cases, `node:test`) with a new `npm test` script and
  a CI step; text helpers extracted to `src/lib/text.ts`.
- **Silence gate** (`OPENCODE_VOICE_SILENCE_PEAK`/`_RMS`) and whisper.cpp anti-hallucination flags
  (`-mc 0 -sns`) so Whisper is not run on silence.
- **`/voice` auto-stop by silence** with graceful `SIGINT`: the recorder now stops ~1.5 s after speech
  ends (hard cap 60 s of audio) and the WAV header is always finalized — the old `SIGKILL` truncated
  long recordings and left a stale header.
- **Unified recognized-text log** `/tmp/opencode/voice-recognized.log` with `source=command|button`,
  backend, model, language and duration.
- **Optional access token** (`OPENCODE_VOICE_TOKEN`) with `X-Voice-Token`/`Bearer`, plus startup
  runtime checks; `/health` now reports `version`, `python` and `auth`.
- **`doctor.sh`** and **`/voice doctor [--fix]`** — one-shot diagnostics (port/health/CORS, stuck
  recording, microphone probe with delivery ratio and levels) and safe auto-repair.
- **Agent skills:** nine versioned `ovi-*` skills with a routing table and `SKILLS_GUIDE.md`.
- Server auto-start now logs to a file (`/tmp/opencode/stt_server.log`) instead of `/dev/null`.
- Material icons and npm metadata; version reporting in `/health`, `/voice help` and the popup.

### Changed
- `/voice` and info subcommands no longer send an empty model prompt (failures abort the command).
- Full documentation refresh (EN/RU): installation for Linux + WSL2, configuration, logs,
  troubleshooting, structure.
- `.opencode/` runtime artifacts are generated locally and kept out of git (skills are versioned);
  the deprecated Tampermonkey userscript was removed.

### Security
- Server binds `127.0.0.1` by default, CORS allowlist (localhost/RFC1918 + `chrome-extension://`),
  lazy `faster-whisper` import, pinned requirements and a green CI (`pytest` + `tsc`).

## [0.2.0] - 2026-09-17

### Added
- **GPU acceleration:** whisper.cpp with CUDA (`OPENCODE_VOICE_DEVICE=auto|gpu|cpu`) and
  faster-whisper fallback; `/voice` also uses the GPU when available.
- **Server auto-start + watchdog:** the plugin starts `stt_server.py` on load and restarts it if it
  dies (`OPENCODE_VOICE_SERVER`, `OPENCODE_VOICE_SERVER_WATCHDOG_MS`).
- **Microphone auto-recovery** for the WSLg audio channel and `fix-mic.sh`.
- Beeps on record start/stop/finish (plugin and extension) with a mute toggle in the popup.
- Recording to RAM (`/dev/shm/opencode-voice`) with retention (`OPENCODE_VOICE_RETAIN_SECONDS`).
- Pinned PulseAudio mic source (`OPENCODE_VOICE_SOURCE`) so system sound is not recorded.

### Fixed
- Stuck recording (`409 already recording`) and the "silent audio source" hang.
- whisper.cpp could not decode browser WebM/Opus uploads (ffmpeg conversion added).

## [0.1.0] - 2026-09-16

### Added
- **STT HTTP server** (`/transcribe`, `/record/*`, `/health`) with record watchdog and language
  detection.
- **Chrome extension** (🎤 button in the web UI) uploading audio to the server.
- Bilingual README (English + Russian).

### Fixed
- Microphone auto-recovery and backend fall-through in the recorder.

## [0.0.2] - 2026-09-15

### Added
- TUI hotkey `<leader>v` → runs `/voice` (push-to-talk).

### Fixed
- Plugin loader compatibility (`getLegacyPlugins`), recorder absolute paths, `/voice` hook response.

## [0.0.1] - 2026-09-12

### Added
- First working prototype: OpenCode plugin with `/voice` and speech-to-text backends
  (faster-whisper / whisper.cpp / vosk / OpenAI Whisper API).

[0.3.1]: https://github.com/Di1r1/OpenCode-Voice/compare/0.3.0...0.3.1
[0.3.0]: https://github.com/Di1r1/OpenCode-Voice/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/Di1r1/OpenCode-Voice/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/Di1r1/OpenCode-Voice/compare/0.0.2...0.1.0
[0.0.2]: https://github.com/Di1r1/OpenCode-Voice/compare/0.0.1...0.0.2
[0.0.1]: https://github.com/Di1r1/OpenCode-Voice/releases/tag/0.0.1
