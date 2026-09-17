# Changelog

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice

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
- **Consistency fixes.** The recorder now reads the silence threshold from `shared/stt-spec.json`
  (`OPENCODE_VOICE_SILENCE_RMS` still wins); the server-side recording cap matches the audio limit
  (`OPENCODE_VOICE_MAX_SECONDS` default `120` -> `300`); `/health` reports `max_upload_mb`,
  `max_audio_seconds` and `rate_limit_per_min`, and the extension takes its upload limit from there
  instead of a hardcoded copy; the popup uses the host remembered by the content script (works over
  LAN/IP). Extension `1.0.11`.

### Added
- **One-command installer `setup.sh`**: checks dependencies, installs `stt-server/requirements.txt`
  (CPU path via faster-whisper), runs `sync-plugin.sh`, prints the `opencode.json`/`tui.json` lines to
  add (or patches them with `--write-config`, backup included) and runs `doctor.sh`. `--gpu` builds
  whisper.cpp with CUDA (auto-detects the toolkit and compute capability) and downloads the
  `ggml-*.bin` model into `$OPENCODE_VOICE_WHISPER_DIR`; `--check` prints the plan and changes nothing.
- **Portable whisper/CUDA discovery** (`src/lib/whisper.ts`, mirrored in `stt_server.py`): no hardcoded
  toolkit version or paths. Base dir `OPENCODE_VOICE_HOME` (default `~/.local/share/opencode-voice`),
  CLI/model auto-detected in `OPENCODE_VOICE_WHISPER_DIR`, CUDA directories discovered via `cuda-*`
  globs plus `CUDA_HOME`/`CUDA_PATH`.
- **Adaptive model size:** `WHISPER_MODEL`/`WHISPER_CPP_MODEL_SIZE` override the default, which is
  now `medium` on GPU and `small` on CPU (previously always `medium`).
- `OPENCODE_VOICE_MAX_RECORD_SECONDS` (default `300`) — configurable hard cap for `/voice`
  recordings; recording still stops on silence (~1.5 s),   the cap only bounds long monologues.
- **Single source of truth for TypeScript and Python:** `shared/stt-spec.json` (non-speech markers,
  silence thresholds, whisper.cpp extra flags, per-device model sizes) and `shared/strip-cases.json`
  (parity cases). Both `npm test` and `pytest` read them, so the two implementations can no longer
  drift; Python gained the previously missing `stripNonSpeech` tests.
- **Persisted settings:** `/voice backend|lang|device` are written to `~/.config/opencode-voice/state.json`
  (`OPENCODE_VOICE_STATE_FILE`) by `src/lib/state.ts` and survive restarts. Precedence at startup is
  env > file > defaults, and the toast warns when an env variable will override the saved choice.
- **Hermetic E2E tests** (Node `node:test`, wired into CI): `test/e2e-plugin.test.mjs` drives the real
  recorder/STT code (start → silence auto-stop → graceful SIGINT → finalized WAV → stub whisper-cli →
  recognized-text log) with a fake Bun-`$` shim and stub binaries, and `test/e2e-server.test.mjs`
  exercises the actual server over HTTP (health, CORS preflight, transcribe with `source=button`,
  Origin guard, beep) with a stub whisper-cli; the latter skips itself when Flask is unavailable.
  Test hooks: `OPENCODE_VOICE_RECORDER_BIN` (plugin) and `OPENCODE_VOICE_STALE_CLEANUP=0` (server).
- **Full npm packaging.** The package ships the plugin, the STT server, the Chrome extension, the
  installer scripts and the OpenCode runtime assets (`.opencode/{tui,web,commands}`), and the plugin
  resolves `stt-server/stt_server.py` / `doctor.sh` relative to the package, so an npm install works
  without a repo checkout. `.opencode/{tui,web,commands}` are versioned; `plugins/index.ts` (generated),
  `skills/` and `agents/` (dev material) are local-only. `npm pack` yields 29 files (~182 kB unpacked)
  with no dev/test files.
- **Workflow lint.** `voice-opencode-plugin/check-workflows.sh` plus a separate **Workflow lint**
  GitHub Actions workflow parse every workflow file on each push, so invalid YAML can no longer break
  CI startup silently (an unquoted colon in a step name once did exactly that).
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
