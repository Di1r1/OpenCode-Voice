/**
 * Текстовая пост-обработка распознавания.
 *
 * Вынесено отдельным модулем без зависимостей, чтобы её можно было тестировать
 * напрямую (node --experimental-strip-types) и переиспользовать вне stt.ts.
 */

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
