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
pip install --no-input faster-whisper flask requests

export PULSE_SERVER=unix:/mnt/wslg/PulseServer
python3 stt_server.py --model base --port 8765
```

Models: `tiny` / `base` (default) / `small` / `medium`. Check: `curl -s localhost:8765/health`.

Without a microphone you can exercise the whole pipeline on a prepared WAV:

```bash
OPENCODE_VOICE_FAKE_AUDIO=/tmp/test-voice.wav python3 stt_server.py --port 8765
```

Route tests: `python3 test_stt_server.py --port 8765`.

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

### 5. Userscript (extension alternative)

Install `voice-button.user.js` in Tampermonkey (or similar) — it adds the 🎤 button with no extension needed.

## `/voice` commands

| Command | Action |
|---------|--------|
| `/voice` | Push-to-talk: record → transcribe → insert text into the prompt |
| `/voice <file.wav>` | Transcribe a local audio file (no microphone needed) |
| `/voice backend [local\|api]` | Show/switch the STT backend |
| `/voice lang [ru\|en\|auto]` | Show/switch the language |

TUI: the `<leader>v` hotkey (leader is `ctrl+x` by default) triggers push-to-talk.

## Configuration (environment variables)

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCODE_VOICE_BACKEND` | `local` \| `api` | `local` |
| `OPENCODE_VOICE_LANGUAGE` | `ru` \| `en` \| `auto`/empty (auto) | `ru` |
| `OPENAI_API_KEY` | key for the `api` backend | — |
| `WHISPER_MODEL` | model for the plugin's local backend | `base` |
| `WHISPER_BEAM_SIZE` | decoder beam size (`1` = greedy, fastest) | `1` |
| `WHISPER_VAD` | voice-activity filter (`1`/`0`) | `1` |
| `WHISPER_INITIAL_PROMPT` | context hint for Whisper | empty (off) |
| `WHISPER_LANG_DETECT_SEGMENTS` | segments used for auto language detection | `3` |
| `WHISPER_LANG_DETECT_THRESHOLD` | language confidence threshold | `0.6` |
| `OPENCODE_VOICE_MAX_SECONDS` | max server-side recording length | `120` |
| `OPENCODE_VOICE_FAKE_AUDIO` | path to a WAV for microphone-free testing | — |
| `OPENCODE_VOICE_AUTO_RECOVER` | auto-recreate the WSLg audio channel on a silent source | `1` |
| `OPENCODE_VOICE_KEEP_AUDIO` | directory to save recorded audio for debugging | — |
| `PULSE_SERVER` | PulseAudio socket | auto `/mnt/wslg/PulseServer` |

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
├── stt-server/              # Flask + faster-whisper: stt_server.py, test_stt_server.py
├── extension/               # Chrome extension (MV3)
├── voice-button.user.js     # userscript
├── fix-mic.sh               # recreate the WSLg audio channel (microphone fix)
├── sync-plugin.sh           # src/index.ts -> .opencode/plugins/index.ts
├── opencode.json            # plugin wiring + agents
├── tui.json                 # TUI/web plugins + keybinds
├── AGENTS.md                # architecture notes
└── TEST_PLAN.md             # test plan
```

## License

MIT
