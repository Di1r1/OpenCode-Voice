// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
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
  const { config, STT_LANGUAGES, STT_DEVICES, DEFAULTS, PLUGIN_VERSION } = await import("./lib/config")
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
      // this hook, so parts are never left empty: success paths carry the
      // transcript, info subcommands carry a service text (svc), and failures
      // throw so no request is sent at all.
      const setParts = (text: string) => {
        output.parts.length = 0
        // Part требует id/sessionID/messageID по типам, рантайм их проставляет сам.
        output.parts.push({ type: "text", text } as any)
      }
      // Служебные ответы не должны превращаться в пустой запрос к модели:
      // кладём осмысленный текст с просьбой не отвечать (OpenCode всегда
      // вызывает prompt() после хука).
      const svc = (t: string) =>
        `(служебное сообщение плагина Voice, ответ не нужен) ${t}`
      setParts("\n")
      await log("parts replaced", { now: output.parts.length })

      const args = (input.arguments || "").trim()
      const parts = args.split(/\s+/).filter(Boolean)
      const sub = parts[0]?.toLowerCase()

      // /voice backend [local|api]
      if (sub === "backend") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущий бэкенд: ${state.backend}`)
          setParts(svc(`Текущий бэкенд: ${state.backend}`))
          return
        }
        if (want !== "local" && want !== "api") {
          showToast("Доступные бэкенды: local, api", "error")
          setParts(svc(`Неизвестный бэкенд «${want}». Доступные: local, api`))
          return
        }
        state.backend = want as "local" | "api"
        showToast(`Бэкенд переключён на: ${state.backend}`)
        setParts(svc(`Бэкенд переключён на: ${state.backend}`))
        return
      }

      // /voice lang [ru|en]
      if (sub === "lang") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущий язык: ${state.language}`)
          setParts(svc(`Текущий язык: ${state.language}`))
          return
        }
        if (!(STT_LANGUAGES as readonly string[]).includes(want)) {
          showToast(`Доступные языки: ${STT_LANGUAGES.join(", ")}`, "error")
          setParts(svc(`Неизвестный язык «${want}». Доступные: ${STT_LANGUAGES.join(", ")}`))
          return
        }
        state.language = want
        showToast(`Язык установлен: ${state.language}`)
        setParts(svc(`Язык установлен: ${state.language}`))
        return
      }

      // /voice device [auto|gpu|cpu] — выбор CPU/GPU для локального распознавания
      if (sub === "device" || sub === "dev") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущее устройство: ${state.device} (auto: GPU, иначе CPU)`)
          setParts(svc(`Текущее устройство: ${state.device} (auto: GPU, иначе CPU)`))
          return
        }
        if (!(STT_DEVICES as readonly string[]).includes(want)) {
          showToast(`Доступные устройства: ${STT_DEVICES.join(", ")}`, "error")
          setParts(svc(`Неизвестное устройство «${want}». Доступные: ${STT_DEVICES.join(", ")}`))
          return
        }
        state.device = want
        showToast(`Устройство установлено: ${state.device}${want === "cpu" ? " (faster-whisper)" : ""}`)
        setParts(svc(`Устройство установлено: ${state.device}`))
        return
      }

      // /voice doctor [--fix] — диагностика/ремонт кнопки и микрофона
      if (sub === "doctor" || sub === "diag" || sub === "check") {
        const fs = await import("node:fs")
        const path = await import("node:path")
        const candidates = [
          path.join(directory, "voice-opencode-plugin", "doctor.sh"),
          path.join(directory, "doctor.sh"),
          path.join(directory, ".opencode", "plugins", "doctor.sh"),
        ]
        const script = candidates.find((p) => fs.existsSync(p))
        if (!script) {
          showToast("doctor.sh не найден", "error")
          setParts(svc("doctor.sh не найден рядом с плагином"))
          return
        }
        const fix = parts.includes("--fix") || parts.includes("fix")
        showToast("🩺 Проверяю…")
        try {
          const out = fix
            ? await $`bash ${script} --fix`.text()
            : await $`bash ${script}`.text()
          const tail = out.trim().split("\n").slice(-14).join("\n")
          await log("doctor", { fix })
          setParts(svc(`диагностика (${fix ? "с ремонтом" : "только чтение"}):\n${tail}`))
          showToast("🩺 Готово — смотри поле ввода", "success")
        } catch (e: any) {
          await log("doctor failed", { error: e?.message || String(e) })
          setParts(svc(`ошибка doctor: ${e?.message || e}`))
          showToast(`Ошибка doctor: ${e?.message || e}`, "error")
        }
        return
      }

      // /voice help — список возможностей
      if (sub === "help" || sub === "-h" || sub === "--help") {
        const helpText =
          `Voice v${PLUGIN_VERSION}:\n` +
          "• /voice — запись → текст в поле ввода (авто-стоп по тишине)\n" +
          "• /voice backend [local|api]\n" +
          "• /voice lang [ru|en|auto]\n" +
          "• /voice device [auto|gpu|cpu]\n" +
          "• /voice doctor [--fix] — диагностика кнопки/микрофона\n" +
          "• /voice <файл.wav|mp3|m4a|ogg|flac>"
        showToast(helpText)
        setParts(svc(helpText))
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
            source: "command-file",
          })
          const text = stripNonSpeech(raw)
          append(text)
          setParts(text)
          showToast("Готово", "success")
        } catch (e: any) {
          await log("transcribe file failed", { error: e?.message || String(e) })
          showToast(`Ошибка: ${e?.message || e}`, "error")
          setParts(svc(`/voice ${file}: ошибка распознавания — ${e?.message || e}`))
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
          const s = await rec.startPushToTalk($)
          const info = await rec.waitPushToTalkAuto(s)
          await beep($, 520, 140)
          await log("ptt recorded", { reason: info.reason, audioMs: Math.round(info.audioMs) })
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
            source: "command",
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
        await beep($, 660, 120)
        append(text)
        setParts(text)
        showToast(`✅ Готово: "${text.slice(0, 40)}..."`, "success")
      } catch (e: any) {
        await log("ptt aborted", { error: e?.message || String(e) })
        throw e
      }
    },
  }

  return hooks
}