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

import { unlinkSync } from "node:fs"

export interface PttOptions {
  $: any
  language?: string
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  /** Максимальная продолжительность записи в секундах */
  maxSeconds?: number
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

async function hasFfmpeg($: any): Promise<boolean> {
  return !!(await which($, "ffmpeg"))
}

async function hasArecord($: any): Promise<boolean> {
  return !!(await which($, "arecord"))
}

async function hasSox($: any): Promise<boolean> {
  return !!(await which($, "sox")) || !!(await which($, "rec"))
}

async function hasPythonSdt($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "import sounddevice, numpy; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

export async function recordPushToTalk(options: PttOptions): Promise<string> {
  const { $, maxSeconds = 30 } = options
  const sr = options.sampleRate || SAMPLE_RATE
  const ch = options.channels || CHANNELS

  const out = `/tmp/voice-ptt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`

  // Бэкенды пробуются по порядку, при ошибке — следующий.
  // (Наличие бинарника ещё не значит, что запись сработает:
  // например, ffmpeg может быть собран без ALSA-плагинов.)
  const errors: string[] = []
  const attempt = async (label: string, cmd: string[]) => {
    try {
      return await recordWith($, cmd, out)
    } catch (e: any) {
      errors.push(`${label}: ${e?.message || e}`)
      return null
    }
  }

  // 1) ffmpeg (ALSA -> PulseAudio напрямую)
  const ffmpegBin = (await which($, "ffmpeg")) || "/usr/bin/ffmpeg"
  const got = await attempt("ffmpeg", [ffmpegBin, "-y", "-f", "alsa", "-ar", String(sr), "-ac", String(ch), "-i", "pulse", "-t", String(maxSeconds), out])
  if (got) return got

  // 2) arecord. -D pulse идёт напрямую в PulseAudio
  const arecBin = (await which($, "arecord")) || "/usr/bin/arecord"
  const got2 = await attempt("arecord", [arecBin, "-D", "pulse", "-f", "cd", "-r", String(sr), "-c", String(ch), "-t", "wav", "-d", String(maxSeconds), out])
  if (got2) return got2

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

async function recordWith($: any, cmd: string[], out: string): Promise<string> {
  try {
    await $`${cmd}`.quiet()
    return out
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e)
    if (/cancel|interrupt|exit code 130|SIGINT|EINTR/.test(msg)) {
      try { unlinkSync(out) } catch {}
      throw new Error("cancelled")
    }
    throw new Error(`Запись не удалась: ${msg.slice(0, 200)}`)
  }
}