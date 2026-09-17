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

// Служебные пометки Whisper на музыке/шуме: [музыка], (смех), ♪, *music* и т.п.
const NON_SPEECH = new RegExp(
  "^(музык|music|аплодисмент|applause|смех|laugh|тишин|silence|шум|noise|" +
  "звук|sound|свист|whistl|кашел|кашл|cough|вздох|sigh|шёпот|шепот|whisper|" +
  "неразборчив|inaudible|пауза|paus|гудок|сигнал|signal|звон|ring|стук|knock|" +
  "хлопок|clap|помех|static|инструментал|instrumental|мужской голос|женский голос)",
  "i",
)

/** Вырезает служебные пометки ([музыка], (смех), ♪ …) из результата распознавания. */
export function stripNonSpeech(text: string): string {
  let t = text
  t = t.replace(/\[[^\]]*\]/g, " ")                        // [музыка], [Music]
  t = t.replace(/\*[^*]*\*/g, " ")                          // *music*
  t = t.replace(/\(([^)]*)\)/g, (m, inner) =>
    NON_SPEECH.test(String(inner).trim()) ? " " : m)        // (смех), но не (то есть)
  t = t.replace(/[♪♫♬♩♭♮#]+/g, " ")                        // ноты
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim()
  return t
}

// whisper.cpp CLI (для GPU-режима; см. раздел GPU в README).
const WHISPER_CPP_BIN = process.env.WHISPER_CPP_BIN ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/bin/whisper-cli")
const WHISPER_CPP_MODEL = process.env.WHISPER_CPP_MODEL ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/ggml-medium.bin")
const WHISPER_CPP_SMALL_MODEL = process.env.WHISPER_CPP_MODEL_FALLBACK ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/ggml-small.bin")
const WHISPER_CPP_LIB_DIR = process.env.WHISPER_CPP_LIB_DIR ||
  path.join(os.homedir(), ".local/share/opencode-voice/whisper/bin")

/**
 * Есть ли CUDA-драйвер. Проверяем по библиотеке libcuda (WSL2-драйвер или
 * системная), а не по бинарнику whisper-cli: сборка с CUDA есть, а GPU может
 * не быть — тогда whisper.cpp не запустится и надо уходить на CPU.
 */
export function cudaAvailable(): boolean {
  if (["0", "false", "no", "off"].includes(
    String(process.env.OPENCODE_VOICE_CUDA ?? "1").toLowerCase(),
  )) return false
  return [
    "/usr/lib/wsl/lib/libcuda.so.1",
    "/usr/lib/wsl/lib/libcuda.so",
    "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
    "/usr/local/cuda/lib64/libcuda.so.1",
    path.join(os.homedir(), "cuda-12.6/lib64/libcudart.so"),
  ].some((p) => existsSync(p))
}

export interface TranscribeOptions {
  backend: "local" | "api"
  language: string
  file: string
  $: any
  /** auto (по умолчанию) | gpu | cpu. auto: GPU, при неудаче/отсутствии — CPU. */
  device?: string
}

export interface TranscribeResult {
  text: string
  backend: "local" | "api"
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const { backend, language, file, $, device } = opts

  if (backend === "api") {
    return transcribeApi({ file, language, $ })
  }
  return transcribeLocal({ file, language, device, $ })
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

async function transcribeLocal(opts: { file: string; language: string; device?: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const pref = (process.env.OPENCODE_VOICE_STT_BACKEND || "").toLowerCase()

  // Устройство: auto (по умолчанию) | gpu | cpu.
  // OPENCODE_VOICE_STT_BACKEND оставлен для совместимости.
  let device = (opts.device || process.env.OPENCODE_VOICE_DEVICE || "auto").toLowerCase()
  if (["faster-whisper", "cpu", "faster_whisper"].includes(pref)) device = "cpu"
  if (["whispercpp", "gpu", "cuda"].includes(pref)) device = "gpu"
  if (!["auto", "gpu", "cpu"].includes(device)) device = "auto"

  const haveWhisperCpp = existsSync(WHISPER_CPP_BIN) && existsSync(WHISPER_CPP_MODEL)
  const preferGpu = device === "gpu" || (device === "auto" && cudaAvailable())

  // 1) whisper.cpp на GPU — только если есть CUDA (или явно попросили gpu).
  if (preferGpu && haveWhisperCpp) {
    try {
      return await transcribeWhisperCpp({
        file, language, $, cli: WHISPER_CPP_BIN, model: WHISPER_CPP_MODEL,
      })
    } catch (e) {
      // Явный gpu — не прячем ошибку. auto — молча уходим на CPU.
      if (device === "gpu") throw e
    }
  }

  // 2) faster-whisper (CPU, рекомендуется: не требует torch).
  if (device !== "gpu" && await hasFasterWhisper($)) {
    return transcribeFasterWhisper({ file, language, $ })
  }

  // 3) whisper.cpp на CPU — если GPU нет, а faster-whisper не установлен.
  //    На CPU берём small, если он есть (medium на CPU слишком медленный).
  if (device !== "gpu") {
    const cpuModel = existsSync(WHISPER_CPP_SMALL_MODEL) ? WHISPER_CPP_SMALL_MODEL : WHISPER_CPP_MODEL
    if (existsSync(WHISPER_CPP_BIN) && existsSync(cpuModel)) {
      try {
        return await transcribeWhisperCpp({ file, language, $, cli: WHISPER_CPP_BIN, model: cpuModel })
      } catch {
        // уходим к остальным фолбэкам
      }
    }
  }

  // 4) whisper.cpp CLI из PATH (whisper-cli / main / whisper)
  const whisperCli = await which($, "whisper-cli") || await which($, "main") || await which($, "whisper")
  if (whisperCli) {
    return transcribeWhisperCpp({ file, language, $, cli: whisperCli })
  }

  // 5) Python whisper (openai-whisper)
  if (await hasPythonWhisper($)) {
    return transcribePythonWhisper({ file, language, $ })
  }

  // 6) vosk
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
  const modelSize = process.env.WHISPER_MODEL || "medium"
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
  const model = opts.model || process.env.WHISPER_MODEL_PATH || WHISPER_CPP_MODEL
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
  const modelSize = process.env.WHISPER_MODEL || "medium"
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