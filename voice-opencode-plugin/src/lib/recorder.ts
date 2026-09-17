/**
 * Запись микрофона (push-to-talk) в фоновом режиме.
 *
 * Почему фон: хуки opencode выполняются строго последовательно, поэтому вторая
 * команда не вызывается, пока не завершится первая. Схема:
 *   startPushToTalk()       — запускает детачированный рекордер, возвращает сессию сразу;
 *   stopPushToTalk(session) — SIGINT; рекордер финализирует WAV и выходит;
 *   waitPushToTalkEnd(...)  — фоновый обработчик ждёт выхода, затем распознаёт.
 *
 * Бэкенд: arecord (в WSL самый надёжный — PulseAudio), иначе ffmpeg.
 */

import { spawn } from "node:child_process"
import { mkdirSync, statSync } from "node:fs"

export interface PttOptions {
  sampleRate?: number
  channels?: number
  maxSeconds?: number
}

export interface PttSession {
  file: string
  pid: number
  backend: string
}

const SAMPLE_RATE = 16000
const CHANNELS = 1

/**
 * Явный источник PulseAudio (микрофон).
 *
 * Если записывать с default-source, то после обрыва канала audin PulseAudio
 * переключает default на RDPSink.monitor (лупбек) — и в файл попадает системный
 * звук вместо голоса. Поэтому источник задаём жёстко.
 */
function micSource(): string {
  return process.env.OPENCODE_VOICE_SOURCE || "RDPSource"
}

const DEFAULT_TMP_DIR = "/dev/shm/opencode-voice"

/** Каталог для записей: по умолчанию RAM (tmpfs), а не диск. */
function recordingDir(): string {
  const dir = process.env.OPENCODE_VOICE_TMP_DIR || DEFAULT_TMP_DIR
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/** Сколько секунд хранить запись перед удалением (для отладки/тестов). */
function retainSeconds(): number {
  const n = Number(process.env.OPENCODE_VOICE_RETAIN_SECONDS ?? "300")
  return Number.isFinite(n) ? n : 300
}

/**
 * Планирует удаление файла через retainSeconds.
 *
 * Делается отдельным detached-процессом (sleep + rm), поэтому удаление
 * переживёт перезапуск плагина. Если задан OPENCODE_VOICE_KEEP_AUDIO
 * (отладочное сохранение) — файл не удаляем.
 */
function scheduleDelete(file: string): void {
  if (process.env.OPENCODE_VOICE_KEEP_AUDIO) return
  const sec = retainSeconds()
  if (sec <= 0) return
  try {
    const child = spawn("sh", ["-c", `sleep ${Math.round(sec)}; rm -f "${file}"`], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {}
}

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

export async function startPushToTalk($: any, opts: PttOptions = {}): Promise<PttSession> {
  const sr = opts.sampleRate || SAMPLE_RATE
  const ch = opts.channels || CHANNELS
  const max = opts.maxSeconds || 30
  const file = `${recordingDir()}/voice-ptt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  scheduleDelete(file)

  // Убираем зависшие записи прошлых запусков — они держат микрофон.
  try { await $`pkill -f voice-ptt-`.quiet() } catch {}

  const arec = await which($, "arecord")
  let bin: string
  let args: string[]
  let backend: string
  if (arec) {
    bin = arec
    backend = "arecord"
    args = ["-D", "pulse", "-f", "S16_LE", "-r", String(sr), "-c", String(ch), "-t", "wav", "-d", String(max), file]
  } else {
    const ffmpeg = await which($, "ffmpeg")
    if (!ffmpeg) throw new Error("не найден рекордер: установи alsa-utils (arecord) или ffmpeg")
    bin = ffmpeg
    backend = "ffmpeg"
    args = ["-nostdin", "-y", "-f", "alsa", "-ar", String(sr), "-ac", String(ch), "-i", "pulse", "-t", String(max), file]
  }

  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PULSE_SOURCE: micSource() },
  })
  child.unref()
  if (!child.pid) throw new Error("не удалось запустить рекордер")
  return { file, pid: child.pid, backend }
}

export function stopPushToTalk(session: PttSession): void {
  try {
    process.kill(session.pid, "SIGINT")
  } catch {
    // процесс уже завершился
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Ждёт завершения рекордера; по истечении maxMs — убивает (SIGKILL). */
export async function waitPushToTalkEnd(session: PttSession, maxMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (!isAlive(session.pid)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  try { process.kill(session.pid, "SIGKILL") } catch {}
}

export function pttFileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Пересоздаёт аудиоканал WSLg (weston + pulseaudio) через интероп wsl.exe.
 * Тот же рецепт, что в fix-mic.sh: WSLGd перезапускает процессы сам.
 * Отключается через OPENCODE_VOICE_AUTO_RECOVER=0.
 */
export async function recoverMic($: any): Promise<boolean> {
  if ((process.env.OPENCODE_VOICE_AUTO_RECOVER ?? "1") === "0") return false
  const wsl = process.env.WSL_EXE || "/mnt/c/Windows/System32/wsl.exe"
  const sys = (cmd: string) => $`${wsl} --system -e sh -lc ${cmd}`.quiet()
  try {
    try { await sys("pkill -9 -x weston") } catch {}
    await sleep(Number(process.env.OPENCODE_VOICE_RECOVER_WAIT_WESTON || 8000))
    try { await sys("pkill -9 -x pulseaudio") } catch {}
    await sleep(Number(process.env.OPENCODE_VOICE_RECOVER_WAIT_PULSE || 5000))
    // Default source после сброса может уехать на RDPSink.monitor — вернём микрофон.
    try {
      const pulse = process.env.PULSE_SERVER || "unix:/mnt/wslg/PulseServer"
      await $`env PULSE_SERVER=${pulse} pactl set-default-source ${micSource()}`.quiet()
    } catch {}
    return true
  } catch {
    return false
  }
}
