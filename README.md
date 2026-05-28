# Grom

![Grom](resources/icon.png)

**[Documentation](https://ryanjames85.github.io/grom)** · **[Marketplace](https://marketplace.visualstudio.com/items?itemName=RyanConnolly.grom)** · **[GitHub](https://github.com/ryanjames85/grom)**

## BYOLLM

**Bring Your Own LLM. Your model. Your machine. Your rules.**

---

Grom is a local-first agent harness and AI coding assistant for VS Code. Bring your own LLM — your code never leaves your machine.

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

When Grom goes idle he does two useful things quietly in the background: for Ollama users, he sends a keep-alive ping so your model stays loaded in VRAM and is ready instantly when you return. And if the file you have open has errors, he shows the count in his thought bubble — a gentle nudge without interrupting your flow.

His antenna tells you what's happening before you read a word:

| | State | What it means |
| :---: | --- | --- |
| ![PLAN](resources/grom-plan.png) | Gold, antenna bent | PLAN mode — thinking broadly |
| ![BUILD](resources/grom-build.png) | Blue, antenna straight | BUILD mode — focused, ready to ship |
| ![Generating](resources/grom-build.png) | Antenna bouncing *(animated)* | Model is generating a response |
| ![Disconnected](resources/grom-disconnect.png) | Grey, unplugged | Your server isn't running or isn't connected |
| ![Error](resources/grom-error.png) | Glitching | Server returned an error |
| ![Idle](resources/grom-idle.png) | Eyes closed, thought bubble *(animated)* | Idle — keeps model in VRAM; shows error count if active file has issues |
| ![Float PLAN](resources/grom-float-plan.svg) | Gold, riding a cloud | Floating window — PLAN mode detached from the sidebar |
| ![Float BUILD](resources/grom-float-build.svg) | Blue, riding a cloud | Floating window — BUILD mode detached from the sidebar |
| ![Mic PLAN](resources/grom-mic-plan.svg) | Gold, sound waves | Voice recording active — PLAN mode listening |
| ![Mic BUILD](resources/grom-mic-build.svg) | Blue, sound waves | Voice recording active — BUILD mode listening |

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
| **Open Code** | `api.opencode.ai` — requires API key |
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
| `@docs` | Searches all indexed documentation sources (`grom.docSources`) |
| `@docs:name` | Searches a specific doc source by name |

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

### Documentation Sources

Index web documentation so you can reference it with `@docs` in any message. Grom crawls the URLs you configure, strips the HTML, and builds a searchable index — no copy-pasting docs into context. Any HTTP/HTTPS URL works, including local dev servers (`http://localhost:3000/docs`).

```json
"grom.docSources": [
  { "name": "react",   "url": "https://react.dev/reference" },
  { "name": "mdn",     "url": "https://developer.mozilla.org/en-US/docs/Web/API" },
  { "name": "mylib",   "url": "http://localhost:3000/docs" }
]
```

Each source needs a `name` (short identifier) and a `url` (root page to start crawling). Grom follows links within the configured path only, up to 40 pages per source. Indexing runs at startup and whenever `grom.docSources` changes.

> **Note:** Grom fetches pages directly — it does not run JavaScript. Sites that render content client-side (pure SPAs) will return little or no usable text. Use a server-side rendered URL, a static export, or a local dev server instead.

Once indexed, use `@docs` to search all sources or `@docs:name` to target one:

```text
@docs how do I use useEffect?
@docs:react suspense boundaries
```

### Voice Input

Speak your prompts instead of typing them. Grom captures audio locally and transcribes it on-device using Whisper — nothing is ever sent to a server.

- **Mic button** in the toolbar (enable in Settings → Voice Input on first use)
- **Push-to-talk** — click to start recording, click again to stop and transcribe
- **Six Whisper models** — from Tiny EN (~40 MB, fast) up to Small (~244 MB, best accuracy), downloaded on demand. English-only `.en` variants are faster and more accurate for English speakers
- **Model pre-warming** — the selected model loads silently when Grom starts so the first utterance transcribes without delay
- **No account, no cloud** — audio stays on your machine. The mic is optional and designed for those who want or need voice input as an accessibility tool.
- Requires a one-time ffmpeg download (~50 MB), managed entirely within VS Code. Remove it anytime from Settings → Voice Input.

> **Platform support:** Windows (DirectShow), macOS (avfoundation), Linux (PulseAudio/PipeWire, ALSA fallback).

### Floating Panel

Pop Grom out of the sidebar into a standalone window — useful for multi-monitor setups where you want Grom on a second screen while keeping your file tree visible.

- Click the ![float](resources/icon-float.svg) button in the header to detach Grom into its own window
- The sidebar becomes a passive mirror — the **"floating"** pill and a banner confirm it's active
- The floating window is fully functional — chat, voice input, model switching, all modes work
- Grom's icon changes to the **cloud variant** in the floating window so you always know which panel is live
- The mic changes Grom's face to the **listening variant** while recording
- Close the floating window at any time — the sidebar restores automatically
- The floating panel **persists across VS Code restarts** — it reopens exactly where you left it

> The sidebar input is disabled while floating is active. Click **Close floating** in the banner to return to the sidebar.

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
- **Context window indicator** — the radial circle in the toolbar shows token usage; hover for exact counts and estimated cost (when pricing is configured in `grom.modelPricing`)

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
| `Ctrl+Shift+M` / `Cmd+Shift+M` | Toggle voice recording (when mic is enabled) |
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
| `grom.embeddingModel` | Embedding model for semantic RAG — works with Ollama and LM Studio | *(blank)* |
| `grom.mcpServers` | MCP server definitions | `[]` |
| `grom.customProviders` | Custom provider endpoints; keys stored securely in OS keychain | `[]` |
| `grom.robotAnimations` | Enable Grom's animations | `true` |
| `grom.theme` | UI theme: Grom, Cyberpunk, Classic, High Contrast | `Grom` |
| `grom.agentEnabled` | Master switch — disables tools globally when off | `true` |
| `grom.toolsEnabledByDefault` | Start every new session with ⚡ Tools already on | `false` |
| `grom.agentMaxIterations` | Max tool-call rounds per task | `20` |
| `grom.fontSize` | Chat panel font size: `small`, `medium`, `large` | `medium` |
| `grom.debugLogging` | Write diagnostics to the Grom Output channel | `false` |
| `grom.hints` | Show in-chat hint cards (e.g. context window full warning) | `true` |
| `grom.modelPricing` | Per-model token pricing and context window size overrides | `{}` |
| `grom.docSources` | Documentation sources available via `@docs` | `[]` |
| `grom.presets` | Custom prompt presets shown in the `/` menu | `[]` |
| `grom.chatLanguageModels` | Per-language chat model overrides (takes priority over `grom.languageModels`) | `{}` |
| `grom.autocompleteLanguageModels` | Per-language autocomplete model overrides (takes priority over `grom.languageModels`) | `{}` |
| `grom.customGreeting` | Override the greeting shown in the empty chat state | *(blank)* |
| `grom.customLogo` | Override the chat logo — URL, `data:` URI, or emoji | *(blank)* |
| `grom.voiceInput` | Enable the mic button in the toolbar | `false` |
| `grom.voiceModel` | Whisper model: `tiny.en`, `tiny`, `base.en`, `base`, `small.en`, `small` | `tiny.en` |
| `grom.voiceSensitivity` | Mic energy gate (RMS threshold). Raise if phantom transcriptions appear; lower for quiet mics | `0.010` |
| `grom.ffmpegPath` | Path to a custom ffmpeg binary (skips the built-in download) | *(blank)* |

### Per-Language Model Routing

`grom.languageModels` sets a model for a language in both chat and autocomplete. Use `grom.chatLanguageModels` or `grom.autocompleteLanguageModels` to set them independently — these take priority when set.

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
