/**
 * Запись микрофона в режиме push-to-talk.
 *
 * Поддерживаемые бэкенды (по порядку):
 *   1. ffmpeg  (самый универсальный)
 *   2. arecord (ALSA)
 *   3. sox / rec
 *   4. Python sounddevice/pyaudio
 *
 * Управление:
 *   Enter / пробел — начать/остановить запись
 *   Esc / q       — отменить
 *   Ctrl+C         — отменить
 *
 * В песочнике микрофона нет — в этом случае функция бросает понятную ошибку,
 * чтобы плагин не "завис". Для тестирования используй /voice <file.wav>.
 */

import { statSync } from "node:fs"

export interface PttOptions {
  $: any
  language?: string
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  /** Максимальная продолжительность записи в секундах */
  maxSeconds?: number
  /** Колбэк прогресса: вызывается каждую секунду во время записи */
  onProgress?: (seconds: number) => void
}

export interface PttResult {
  file: string
  cancelled: boolean
}

const SAMPLE_RATE = 16000
const CHANNELS = 1

async function which($: any, cmd: string): Promise<string | null> {
  try {
    const out = await $`command -v ${cmd}`.text()
    const p = out.trim()
    if (p) return p
  } catch {}
  // Fallback: песочница opencode не видит command -v, но бинарники в /usr/bin есть
  try { await $`test -x /usr/bin/${cmd}`.quiet(); return `/usr/bin/${cmd}` } catch {}
  try { await $`test -x /bin/${cmd}`.quiet(); return `/bin/${cmd}` } catch {}
  return null
}

export async function recordPushToTalk(options: PttOptions): Promise<string> {
  const { $, maxSeconds = 30, onProgress } = options
  const sr = options.sampleRate || SAMPLE_RATE
  const ch = options.channels || CHANNELS

  const out = `/tmp/voice-ptt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`

  // Убираем зависшие записи прошлых запусков — они держат микрофон и мешают
  // и плагину, и Chrome-расширению.
  try { await $`pkill -f voice-ptt-`.quiet() } catch {}

  // Бэкенды пробуются по порядку, при ошибке — следующий.
  // timeout — страховка: если рекордер зависнет на connect к PulseAudio,
  // он будет убит через maxSeconds + 8 и мы перейдём к следующему бэкенду.
  const errors: string[] = []
  const hardTimeout = maxSeconds + 8
  const attempt = async (label: string, cmd: string[]) => {
    try {
      const full = ["timeout", "--signal=INT", String(hardTimeout), ...cmd]
      return await recordWith($, full, out, maxSeconds, onProgress)
    } catch (e: any) {
      // «Мёртвый» источник — не пробуем остальные бэкенды, они упрутся в то же.
      if (e?.noAudio) throw e
      errors.push(`${label}: ${e?.message || e}`)
      return null
    }
  }

  // 1) arecord — в WSL самый надёжный (ffmpeg часто зависает на PulseAudio)
  const arecBin = (await which($, "arecord")) || "/usr/bin/arecord"
  const got2 = await attempt("arecord", [arecBin, "-D", "pulse", "-f", "cd", "-r", String(sr), "-c", String(ch), "-t", "wav", "-d", String(maxSeconds), out])
  if (got2) return got2

  // 2) ffmpeg (ALSA -> PulseAudio); -nostdin чтобы не ждал ввод
  const ffmpegBin = (await which($, "ffmpeg")) || "/usr/bin/ffmpeg"
  const got = await attempt("ffmpeg", [ffmpegBin, "-nostdin", "-y", "-f", "alsa", "-ar", String(sr), "-ac", String(ch), "-i", "pulse", "-t", String(maxSeconds), out])
  if (got) return got

  // 3) sox / rec
  const soxBin = (await which($, "sox")) || (await which($, "rec")) || "/usr/bin/sox"
  const got3 = await attempt("sox", [soxBin, "-r", String(sr), "-c", String(ch), "-t", "wav", out, "trim", "0", String(maxSeconds)])
  if (got3) return got3

  // 4) python sounddevice
  try {
    const pyCheck = await $`python3 -c "import sounddevice, numpy; print('ok')"`.text()
    if (pyCheck.includes("ok")) {
      const got4 = await attempt("sounddevice", [
        "python3", "-c",
        [
          "import sounddevice as sd, numpy as np, sys, wave",
          `sr=${sr}; ch=${ch}; dur=${maxSeconds}`,
          "q=sd.InputStream(samplerate=sr,channels=ch,dtype='int16')",
          "frames=[]; q.start()",
          "import time; t0=time.time()",
          "while time.time()-t0<dur:",
          "  d=q.read(int(sr*0.1))[0]; frames.append(d)",
          "q.stop(); q.close()",
          "a=np.concatenate(frames)",
          "w=wave.open(sys.argv[1],'wb'); w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr); w.writeframes(a.tobytes()); w.close()",
          "print('ok')",
        ].join(";"),
        out,
      ])
      if (got4) return got4
    }
  } catch {}

  if (errors.length) {
    throw new Error(`Запись не удалась (${errors.join("; ").slice(0, 300)}). Для тестирования используй /voice <file.wav>.`)
  }
  throw new Error(
    "Микрофон недоступен: не найдены ffmpeg/arecord/sox или sounddevice. " +
    "Для тестирования используй /voice <file.wav>.",
  )
}

async function recordWith($: any, cmd: string[], out: string, maxSeconds: number, onProgress?: (sec: number) => void): Promise<string> {
  const proc = $`${cmd}`
  const start = Date.now()

  if (onProgress) {
    const timer = setInterval(() => {
      const sec = Math.floor((Date.now() - start) / 1000)
      if (sec < maxSeconds) onProgress(sec)
    }, 1000)
    try {
      await proc.quiet()
    } finally {
      clearInterval(timer)
    }
  } else {
    await proc.quiet()
  }

  // Защита от «мёртвого» источника: рекордер мог подключиться, но не записать
  // звук (WAV-заголовок создаётся сразу). Почти пустой файл — сообщаем явно,
  // иначе плагин молча вернёт пустую расшифровку.
  let size = 0
  try {
    size = statSync(out).size
  } catch {
    size = 0
  }
  if (size < 2000) {
    const err: any = new Error(
      "микрофон молчит: рекордер подключился, но данные не пошли " +
      "(проверь канал RDP/audin или PULSE_SERVER=/mnt/wslg/PulseServer)",
    )
    err.noAudio = true
    throw err
  }
  return out
}