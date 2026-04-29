# Grom

<p align="center">
  <img src="resources/icon.png" width="120" alt="Grom" />
</p>

**Your AI. Stays on your machine. Built by one person in Ireland.**

Grom is a privacy-first AI assistant for VS Code that runs entirely on your local hardware. No cloud. No account. No telemetry. Just you, your code, and Grom.

---

## Meet Grom

Grom is the little robot who lives in your sidebar. He watches your cursor, thinks while you type, and goes to sleep when you're idle. He's not a feature — he's the soul of the tool.

Built for developers who are done handing their code to someone else's server.

### Grom has states

He doesn't just sit there. His antenna tells you what's happening before you read a word.

| State | What it means |
|---|---|
| Antenna bent | PLAN mode — thinking broadly |
| Antenna straight | BUILD mode — focused, ready to ship |
| Antenna bobbing | Waiting for a response |
| Antenna drooping, faded | Your server isn't running |
| Glitching | Server returned an error |
| Eyes closed, thought bubble | Idle — wake him up by typing |

---

## What Grom Does

### Two Modes. One Purpose.
- **PLAN mode** — warm honey gold. Grom thinks architecturally. Great for breaking down problems, planning features, and talking through ideas.
- **BUILD mode** — focused blue. Grom is direct and implementation-ready. Write code, fix bugs, ship things.

The UI colour shifts with the mode. So does Grom's personality.

### Talks to Your Local Models
Plug in whatever you're running locally:
- **Ollama** (`127.0.0.1:11434`)
- **LM Studio** (`127.0.0.1:1234`)
- **Open Code**
- Any **OpenAI-compatible** API
- **Custom providers** — add your own endpoints in settings

Switch providers and models without leaving the panel. Grom detects model capabilities automatically — vision, tool use, and reasoning models each show their own icon.

### Knows What You're Working On

Grom has rich context awareness. Use `@` in any message to attach context:

| Mention | What it includes |
|---|---|
| `@filename` | Any workspace file (fuzzy search) |
| `@problems` | All current VS Code errors and warnings |
| `@git` | Your current uncommitted diff (`git diff HEAD`) |
| `@terminal` | Recent output from the integrated terminal |
| `@url:https://...` | Fetches a web page and includes its text |

You can also:
- **Auto-context** — Grom reads the file you have open automatically
- **Image support** — upload images via the `+` button, or paste from clipboard with Ctrl+V
- **Web search** — use `/search your query` to fetch live results before the model answers

### Inline Autocomplete

Grom provides ghost-text completions as you type, powered by FIM (fill-in-middle) models.

- **Adaptive debounce** — speeds up when you're accepting, slows down when you're not
- **Word-by-word accept** — Tab accepts the next word; keep pressing for more
- **Toggle** — click the status bar item (`✦ Grom`) to enable/disable instantly
- **Dedicated model** — set `grom.autocompleteModel` to a fast FIM model (e.g. `qwen2.5-coder:1.5b`) separate from your chat model
- **Per-language routing** — use different models for different languages via `grom.languageModels`

### Inline Edit

Select code, press `Ctrl+Shift+I`, describe what you want. Grom rewrites it and opens a diff — Accept or Reject.

### Compose (Multi-file Edit)

Press `Ctrl+Shift+O` or type `/compose` to enter compose mode. Describe the changes you want across your codebase. Grom outputs each file in a structured format. Review per-file or apply everything at once. Undo the whole run with one click if you change your mind.

Every code block Grom writes in compose format gets a **💾 Save** button — click it to open a diff view showing exactly what will change. Accept to write the file, Skip to discard. New files are created immediately with no diff step.

### Remembers Your Conversations
- Multiple chat sessions, persistent across restarts
- Rename chats by clicking the title in the header or the pencil icon in the session list
- **Compact** — type `/compact` or use the `/` menu to trim long histories; a divider marks exactly where the history was cut
- **Export** any conversation as a `.md` file, and **import** it back to continue where you left off
- **Search** — search through any conversation with live highlighting
- **Scroll to latest** — a jump button appears in the bottom-right corner of the chat when you scroll up during a long response; click it to return to the latest message

