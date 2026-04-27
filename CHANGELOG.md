# Changelog

All notable changes to Grom are documented here.

---

## [0.1.2] — 2026-04-28

### Internal
- Made `.btn-cancel` self-contained, removing dependency on `.icon-btn`

---

## [0.1.1] — 2026-04-27

### Internal
- Removed all debug logging left over from session rename development
- Moved all inline styles out of `webview.html` and `main.js` into named CSS classes in `styles.css`
- Fixed `copy-media` build script referencing stale `src/webview/` paths
- Replaced SVG with PNG in README for marketplace compatibility
- Converted extension icon to PNG

---

## [0.1.0] — 2026-04-26

Initial public release.

### Core chat
- Streaming chat panel with Markdown rendering and syntax highlighting
- PLAN / BUILD mode toggle — adjusts system prompt tone for architecture vs. implementation
- Multiple sessions with rename, delete, compact, export to Markdown, and import from Markdown
- Session auto-title via a quick LLM summarisation call on the second message
- User memory — persistent custom instructions injected into every new session
- Per-session system prompt override
- Conversation search — highlights matching messages across the chat history
- Prompt presets — one-click prompt snippets, customisable in settings and via `.grom/*.md` files
- Clipboard image paste — paste screenshots directly into the chat input
- Themes — Grom (default), Cyberpunk, Classic, High Contrast
- Robot animations — idle thoughts, eye-tracking, sleep mode (can be disabled)
- Context window indicator — radial progress circle shows token usage

### Agentic loop
- Built-in file tools: `read_file`, `write_file`, `delete_file`, `list_directory`, `search_files`, `run_terminal`
- MCP (Model Context Protocol) server support — connects to any stdio MCP server configured in settings
- Tool name namespacing (`serverName__toolName`) to avoid collisions across servers
- **Per-action approval** — destructive tools (write, delete, terminal) and all MCP tools pause for Allow / Allow All / Deny before execution
- **Agent diff view** — proposed file writes shown in VS Code's native diff editor before applying
- Task log panel — live record of all tool calls with args and result snippets
- Agent loop hardening: prose suppression in JSON mode, one reprompt nudge when model drifts mid-task

### Context providers (@ mentions)
- `@filename` — attaches a workspace file by fuzzy name match
- `@problems` — all current VS Code errors and warnings
- `@git` — uncommitted diff (`git diff HEAD`)
- `@terminal` — recent terminal output
- `@url:https://…` — fetches and strips a web page
- `@docs` / `@docs:name` — searches indexed documentation sources

### RAG
- Workspace codebase indexing with TF-IDF + optional semantic embeddings via Ollama
- Bigram matching, exact-substring 2× boost, filename 1.3× boost
- Automatic re-index on file change (3-second debounce)
- One-time prompt to configure an embedding model if none is set

### Docs indexing
- Crawls configured documentation URLs (up to 40 pages per source, same-origin only)
- TF-IDF retrieval with `@docs` context mentions
- Re-indexes on `grom.docSources` config change

### Autocomplete
- Inline ghost-text completions via VS Code's InlineCompletionItemProvider
- FIM (fill-in-the-middle) prompt format
- Adaptive debounce — slows down automatically when acceptance rate is low
- Partial accept — serves one word at a time on re-trigger
- Extra context from open same-language tabs and recently edited files
- Per-language model overrides (`grom.autocompleteLanguageModels`)

### Editor commands
- **Inline edit** (`grom.inlineEdit`) — select code, give an instruction, review diff, accept or reject
- **Composer** (`/compose`) — multi-file changes with per-file review, path-traversal guards, and undo
- **Explain / Refactor** — right-click or command palette actions that pre-fill the chat
- **Run in Terminal** — code blocks have a Run button that sends the command to the active terminal

### Settings & configuration
- Supports Ollama, LM Studio, and any OpenAI-compatible API
- Per-language model routing (`grom.chatLanguageModels`, `grom.languageModels`)
- Custom slash commands via `.grom/*.md` files in the workspace
- Web search (`/search`) via DuckDuckGo — no API key required
- Model pricing config for token cost display
- MCP server config (`grom.mcpServers`)
- Documentation sources (`grom.docSources`)

### Developer / quality
- All pure-logic modules (`rag.ts`, `docs-index.ts`, `client.ts`, `composer.ts`) are VS Code-free and unit-testable without stubs
- 96 unit tests covering session management, RAG scoring, streaming client, MCP parsing, and editor utilities
- Error boundary in webview — JS crashes show a dismissable banner with a Reload button instead of a silent blank panel
- Webview HTML extracted to `media/webview.html` — readable and editable without recompiling TypeScript
- All source files documented with file headers and function-level JSDoc

### Configuration reference

| Setting | Default | Description |
|---|---|---|
| `grom.apiUrl` | `http://127.0.0.1:11434` | LLM server base URL |
| `grom.model` | `qwen2.5-coder` | Chat model |
| `grom.useOllamaFormat` | `true` | Use Ollama API format |
| `grom.autocomplete` | `true` | Enable inline completions |
| `grom.autocompleteModel` | _(chat model)_ | Dedicated FIM model for completions |
| `grom.ragEnabled` | `true` | Enable codebase indexing |
| `grom.embeddingModel` | _(blank)_ | Ollama model for semantic RAG (e.g. `nomic-embed-text`) |
| `grom.agentEnabled` | `true` | Enable built-in file tools in the agentic loop |
| `grom.agentMaxIterations` | `20` | Maximum tool-call rounds per message |
| `grom.mcpServers` | `[]` | MCP server definitions |
| `grom.docSources` | `[]` | Documentation URLs to crawl and index |
| `grom.customProviders` | `[]` | Additional LLM providers shown in the provider picker |
| `grom.theme` | `Grom` | UI theme |
| `grom.robotAnimations` | `true` | Enable robot animations |
| `grom.presets` | _(defaults)_ | Prompt preset buttons |
| `grom.customGreeting` | _(blank)_ | Override empty-state greeting text |
| `grom.customLogo` | _(blank)_ | Override chat logo (URL, data URI, or emoji) |
