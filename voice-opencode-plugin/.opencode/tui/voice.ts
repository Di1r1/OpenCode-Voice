import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// TUI-часть opencode-voice: хоткей <leader>v запускает /voice (запись до тишины;
// жёсткий предел — OPENCODE_VOICE_MAX_RECORD_SECONDS, по умолчанию 300 с).
// v1-модули target-exclusive (server или tui, но не оба сразу),
// поэтому TUI живёт отдельным файлом с default export { id, tui }.
// Именованных рантайм-экспортов нет. Сама запись/распознавание
// выполняются серверной частью через хук command.execute.before.

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
}

const plugin: TuiPluginModule & { id: string } = {
  id: "voice.tui",
  tui,
}

export default plugin
