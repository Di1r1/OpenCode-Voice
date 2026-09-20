# OpenCode Voice

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice

Voice input for [OpenCode](https://opencode.ai): speak, and your words land in the prompt. Works locally (`faster-whisper` on CPU, `whisper.cpp` on GPU) or in the cloud (OpenAI Whisper API), with push-to-talk in the TUI, a 🎤 button in the web UI, and a built-in `doctor` for diagnostics.

**English** | [Русский](README.ru.md)

Release history: [CHANGELOG.md](CHANGELOG.md).

## Components

| Part | What it does |
|------|--------------|
| `voice-opencode-plugin/src/` | OpenCode plugin (TypeScript): the `/voice` command, push-to-talk recording, STT backends, server autostart |
| `voice-opencode-plugin/stt-server/` | Flask + faster-whisper / whisper.cpp: HTTP API, server-side recording via PulseAudio, transcription |
| `voice-opencode-plugin/extension/` | Chrome extension (MV3): the 🎤 button in the web UI (browser recording → server) |
| `voice-opencode-plugin/doctor.sh` | Diagnostics and repair for the button/extension path (server, CORS, stuck recording, microphone) |
| `voice-opencode-plugin/fix-mic.sh` | Recreates the WSLg audio channel when the microphone dies (WSL2) |
| `voice-opencode-plugin/sync-plugin.sh` | Generates the local plugin/TUI entry points that OpenCode loads |
| `voice-opencode-plugin/setup.sh` | One-command install: checks deps, server packages, optional GPU build, entry points, config hints |

## Requirements

- **Linux desktop**, or **Windows 10/11 + WSL2 with WSLg** (audio is delivered through WSLg PulseAudio in WSL2).
- **Node.js 22+ and npm** — for the plugin (and for `npm ci` / typecheck).
- **Python 3.9+** — for the STT server.
- System packages: `alsa-utils` (`arecord`), `libasound2-plugins`, `ffmpeg`, `libnotify` (optional).
- **Chrome/Chromium** — for the 🎤 button in the web UI (the TUI works without it).
- Optional: an NVIDIA GPU with a WSL-capable driver, for `whisper.cpp` + CUDA.

> **Generated vs versioned in `.opencode/`.** `sync-plugin.sh` generates `voice-opencode-plugin/.opencode/plugins/index.ts` (a copy of `src/index.ts` with rewritten imports) — that file is git-ignored, so run the sync step after every clone and after editing `src/index.ts`. Versioned runtime assets: `.opencode/tui/`, `.opencode/web/`, `.opencode/commands/`. `.opencode/agents/` and `.opencode/skills/` are optional local dev material — neither committed nor published.

## Installation

### 0. Quick start

```bash
git clone https://github.com/Di1r1/OpenCode-Voice.git
cd OpenCode-Voice/voice-opencode-plugin

# one command: checks, deps, plugin entry points, config hints, doctor
./setup.sh                  # CPU: faster-whisper (model downloads on first run)
./setup.sh --all            # everything at once: deps, TTS, config write, env file, doctor
./setup.sh --gpu            # optional: build whisper.cpp with CUDA + fetch a ggml model
```

`setup.sh` checks the environment, installs `stt-server/requirements.txt`, runs `sync-plugin.sh`, then prints the exact `~/.config/opencode/opencode.json` and `tui.json` lines to add (use `--write-config` to patch them with a backup; `--check` prints the plan and changes nothing; `--all` does everything at once and writes `$OPENCODE_VOICE_HOME/env.sh`).

Manual equivalent:

```bash
# 1. server deps (CPU backend)
pip install --no-input -r stt-server/requirements.txt

# 2. plugin deps + local entry points
npm install
bash sync-plugin.sh
```

Then register the plugin in your OpenCode config (step 3 below), and start it:

```bash
opencode web --hostname 0.0.0.0
```

The plugin auto-starts the STT server on load and keeps it alive with a watchdog — a separate `python3 stt_server.py` is only needed for manual runs. Verify with `/voice doctor` (see step 5).

### 1. Audio

**Linux desktop** (no extra setup — PulseAudio/ALSA is used directly). Find your microphone source name:

```bash
pactl list short sources        # e.g. alsa_input.pci-0000_00_1f.3.analog-stereo
export OPENCODE_VOICE_SOURCE=$(pactl get-default-source)   # pin it (see Configuration)
arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav && ls -la /tmp/t.wav
```

**WSL2:**

```bash
sudo apt-get update
sudo apt-get install -y alsa-utils libasound2-plugins ffmpeg
export PULSE_SERVER=unix:/mnt/wslg/PulseServer

# check (must write ~500 KB, not a 44-byte stub)
pactl info
arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav && ls -la /tmp/t.wav
```

There is no `/dev/snd` in WSL2 — that is expected; the microphone is reachable only through `PULSE_SERVER=unix:/mnt/wslg/PulseServer`. Recordings are written to RAM (`/dev/shm/opencode-voice`, tmpfs).

### 2. STT server

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input -r requirements.txt      # flask + faster-whisper (CPU backend)

export PULSE_SERVER=unix:/mnt/wslg/PulseServer   # WSL2 only
python3 stt_server.py --model medium --port 8765
```

- Binds `127.0.0.1` by default; check with `curl -s 127.0.0.1:8765/health`.
- Starts without `faster-whisper` when the GPU (`whisper.cpp`) backend is used — the CPU package is imported lazily.
- Models: `tiny` / `base` / `small` / `medium` (default) / `large`.
- On startup it prints runtime checks (Python, CUDA driver, recorder, whisper.cpp CLI/model, `PULSE_SERVER`).
- Microphone-free smoke test: `OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765`.

### 3. OpenCode plugin

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh        # generates .opencode/plugins/index.ts
npm run typecheck
```

Alternatively, install the package from npm — it bundles the plugin, the STT server, the extension and the installer scripts:

```bash
npm install @di1r1/opencode-voice
```

and reference it by name (no `sync-plugin.sh` needed; the plugin locates `stt-server/stt_server.py` inside the package automatically):

```jsonc
"plugin": ["@di1r1/opencode-voice"]
```

A tarball built with `npm pack` has the same layout.

Then point OpenCode at the generated entry point. The plugin and the TUI hotkey are registered as **file URLs** in the OpenCode config (this is exactly how it is wired in a working setup):

```jsonc
// ~/.config/opencode/opencode.json   (global)  — or ./opencode.json (project)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // ... your other plugins ...
    "file:///ABS/PATH/voice-opencode-plugin/.opencode/plugins/index.ts"
  ]
}
```

```jsonc
// ~/.config/opencode/tui.json   (global) — optional: enables the <leader>v hotkey
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///ABS/PATH/voice-opencode-plugin/.opencode/tui/voice.ts"]
}
```

Replace `/ABS/PATH` with the absolute path to the cloned repo (e.g. `/home/you/OpenCode-Voice`). Then restart OpenCode — config and plugins are loaded once at startup.

### 4. Chrome extension (🎤 button)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select the `voice-opencode-plugin/extension` folder.
3. Open the OpenCode web UI — the 🎤 button appears next to the input field.
4. Optional: **hold `Alt+Z`** on the OpenCode page for push-to-talk — recording runs while you hold the keys, release to stop and transcribe (works only on the OpenCode page). The combo is configurable in the extension popup (`Alt+Z`, `Ctrl+Shift+Z`, `Alt+Q`, `F9`); press the modifier first, then the key, and release in any order (Escape cancels). **Hold `Alt+X`** does the same but sends the request immediately (bypassing the input box; append-and-send if the field already has text) — can be turned off in the popup.

The extension talks to the STT server at `http(s)://<host>:8765` (`STT_PORT` in `extension/content.js`). `extension/manifest.json` lists `localhost`/`127.0.0.1`; add your host to `host_permissions` if it differs. Optional settings in the popup: **access token**, **sound beeps**, hotkey, auto-send, and a **🔧 Restore server** button (`POST /heal?restart=1` — resets a stuck recording, purges stale audio, restarts the process; the server respawns itself in ~3–5 s and the popup waits for `/health` showing a neutral waiting state).

### 5. Verify

```bash
# full check of the button/extension path (server, CORS, stuck recording, mic)
bash voice-opencode-plugin/doctor.sh          # add --fix to auto-repair
# or from the TUI:
/voice doctor --fix

# server health (includes "version", "backend", "device", "auth")
curl -s 127.0.0.1:8765/health

# tests (no microphone/model needed)
cd voice-opencode-plugin
pip install --no-input -r stt-server/requirements-dev.txt
python3 -m pytest          # 62 server tests (incl. /speak)
npm test                   # 74 tests (stripNonSpeech/cleanForSpeech, whisper paths, state, E2E: plugin pipeline + server over HTTP)
npm run typecheck
bash sync-plugin.sh --check
bash check-workflows.sh    # validate .github/workflows/*.yml (needs PyYAML)
```

### Optional: GPU acceleration (NVIDIA + CUDA)

By default the server runs `faster-whisper` on CPU. With an NVIDIA GPU exposed to WSL2 (or a Linux host) you can run `whisper.cpp` with CUDA instead (verified on a GTX 950M / Maxwell, CC 5.0).

1. Update the NVIDIA driver to a WSL-capable branch (R470+). After a reboot `/usr/lib/wsl/lib/libcuda.so.1` should exist.
2. Install the CUDA toolkit into your home directory (no root). Use a toolkit that still supports your GPU — CUDA 13 dropped Maxwell/Pascal, so use 12.6 for those:

```bash
sh cuda_12.6.0_560.28.03_linux.run --silent --toolkit --toolkitpath=$HOME/cuda-12.6 \
  --no-opengl-libs --no-man-page --override
```

3. Build whisper.cpp with CUDA (`<cc>` = compute capability: `50` Maxwell, `61` Pascal, `75` Turing, `86` Ampere):

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=<cc> -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DCUDAToolkit_ROOT=$HOME/cuda-12.6 \
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
  -DCMAKE_EXE_LINKER_FLAGS="-L$HOME/cuda-12.6/lib64 -Wl,--copy-dt-needed-entries"
cmake --build build -j4 --target whisper-cli
```

4. Install the CLI + model where the plugin/server look for them:

```bash
DEST=$HOME/.local/share/opencode-voice/whisper
mkdir -p $DEST/bin
cp build/bin/whisper-cli build/bin/*.so* $DEST/bin/
cp models/ggml-medium.bin $DEST/
```

The server and the `/voice` command auto-detect the CLI (`/health` then shows `"backend":"whispercpp"`, `"device":"cuda"`). If there is no GPU (no `libcuda`), both fall back to `faster-whisper` on CPU. Force a device with `/voice device cpu|gpu|auto` or `OPENCODE_VOICE_DEVICE`; the legacy alias `OPENCODE_VOICE_STT_BACKEND=faster-whisper` also works.

## Text-to-speech (optional, off by default)

OpenCode Voice can read assistant answers aloud. It is strictly additive: with the toggle off (the
default) nothing changes.

Two engines:

- **Browser** (default) — the Web Speech API; no server or model needed. With "local only" on, only
  voices where `localService === true` are used; remote voices may send the text to the browser vendor.
- **Server** — `POST /speak` on the local STT server returns a WAV that the browser plays, using
  offline [Piper](https://github.com/rhasspy/piper) voices. Enable with `OPENCODE_VOICE_TTS=1`.

Install the server engine (Piper + Russian and English voices) into `$OPENCODE_VOICE_HOME/tts`:

```bash
./setup.sh --tts           # downloads piper + all 4 RU voices (~260 MB) + EN voice lessac (~60 MB)
export OPENCODE_VOICE_TTS=1
# OPENCODE_VOICE_TTS_BIN=$HOME/.local/share/opencode-voice/tts/piper/piper
# OPENCODE_VOICE_TTS_VOICES_DIR=$HOME/.local/share/opencode-voice/tts/voices
# ...or source the persisted file written by setup.sh: source $HOME/.local/share/opencode-voice/env.sh
```

> **Persistence:** the server reads `OPENCODE_VOICE_TTS` once at startup. Export it in the
> environment OpenCode itself starts from (e.g. `~/.bashrc`) and restart the server —
> neither the popup "heal" button nor the watchdog can enable it on a running process
> (they respawn with the old environment).

Then open the extension popup, turn on **🔊 Voice assistant answers** and pick the engine
(**Browser**/**Server**), mode (**brief** — first sentences plus any error lines / **full**),
language, browser voice, server voice (Piper catalog from `GET /voices`) and speed. The popup UI itself
switches RU/EN (top selector, key `uiLang`). Settings live in `chrome.storage.local` (keys `tts`, `ttsEngine`,
`ttsMode`, `ttsLang`, `ttsVoice`, `ttsServerVoice`, `ttsRate`, `ttsLocalOnly`) and apply without a reload. `Ctrl+C`
stops speech only while it is speaking; starting a recording pauses it.

