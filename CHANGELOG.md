# Changelog

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice

All notable changes to OpenCode Voice are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version in code: `PLUGIN_VERSION` (`voice-opencode-plugin/src/lib/config.ts`), `SERVER_VERSION`
(`voice-opencode-plugin/stt-server/stt_server.py`), `package.json` and `/health` (field `version`).
The Chrome extension is versioned independently (`voice-opencode-plugin/extension/manifest.json`).

## [0.4.1] - 2026-09-20

### Fixed
- **`setup.sh --model-size <size>` (space form) was dead:** the `for arg in "$@"`
  loop ignored `shift`, so only `--model-size=*` worked and the space form died
  with `exit 2`. The parser is now a `while` loop; both forms work.
- **Dead code removed:** `setup.sh ask()`, `waitPushToTalkEnd()`, unread
  `config.sttBackend/Language/Device`, `wavLevels`/`cudaAvailable` wrappers,
  `void sessionID`, always-true `CHECK_ONLY` guards, misleading `TTS_VOICE` var;
  silence thresholds are now canonical `silenceRms()`/`silencePeak()` (env +
  `shared/stt-spec.json`); non-capturing groups in the TS/Python/browser
  `IMAGE_RE`/`AUTOLINK_RE` (output parity unchanged).
- **Hermetic `/speak` tests:** the `_reset_tts` fixture now points the voices dir
  at an empty tmp dir instead of deleting the env override — real voices installed
  by `setup.sh --tts` no longer fail the suite with `400` on dev machines (`65/65`).
- **Docs symmetry (EN/RU):** READMEs now cover `setup.sh --all`, the EN voice,
  `env.sh`, the popup RU/EN switch, server chunking and the stuck-speech watchdog;
  `SKILLS_GUIDE.md` §7 and `AGENTS.md` no longer claim skills are versioned
  (they are git-ignored local-only, like agents).

## [0.4.0] - 2026-09-20

### Added
- **Text-to-speech (optional, off by default):** assistant answers can be read aloud.
  - `extension/tts.js` (content script, loaded before `content.js`) reads the final assistant
    message from the same-origin web-UI API (`/api/session`, `/session/{id}/message`; optional
    `/api/event` SSE), not by scraping the DOM. Modes `brief` (first sentences + error lines) and
    `full`, dedup by `messageID`+hash, sentence chunking, `Ctrl+C` stop only while speaking, pause
    while recording, voice picker. Gate: OpenCode UI (`prompt-input` + live `/session`).
    Extension `1.0.29`.
  - Server engine: `POST /speak` (JSON `{text,voice?,rate?,mode?}` -> `audio/wav`; the browser plays
    it) with offline Piper voices, text over stdin (no shell), a voice whitelist, an LRU WAV cache,
    a synthesis semaphore, and reuse of token/limits/CORS; `501` when disabled. Opt-in via
    `OPENCODE_VOICE_TTS=1`; install with `./setup.sh --tts`. `_play_file` extracted for TUI/fallback.
  - Shared `cleanForSpeech` canon in `src/lib/text.ts` with Python and browser mirrors
    (`shared/tts-cases.json`; cross-parity test via `node:vm`).
  - Popup: toggle, engine (browser/server), mode, language, voice, local-only, speed, debug log.
  - Tests: `pytest` 65 (+12 on `/speak`, +3 on `/voices`), `npm test` 74.

### Added
- **`setup.sh --all` (one-command install):** pip deps + TTS (Piper + voices) + plugin
  config write (backup) + `$OPENCODE_VOICE_HOME/env.sh` (`OPENCODE_VOICE_TTS=1`, Piper
  binary, voices dir — survives shell/machine restarts via `source`) + `doctor.sh`,
  no questions. GPU build only when `nvcc` is visible (explicit `--gpu`/`--cpu` win).
  The "what's next" summary now also reminds to Reload the extension + F5 the tab.
- **English TTS voice out of the box:** `setup.sh --tts` / `--all` now also download
  `en_US-lessac-medium` (override via `OPENCODE_VOICE_TTS_VOICES_EN`, e.g. `"lessac ryan"`),
  so English speakers have a server voice in the popup dropdown without extra steps.
- **Popup UI language (RU/EN):** the extension popup has an interface-language switch
  (persisted in `chrome.storage.local.uiLang`, default RU). All static labels and popup
  statuses are localized; content-script toasts stay Russian for now. Extension `1.0.34`.

