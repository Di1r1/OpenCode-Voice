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
 *   /voice lang <ru|en|auto> — установить язык распознавания
 *   /voice device <auto|gpu|cpu> — GPU (whisper.cpp) или CPU (faster-whisper)
 *
 * Текст подставляется в поле ввода opencode через client.tui.appendPrompt,
 * как будто его напечатали вручную.
 */
export const VoicePlugin: Plugin = async ({ client, $, directory }) => {
  const { config, STT_LANGUAGES, STT_DEVICES, DEFAULTS } = await import("./lib/config")
  const state = {
    backend: (config.sttBackend || DEFAULTS.sttBackend) as "local" | "api",
    language: (config.sttLanguage || DEFAULTS.sttLanguage) as string,
    device: (config.sttDevice || DEFAULTS.sttDevice) as string,
  }

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "voice", level: "info", message, extra } })
    } catch {
      // logging is best-effort
    }
  }

  // Авто-старт STT-сервера при загрузке плагина, чтобы Chrome-расширение сразу работало.
  const { ensureSttServer, startServerWatchdog } = await import("./lib/server-launcher")
  void ensureSttServer(directory, log)
  startServerWatchdog(directory, log)

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
      const cmd = input.command
      if (cmd !== "voice" && cmd !== "v") return

      // Suppress the markdown command template ($ARGUMENTS) so the LLM is not
      // invoked with the raw template for /voice subcommands — we handle them
      // entirely in the plugin. OpenCode always calls the prompt function after
      // this hook, so we replace parts with a single empty text part to keep the
      // prompt valid (an empty parts array triggers a Google API error).
      output.parts.length = 0
      // Part требует id/sessionID/messageID по типам, рантайм их проставляет сам.
      output.parts.push({ type: "text", text: "\n" } as any)
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
        if (!(STT_LANGUAGES as readonly string[]).includes(want)) {
          showToast(`Доступные языки: ${STT_LANGUAGES.join(", ")}`, "error")
          return
        }
        state.language = want
        showToast(`Язык установлен: ${state.language}`)
        return
      }

      // /voice device [auto|gpu|cpu] — выбор CPU/GPU для локального распознавания
      if (sub === "device" || sub === "dev") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущее устройство: ${state.device} (auto: GPU, иначе CPU)`)
          return
        }
        if (!(STT_DEVICES as readonly string[]).includes(want)) {
          showToast(`Доступные устройства: ${STT_DEVICES.join(", ")}`, "error")
          return
        }
        state.device = want
        showToast(`Устройство установлено: ${state.device}${want === "cpu" ? " (faster-whisper)" : ""}`)
        return
      }

      // /voice help — список возможностей
      if (sub === "help" || sub === "-h" || sub === "--help") {
        showToast(
          "Voice:\n" +
          "• /voice — запись 30 с → текст в поле ввода\n" +
          "• /voice backend [local|api]\n" +
          "• /voice lang [ru|en|auto]\n" +
          "• /voice device [auto|gpu|cpu]\n" +
          "• /voice <файл.wav|mp3|m4a|ogg|flac>",
        )
        return
      }

      // /voice <file.wav> — распознать готовый аудиофайл
      if (parts.length && (parts[0].endsWith(".wav") || parts[0].endsWith(".mp3") || parts[0].endsWith(".m4a") || parts[0].endsWith(".ogg") || parts[0].endsWith(".flac"))) {
        const file = parts[0]
        const resolved = file.startsWith("/") ? file : `${directory}/${file}`
        showToast("Распознаю аудио…")
        try {
          const { transcribe, stripNonSpeech } = await import("./lib/stt")
          const raw = await transcribe({
            backend: state.backend,
            language: state.language,
            device: state.device,
            file: resolved,
            $,
          })
          const text = stripNonSpeech(raw)
          append(text)
          output.parts.length = 0
          output.parts.push({ type: "text", text } as any)
          showToast("Готово", "success")
        } catch (e: any) {
          await log("transcribe file failed", { error: e?.message || String(e) })
          showToast(`Ошибка: ${e?.message || e}`, "error")
        }
        return
      }

      // /voice — запись 30 секунд -> распознавание -> текст в поле ввода.
      // При любой ошибке хук бросает исключение: иначе OpenCode отправит
      // заглушку ("\n") и модель получит пустой запрос.
      try {
        const rec = await import("./lib/recorder")
        const { transcribe, stripNonSpeech } = await import("./lib/stt")

        const { beep } = await import("./lib/beep")
        const recordOnce = async () => {
          await beep($, 880, 120)
          const s = await rec.startPushToTalk($, { maxSeconds: 30 })
          await rec.waitPushToTalkEnd(s, 35000)
          await beep($, 520, 140)
          return s
        }

        let session = await recordOnce()
        if (rec.pttFileSize(session.file) < 2000) {
          // Аудиоканал WSLg отвалился — один раз пересоздаём и пробуем снова.
          await log("ptt no audio, recovering", { file: session.file })
          showToast("🔄 Микрофон не отвечает — пересоздаю аудиоканал…")
          await rec.recoverMic($)
          session = await recordOnce()
        }
        if (rec.pttFileSize(session.file) < 2000) {
          await log("ptt no audio", { file: session.file })
          showToast("❌ Микрофон молчит: запись пустая. Проверь аудиоканал (fix-mic.sh)", "error")
          throw new Error("ptt: пустая запись")
        }
        showToast("🧠 Распознаю речь…")
        let raw: string
        try {
          raw = await transcribe({
            backend: state.backend,
            language: state.language,
            device: state.device,
            file: session.file,
            $,
          })
        } catch (e: any) {
          await log("ptt transcribe failed", { error: e?.message || String(e) })
          showToast(`❌ Ошибка распознавания: ${e?.message || e}`, "error")
          throw new Error("ptt: ошибка распознавания")
        }
        const text = stripNonSpeech(raw)
        if (!text) {
          showToast("🤷 Речь не распознана (только шум)", "error")
          throw new Error("ptt: речь не распознана")
        }
        append(text)
        output.parts.length = 0
        output.parts.push({ type: "text", text } as any)
        showToast(`✅ Готово: "${text.slice(0, 40)}..."`, "success")
      } catch (e: any) {
        await log("ptt aborted", { error: e?.message || String(e) })
        throw e
      }
    },
  }

  return hooks
}