The text comes from the same-origin web-UI API (`/api/session`, `/session/{id}/message`), not from
DOM scraping. Long answers are chunked (≤180 chars) so the server `maxChars` limit never triggers a
fallback; a stuck browser utterance is retried once, then a toast tells you to fully close and reopen
the tab (a stale renderer survives F5). The server route reuses the usual token/limits/CORS, keeps an LRU WAV cache and
returns `501` when disabled — the extension then falls back to the browser voice. Synthesis log:
`/tmp/opencode/voice-tts.log`.

## Usage

### `/voice` commands

| Command | Action |
|---------|--------|
| `/voice` | Push-to-talk: records until ~1.5 s of silence (hard cap `OPENCODE_VOICE_MAX_RECORD_SECONDS`, default 300 s), transcribes, inserts the text into the prompt |
| `/voice <file.wav>` | Transcribe a local audio file (`wav`/`mp3`/`m4a`/`ogg`/`flac`) |
| `/voice backend [local\|api]` | Show/switch the STT backend |
| `/voice lang [ru\|en\|auto]` | Show/switch the language |
| `/voice device [auto\|gpu\|cpu]` | Show/switch local device: GPU (`whisper.cpp`) or CPU (`faster-whisper`) |
| `/voice doctor [--fix]` | Diagnose the button/extension path and optionally auto-repair |
| `/voice heal` | Recover: reset a stuck recording, restart the server, recreate the audio channel (`doctor.sh --fix`) |
| `/voice help` | List all subcommands |

