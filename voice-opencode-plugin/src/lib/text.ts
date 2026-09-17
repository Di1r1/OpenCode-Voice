/**
 * Текстовая пост-обработка распознавания.
 *
 * Список служебных маркеров и символы берутся из `shared/stt-spec.json` —
 * единого источника истины для TypeScript и Python (см. stt_server.py).
 * Если файл недоступен (нестандартная упаковка), используется встроенный
 * фолбэк, совпадающий со спеком.
 *
 * Модуль не имеет зависимостей (кроме node:fs), поэтому тестируется напрямую
 * через `node --experimental-strip-types`.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const FALLBACK_KEYWORDS = [
  "музык", "music", "аплодисмент", "applause", "смех", "laugh", "тишин", "silence",
  "шум", "noise", "звук", "sound", "свист", "whistl", "кашел", "кашл", "cough",
  "вздох", "sigh", "шёпот", "шепот", "whisper", "неразборчив", "inaudible", "пауза",
  "paus", "гудок", "сигнал", "signal", "звон", "ring", "стук", "knock", "хлопок",
  "clap", "помех", "static", "инструментал", "instrumental", "мужской голос", "женский голос",
]
const FALLBACK_SYMBOLS = "♪♫♬♩♭♮#"

interface TextSpec {
  keywords: string[]
  symbols: string
}

function loadSpec(): TextSpec {
  try {
    const url = new URL("../../shared/stt-spec.json", import.meta.url)
    const raw = JSON.parse(readFileSync(fileURLToPath(url), "utf8"))
    const keywords = Array.isArray(raw?.nonSpeechKeywords) && raw.nonSpeechKeywords.length
      ? raw.nonSpeechKeywords.map(String)
      : FALLBACK_KEYWORDS
    const symbols = typeof raw?.nonSpeechSymbols === "string" && raw.nonSpeechSymbols
      ? raw.nonSpeechSymbols
      : FALLBACK_SYMBOLS
    return { keywords, symbols }
  } catch {
    return { keywords: FALLBACK_KEYWORDS, symbols: FALLBACK_SYMBOLS }
  }
}

const SPEC = loadSpec()

// Служебные пометки Whisper на музыке/шуме: [музыка], (смех), ♪, *music* и т.п.
const NON_SPEECH = new RegExp(`^(?:${SPEC.keywords.join("|")})`, "i")
const SYMBOLS_RE = new RegExp(`[${SPEC.symbols.replace(/[\\\]^]/g, "\\$&")}]+`, "g")

/** Вырезает служебные пометки ([музыка], (смех), ♪ …) из результата распознавания. */
export function stripNonSpeech(text: string): string {
  let t = text
  t = t.replace(/\[[^\]]*\]/g, " ")                        // [музыка], [Music]
  t = t.replace(/\*[^*]*\*/g, " ")                          // *music*
  t = t.replace(/\(([^)]*)\)/g, (m, inner) =>
    NON_SPEECH.test(String(inner).trim()) ? " " : m)        // (смех), но не (то есть)
  t = t.replace(SYMBOLS_RE, " ")                            // ноты
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim()
  return t
}