### Fixed
- **Server TTS voices are now visible:** new read-only `GET /voices`
  (`{status, engine, default, voices, enabled, available}`; token-protected like the
  other endpoints) lists the installed Piper `*.onnx` voices. The popup shows them in a
  separate **server voice** dropdown (`ttsServerVoice`), so the browser voice choice is no
  longer sent to `/speak` by mistake (unknown name → `400` → silent browser fallback).
  Extension `1.0.30`.
- **Server→browser TTS fallback loop:** on any `/speak` error the fallback called the
  `speak()` router, which re-entered the server path — an infinite `/speak` request loop
  (tens of thousands of hits) that never reached browser speech. The fallback now calls
  the browser synthesizer directly. Extension `1.0.31`.
- **Stuck speech watchdog (silent TTS on a stale tab):** the `speechSynthesis` queue and
  the `AudioContext` live in the tab's renderer process — F5 keeps the process (a stuck
  queue/suspended context survives reloads; only fully closing the tab kills it), so TTS
  could go silent with no error. Each browser utterance now has a watchdog
  (`utteranceBudget`: ~14 chars/s + margin, clamped to 10–60 s): on timeout one `cancel()`
  + retry, on repeated stalls a toast telling to close the tab fully and reopen it.
  Extension `1.0.33`.
- **Server TTS on long answers (413 → silent browser voice):** `speakServer` sent the whole
  text in one `POST /speak`, so anything over `OPENCODE_VOICE_TTS_MAX_CHARS` (default 300,
  e.g. 391 chars) got `413 text too long` and fell back to Web Speech. The server engine now
  chunks like the browser one (`chunkSentences`, ≤180 chars) and plays the WAVs in sequence;
  only the remaining chunks fall back on fatal errors. Also fixed `X-Voice-Source: tts` being
  overwritten by `button` from `content.js` `authHeaders()`. Extension `1.0.32`.
- **`setup.sh --tts` installs all 4 Russian Piper voices** (`irina dmitri denis ruslan`,
  override via `OPENCODE_VOICE_TTS_VOICES`) instead of irina only — there is now something
  to pick in the popup server-voice dropdown. synthesis verified live with real Piper
  (all 4 voices → valid WAV).
- **npm packaging:** `extension/tts.js`, `shared/tts-cases.json` and `shared/strip-cases.json`
  were missing from `files` in `package.json`, so the published tarball shipped without TTS
  (30 files). Now 33 files — the browser TTS engine and the shared parity cases are included.

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
- **Auto-recovery on failure:** if `/voice` fails (silent/empty recording, transcription error, no
  speech) the plugin runs `doctor.sh --fix` once (server restart via the watchdog, stuck recording
  reset, WSLg audio channel recreated) and retries the recording once. Controlled by
  `OPENCODE_VOICE_AUTO_HEAL` (default `1`) and `OPENCODE_VOICE_AUTO_HEAL_COOLDOWN` (default 90 s).
  Manual trigger: **`/voice heal`** (aliases `fix`, `restart`).
- **"Restore server" button in the extension popup:** calls `POST /heal?restart=1` (resets a stuck
  recording, purges stale audio, restarts the server process) and then waits for `/health`.
  `/heal` is rate-limited and token-protected like the other endpoints. Extension `1.0.17`.
- **Fast server restart:** on `?restart=1` the server spawns a detached replacement (which waits for
  the port to free) instead of relying on the plugin watchdog — recovery takes ~3–5 s instead of up
  to 120 s. The plugin's `heal()` also calls its server launcher right away, and the popup keeps a
  neutral "waiting" state while polling (no red flash on transient failures).
- **Push-to-talk hotkey in the web UI:** hold the combo on the OpenCode page to record while you hold
  the keys and transcribe on release. Default **`Alt+Z`**, selectable in the popup (`Alt+Z`,
  `Ctrl+Shift+Z`, `Alt+Q`, `F9`). Also stops on releasing the modifier first (Windows/Chrome can route
  the following keyup to the browser menu), on **Escape**, on blur/hidden, and via a 120 s safety
  timeout. Extension `1.0.14` (a very short hold is stopped right after start instead of leaving a
  dangling recording).
- **Send-immediately hotkey `Alt+X` (extension `1.0.15`):** same push-to-talk, but the transcript is
  sent right away instead of only being inserted (append-and-send when the input already has text).
  Can be disabled in the popup.
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
