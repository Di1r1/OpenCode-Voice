/**
 * Speech-to-text: два бэкенда.
 *
 * api   — OpenAI Whisper API (требует OPENAI_API_KEY). Требует internet.
 * local — локальный: faster-whisper (pip), whisper.cpp или vosk.
 *        faster-whisper предпочтительнее — не требует torch, работает на CPU.
 *        Если ни одно не доступно — бросает понятную ошибку.
 */

import { config } from "./config"

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
    file: openai.toFile(audio, path.basename(file)),
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

  // 1) faster-whisper (рекомендуется: не требует torch, работает на CPU)
  if (await hasFasterWhisper($)) {
    return transcribeFasterWhisper({ file, language, $ })
  }

  // 2) whisper.cpp CLI (whisper-cli / main)
  const whisperCli = await which($, "whisper-cli") || await which($, "main") || await which($, "whisper")
  if (whisperCli) {
    return transcribeWhisperCpp({ file, language, $, cli: whisperCli })
  }

  // 3) Python whisper (openai-whisper)
  if (await hasPythonWhisper($)) {
    return transcribePythonWhisper({ file, language, $ })
  }

  // 4) vosk
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
  const modelSize = process.env.WHISPER_MODEL || "base"
  const lang = language === "auto" ? null : language
  const code = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("${modelSize}", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], language=${JSON.stringify(lang)}, beam_size=5)
print("".join(s.text for s in segments))
`
  const out = await $`python3 -c ${code} ${file}`.text()
  return out.trim()
}

async function transcribeWhisperCpp(opts: { file: string; language: string; $: any; cli: string }): Promise<string> {
  const { file, language, $, cli } = opts
  const model = process.env.WHISPER_MODEL_PATH || "./models/ggml-base.bin"
  const args = [cli, "-m", model, "-f", file, "-otxt"]
  if (language && language !== "auto") {
    args.push("-l", language === "ru" ? "ru" : "en")
  }
  await $`${args}`.quiet()
  const txt = `${file}.txt`
  try {
    const fs = await import("node:fs/promises")
    const content = await fs.readFile(txt, "utf8")
    return content.trim()
  } catch {
    throw new Error("whisper.cpp не выдал текст")
  }
}

async function transcribePythonWhisper(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const lang = language === "auto" ? null : language
  const code = `
import whisper, sys, json
model = whisper.load_model("${process.env.WHISPER_MODEL || "base"}")
res = model.transcribe(sys.argv[1], language=${JSON.stringify(lang)}, verbose=False)
print(res["text"])
`
  const out = await $`python3 -c ${code} ${file}`.text()
  return out.trim()
}

async function transcribeVosk(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const code = `
import json, sys
from vosk import Model, KaldiRecognizer
import wave
model = Model("${process.env.VOSK_MODEL_PATH or "./model"}")
wf = wave.open(sys.argv[1], "rb")
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetLanguage("${language === "ru" ? "ru" : "en"}")
res = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0: break
    if rec.AcceptWaveform(data):
        res.append(json.loads(rec.Result())["text"])
print(" ".join(res).strip())
`
  const out = await $`python3 -c ${code} ${file}`.text()
  return out.trim()
}