/**
 * Speech-to-text: два бэкенда.
 *
 * api   — OpenAI Whisper API (требует OPENAI_API_KEY). Требует internet.
 * local — локальный: faster-whisper (pip), whisper.cpp или vosk.
 *        faster-whisper предпочтительнее — не требует torch, работает на CPU.
 *        Если ни одно не доступно — бросает понятную ошибку.
 */

import { appendFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { config } from "./config"

// Диагностика: какой бэкенд реально использовался (`/tmp/opencode/voice-stt.log`).
function note(backend: string, info: string): void {
  try {
    appendFileSync(
      "/tmp/opencode/voice-stt.log",
      `${new Date().toISOString()} ${backend} ${info}\n`,
    )
  } catch {
    // диагностика best-effort
  }
}

// whisper.cpp CLI (для GPU-режима; см. раздел GPU в README).
const WHISPER_CPP_BIN = process.env.WHISPER_CPP_BIN ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/bin/whisper-cli")
const WHISPER_CPP_MODEL = process.env.WHISPER_CPP_MODEL ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/ggml-small.bin")
const WHISPER_CPP_LIB_DIR = process.env.WHISPER_CPP_LIB_DIR ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/bin")

export interface TranscribeOptions {
  backend: "local" | "api"
  language: string
  file: string
  $: any
}

export interface TranscribeResult {
  text: string
  backend: "local" | "api"
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const { backend, language, file, $ } = opts

  if (backend === "api") {
    return transcribeApi({ file, language, $ })
  }
  return transcribeLocal({ file, language, $ })
}

// ---------------------------------------------------------------------------
// Облачный бэкенд: OpenAI Whisper API
// ---------------------------------------------------------------------------

async function transcribeApi(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts

  if (!config.openaiApiKey) {
    throw new Error(
      "Для бэкенда 'api' нужен OPENAI_API_KEY. " +
      "Установи его в opencode.json: env.OPENAI_API_KEY или экспортуй в среду.",
    )
  }

  // whisper-1 не поддерживает language=auto — фильтруем
  const lang = language === "auto" ? undefined : language

  const { OpenAI } = await import("openai")
  const openai = new OpenAI({ apiKey: config.openaiApiKey })

  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const audio = await fs.readFile(file)

  const res = await openai.audio.transcriptions.create({
    file: await OpenAI.toFile(audio, path.basename(file)),
    model: config.whisperModel,
    ...(lang ? { language: lang } : {}),
    response_format: "text",
  })

  return String(res).trim()
}

// ---------------------------------------------------------------------------
// Локальный бэкенд
// ---------------------------------------------------------------------------

async function transcribeLocal(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const pref = (process.env.OPENCODE_VOICE_STT_BACKEND || "").toLowerCase()

  // 1) whisper.cpp с CUDA (GPU) — если собран (см. README, GPU acceleration)
  if (pref !== "faster-whisper" && existsSync(WHISPER_CPP_BIN) && existsSync(WHISPER_CPP_MODEL)) {
    try {
      return await transcribeWhisperCpp({
        file, language, $, cli: WHISPER_CPP_BIN, model: WHISPER_CPP_MODEL,
      })
    } catch (e) {
      if (pref === "whispercpp") throw e
    }
  }

  // 2) faster-whisper (рекомендуется для CPU: не требует torch)
  if (pref !== "whispercpp" && await hasFasterWhisper($)) {
    return transcribeFasterWhisper({ file, language, $ })
  }

  // 3) whisper.cpp CLI из PATH (whisper-cli / main / whisper)
  const whisperCli = await which($, "whisper-cli") || await which($, "main") || await which($, "whisper")
  if (whisperCli) {
    return transcribeWhisperCpp({ file, language, $, cli: whisperCli })
  }

  // 4) Python whisper (openai-whisper)
  if (await hasPythonWhisper($)) {
    return transcribePythonWhisper({ file, language, $ })
  }

  // 5) vosk
  if (await hasVosk($)) {
    return transcribeVosk({ file, language, $ })
  }

  throw new Error(
    "Локальный бэкенд не настроен. Установи один из:\n" +
    "  • pip install faster-whisper (рекомендуется)\n" +
    "  • whisper.cpp: https://github.com/ggerganov/whisper.cpp\n" +
    "  • pip install openai-whisper (требуется torch)\n" +
    "  • pip install vosk\n" +
    "Или переключись на облачный: /voice backend api",
  )
}

async function which($: any, cmd: string): Promise<string | null> {
  try {
    const out = await $`command -v ${cmd}`.text()
    return out.trim() || null
  } catch {
    return null
  }
}

async function hasFasterWhisper($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "from faster_whisper import WhisperModel; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

async function hasPythonWhisper($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "import whisper; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

async function hasVosk($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "import vosk; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

async function transcribeFasterWhisper(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const modelSize = process.env.WHISPER_MODEL || "small"
  note("faster-whisper", `${modelSize} ${file}`)
  // Python ждёт None, а не null — поэтому маппим auto -> None явно.
  const langPy = language === "auto" ? "None" : JSON.stringify(language)
  const initialPrompt = process.env.WHISPER_INITIAL_PROMPT || ""
  // Качество авто-определения языка (применяется когда language=auto/None).
  const detectSegments = Number(process.env.WHISPER_LANG_DETECT_SEGMENTS ?? 3) || 3
  const detectThreshold = Number(process.env.WHISPER_LANG_DETECT_THRESHOLD ?? 0.6) || 0.6
  // Скорость распознавания.
  const beamSize = Number(process.env.WHISPER_BEAM_SIZE ?? 1) || 1
  const vad = !["0", "false", "no", "off", ""].includes(
    String(process.env.WHISPER_VAD ?? "1").toLowerCase(),
  )
  const code = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel(${JSON.stringify(modelSize)}, device="cpu", compute_type="int8")
segments, info = model.transcribe(
    sys.argv[1],
    language=${langPy},
    beam_size=${beamSize},
    vad_filter=${vad ? "True" : "False"},
    vad_parameters=dict(min_silence_duration_ms=300),
    initial_prompt=${initialPrompt ? JSON.stringify(initialPrompt) : "None"},
    condition_on_previous_text=False,
    temperature=0.0,
    language_detection_segments=${detectSegments},
    language_detection_threshold=${detectThreshold},
)
print("".join(s.text for s in segments))
`
  const out = await runPythonFile($, code, file)
  return out.trim()
}

async function transcribeWhisperCpp(opts: { file: string; language: string; $: any; cli: string; model?: string }): Promise<string> {
  const { file, language, $, cli } = opts
  const model = opts.model || process.env.WHISPER_MODEL_PATH || "./models/ggml-base.bin"
  note("whispercpp", `${cli} ${model}`)
  const lang = language && language !== "auto" ? language : "auto"
  // CUDA-рантайм + драйвер WSL должны быть в LD_LIBRARY_PATH.
  const ld = [
    WHISPER_CPP_LIB_DIR,
    path.join(os.homedir(), "cuda-12.6/lib64"),
    "/usr/lib/wsl/lib",
  ].join(":")
  const out = await $`env LD_LIBRARY_PATH=${ld} ${cli} -m ${model} -f ${file} -l ${lang} -nt -np`.text()
  const text = out.trim()
  if (!text) throw new Error("whisper.cpp не выдал текст")
  return text
}

async function transcribePythonWhisper(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const langPy = language === "auto" ? "None" : JSON.stringify(language)
  const modelSize = process.env.WHISPER_MODEL || "small"
  const code = `
import whisper, sys, json
model = whisper.load_model(${JSON.stringify(modelSize)})
res = model.transcribe(sys.argv[1], language=${langPy}, verbose=False)
print(res["text"])
`
  const out = await runPythonFile($, code, file)
  return out.trim()
}

async function transcribeVosk(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const modelPath = process.env.VOSK_MODEL_PATH || "./model"
  const code = `
import json, sys
from vosk import Model, KaldiRecognizer
import wave
model = Model(${JSON.stringify(modelPath)})
wf = wave.open(sys.argv[1], "rb")
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetLanguage(${JSON.stringify(language === "ru" ? "ru" : "en")})
res = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0: break
    if rec.AcceptWaveform(data):
        res.append(json.loads(rec.Result())["text"])
print(" ".join(res).strip())
`
  const out = await runPythonFile($, code, file)
  return out.trim()
}

/**
 * Запускает многострочный Python-код через временный файл.
 * `python3 -c <многострочный код>` ломается на кавычках/переносах,
 * поэтому пишем код в /tmp/*.py и передаём аудиофайл как argv[1].
 */
async function runPythonFile($: any, code: string, audioFile: string): Promise<string> {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const script = path.join(os.tmpdir(), `voice-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.py`)
  await fs.writeFile(script, code, "utf8")
  try {
    const out = await $`python3 ${script} ${audioFile}`.text()
    return out
  } finally {
    try { await fs.unlink(script) } catch {}
  }
}