### Grom Memory
Grom has a persistent memory that gets injected into every new chat — like custom instructions in Cursor or Claude. Write your rules once:
- *Only use TypeScript*
- *Never push code directly, always explain changes first*
- *My stack is React 18 + Express*

Open it with the brain icon in the header.

### Per-Session System Prompt
Override the system prompt for any single session — useful for giving Grom a specific persona or constraint for a task without touching your global memory. Open it with the chat bubble icon.

### Custom Prompt Files

Create `.grom/*.md` files in your workspace to add team-shareable slash commands. A file at `.grom/deploy.md` becomes `/deploy` in the menu — available to everyone on the project who has Grom installed.

### Agentic Loop

When you give Grom a task, it doesn't just reply once — it works through it step by step. Grom reads files, writes files, lists directories, searches code, and runs terminal commands on its own, calling the next tool based on what the last one returned.

**Built-in file tools** (always available, no config needed):

| Tool | What it does |
|---|---|
| `read_file` | Read any file in your workspace |
| `write_file` | Write or create a file, then open it in the editor |
| `list_directory` | List files and folders at a path |
| `delete_file` | Delete a file |
| `search_files` | Search workspace files by regex pattern |
| `run_terminal` | Run a shell command and return its output |
| `browse_web` | Fetch a live web page and return its text content |

The loop continues until the task is done, the model gives a final answer, or it hits the `grom.agentMaxIterations` limit (default: 20). Every tool call is logged in the **Task Log** tab next to the Sessions list.

You can disable the agentic loop in settings (`grom.agentEnabled: false`) to return to simple single-shot responses.

> **Model reliability note:** Tool call accuracy depends heavily on model size. Large models (32b+) call tools reliably. Smaller models (1.5b–7b) sometimes write prose instead of a tool call, especially mid-task. Grom handles this in two ways: it re-prompts once when it detects prose where a tool call was expected, and it enables Ollama's structured JSON output mode after the first tool use to constrain subsequent responses. Even so, if you're doing complex agentic tasks, a 14b+ model will be significantly more reliable.

### MCP Tool Use

