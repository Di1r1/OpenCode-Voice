/**
 * Конфигурация плагина.
 *
 * Переменные окружения:
 *   OPENCODE_VOICE_BACKEND   local | api     (по умолчанию api)
 *   OPENCODE_VOICE_LANGUAGE  ru | en       (по умолчанию ru)
 *   OPENAI_API_KEY           ключ для облачного Whisper
 *   OPENCODE_VOICE_MODEL     модель Whisper (по умолчанию whisper-1)
 *   OPENCODE_VOICE_PTT_KEY   горячая клавиша для push-to-talk
 */

export const STT_BACKENDS = ["local", "api"] as const
export const STT_LANGUAGES = ["ru", "en", "auto"] as const

export const DEFAULTS = {
  sttBackend: "api" as const,
  sttLanguage: "ru" as const,
  whisperModel: "whisper-1",
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  pttKey: "ctrl+shift+v",
}

export const config = {
  sttBackend: (process.env.OPENCODE_VOICE_BACKEND || DEFAULTS.sttBackend) as "local" | "api",
  sttLanguage: (process.env.OPENCODE_VOICE_LANGUAGE || DEFAULTS.sttLanguage) as string,
  whisperModel: process.env.OPENCODE_VOICE_MODEL || DEFAULTS.whisperModel,
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  sampleRate: Number(process.env.OPENCODE_VOICE_SAMPLE_RATE) || DEFAULTS.sampleRate,
  channels: Number(process.env.OPENCODE_VOICE_CHANNELS) || DEFAULTS.channels,
  bitsPerSample: Number(process.env.OPENCODE_VOICE_BITS_PER_SAMPLE) || DEFAULTS.bitsPerSample,
  pttKey: process.env.OPENCODE_VOICE_PTT_KEY || DEFAULTS.pttKey,
}