The `backend`/`lang`/`device` choices are persisted to `~/.config/opencode-voice/state.json`, so they survive a restart (env vars still take precedence).

TUI: the `<leader>v` hotkey (leader is `ctrl+x` by default) triggers push-to-talk. Web UI: the 🎤 button from the extension, or **hold `Alt+Z`** on the OpenCode page (push-to-talk; the combo is selectable in the popup).

Known limitations of the TUI command (by OpenCode design): the hook blocks while recording (so there is no live on-screen timer), and a failed attempt is logged as an ERROR in the OpenCode log (the plugin throws to avoid sending an empty prompt).

## Configuration (environment variables)

### Plugin (TUI `/voice`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_VOICE_BACKEND` | `local` \| `api` | `local` |
| `OPENCODE_VOICE_LANGUAGE` | `ru` \| `en` \| `auto` | `ru` |
| `OPENCODE_VOICE_DEVICE` | `auto` (GPU, else CPU) \| `gpu` \| `cpu` | `auto` |
| `OPENCODE_VOICE_STATE_FILE` | Where `/voice backend\|lang\|device` choices are persisted | `~/.config/opencode-voice/state.json` |
| `OPENAI_API_KEY` | key for the `api` backend | — |
| `OPENCODE_VOICE_MODEL` | model name for the `api` backend | `whisper-1` |
| `WHISPER_MODEL` | model size for the local backend; default depends on the device (medium on GPU, small on CPU) | auto (device) |
| `OPENCODE_VOICE_HOME` | base directory for the model/CLI install | `~/.local/share/opencode-voice` |
| `OPENCODE_VOICE_WHISPER_DIR` | whisper.cpp directory (CLI + `ggml-*.bin`) | `<home>/whisper` |
| `OPENCODE_VOICE_SOURCE` | PulseAudio source (microphone) for recording; pinned so the default cannot drift to a playback monitor | `RDPSource` (WSLg) |
| `OPENCODE_VOICE_TMP_DIR` | directory for recordings (RAM by default) | `/dev/shm/opencode-voice` |
| `OPENCODE_VOICE_RETAIN_SECONDS` | keep a recording before auto-delete, s (`0` = delete right after transcription) | `300` |
| `OPENCODE_VOICE_MAX_UPLOAD_MB` | max size of an uploaded audio file (`413` above it) | `25` |
| `OPENCODE_VOICE_MAX_AUDIO_SECONDS` | max audio duration accepted (`400` above it) | `300` |
| `OPENCODE_VOICE_MAX_CONCURRENT` | transcriptions allowed at once (others get `429`) | `1` |
| `OPENCODE_VOICE_TRANSCRIBE_TIMEOUT` | transcription timeout in seconds (`504` after it) | `300` |
| `OPENCODE_VOICE_RATE_LIMIT` | requests per minute per IP/endpoint (`0` = off) | `60` |
| `OPENCODE_VOICE_PURGE_INTERVAL` | how often the RAM dir is purged, s | `600` |
| `OPENCODE_VOICE_STALE_CLEANUP` | on startup kill stray recorders (`voice-ptt-`, arecord, ffmpeg); `0` = leave other processes alone (tests/parallel runs) | `1` |
| `OPENCODE_VOICE_KEEP_AUDIO` | if set, do not delete recordings (debug) | — |
| `OPENCODE_VOICE_AUTO_RECOVER` | recreate the WSLg audio channel on a silent source | `1` |
| `OPENCODE_VOICE_AUTO_RECOVER_COOLDOWN`, `OPENCODE_VOICE_RECOVER_WAIT_WESTON`, `OPENCODE_VOICE_RECOVER_WAIT_PULSE` | recovery timing | `90`, `8000`, `5000` ms |
| `OPENCODE_VOICE_AUTO_HEAL`, `OPENCODE_VOICE_AUTO_HEAL_COOLDOWN` | on a failed `/voice`, run `doctor.sh --fix` and retry the recording once (`0` disables; cooldown in seconds) | `1`, `90` |
| `OPENCODE_VOICE_MAX_RECORD_SECONDS` | Hard cap on `/voice` recording length (seconds); it normally stops earlier — ~1.5 s after you stop speaking | `300` |
| `OPENCODE_VOICE_RECORDER_BIN` | replace the recorder binary (tests/E2E): gets the same args as `arecord` and writes the WAV to the last argument | — |

