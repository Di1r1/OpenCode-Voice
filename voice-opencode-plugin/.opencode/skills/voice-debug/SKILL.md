---
name: voice-debug
description: Debug the opencode-voice plugin: check backend availability, API keys, and command execution
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: troubleshooting
---
# Voice Debug Skill

Use this skill to diagnose problems with `opencode-voice`.

## Check backend availability

Run these to see which recording/transcription tools are installed:

```bash
command -v ffmpeg && echo "ffmpeg OK" || echo "no ffmpeg"
command -v arecord && echo "arecord OK" || echo "no arecord"
command -v sox     && echo "sox OK"     || echo "no sox"
command -v rec     && echo "rec OK"     || echo "no rec"
command -v whisper-cli && echo "whisper-cli OK" || echo "no whisper-cli"
python3 -c "import whisper; print('openai-whisper OK')" 2>/dev/null || echo "no openai-whisper"
python3 -c "import vosk; print('vosk OK')" 2>/dev/null || echo "no vosk"
```

## Check configuration

```bash
env | grep -E "OPENCODE_VOICE|OPENAI_API_KEY" | sed 's/KEY=.*/KEY=<set>/'
```

## Test transcription

Create a test WAV and run:

```bash
python3 -c "
import struct, math
sr=16000; n=sr
with open('/tmp/test_voice.wav','wb') as f:
    f.write(b'RIFF'+struct.pack('<I',36+n*2)+b'WAVE')
    f.write(b'fmt '+struct.pack('<IHHIIHH',16,1,1,sr,sr*2,2,16))
    f.write(b'data'+struct.pack('<I',n*2))
    for i in range(n):
        f.write(struct.pack('<h', int(32767*0.3*math.sin(2*math.pi*440*i/sr))))
"
```

Then in OpenCode run: `/voice backend api /tmp/test_voice.wav`

## Plugin loading

- Local plugins live in `.opencode/plugins/` and load automatically.
- Run `opencode --print-logs --log-level DEBUG` to watch plugin load errors.
- A failing plugin logs `failed to load plugin <path>: <error>`.