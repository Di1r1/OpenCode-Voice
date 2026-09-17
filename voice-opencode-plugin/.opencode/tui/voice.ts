import { readFileSync } from "node:fs"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// TUI-часть opencode-voice: хоткей <leader>v запускает /voice (push-to-talk)
// и живой индикатор записи.
// v1-модули target-exclusive (server или tui, но не оба сразу),
// поэтому TUI живёт отдельным файлом с default export { id, tui }.
// Именованных рантайм-экспортов нет. Сама запись/распознавание
// выполняются серверной частью через хук command.execute.before.

const STATUS_FILE = "/tmp/opencode/voice-status.json"

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "voice.pushToTalk",
        title: "Voice: записать и распознать в промпт",
        description: "Записать микрофон, распознать речь и вставить текст в поле ввода",
        category: "Plugin",
        namespace: "palette",
        async run() {
          try {
            await api.client.tui.executeCommand({ command: "voice" })
          } catch (e: any) {
            api.ui.toast({ message: `Voice: ${e?.message || e}`, variant: "error" })
          }
        },
      },
    ],
    bindings: [{ key: "<leader>v", cmd: "voice.pushToTalk", desc: "Voice push-to-talk" }],
  })

  // Живой индикатор: серверный плагин во время записи пишет статус в файл,
  // а мы показываем тост-таймер (серверные тосты во время хука не отображаются).
  let lastToast = 0
  const timer = setInterval(() => {
    if (Date.now() - lastToast < 900) return
    try {
      const s = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as {
        state?: string
        start?: number
        max?: number
      }
      if (s?.state !== "recording") return
      const max = s.max ?? 30
      const elapsed = Math.floor((Date.now() - (s.start ?? Date.now())) / 1000)
      const sec = Math.max(0, Math.min(max, elapsed))
      lastToast = Date.now()
      api.ui.toast({
        variant: "info",
        title: "🎙 Запись микрофона",
        message: `${sec}/${max} с`,
        duration: 1200,
      })
    } catch {
      // статуса нет — ничего не показываем
    }
  }, 250)

  api.lifecycle.onDispose(() => clearInterval(timer))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "voice.tui",
  tui,
}

export default plugin