### STT server

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_VOICE_PORT` | server port | `8765` |
| `OPENCODE_VOICE_HOST` | bind host; localhost-only by default | `127.0.0.1` |
| `OPENCODE_VOICE_SERVER` | auto-start the server on plugin load | `1` |
| `OPENCODE_VOICE_SERVER_SCRIPT` | path to `stt_server.py` (non-standard layouts) | auto |
| `OPENCODE_VOICE_SERVER_LOG` | server log file | `/tmp/opencode/stt_server.log` |
| `OPENCODE_VOICE_SERVER_WATCHDOG_MS` | health-check/restart interval, ms (`0` = off) | `120000` |
| `OPENCODE_VOICE_MAX_SECONDS` | max server-side recording length, s | `300` |
| `OPENCODE_VOICE_FAKE_AUDIO` | WAV used instead of the microphone (testing) | — |
| `OPENCODE_VOICE_TOKEN` | shared secret; when set, every endpoint except `/health` requires `X-Voice-Token` (or `Authorization: Bearer`) | empty (off) |
| `PULSE_SERVER` | PulseAudio socket | `/mnt/wslg/PulseServer` on WSL2 |

### Text-to-speech (server `/speak`, opt-in)

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_VOICE_TTS` | enable `POST /speak` (when `0`, it answers `501`) | `0` |
| `OPENCODE_VOICE_TTS_ENGINE` | synthesis engine | `piper` |
| `OPENCODE_VOICE_TTS_VOICE` | Piper voice (default; catalog in popup via `GET /voices`) | `ru_RU-irina-medium` |
| `OPENCODE_VOICE_TTS_VOICES` | space-separated voice names for `./setup.sh --tts` | `irina dmitri denis ruslan` |
| `OPENCODE_VOICE_TTS_RATE` | speech speed | `1.0` |
| `OPENCODE_VOICE_TTS_MAX_CHARS` | trim long text (`413` above it) | `300` |
| `OPENCODE_VOICE_TTS_BRIEF_SENTENCES` | `brief` mode: first sentences (errors always included) | `2` |
| `OPENCODE_VOICE_TTS_MODE` | default mode: `brief` \| `full` (switchable in the popup) | `brief` |
| `OPENCODE_VOICE_TTS_LANG` | voice language (`auto` = by reply language) | `auto` |
| `OPENCODE_VOICE_TTS_BIN` | Piper binary (`./setup.sh --tts` installs it) | auto (`<home>/tts/piper/piper`) |
| `OPENCODE_VOICE_TTS_VOICES_DIR` | Piper voices directory | auto (`<home>/tts/voices`) |
| `OPENCODE_VOICE_TTS_CACHE_MB` | LRU WAV cache size, MB | `64` |
| `OPENCODE_VOICE_TTS_TIMEOUT` | synthesis timeout, s | `60` |
| `OPENCODE_VOICE_TTS_LOG` | synthesis log | `/tmp/opencode/voice-tts.log` |