Connect any [Model Context Protocol](https://modelcontextprotocol.io/) server and Grom's model can call its tools during chat. Tool calls stream live with a badge showing which tool is running. Configure servers via `grom.mcpServers`.

### Code Actions
Every code block Grom writes has one-click actions:

| Button | What it does |
|---|---|
| **Diff** | Compare with your current file before committing |
| **Apply** | Replace your selection (or whole file) instantly |
| **Insert** | Paste at cursor |
| **Run** | Send directly to the active terminal |
| **✓ Accept** | Apply the suggested change to the whole file |
| **✕ Reject** | Dismiss the suggestion |
| **💾 Save** | Preview a diff then write the file (shown when Grom names the file with `### path/file.ext`) |

### Background Notifications
When Grom finishes a task while the panel is hidden (e.g. you switched to a different view), a VS Code notification appears so you know it's done without having to check. On Windows, a desktop toast notification is also fired so it surfaces even when VS Code is minimised.

### Terminal Integration
- **Debug This** — right-click any terminal selection and send it to Grom
- **Auto-capture** — Grom watches for errors in terminal output and offers to debug them automatically
- **`@terminal`** — type `@terminal` in any message to include recent terminal output as context

### Slash Commands

Type `/` to open the command menu. Built-in commands:

| Command | What it does |
|---|---|
| `/explain` | Explain the active file's code |
| `/refactor` | Refactor for clarity and best practices |
| `/fix` | Find and fix bugs |
| `/tests` | Write unit tests |
| `/docs` | Write documentation |
| `/review` | Full code review |
| `/commit` | Generate a git commit message |
| `/compose` | Multi-file edit mode |
| `/search <query>` | Web search via DuckDuckGo |
| `/<name>` | Any `.grom/<name>.md` file in your workspace |

You can add your own shortcuts in settings under `grom.presets`.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+G` / `Cmd+Shift+G` | Open Grom |
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Inline edit (requires selection) |
| `Ctrl+Shift+Y` / `Cmd+Shift+Y` | Accept inline diff |
| `Ctrl+Shift+U` / `Cmd+Shift+U` | Reject inline diff |
| `Ctrl+Shift+O` / `Cmd+Shift+O` | Open Compose mode |
| `Enter` | Send message |
| `Shift+Enter` | New line |

---

## Context Window

The radial circle in the toolbar shows how full your context window is. Hover it to see the exact token count and window size. When it fills up, type `/compact` or click the compact option in the `/` menu to trim old messages — Grom marks the cut point in the chat so you always know what's been removed.

The default context window is 8192 tokens. Set the exact value for your model via `grom.modelPricing` to get an accurate reading.

---

## Requirements

You need a local LLM server running. Grom works out of the box with:

- [Ollama](https://ollama.com/) — recommended, free, runs most open models
- [LM Studio](https://lmstudio.ai/) — great UI for managing models

No API keys. No subscriptions. No data leaving your machine.

**Recommended models:**
- Chat: `qwen2.5-coder:32b`, `deepseek-coder-v2`, `llama3.1`
- Autocomplete: `qwen2.5-coder:1.5b`, `deepseek-coder:1.3b`, `starcoder2:3b`
- Embeddings (semantic RAG): `nomic-embed-text`, `mxbai-embed-large`

---

## Settings

| Setting | Description | Default |
|---|---|---|
| `grom.apiUrl` | Your local server URL | `http://127.0.0.1:11434` |
| `grom.model` | Chat model name | `qwen2.5-coder` |
| `grom.useOllamaFormat` | Use Ollama's chat format | `true` |
| `grom.autocomplete` | Enable inline completions | `true` |
| `grom.autocompleteModel` | Dedicated FIM model for completions | _(chat model)_ |
| `grom.languageModels` | Per-language model overrides | `{}` |
| `grom.ragEnabled` | Enable codebase indexing | `true` |
| `grom.embeddingModel` | Ollama model for semantic RAG | _(blank)_ |
| `grom.mcpServers` | MCP server definitions | `[]` |
| `grom.customProviders` | Add your own provider endpoints (supports optional `apiKey`) | `[]` |
| `grom.robotAnimations` | Enable Grom's animations | `true` |
| `grom.theme` | UI theme: Grom, Cyberpunk, Classic, High Contrast | `Grom` |
| `grom.presets` | Custom prompt shortcuts shown in `/` menu | see defaults |
| `grom.customGreeting` | Override empty-state greeting text | _(blank)_ |
| `grom.customLogo` | Override chat logo (URL, data URI, or emoji) | _(blank)_ |
| `grom.modelPricing` | Context window sizes and pricing per model (used for the context circle) | see defaults |
| `grom.agentEnabled` | Enable the agentic loop | `true` |
| `grom.agentMaxIterations` | Max tool-call rounds per task | `20` |

### Per-Language Model Routing

Use different models for different languages. In your VS Code settings (`grom.languageModels`):

```json
{
  "python": "qwen2.5-coder:1.5b",
  "typescript": "qwen2.5-coder:32b",
  "rust": "deepseek-coder-v2"
}
```

Keys are VS Code language IDs. Applies to both chat and autocomplete.

### Adding a Custom Provider

In your VS Code settings (`grom.customProviders`):

```json
[
  {
    "name": "My Local Server",
    "url": "http://127.0.0.1:8080",
    "useOllamaFormat": false
  },
  {
    "name": "Gemini",
    "url": "https://generativelanguage.googleapis.com/v1beta/openai",
    "useOllamaFormat": false,
    "apiKey": "YOUR_GEMINI_API_KEY"
  }
]
```

The `apiKey` field is optional — leave it out for local servers. When set, it is sent as `Authorization: Bearer <key>` on every request.

### MCP Servers

```json
[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
  }
]
```

### Custom Prompt Files

Create `.grom/` in your workspace root. Any `.md` file inside becomes a slash command:

```
.grom/
  deploy.md       → /deploy
  review-pr.md    → /review-pr
  standup.md      → /standup
```

Commit `.grom/` to git to share prompts with your whole team.

---

## License

PolyForm Noncommercial 1.0.0 — free to use, free to modify, free to share. Not for commercial use. See [LICENSE](https://github.com/ryanjames85/grom/blob/main/LICENSE).

---

*Built in Ireland. Shipped with care.*
