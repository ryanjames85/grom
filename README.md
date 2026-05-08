# Grom

![Grom](resources/icon.png)

**[Documentation](https://ryanjames85.github.io/grom)** · **[Marketplace](https://marketplace.visualstudio.com/items?itemName=RyanConnolly.grom)** · **[GitHub](https://github.com/ryanjames85/grom)**

## BYOLLM

**Bring Your Own LLM. Your model. Your machine. Your rules.**

---

Grom is a privacy-first AI coding assistant for VS Code that runs entirely on your local hardware.

No cloud. No account. No telemetry. No dark patterns. No upsell.

Just you, your code, and Grom.

---

## Why Grom?

Other tools say they support local models. Try it and you'll find yourself three config screens deep, staring at a broken connection, wondering why the cloud path is suspiciously smooth.

Grom was built because local AI shouldn't require fighting your tools.

If Ollama is running, Grom works. That's the whole deal.

---

## Meet Grom

Grom is the little robot who lives in your sidebar. He watches your cursor, thinks while you type, and goes to sleep when you're idle. He's not a feature — he's the soul of the tool.

His antenna tells you what's happening before you read a word:

| State | What it means |
| --- | --- |
| Gold, antenna bent | PLAN mode — thinking broadly |
| Blue, antenna straight | BUILD mode — focused, ready to ship |
| Antenna physically bouncing up and down | Model is generating a response |
| Faded, antenna drooping | Your server isn't running or isn't connected |
| Glitching | Server returned an error |
| Eyes closed, thought bubble | Idle — wake him up by typing |

---

## Two Modes, One Purpose

**PLAN mode** — warm honey gold. Grom thinks architecturally. Break down problems, plan features, talk through ideas before a single line is written.

**BUILD mode** — focused blue. Grom is direct and implementation-ready. Write code, fix bugs, ship things.

**⚡ Tools** — a toggle in the toolbar, only available in BUILD mode. Off by default so plain chat stays fast. When off the button is muted; when on it fills solid with the accent colour — no ambiguity. Turn it on when you want Grom to read and write files, run terminal commands, and call MCP tools. Each session remembers its own Tools state.

The UI colour shifts with the mode. So does Grom's personality.

---

## What Grom Does

### Providers

Grom works with local servers out of the box — no account, no key. Cloud providers are supported optionally if you want to bring your own key.

**Built-in:**

| Provider | Notes |
| --- | --- |
| **Ollama** | Local, `127.0.0.1:11434` — recommended |
| **LM Studio** | Local, `127.0.0.1:1234` |
| **Open Code** | Local |
| **OpenAI** | GPT-4o, o1, o3-mini |
| **Anthropic** | Claude Sonnet, Claude Opus |
| **Groq** | Llama 3, Mixtral — fast inference |
| **Mistral** | Mistral Large, Small, Codestral |
| **Gemini** | Gemini 2.5 Pro, Flash — Google AI API |

**Custom providers** — add any OpenAI-compatible endpoint or Anthropic-compatible proxy via `grom.customProviders`. Gemini, OpenRouter, Together AI, and most other cloud APIs work out of the box. See [Adding a Custom Provider](#adding-a-custom-provider) below.

Switch providers and models without leaving the panel. Each session remembers its own model — switching sessions restores it automatically. Grom detects model capabilities automatically — vision, tool use, and reasoning models each show their own icon. Vision models (llava, qwen2-vl, etc.) can receive images via the `+` button or paste.

### Knows What You're Working On

Use `@` in any message to attach context:

| Mention | What it includes |
| --- | --- |
| `@selection` | Currently selected text in the active editor |
| `@filename` | Any workspace file — open tabs shown first |
| `@problems` | All current VS Code errors and warnings |
| `@git` | Your current uncommitted diff (`git diff HEAD`) |
| `@terminal` | Recent output from the integrated terminal |
| `@url:https://...` | Fetches a web page and includes its text |

Auto-context is on by default — Grom reads the file you have open automatically.

### Inline Autocomplete

Ghost-text completions as you type, powered by FIM models.

- **Adaptive debounce** — speeds up when you're accepting, slows down when you're not
- **Word-by-word accept** — Tab accepts the next word; keep pressing for more
- **Dedicated model** — set a fast FIM model (e.g. `qwen2.5-coder:1.5b`) separate from your chat model
- **Per-language routing** — different models for different languages via `grom.languageModels`
- **Toggle** — click `✦ Grom` in the status bar to enable/disable instantly

### Inline Edit

Select code, press `Ctrl+Shift+I`, describe what you want. Grom rewrites it and opens a diff. Accept or Reject.

### Compose — Multi-file Edit

Press `Ctrl+Shift+O` or type `/compose`. Describe changes across your codebase. Review per-file or apply everything at once. Undo the whole run with one click.

Every code block in compose format gets a **💾 Save** button — opens a diff showing exactly what will change.

### Agentic Loop

Enable **⚡ Tools** in the toolbar (BUILD mode only) and Grom doesn't just reply once — it works through tasks step by step, calling tools based on what the last one returned.

| Tool | What it does |
| --- | --- |
| `read_file` | Read any file in your workspace |
| `write_file` | Write or create a file, then open it in the editor |
| `list_directory` | List files and folders at a path |
| `delete_file` | Delete a file |
| `search_files` | Search workspace files by regex pattern |
| `run_terminal` | Run a shell command and return its output |
| `browse_web` | Fetch a live web page and return its text content |

> **Note on model size:** Tool call accuracy scales with model size. 32B+ models call tools reliably. Smaller models (1.5B–7B) occasionally write prose instead of a tool call. Grom handles this by re-prompting once when it detects prose where a tool call was expected, and enables structured JSON mode after the first tool use. For complex agentic tasks, 14B+ is significantly more reliable.

### MCP Tool Use

Connect any [Model Context Protocol](https://modelcontextprotocol.io/) server and Grom's model can call its tools during chat. Tool calls stream live with a badge showing which tool is running. Configure via `grom.mcpServers`.

### Grom Memory

Persistent memory injected into every new chat — like custom instructions, but yours.

```text
Only use TypeScript.
Never push code directly, always explain changes first.
My stack is React 18 + Express.
```

Open it with the brain icon in the header.

### Conversations

- Multiple chat sessions, persistent across restarts
- **Prompt history** — up/down arrow in the input cycles your previously sent messages
- `/compact` trims long histories — a divider marks exactly where the cut was made
- Export any conversation as `.md`, import it back to continue
- Search through any conversation with live highlighting
- Per-session system prompt override via the chat bubble icon
- **Context window indicator** — the radial circle in the footer shows token usage; hover for exact counts and estimated cost (when pricing is configured in `grom.modelPricing`)

### Custom Prompt Files

Create `.grom/*.md` files in your workspace. A file at `.grom/deploy.md` becomes `/deploy` — shareable with your whole team via git.

---

## Slash Commands

Type `/` to open the command menu:

| Command | What it does |
| --- | --- |
| `/explain` | Explain the active file |
| `/refactor` | Refactor for clarity and best practices |
| `/fix` | Find and fix bugs |
| `/tests` | Write unit tests |
| `/docs` | Write documentation |
| `/review` | Full code review |
| `/commit` | Draft a commit message from your actual `git diff` — no `@git` needed |
| `/compose` | Multi-file edit mode |
| `/search <query>` | Web search via DuckDuckGo |
| `/<name>` | Any `.grom/<name>.md` file in your workspace |

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+G` / `Cmd+Shift+G` | Open Grom |
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Inline edit (requires selection) |
| `Ctrl+Shift+Y` / `Cmd+Shift+Y` | Accept inline diff |
| `Ctrl+Shift+U` / `Cmd+Shift+U` | Reject inline diff |
| `Ctrl+Shift+O` / `Cmd+Shift+O` | Open Compose mode |
| `Enter` | Send message |
| `Shift+Enter` | New line |

---

## Requirements

Grom works with local servers (no account or key needed) or cloud providers (bring your own key).

**Editors:**

Grom runs in VS Code and any VS Code-compatible editor:

- [Visual Studio Code](https://code.visualstudio.com/) — recommended
- [Google Antigravity](https://antigravity.dev/) — confirmed working
- Cursor, Windsurf, and other VS Code forks should work too

**Local — runs entirely on your machine:**

- [Ollama](https://ollama.com/) — recommended, free, runs most open models
- [LM Studio](https://lmstudio.ai/) — great UI for managing models

**Cloud — optional, requires an API key from each provider:**

- [OpenAI](https://platform.openai.com/) — GPT-4o, o1, o3-mini
- [Anthropic](https://console.anthropic.com/) — Claude Sonnet, Claude Opus
- [Gemini](https://aistudio.google.com/), [Groq](https://console.groq.com/), [Mistral](https://console.mistral.ai/), [OpenRouter](https://openrouter.ai/), and any OpenAI-compatible endpoint

**Recommended local models:**

| Use | Model |
| --- | --- |
| Chat | `qwen2.5-coder:32b`, `deepseek-coder-v2`, `llama3.1` |
| Autocomplete | `qwen2.5-coder:1.5b`, `deepseek-coder:1.3b`, `starcoder2:3b` |
| Embeddings (RAG) | `nomic-embed-text`, `mxbai-embed-large` |

---

## Settings

| Setting | Description | Default |
| --- | --- | --- |
| `grom.apiUrl` | Your local server URL | `http://127.0.0.1:11434` |
| `grom.model` | Chat model name | `qwen2.5-coder` |
| `grom.useOllamaFormat` | Use Ollama's chat format | `true` |
| `grom.autocomplete` | Enable inline completions | `true` |
| `grom.autocompleteModel` | Dedicated FIM model | *(chat model)* |
| `grom.languageModels` | Per-language model overrides | `{}` |
| `grom.ragEnabled` | Enable codebase indexing | `true` |
| `grom.embeddingModel` | Ollama model for semantic RAG | *(blank)* |
| `grom.mcpServers` | MCP server definitions | `[]` |
| `grom.customProviders` | Custom provider endpoints; keys stored securely in OS keychain | `[]` |
| `grom.robotAnimations` | Enable Grom's animations | `true` |
| `grom.theme` | UI theme: Grom, Cyberpunk, Classic, High Contrast | `Grom` |
| `grom.agentEnabled` | Master switch — disables tools globally when off | `true` |
| `grom.toolsEnabledByDefault` | Start every new session with ⚡ Tools already on | `false` |
| `grom.agentMaxIterations` | Max tool-call rounds per task | `20` |
| `grom.fontSize` | Chat panel font size: `small`, `medium`, `large` | `medium` |
| `grom.debugLogging` | Write diagnostics to the Grom Output channel | `false` |

### Per-Language Model Routing

```json
{
  "python": "qwen2.5-coder:1.5b",
  "typescript": "qwen2.5-coder:32b",
  "rust": "deepseek-coder-v2"
}
```

### Adding a Custom Provider

OpenAI and Anthropic are built-in — select them from the provider dropdown. Use `grom.customProviders` for everything else.

API keys are **never stored in settings files**. Grom prompts for a key the first time you select a provider that needs one, then stores it securely in the OS keychain (Windows Credential Manager / macOS Keychain / libsecret on Linux). Click the lock icon next to the provider dropdown at any time to update or clear a key.

```json
[
  { "name": "OpenRouter", "url": "https://openrouter.ai/api" },
  { "name": "Together",   "url": "https://api.together.xyz" },
  { "name": "Local (no key)", "url": "http://127.0.0.1:8080", "authType": "none" },
  { "name": "Claude proxy",   "url": "https://my-proxy.example.com", "providerFormat": "anthropic" }
]
```

For most cloud providers, `name` and `url` are all you need. Optional fields:

| Field | Values | Default | When to set |
| --- | --- | --- | --- |
| `providerFormat` | `openai`, `anthropic` | `openai` | Only for a self-hosted Claude-compatible proxy |
| `authType` | `bearer`, `x-api-key`, `none` | `bearer` | Set to `none` for keyless local servers |
| `useOllamaFormat` | `true`, `false` | `false` | Only for servers using Ollama's `/api/chat` format |

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

---

## Context Window

The radial circle in the toolbar shows how full your context window is. Hover it to see the exact token count and window size. When it fills up, `/compact` trims old messages — Grom marks the cut point so you always know what's been removed.

Set the exact context window size for your model via `grom.modelPricing` for an accurate reading.

---

## License

[PolyForm Shield 1.0.0](LICENSE) — free to use for any purpose, including commercially. You may not redistribute it as a competing product.

---

*BYOLLM. Built in Ireland.*