### Recognition quality and models

| Variable | Purpose | Default |
|----------|---------|---------|
| `WHISPER_CPP_BIN` | whisper.cpp CLI path (auto-detected in the whisper dir) | `<home>/whisper/bin/whisper-cli` |
| `WHISPER_CPP_MODEL` | whisper.cpp ggml model (explicit path) | `<home>/whisper/ggml-<size>.bin` |
| `WHISPER_CPP_MODEL_SIZE` | model size for whisper.cpp (`tiny`…`large`) | auto (medium GPU / small CPU) |
| `WHISPER_CPP_LIB_DIR`, `WHISPER_CPP_EXTRA_LIBS` | extra library paths for the CLI | auto (CUDA dirs discovered) |
| `CUDA_HOME`, `CUDA_PATH` | CUDA toolkit root; its `lib64` is added to `LD_LIBRARY_PATH` automatically | — |
| `WHISPER_BEAM_SIZE` | decoder beam (`1` = greedy/fastest) | `1` |
| `WHISPER_VAD` | voice-activity filter (`1`/`0`) | `1` |
| `WHISPER_INITIAL_PROMPT` | context hint for Whisper | empty (off) |
| `WHISPER_LANG_DETECT_SEGMENTS` / `WHISPER_LANG_DETECT_THRESHOLD` | auto language detection tuning | `3` / `0.6` |
| `OPENCODE_VOICE_SILENCE_PEAK` / `_RMS` | silence gate: below both thresholds the clip is treated as "no speech" (Whisper hallucinates on silence) | `700` / `80` |
| `OPENCODE_VOICE_STT_BACKEND` | `whispercpp` (GPU) \| `faster-whisper` (CPU); empty = auto | auto |
| `OPENCODE_VOICE_LANGUAGE` | server-side language (`ru`/`en`); empty = auto-detect | auto |

