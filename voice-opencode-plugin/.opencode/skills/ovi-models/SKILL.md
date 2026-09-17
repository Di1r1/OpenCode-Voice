---
name: ovi-models
description: Use when choosing or tuning STT models/backends, setting up GPU (CUDA toolkit, whisper.cpp build, GTX 950M / CC 5.0), switching GPU↔CPU, or measuring quality/speed for OpenCode Voice. Triggers whisper.cpp, ggml model, faster-whisper, CUDA, nvcc, GPU, model quality, beam, VAD, transcription speed.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: both
  workflow: models
---

# OpenCode Voice — models, GPU and tuning

## Backends

| Backend | Where | Typical use |
| --- | --- | --- |
| `whispercpp` | `WHISPER_CPP_BIN` + GGML model, GPU via CUDA | Default when a CUDA driver and the CLI/model exist |
| `faster-whisper` | Python, CPU (`pip install faster-whisper`) | Fallback / explicit CPU (`WHISPER_MODEL`, default `medium`) |
| `python-whisper`, `vosk` | Python | Last-resort fallbacks |
| OpenAI API | `OPENCODE_VOICE_BACKEND=api` + `OPENAI_API_KEY` | No local compute |

Selection: `OPENCODE_VOICE_DEVICE=auto|gpu|cpu` (or `/voice device …`).
`OPENCODE_VOICE_STT_BACKEND=whispercpp|faster-whisper` is a legacy alias.
`auto` = GPU if `libcuda` is present, otherwise CPU; an explicit `gpu` never silently falls back.

## Installed layout (this machine)

```
~/.local/share/opencode-voice/whisper/
  bin/whisper-cli, lib*.so*    # whisper.cpp built with CUDA
  ggml-medium.bin              # default model
  ggml-small.bin               # CPU/fallback model
~/cuda-12.6/                   # user-space CUDA Toolkit (no root)
```

`LD_LIBRARY_PATH` when running the CLI: `<bin> : ~/cuda-12.6/lib64 : /usr/lib/wsl/lib`.

## GPU notes (WSL2, GTX 950M, CC 5.0)

- WSL CUDA needs a modern Windows driver exposing `/usr/lib/wsl/lib/libcuda.so*` (the 2017 driver did not).
- **CUDA 13 cannot compile Maxwell (CC 5.0)** — use the 12.x toolkit. Install into `$HOME` (runfile with
  `--toolkit --toolkitpath=$HOME/cuda-12.6 --no-opengl-libs --no-man-page --override`, `DISPLAY=` set).
- Build whisper.cpp:

```bash
cmake -B build-cuda -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=50 -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DCUDAToolkit_ROOT=$HOME/cuda-12.6 \
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
  -DCMAKE_EXE_LINKER_FLAGS="-L$HOME/cuda-12.6/lib64 -Wl,--copy-dt-needed-entries -Wl,-rpath,$HOME/cuda-12.6/lib64"
```

- Measure GPU load with NVML (`/tmp/opencode/gpu_util.py`); a running transcript shows 85–100 % util and ~0.9 GB VRAM for the small model on this GPU.

## Tuning defaults (both plugin and server)

| Setting | Default | Note |
| --- | --- | --- |
| Model | `medium` (GGML / `WHISPER_MODEL`) | `small` is faster, slightly more case/number errors |
| `WHISPER_BEAM_SIZE` | `1` (greedy) | beam 5 is ~30 % slower with marginal gain |
| `WHISPER_VAD` | on | VAD filter for faster-whisper |
| `WHISPER_INITIAL_PROMPT` | empty | A default Russian prompt caused misrecognitions ("проверка"→"прайберка") |
| whisper.cpp flags | `-mc 0 -sns` | no context carry-over, suppress non-speech tokens |
| `OPENCODE_VOICE_LANGUAGE` | auto | `ru` skips detection (~25–30 % faster) and avoids word reordering |
| Silence gate | peak 700 / rms 80 | Silence is rejected before Whisper (anti-hallucination) |

Measured on the reference clip "Раз, два, три, проверка микрофона, как слышно":
medium returns it verbatim with `ru` or `auto`, with or without `-mc 0 -sns`; the flags mainly cut
hallucinations on noise, not word accuracy. Speed on this CPU/GPU is dominated by captured-audio
length; the GPU keeps 5-second clips around 5 s total.

## How to A/B a model

```bash
W=~/.local/share/opencode-voice/whisper/bin/whisper-cli
M=~/.local/share/opencode-voice/whisper/ggml-medium.bin
LD_LIBRARY_PATH=~/.local/share/opencode-voice/whisper/bin:~/cuda-12.6/lib64:/usr/lib/wsl/lib \
  $W -m $M -f sample.wav -l ru -nt -np
# add -mc 0 -sns to match production, or drop them to compare
```

Compare on files with known content (e.g. a 5–10 s clip you read aloud) and always re-check duration
and levels — a truncated or low-level file will look like a "model problem" when it is a capture problem
(see `ovi-debug`).
