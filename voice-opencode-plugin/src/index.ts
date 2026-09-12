import type { Plugin, Hooks } from "@opencode-ai/plugin"

// NOTE: config and constants are imported dynamically inside the plugin function.
// OpenCode's legacy plugin loader (getLegacyPlugins) iterates over a module's exports
// and throws "Plugin export is not a function" for any non-function export, so we
// must avoid top-level imports of plain objects/arrays here.

/**
 * opencode-voice — голосовое управление opencode.
 *
 * Команды (вводятся в TUI):
 *   /voice            — push-to-talk: записать микрофон, распознать, вставить текст в prompt
 *   /voice <file.wav> — распознать готовый аудиофайл и вставить текст в prompt
 *   /voice backend    — показать текущий бэкенд распознавания
 *   /voice backend <local|api> — переключить бэкенд
 *   /voice lang <ru|en> — установить язык распознавания
 *
 * Текст подставляется в поле ввода opencode через client.tui.appendPrompt,
 * как будто его напечатали вручную.
 */
export const VoicePlugin: Plugin = async ({ client, $, directory }) => {
  const { config, STT_BACKENDS, STT_LANGUAGES, DEFAULTS } = await import("./lib/config")
  const state = {
    backend: (config.sttBackend || DEFAULTS.sttBackend) as "local" | "api",
    language: (config.sttLanguage || DEFAULTS.sttLanguage) as string,
  }

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "voice", level: "info", message, extra } })
    } catch {
      // logging is best-effort
    }
  }

  const append = (text: string) => {
    if (!text) return
    try {
      client.tui.appendPrompt({ body: { text } })
    } catch {
      // appendPrompt is best-effort
    }
  }

  const showToast = (message: string, variant: "success" | "error" | "info" = "info") => {
    try {
      client.tui.showToast({ body: { message, variant } })
    } catch {
      // Toast is best-effort
    }
  }

  const hooks: Hooks = {
    "command.execute.before": async (input, output) => {
      await log("hook fired", { command: input.command, parts: output.parts.length })
      const cmd = input.command
      if (cmd !== "voice" && cmd !== "v") return

      // Suppress the markdown command template ($ARGUMENTS) so the LLM is not
      // invoked with the raw template for /voice subcommands — we handle them
      // entirely in the plugin. OpenCode always calls the prompt function after
      // this hook, so we replace parts with a single empty text part to keep the
      // prompt valid (an empty parts array triggers a Google API error).
      output.parts.length = 0
      output.parts.push({ type: "text", text: "" })
      await log("parts replaced", { now: output.parts.length })

      const args = (input.arguments || "").trim()
      const parts = args.split(/\s+/).filter(Boolean)
      const sub = parts[0]?.toLowerCase()

      // /voice backend [local|api]
      if (sub === "backend") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущий бэкенд: ${state.backend}`)
          return
        }
        if (want !== "local" && want !== "api") {
          showToast("Доступные бэкенды: local, api", "error")
          return
        }
        state.backend = want as "local" | "api"
        showToast(`Бэкенд переключён на: ${state.backend}`)
        return
      }

      // /voice lang [ru|en]
      if (sub === "lang") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущий язык: ${state.language}`)
          return
        }
        if (!STT_LANGUAGES.includes(want)) {
          showToast(`Доступные языки: ${STT_LANGUAGES.join(", ")}`, "error")
          return
        }
        state.language = want
        showToast(`Язык установлен: ${state.language}`)
        return
      }

      // /voice <file.wav> — распознать готовый аудиофайл
      if (parts.length && (parts[0].endsWith(".wav") || parts[0].endsWith(".mp3") || parts[0].endsWith(".m4a") || parts[0].endsWith(".ogg") || parts[0].endsWith(".flac"))) {
        const file = parts[0]
        const resolved = file.startsWith("/") ? file : `${directory}/${file}`
        showToast("Распознаю аудио…")
        try {
          const { transcribe } = await import("./lib/stt")
          const text = await transcribe({
            backend: state.backend,
            language: state.language,
            file: resolved,
            $,
          })
          append(text)
          showToast("Готово", "success")
        } catch (e: any) {
          showToast(`Ошибка: ${e?.message || e}`, "error")
        }
        return
      }

      // /voice — push-to-talk запись микрофона
      showToast("Говорите… (Esc — отменить)")
      try {
        const { recordPushToTalk } = await import("./lib/recorder")
        const text = await recordPushToTalk({ $, language: state.language })
        if (text) {
          append(text)
          showToast("Готово", "success")
        }
      } catch (e: any) {
        if (e?.message === "cancelled") return
        showToast(`Ошибка: ${e?.message || e}`, "error")
      }
    },
  }

  return hooks
}