On short phrases auto language detection is unreliable — if you usually speak one language, pin it (`OPENCODE_VOICE_LANGUAGE=ru`).

**Security:** the server listens on `127.0.0.1` only and answers CORS only for local origins (OpenCode UI, the extension). Set `OPENCODE_VOICE_TOKEN` to require a shared secret on every request except `/health`. Without a token, if you expose the server (`--host 0.0.0.0` / `OPENCODE_VOICE_HOST=0.0.0.0`), anyone on the network can record from your microphone and read transcripts.

## Logs & diagnostics

| File | Contents |
|------|----------|
| `/tmp/opencode/stt_server.log` | STT server log: startup checks and every transcription (button and server-side records) |
| `/tmp/opencode/voice-recognized.log` | every recognized text with `source=` (`command` = `/voice`, `button` = extension), backend, model, language, duration |
| `/tmp/opencode/voice-stt.log` | which backend/model the plugin used, plus audio levels |
| `/tmp/opencode/voice-requests.log` | incoming HTTP requests (button path): `/beep`, `/transcribe`, `/record/*` |
| `/tmp/opencode/voice-tts.log` | TTS `/speak` synthesis: cache hit/miss, errors |
| `/dev/shm/opencode-voice/` | recordings (RAM); deleted after `OPENCODE_VOICE_RETAIN_SECONDS` |
| `/mnt/wslg/wlog.log` | WSLg log; `audin … error 1359` lines are a known channel teardown artifact, not a criterion |

