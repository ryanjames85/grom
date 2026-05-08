# Changelog

All notable changes to Grom are documented here.

---

## [0.3.7] — 2026-05-08

### New

- **⚡ Tools toggle** — agent tools are now off by default; a new Tools button in the BUILD mode toolbar enables file read/write, terminal, and MCP tools per session. Keeps plain chat fast — no tool schema is sent to the model unless you explicitly turn it on. Greyed out in PLAN mode. Each session remembers its own state. The button fills solid with the accent colour when on so the active state is unambiguous.

### Fixed

- **MCP tools respect the toggle** — when Tools is off, MCP tools are now also excluded from the agent loop; previously only built-in tools were gated and MCP tools were still injected.
- **Gemma 4 capability detection** — `gemma-4` / `gemma4` added to the vision and tools name-based lists; all Gemma 4 variants are multimodal and support function calling but LM Studio reports no explicit capability fields, so name-based is the only detection path.
- **LM Studio tool detection** — `tool_calls` (LM Studio's field name) is now recognised alongside `tool_use` and `function_calling`; previously LM Studio models with explicit capability entries were not flagged as tool-capable.
- **Single request for OpenAI-compat** — `getCapabilities()` now reuses the `/v1/models` response already fetched by `getModels()` instead of making a second identical network call; eliminates a redundant round-trip on every connect for LM Studio, OpenAI, Groq, Gemini, and all custom providers.
- **Session migration** — upgrading from v0.3.6: only sessions with conversation history are migrated to `agentEnabled = true`; empty sessions get the new default-off behaviour instead of appearing with Tools already on.
- **Polling during generation** — the connection status check no longer fires while the model is generating; interval bumped from 15 s to 60 s. Prevents single-threaded local servers (LM Studio) from being interrupted mid-response.

---

## [0.3.6] — 2026-05-08

### New

- **System prompt dot** — a blue dot appears on the session system prompt button (chat bubble icon) whenever a custom prompt is active; the dot clears automatically when the prompt is removed
- **Agent undo** — after an agentic run completes, an **Undo agent changes** button appears on the final message; clicking it opens a multi-select picker so you can choose exactly which files to revert; files that didn't exist before the run are deleted, existing files are restored to their pre-run content
- **Autocomplete debounce persistence** — the adaptive debounce value (tuned automatically based on your accept rate) now survives restarts; restored from extension state so the tuning doesn't reset every session; status bar tooltip shows current accept rate and debounce interval

### Fixed

- **Mini-Grom logo on new session** — the small robot icon in the panel header now correctly shows the Planning (gold) logo when opening a new session; previously it showed the Build (blue) logo due to a state-cache short-circuit
- **Disconnect logo** — replaced the old "not connected" SVG with a cleaner `grom-disconnect.svg`

### Changed

- Logo alignment refined — PLAN and BUILD logos now use per-mode CSS positioning so the Grom face stays the same visual size when switching modes
- README Grom state table updated — antenna states are described in plain language ("Antenna physically bouncing up and down" instead of "Antenna bobbing")

---

## [0.3.5] — 2026-05-05

### New

- **Per-session model** — each chat session remembers which model it was using; switching sessions restores the correct model automatically
- **Ollama vision** — images are now correctly passed to Ollama vision models (llava, qwen2-vl, etc.) using Ollama's native image format; non-vision models show a brief warning
- **Memory panel polish** — brain icon shows an amber dot when memory is set; live token counter in the footer; auto-saves after 800ms so edits are never lost; Cancel reverts to the previous content

### Fixed

- Custom greeting (`grom.customGreeting`) is now validated — blocked terms and strings over 200 characters fall back to the default greeting silently

---

## [0.3.4] — 2026-05-05

### New

- **Jupyter notebook support** — `.ipynb` files are indexed by RAG and readable by the agent; cell source is extracted and presented as readable code
- **Font size setting** — `grom.fontSize` (`small` / `medium` / `large`) controls the chat panel font size; applies immediately without reload
- **Documentation site** — [ryanjames85.github.io/grom](https://ryanjames85.github.io/grom); covers features, providers, @ context, and quick start
- **Gemini built-in provider** — select Gemini from the provider dropdown; prompts for Google AI API key on first use; supports Gemini 2.5 Pro, Flash, and other models via the OpenAI-compatible endpoint
- **Debug logging** — `grom.debugLogging` setting writes timestamped diagnostics to the Grom Output channel (View → Output → Grom); useful for reporting issues in GitHub Discussions

### Fixed

- **Open Grom Settings** button in the settings panel now correctly filters to Grom's settings in both development and marketplace installs

### Changed

- README links updated; license description corrected to PolyForm Shield

---

## [0.3.3] — 2026-05-04

### New

- **`@selection`** — attach the currently selected text in the active editor as context; shows first in the `@` picker with a description; includes language tag for syntax-aware responses
- **Groq built-in provider** — select Groq from the provider dropdown; prompts for API key on first use (stored in OS keychain); supports all Groq-hosted models via their OpenAI-compatible API
- **Mistral built-in provider** — same pattern; connects to `api.mistral.ai` including Mistral Large, Mistral Small, and Codestral
- **First-run welcome message** — new installs see a welcome card with setup instructions and the Grom icon; only shown once (always shown in development mode for testing)

---

## [0.3.2] — 2026-05-03

### New

- **Smart @ mention picker** — open editor tabs are surfaced first in the file picker with an "open" badge; workspace files follow; results update as you type
- **Indexing indicator** — a pulsing dot in the header appears while the RAG index is being built; disappears automatically when indexing completes
- **Task log deep links** — file paths in the task log are rendered as clickable links that open the file in the editor

### Fixed

- **Agent tool result history** — the assistant message and the tool result are now pushed to `session.history` after each tool call so multi-step agent runs keep full context across iterations
- **MCP server handshake** — agent loop now calls `mcp.waitForReady()` before enumerating tools; prevents a race where the tool list was empty on the first message after VS Code load
- **Thinking token streaming** — accumulated text is streamed live as `<think>…</think>` content; prose check no longer fires on non-thinking responses
- **Path traversal hardening** — `safePath` in `builtin-tools.ts` now also blocks Windows absolute paths (e.g. `C:\…`), not just `../` traversal
- **`search_files` exclude** — `node_modules` and other blocked dirs are now passed as a glob exclude to ripgrep, reducing noise; a fuzzy fallback kicks in automatically when the regex search finds no matches

### Internal

- **`mcp.waitForReady(ms)` / `mcp.isReady()`** — new `McpManager` methods; `waitForReady` races the initialisation promise against a configurable timeout so callers never block indefinitely
- **`updateCapIcons()`** — capability icon update extracted to its own function, removing a duplicated inline block
- **Agent-loop tests** — 6 new tests covering: simple chat, tool call dispatch, destructive-tool approval, tool denial, prose-suppression nudge, and plan-mode tool suppression
- **Builtin-tools tests** — 9 new tests covering: read_file (success, path traversal, absolute path, truncation), write_file, list_directory, delete_file, search_files, and run_terminal (allow + deny paths)
- **184 tests total** (up from 178)

---

## [0.3.1] — 2026-05-01

### Fixed

- **Custom provider/model dropdowns** — replaced native OS `<select>` elements with fully styled custom dropdowns; consistent look across all platforms, accent-coloured border on open, chevron animation, selected option highlighted, long model names truncate with ellipsis
- **Anthropic missing from provider list** — Anthropic disappeared from the provider dropdown after the first status update due to it being omitted from the JS rebuild; now always included
- **Narrow panel layout** — provider row wraps at ≤ 280 px (model select drops to a full-width second line); bottom input toolbar wraps at ≤ 280 px; lower-priority header icons (compact, system prompt, export, import) hide at ≤ 240 px; status label collapses to dot-only at ≤ 240 px; long words in chat messages no longer overflow

---

## [0.3.0] — 2026-05-01

### New

- **Anthropic / Claude** — built-in provider using the native `/v1/messages` API; system messages extracted to the top-level `system` field, correct SSE `content_block_delta` streaming, Anthropic image format, and a static fallback model list if `/v1/models` is unreachable
- **OpenAI built-in** — OpenAI added to the provider dropdown alongside Ollama, LM Studio, Open Code, and Anthropic; no custom provider entry needed
- **Secure API key storage** — keys are no longer stored in `settings.json`; Grom prompts on first select and stores keys in the OS keychain (Windows Credential Manager, macOS Keychain, libsecret on Linux) via VS Code SecretStorage. Existing `apiKey` entries in settings are migrated automatically on first load
- **Lock icon** — click the padlock next to the provider dropdown to update or clear a stored key at any time
- **`authType` field** — custom providers now accept `bearer` (default), `x-api-key`, or `none`; controls which auth header is sent
- **`providerFormat` field** — custom providers now accept `openai` (default) or `anthropic`; selects the correct wire format for chat requests
- **`npm run build`** — combined `copy-media + compile` shortcut for development

### Fixed

- **First-load capability detection** — when the model stored in settings is not served by the active provider (e.g. switching from Ollama to LM Studio), Grom now snaps to the first available model for capability detection instead of computing capabilities against the wrong model name and returning stale results. The active model is also persisted so subsequent loads are correct
- **`window.toggleMode` on cold start** — missing media files (`marked.min.js`, `highlight.min.js`, `github-dark.min.css`) caused `main.js` to throw before `toggleMode` was defined; fixed by ensuring `npm run build` is run as part of the dev setup

### Internal

- **`src/providers.ts`** — all provider implementations (`OllamaProvider`, `OpenAICompatibleProvider`, `AnthropicProvider`) and the `createProvider` factory extracted from `client.ts` into their own module; adding a new provider now requires one class and one line in the factory
- **`src/client.ts`** — reduced to a thin `LocalLLMClient` facade; re-exports types for backwards compatibility with all existing importers
- **18 new tests** — auth type header construction (`bearer`, `x-api-key`, `none`) and full Anthropic provider coverage (streaming, non-streaming, system message extraction, image format, models fallback, capabilities, error paths); 178 tests total

---

## [0.2.2] — 2026-04-29

### New

- **API key support** — custom providers now accept an optional `apiKey` field; sent as `Authorization: Bearer <key>` on every request, enabling cloud providers like Google Gemini to be used alongside local models

---

## [0.2.1] — 2026-04-28

### Fixed

- **Hybrid RAG** — replaced fixed-weight score blend (35% BM25 + 65% cosine) with Reciprocal Rank Fusion (RRF), eliminating the score-normalisation instability that could suppress good BM25 results
- **Semantic query embedding** — query-time embedding was silently returning null due to a missing config reference; semantic retrieval now works correctly end-to-end
- **File watcher** — re-index was triggering on every file change regardless of type; now only indexed extensions (`.ts`, `.py`, `.md`, etc.) schedule a re-index

---

## [0.2.0] — 2026-04-28

### New

- **BM25 search** — replaced TF-IDF with BM25 for significantly better keyword retrieval quality; improves RAG results for everyone with no config required
- **Composer diff review** — the 💾 Save button now opens a side-by-side diff before writing; Accept applies, Skip discards. New files are still written immediately.
- **`browse_web` agent tool** — the agentic loop can now fetch and read live web pages, enabling research, doc lookups, and API checks during tasks

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
| --- | --- | --- |
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
