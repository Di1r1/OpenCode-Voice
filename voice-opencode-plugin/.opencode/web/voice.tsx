import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const plugin: TuiPluginModule = {
  id: "voice.web",
  tui: async (api) => {
    api.slots.register({
      slots: {
        session_prompt_right: (_ctx, _props) => {
          const handleClick = async () => {
            try {
              await api.client.tui.executeCommand({ command: "voice" })
            } catch (e: any) {
              api.ui.toast({ message: `Voice: ${e?.message || e}`, variant: "error" })
            }
          }
          return (
            <button
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "4px 8px",
                fontSize: "16px",
                lineHeight: "1",
                color: "var(--text)",
                opacity: 0.7,
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e: any) => (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e: any) => (e.currentTarget.style.opacity = "0.7")}
              onClick={handleClick}
              title="Voice: record and transcribe (Ctrl+x then v)"
            >
              {"🎤"}
            </button>
          )
        },
      },
    })
  },
}

export default plugin