`/voice doctor` (or `bash doctor.sh`) prints a summary of all of the above and can repair common problems with `--fix`.

## Troubleshooting

### The microphone is unavailable

The server returns one of two errors:

- `Нет доступа к микрофону: PulseAudio не отвечает…` — the recorder could not connect.
- `Аудиоисточник молчит: рекордер подключился, но данных нет (получено N байт)…` — it connected, but no audio arrives over the WSLg `audin` channel.

```bash
PULSE_SERVER=unix:/mnt/wslg/PulseServer pactl info
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/t.wav
```

**Quick fix (WSL2):** `bash voice-opencode-plugin/fix-mic.sh` recreates WSLg's internal RDP channel (restarts weston and pulseaudio). The server also self-heals once on a silent source (`OPENCODE_VOICE_AUTO_RECOVER=0` disables that).

Also make sure the app has microphone access in Windows (Settings → Privacy → Microphone); in an RDP session enable "Record from this computer". As a last resort from Windows: `wsl --shutdown`.

### The 🎤 button says "Failed to fetch"

Usually the server is down or its CORS is stale. Run `bash voice-opencode-plugin/doctor.sh --fix`: it restarts the server via the watchdog and re-checks the preflight for `X-Voice-Source`/`X-Voice-Token`. If a token is set, enter the same token in the extension popup.

### The recording hangs / "already recording"

A stuck server-side recording returns `409`. The extension recovers automatically; you can also clear it with `curl -X POST http://127.0.0.1:8765/record/stop`. `doctor.sh --fix` does this too.

### Poor recognition over RDP

`/voice` records through the RDP `audin` channel, which can deliver audio slower than real time. Recognition quality then depends on the RDP client's microphone capture. What helps: use a client with proper audio-input redirection, select a real microphone (not "Stereo Mix"), disable AGC/noise suppression, and prefer the browser 🎤 button (it captures on the Windows side and uploads a file, bypassing `audin` entirely).

## Structure

```
voice-opencode-plugin/
├── src/                     # plugin code (index.ts, lib/{config,stt,recorder,beep,server-launcher,text,state,heal}.ts)
├── stt-server/              # Flask server: stt_server.py, requirements*.txt, tests/
├── extension/               # Chrome extension (MV3): content.js, tts.js, popup, manifest
├── doctor.sh                # diagnostics/repair (/voice doctor)
├── fix-mic.sh               # recreate the WSLg audio channel
├── setup.sh                 # one-command install (deps, optional GPU build, config hints)
├── sync-plugin.sh           # generate the local plugin/TUI entry points (--check for CI)
├── check-workflows.sh       # validate .github/workflows YAML before pushing (catches startup-breaking YAML)
├── pytest.ini               # hermetic server tests
├── shared/                  # single source of truth for TS+Python (stt-spec.json, strip-cases.json, tts-cases.json)
└── .opencode/               # plugins/index.ts is generated; tui/web/commands are versioned
```

Repo root also contains `README.md`, `README.ru.md`, `CHANGELOG.md` (release history), `LICENSE`, and CI in `.github/workflows/` (`ci.yml` plus `workflow-lint.yml`, which validates the workflow YAML itself).

## Development

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh            # after every change to src/index.ts
npm run typecheck
python3 -m pytest              # server tests (hermetic: no mic, no model)
npm test                       # TS tests + hermetic E2E (node:test)
bash sync-plugin.sh --check    # CI guard: entry points are up to date
bash check-workflows.sh        # CI guard: workflow YAML is valid (needs PyYAML)
```

CI runs the same checks on every push. For interactive development: `npm run dev` (`opencode --plugin .`).

## License

MIT
