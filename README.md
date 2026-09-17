# OpenCode Voice

Voice input for [OpenCode](https://opencode.ai): speak, and your words land in the prompt. Supports local STT (`faster-whisper`) and cloud (OpenAI Whisper API), push-to-talk in the TUI, and a 🎤 button in the web UI.

**English** | [Русский](README.ru.md)

## Components

| Part | What it does |
|------|--------------|
| `src/` | OpenCode plugin (TS): the `/voice` command, push-to-talk recording, STT backends |
| `.opencode/` | OpenCode config (agents, skills, the `/voice` command, TUI/web plugins) |
| `stt-server/` | Flask + faster-whisper: server-side recording via PulseAudio (WSL) and transcription |
| `extension/` | Chrome extension (MV3): the 🎤 button in the web UI, hybrid recording (browser → server) |
| `voice-button.user.js` | Extension alternative — a Tampermonkey userscript |
| `sync-plugin.sh` | Syncs `src/index.ts` → `.opencode/plugins/index.ts` |

## Requirements

- Windows 10/11 + WSL2 with WSLg (audio goes through WSLg PulseAudio).
- Node.js + npm — for the plugin.
- Python 3.9+ — for the STT server.
- System packages: `alsa-utils` (`arecord`), `libasound2-plugins`, `ffmpeg` (optional).

## Installation

### 1. Audio in WSL2

```bash
sudo apt-get update
sudo apt-get install -y alsa-utils libasound2-plugins ffmpeg
export PULSE_SERVER=unix:/mnt/wslg/PulseServer

# check
pactl info
arecord -D pulse -f cd -d 3 /tmp/t.wav && ls -la /tmp/t.wav   # should be ~500 KB, not 44 bytes
```

> There is no `/dev/snd` in WSL2 — that is expected. The microphone is reachable only via `PULSE_SERVER=unix:/mnt/wslg/PulseServer`.

### 2. STT server

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input -r requirements.txt      # flask + faster-whisper (CPU backend)

export PULSE_SERVER=unix:/mnt/wslg/PulseServer
python3 stt_server.py --model medium --port 8765
```

The server binds `127.0.0.1` by default and starts even without `faster-whisper` when using the GPU (whisper.cpp) backend — the CPU package is imported lazily.

The plugin auto-starts this server when OpenCode loads (if it is not already running) and keeps it alive with a watchdog — manual start is optional.

Models: `tiny` / `base` / `small` / `medium` (default) / `large`. Check: `curl -s localhost:8765/health`.

Without a microphone you can exercise the whole pipeline on a prepared WAV:

```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765
```

Route tests: `python3 test_stt_server.py --port 8765` (manual, needs a running server). Hermetic unit tests: `cd voice-opencode-plugin && pip install -r stt-server/requirements-dev.txt && pytest`.

### Optional: GPU acceleration (NVIDIA + CUDA, WSL2)

By default the server runs `faster-whisper` on CPU. With an NVIDIA GPU exposed to WSL2 you can run `whisper.cpp` with CUDA instead (tested on a GTX 950M / Maxwell, CC 5.0).

1. Update the Windows NVIDIA driver to a WSL-capable branch (R470+); after a reboot `/usr/lib/wsl/lib/libcuda.so.1` should exist.
2. Install the CUDA toolkit into your home directory (no root). Use a toolkit that still supports your GPU — CUDA 13 dropped Maxwell/Pascal, so use 12.6 for those:

```bash
sh cuda_12.6.0_560.28.03_linux.run --silent --toolkit --toolkitpath=$HOME/cuda-12.6 --no-opengl-libs --no-man-page --override
```

3. Build whisper.cpp with CUDA. Replace `<cc>` with your compute capability (`50` Maxwell, `61` Pascal, `75` Turing, `86` Ampere):

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=<cc> -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DCUDAToolkit_ROOT=$HOME/cuda-12.6 \
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
  -DCMAKE_EXE_LINKER_FLAGS="-L$HOME/cuda-12.6/lib64 -Wl,--copy-dt-needed-entries"
cmake --build build -j4 --target whisper-cli
```

4. Install the CLI + model where the server looks for them:

```bash
DEST=$HOME/.local/share/opencode-voice/whisper
mkdir -p $DEST/bin
cp build/bin/whisper-cli build/bin/*.so* $DEST/bin/
cp models/ggml-medium.bin $DEST/
```

The server auto-detects the CLI and uses it (`curl -s localhost:8765/health` shows `"backend":"whispercpp"`, `"device":"cuda"`). The `/voice` command in the plugin uses the same CLI when CUDA is available. If there is no GPU (no `libcuda`), it automatically falls back to `faster-whisper` on CPU — the server does the same. Force a device explicitly with `/voice device cpu|gpu|auto` or `OPENCODE_VOICE_DEVICE=cpu` (`OPENCODE_VOICE_STT_BACKEND=faster-whisper` also works).

### 3. OpenCode plugin

```bash
cd voice-opencode-plugin
npm install
bash sync-plugin.sh     # run after editing src/index.ts
npm run typecheck
```

`opencode.json` already loads the plugin (`./.opencode/plugins/index.ts`); `tui.json` wires up the TUI/web parts. Start it:

```bash
export OPENCODE_VOICE_BACKEND=local OPENCODE_VOICE_LANGUAGE=ru PULSE_SERVER=unix:/mnt/wslg/PulseServer
opencode web --hostname 0.0.0.0
```

### 4. Chrome extension (🎤 button)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select the `voice-opencode-plugin/extension` folder.
3. Open the OpenCode web UI — the 🎤 button appears next to the input field.

The extension talks to the STT server at `http(s)://<host>:8765` (`STT_PORT` in `extension/content.js`). `extension/manifest.json` already lists `localhost`/`127.0.0.1`; if your host differs, add it to `host_permissions`.

Optional: an in-UI 🎤 button for the OpenCode prompt is provided by `.opencode/web/voice.tsx` — add it to the `plugin` list of your TUI config (`~/.config/opencode/tui.json`) to enable it.

### 5. Userscript (deprecated)

⚠️ `voice-button.user.js` is **deprecated** — it is kept for compatibility only and is not updated. Use the Chrome extension instead: the userscript talks to an older API, lacks RAM recording/beeps/settings, and uses the same button `id` as the extension (do not enable both).

## `/voice` commands

| Command | Action |
|---------|--------|
| `/voice` | Push-to-talk: record → transcribe → insert text into the prompt |
| `/voice <file.wav>` | Transcribe a local audio file (no microphone needed) |
| `/voice backend [local\|api]` | Show/switch the STT backend |
| `/voice lang [ru\|en\|auto]` | Show/switch the language |
| `/voice device [auto\|gpu\|cpu]` | Show/switch local device: GPU (whisper.cpp) or CPU (faster-whisper) |

TUI: the `<leader>v` hotkey (leader is `ctrl+x` by default) triggers push-to-talk.

## CPU vs GPU (local recognition)

The local backend uses the GPU when possible and **falls back to the CPU automatically**.

| Device | What runs |
|--------|-----------|
| `auto` (default) + CUDA (`libcuda` present) | `whisper.cpp` + `ggml-medium.bin` on GPU |
| `auto` + no GPU | `faster-whisper` (medium) on CPU |
| `gpu` | `whisper.cpp` on GPU only (errors if unavailable, no silent fallback) |
| `cpu` | `faster-whisper` on CPU only |

You do **not** need a CUDA/whisper.cpp build to use the CPU path.

### Switch to CPU manually

Runtime, for the current `/voice` session (`/voice dev` also works):

```
/voice device          # show current device
/voice device cpu      # CPU: faster-whisper
/voice device gpu      # GPU: whisper.cpp
/voice device auto     # GPU if available, otherwise CPU
```

Persistent, via environment variables:

```bash
export OPENCODE_VOICE_DEVICE=cpu              # preferred
# legacy alias, equivalent:
export OPENCODE_VOICE_STT_BACKEND=faster-whisper
```

`/voice device` resets when OpenCode restarts — use the env variable to pin it.
The STT server (the 🎤 button path) reads `OPENCODE_VOICE_DEVICE=cpu` too; restart the server after changing it.

### Example: CPU-only machine (no NVIDIA GPU)

```bash
cd voice-opencode-plugin/stt-server
pip install --no-input faster-whisper flask requests
export OPENCODE_VOICE_DEVICE=cpu
export OPENCODE_VOICE_LANGUAGE=ru
# medium is the default; on a slow CPU choose a smaller model:
# export WHISPER_MODEL=small
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
opencode web --hostname 0.0.0.0
```

### Model and recognition settings

- CPU model size: `WHISPER_MODEL=medium` (default) — `tiny` | `base` | `small` | `medium` | `large`.
- GPU model file: `WHISPER_CPP_MODEL=…/ggml-medium.bin` — point it at any `ggml-*.bin`.
- `WHISPER_CPP_BIN` — path to the `whisper-cli` binary.
- `WHISPER_CPP_MODEL_FALLBACK` — ggml model used when `faster-whisper` is not installed (default `ggml-small.bin`).
- `WHISPER_BEAM_SIZE` — decoder beam (`1` = greedy/fastest, higher = slightly better but slower).
- `WHISPER_VAD` — voice-activity filter (`1`/`0`).
- `WHISPER_INITIAL_PROMPT` — context hint for Whisper (off by default).
- `WHISPER_LANG_DETECT_SEGMENTS` / `WHISPER_LANG_DETECT_THRESHOLD` — auto language detection tuning.
- `/voice lang ru|en|auto` — switch language at runtime; `/voice backend local|api` — local vs OpenAI API.

Full variable list: [Configuration](#configuration-environment-variables) below.

## Configuration (environment variables)

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_VOICE_BACKEND` | `local` \| `api` | `local` |
| `OPENCODE_VOICE_LANGUAGE` | `ru` \| `en` \| `auto`/empty (auto) | `ru` |
| `OPENCODE_VOICE_DEVICE` | local device: `auto` (GPU, else CPU) \| `gpu` \| `cpu` | `auto` |
| `OPENAI_API_KEY` | key for the `api` backend | — |
| `WHISPER_MODEL` | model for the plugin's local (faster-whisper) backend | `medium` |
| `WHISPER_BEAM_SIZE` | decoder beam size (`1` = greedy, fastest) | `1` |
| `WHISPER_VAD` | voice-activity filter (`1`/`0`) | `1` |
| `WHISPER_INITIAL_PROMPT` | context hint for Whisper | empty (off) |
| `WHISPER_LANG_DETECT_SEGMENTS` | segments used for auto language detection | `3` |
| `WHISPER_LANG_DETECT_THRESHOLD` | language confidence threshold | `0.6` |
| `OPENCODE_VOICE_STT_BACKEND` | `whispercpp` (GPU) \| `faster-whisper` (CPU); empty = auto | auto |
| `OPENCODE_VOICE_SOURCE` | PulseAudio source (microphone) used for recording; pinned so the default cannot drift to `RDPSink.monitor` (playback loopback) | `RDPSource` |
| `OPENCODE_VOICE_TMP_DIR` | Directory for recordings; defaults to tmpfs **RAM**, not disk | `/dev/shm/opencode-voice` |
| `OPENCODE_VOICE_RETAIN_SECONDS` | How long to keep a recording before auto-delete (seconds); use `0` to delete right after transcription | `300` |
| `WHISPER_CPP_BIN` | whisper.cpp CLI path | `~/.local/share/opencode-voice/whisper/bin/whisper-cli` |
| `WHISPER_CPP_MODEL` | whisper.cpp ggml model path | `~/.local/share/opencode-voice/whisper/ggml-medium.bin` |
| `WHISPER_CPP_MODEL_FALLBACK` | CPU ggml model used when faster-whisper is absent | `…/ggml-small.bin` |
| `OPENCODE_VOICE_MAX_SECONDS` | max server-side recording length | `120` |
| `OPENCODE_VOICE_FAKE_AUDIO` | path to a WAV for microphone-free testing | — |
| `OPENCODE_VOICE_AUTO_RECOVER` | auto-recreate the WSLg audio channel on a silent source | `1` |
| `OPENCODE_VOICE_KEEP_AUDIO` | directory to save recorded audio for debugging | — |
| `OPENCODE_VOICE_SERVER` | auto-start the STT server on plugin load | `1` |
| `OPENCODE_VOICE_SERVER_SCRIPT` | path to `stt_server.py` (non-standard layouts) | auto |
| `OPENCODE_VOICE_PORT` | STT server port | `8765` |
| `OPENCODE_VOICE_HOST` | STT server bind host; localhost-only by default. Set `0.0.0.0` only if you need LAN access (there is no auth) | `127.0.0.1` |
| `OPENCODE_VOICE_SERVER_WATCHDOG_MS` | health-check/restart interval, `0` = off | `120000` |
| `PULSE_SERVER` | PulseAudio socket | auto `/mnt/wslg/PulseServer` |

**Security:** the STT server listens on `127.0.0.1` only and answers CORS only for local origins (OpenCode UI, the extension). It has **no authentication**: if you expose it (`--host 0.0.0.0` / `OPENCODE_VOICE_HOST=0.0.0.0`), anyone on the network can record from your microphone and read transcripts.

On short phrases auto language detection is limited: if you usually speak one language, set it explicitly (`OPENCODE_VOICE_LANGUAGE=ru`) for reliability.

## If the microphone is unavailable

The server responds with one of two errors:

- `Нет доступа к микрофону: PulseAudio не отвечает…` — the recorder could not connect.
- `Аудиоисточник молчит: рекордер подключился, но данных нет (получено N байт)…` — it connected, but WSLg delivers no audio over the `audin` channel.

Check:

```bash
PULSE_SERVER=unix:/mnt/wslg/PulseServer pactl info
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f cd -r 16000 -c 1 -t wav -d 3 /tmp/t.wav
```

**Quick fix:** run the helper script (recreates WSLg's internal RDP channel — restarts weston and pulseaudio):

```bash
bash voice-opencode-plugin/fix-mic.sh
```

The STT server also self-heals: on a silent source it recreates the WSLg audio channel once and retries (disable with `OPENCODE_VOICE_AUTO_RECOVER=0`).

The same steps manually (without `wsl --shutdown`), run from WSL:

```bash
# 1. recreate the WSLg RDP session (WSLGd will respawn weston); the WSLg GUI restarts
/mnt/c/Windows/System32/wsl.exe --system -e sh -lc 'pkill -9 -x weston'
sleep 8
# 2. restart PulseAudio so it attaches to the fresh channel
/mnt/c/Windows/System32/wsl.exe --system -e sh -lc 'pkill -9 -x pulseaudio'
sleep 5
# 3. verify: a real file (~500 KB) should be written, not a 44-byte stub
PULSE_SERVER=unix:/mnt/wslg/PulseServer arecord -D pulse -f cd -d 3 /tmp/t.wav && ls -la /tmp/t.wav
```

Also make sure the app has microphone access in Windows (Settings → Privacy → Microphone); in an RDP session enable "Record from this computer". If that does not help, do a full restart: `wsl --shutdown` (from Windows PowerShell), then reopen WSL.

## Structure

```
voice-opencode-plugin/
├── src/                     # plugin code (index.ts, lib/config.ts, lib/stt.ts, lib/recorder.ts)
├── .opencode/               # OpenCode config: agents, commands, plugins, skills, tui, web
├── stt-server/              # Flask server: stt_server.py, requirements*.txt, tests/, manual test script
├── extension/               # Chrome extension (MV3)
├── voice-button.user.js     # userscript (deprecated)
├── fix-mic.sh               # recreate the WSLg audio channel (microphone fix)
├── sync-plugin.sh           # src/index.ts -> .opencode/plugins/index.ts (--check for CI)
├── opencode.json            # plugin wiring + agents
├── tui.json                 # TUI/web plugins (sample; not loaded globally)
├── pytest.ini               # hermetic server tests
├── AGENTS.md                # architecture notes
└── TEST_PLAN.md             # test plan
```

Repo root also contains `README.md`, `README.ru.md`, `AUDIT.md` (production-readiness audit), `LICENSE`, and CI in `.github/workflows/ci.yml`.

## License

MIT
