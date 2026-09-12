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
    return out.trim() || null
  } catch {
    return null
  }
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

  // 1) ffmpeg
  if (await hasFfmpeg($)) {
    return recordWith($, ["ffmpeg", "-y", "-f", "alsa", "-ar", String(sr), "-ac", String(ch), "-i", "default", "-t", String(maxSeconds), out], out)
  }

  // 2) arecord
  if (await hasArecord($)) {
    return recordWith($, ["arecord", "-f", "cd", "-r", String(sr), "-c", String(ch), "-t", "wav", "-V", "vd", out, "timeout", String(maxSeconds)], out)
  }

  // 3) sox / rec
  if (await hasSox($)) {
    const cmd = (await which($, "sox")) || (await which($, "rec")) || "sox"
    return recordWith($, [cmd, "-r", String(sr), "-c", String(ch), "-t", "wav", out, "trim", "0", String(maxSeconds)], out)
  }

  // 4) python sounddevice
  if (await hasPythonSdt($)) {
    return recordWith($, [
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
    ], out)
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
      try { require("fs").unlinkSync(out) } catch {}
      throw new Error("cancelled")
    }
    throw new Error(`Запись не удалась: ${msg.slice(0, 200)}`)
  }
}