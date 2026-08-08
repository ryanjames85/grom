# Changelog

All notable changes to Grom are documented here.

---

## [0.5.5] — 2026-08-08

### New

- **Tools and vision icons now reflect your model's actual capabilities** — detection is significantly more accurate for Ollama and LM Studio users. Grom now reads capability data directly from the provider rather than guessing from the model name alone. Ollama models with a function-calling chat template are detected correctly; LM Studio reports explicit `vision` and `tool_calls` flags per model when available. A long-standing bug where nearly every Ollama model was incorrectly shown as tool-capable (causing confused routing for models that don't support it) is fixed.
- **`grom.modelCapabilities` setting** — if detection still gets it wrong for your model, you can pin it. Add a partial model name as a key with the capabilities you want: `{ "my-model": { "tools": true, "vision": false } }`. Takes precedence over everything else.

### Improved

- **Tools off means fast, conversational replies** — with the Tools toggle off, Grom no longer queries the RAG index before sending your message. The codebase embedding step only runs when tools are on, keeping conversational responses instant regardless of workspace size.
- **MCP tools available immediately on startup** — MCP servers previously only registered their tools after a settings change or provider switch. Switching providers away and back was the common workaround. Tools are now available as soon as the servers finish connecting — no manual intervention needed.
- **Provider switching gives immediate feedback** — changing providers while a connection check was already running produced no visible response until the check completed. Grom now shows "Connecting…" the moment you switch and correctly waits for the new connection before updating the status.
- **Context window indicator now accurate for all Ollama model families** — Gemma, Mistral, Phi, and other non-Llama models always showed 8,192 tokens regardless of their actual context window. Grom now reads the architecture-specific key each model reports (`gemma.context_length`, `mistral.context_length`, etc.) so the circle and auto-compact threshold are both correct.
- **Active file stays in context while typing in the input box** — when the input box gained focus, VS Code fired a "no active editor" event and the file context pill disappeared mid-message. The file stays attached now.
- **Agent tells you when it hits its round limit** — reaching the maximum number of tool-call rounds previously ended silently with no explanation. Grom now posts a message so you know to continue manually.
- **`@url` mentions report HTTP errors** — a 404 or 403 from a fetched URL was silently swallowed. Grom now includes the HTTP status in the context so the model can reason about it.
- **`read_file` on binary files returns a clear error** — reading images, compiled artifacts, or `.wasm` files previously sent garbled UTF-8 to the model. Now returns a clear "binary file" message instead.
- **`run_terminal` gives a clear error when no workspace is open** — previously ran the command in the VS Code install directory if no folder was open, producing silently wrong results.

### Fixed

- **LM Studio model dropdown no longer shows embedding models or unloaded models** — the model list previously included all installed models regardless of type or load state (embedding models, unloaded LLMs). Only loaded chat/vision models now appear.
- **Compacted sessions no longer fail on LM Studio and strict local models** — sessions with compacted history sent two system messages to the model (the main prompt and the compact marker). Qwen3, Gemma4, Mistral, and other models with strict Jinja chat templates rejected this with a 400 error. All system messages are now merged into one before sending to any OpenAI-compatible provider.
- **Ollama models without tool support no longer appear blind** — two related bugs caused Gemma and similar models to lose RAG and file context when tool calling was enabled. The capability probe incorrectly flagged nearly every Ollama model as tool-capable (matching `parameter_size` as `"parameter"`), so tool definitions were sent to models whose templates don't support them. When Ollama rejected the request there was no retry path. Detection is now accurate and a retry-without-tools fallback is in place.
- **Gemma4 and strict-JSON models no longer error mid-stream** — Ollama can return a 200 OK then stream `{"error":"..."}` when a model emits malformed tool-call JSON. This was swallowed silently, leaving the model blind. Grom now detects in-stream errors and retries without tools automatically.
- **Stopping a response mid-tool-call no longer breaks the next message** — aborting during a tool call left an orphaned assistant message and tool result in history with no following user message. Providers like Anthropic and OpenAI reject this shape, causing the next turn to fail. Orphaned tail messages are now trimmed on abort.
- **`/compact` and auto-compact work reliably on long sessions** — the structured summary step could silently fail when history was very long, falling back to a bare cut marker. The extraction now stays within a safe token budget, preserving decisions, open files, and next steps.
- **`/memorise` on long sessions** — same silent failure as above. Fixed with the same budget cap.
- **Context window resets immediately on model or provider switch** — the previous model's detected context size was carried over on switch, so the indicator could show the wrong value until the next probe. It now resets the moment you switch.
- **Anthropic streaming no longer drops the final chunk** — the last content block from Claude was occasionally lost because the buffer was not flushed after the stream loop.
- **Claude 3/4 capability detection corrected** — claude-2 and claude-instant were incorrectly flagged as vision-capable. claude-opus-4, claude-sonnet-4, and claude-haiku-4 were not flagged as reasoning-capable. Both corrected.

---

## [0.5.4] — 2026-06-13

### New

- **Layered native tool calling** — Ollama models with native tool support (qwen2.5, llama3.1, mistral, etc.) now use structured function calls instead of free-form JSON text, making tool execution reliable regardless of model size. Cloud providers connected via BYOK also benefit. Grom falls back through schema-constrained JSON → plain JSON mode → heuristic parser for older models, so nothing breaks.
- **API key support for custom providers** — add an `apiKey` field to any `grom.customProviders` entry to connect to any cloud API (e.g. Google Gemini, OpenRouter, Together AI) without a built-in provider entry.
- **SSRF protection** — `browse_web` and `@url:` now block requests to private/internal network addresses (loopback, RFC-1918, link-local/AWS metadata, IPv6 unique-local). A model cannot be tricked into fetching internal services.
- **External content labelling** — content fetched via `browse_web`, `@url:`, and `@docs` is now clearly marked as untrusted external source in the model context, reducing prompt injection risk from attacker-controlled web content.

### Fixed

- **Tool denial conversation integrity** — denying a native tool call previously added a malformed assistant message (no `tool_calls` field) that caused OpenAI and Anthropic to reject the next turn. Both the denial and unknown-tool paths now produce properly formed `role:tool` messages.
- **Windows path tool calls** — commands like `.\setup.ps1` contain `\s` which is invalid JSON. The parser now sanitises unescaped backslashes and retries, so tool calls with Windows paths execute correctly.
- **Concurrent message safety** — sending a second message while the first was streaming could interleave writes to session history. Messages are now serialised through a promise queue.
- **Model/provider swap mid-session** — switching models or providers now resets the native tool calling state so the heuristic fallback re-activates for providers that don't support structured calls.
- **RAG rebuild race** — calling `build(force=true)` while indexing was in progress silently dropped the rebuild. It is now queued and runs immediately after the current build finishes.
- **Voice rapid toggle** — clicking the mic button twice quickly before ffmpeg had started could leave a silent recording process running. The state is now set before any async operations and rechecked after.
- **Reindex timer leak** — the 3-second file-change debounce timer was not cancelled on extension deactivation. It is now disposed with the extension.
- **OpenAI retry heuristic** — the retry-without-tools fallback previously matched any error containing "invalid" or "unknown", which could swallow real server errors (e.g. 503 "Service temporarily invalid"). Now only retries on explicit 400 responses with tool/function in the body.
- **Tool call ID collision** — Ollama fallback IDs used `Date.now()` (millisecond precision). Replaced with a monotonic counter.
- **`grom.toolsEnabledByDefault` removed** — dead setting; `grom.agentEnabled` is the global master switch. New sessions still start in PLAN mode with tools off — fast plain chat is the default, ⚡ Tools is opt-in per session as always.

### Security

- **Shell substitution blocked in `run_terminal`** — commands containing `$(...)` or backtick subshell syntax are rejected before execution. Chains like `npm install && npm test` are unaffected; only subshell evaluation is blocked.
- **MCP tool description sanitisation** — tool names, descriptions, and parameter descriptions from MCP servers are stripped of newlines and quote characters before being embedded in the system prompt, preventing a malicious server from injecting instructions via its metadata.

---

## [0.5.3] — 2026-06-07

### Fixed

- **Diff syntax highlighting** — the View Diff button and agent write_file diffs now correctly apply syntax highlighting for all languages. Previously used a hand-rolled extension map that fell back to plain text for anything not in the list (e.g. Dart, Lua, Erlang, OCaml, shaders). Existing files now use VS Code's own language detection directly; new files use an expanded map (~50 languages) with a ghost untitled-URI fallback for user-installed language extensions.
- **New Chat UI reset** — switching to a new chat mid-request no longer leaves the stop button visible or the thinking state active. The loadSessions handler now cleanly resets all in-flight UI state when called with `userInitiated`.
- **"Cancelled." in new chat** — aborting a request to switch sessions no longer injects a `*Cancelled.*` chunk into the new empty chat. Agent loop now exposes `silentAbort()` for programmatic session switches.
- **Session switch lag** — switching sessions no longer blocks on the model config update. The UI updates immediately; the model setting is applied as a fire-and-forget background operation.
- **Double loadSessions on model switch** — the config-change watcher no longer fires a redundant session reload when the model is changed as part of a session switch (`_suppressNextConfigReload` flag).
- **Blank duplicate sessions on rapid New Chat** — clicking New Chat on an already-blank untitled session no longer creates a second blank entry.
- **Future timestamp handling** — session last-modified dates that are ahead of the current time (clock skew, time zone edge cases) now display as "just now" instead of a negative relative time.
- **_silent flag bleed** — the `silentAbort` flag is now reset at the start of each agent run, preventing a stuck state if a previous run was aborted silently.

### New

- **Session last-modified date** — the session history list now shows a relative timestamp (e.g. "just now", "5m ago", "2h ago", "yesterday") next to each session. Fades on hover to reveal the rename and delete actions.

---

## [0.5.2] — 2026-05-27

### New

- **Floating panel** — pop Grom out of the sidebar into a standalone window. Ideal for multi-monitor setups: keep your file tree and editor visible while Grom floats on a second screen. Click the expand arrows button in the header to detach; the sidebar shows a banner and disables input while the floating window is live. Click "Close floating" or close the window to return to the sidebar.
- **Floating panel persistence** — the floating panel survives VS Code restarts. It reopens automatically and reconnects to session state.
- **Floating Grom icon** — the floating panel shows a cloud variant of Grom (gold for PLAN, blue for BUILD) so you always know which panel is the live one at a glance.
- **Mic Grom icon** — Grom's face swaps to a listening variant (with sound waves) on the main logo and mini header icon while voice recording is active. Reverts automatically when recording ends.
- **Voice in floating panel** — the mic works fully in the floating window. Audio routing follows whichever panel initiated recording; the other panel stays in sync with voice state.
- **Expanded capability detection** — broader name-based and server-caps detection for vision, tools, and reasoning across Ollama, LM Studio, and OpenAI-compatible providers. Catches models like Qwen3, Gemma 3, Llama 4, Mistral Small 3, and more that don't carry explicit capability suffixes.

### Fixed

- **Floating panel banner not clearing** — closing the floating window's title bar X now correctly sends `popoutClosed` to the sidebar even when the panel webview is already disposed at cleanup time.
- **Mic broken after floating panel closes** — closing the floating panel now resets voice state to idle in the sidebar and falls back `_voiceReply` to the sidebar webview, preventing a stuck mic state.
- **Extension host crash on panel dispose** — accessing `panel.webview` inside `onDidDispose` threw "Webview is disposed". All panel webview accesses in cleanup handlers are now wrapped in individual try-catch blocks.

---

## [0.5.1] — 2026-05-22

### Fixed

- **Mic hide/show toggle** — enabling or disabling the mic button via Settings → Voice Input now instantly reflects in the toolbar without requiring a reload. The provider now sends a `voiceInputChanged` message back to the webview after persisting the setting.
- **Transcription accuracy** — PCM chunks were being overwritten on each audio packet instead of accumulated, causing partial or incorrect transcriptions ("Firecat Blue" for "why are cats blue"). All chunks are now merged into a single buffer before being sent to Whisper.
- **Model switch deadlock** — switching the active Whisper model while a transcription was in flight left `_vpBusy` permanently set, silently blocking all future transcriptions. Changing model now resets busy state and discards the in-flight buffer.
- **Error recovery** — a worker inference error now always resets the voice UI to idle, regardless of whether the failed transcription was the final one in a session.
- **Silent audio loss on worker init failure** — PCM buffer was cleared before the worker was ready; if worker initialisation failed, the recording was discarded with no error shown. Buffer is now cleared only after the message is successfully posted.

### Improved

- **Code hygiene** — removed dead `_vpLoadedModel` variable (was written but never read). Extracted shared helpers `_vpInjectToPrompt`, `_vpFlashResult`, and `_vpMaybeWarmUp` to eliminate duplicated logic.

---

## [0.5.0] — 2026-05-21

### New

- **Voice input** — speak your prompts instead of typing them. Grom captures audio locally via ffmpeg and transcribes it on-device using OpenAI Whisper (via Transformers.js) — nothing is ever sent to a server. Push-to-talk: click mic to start, click again to transcribe. Enable from the toolbar; first use walks you through a one-time ffmpeg download.
- **Six Whisper models** — Tiny EN, Tiny, Base EN, Base, Small EN, Small; ranging from ~40 MB to ~244 MB. English-only `.en` variants are faster and more accurate for English speakers. Models download on demand and are cached locally; multiple models can be downloaded and switched without restarting.
- **Active model indicator** — the current default model is clearly marked in the picker. Selecting a model highlights it; a "Set as default" button promotes it. Downloaded models show a tick; the active model shows a filled dot.
- **Model pre-warming** — Whisper loads silently in the background when Grom starts (if the mic is enabled and a model is downloaded), so the first utterance transcribes without delay.
- **Full-utterance transcription** — the entire recording is sent to Whisper as one chunk (capped at 28 s), giving the model full context for accurate transcription. A 0.3 s silence pad is prepended to prevent Whisper from dropping the first word.
- **Mic sensitivity slider** — Settings → Voice Input exposes the energy gate (RMS threshold) as a slider. Raise it if phantom transcriptions appear from background noise; lower it for quiet microphones. Persisted to VS Code settings as `grom.voiceSensitivity`.
- **ffmpeg lifecycle management** — Settings → Voice Input lets you remove the downloaded ffmpeg binary for a full cleanup. Re-downloading works seamlessly afterwards.
- **Hide/show mic toggle** — hide the mic button from the toolbar via Settings → Voice Input; restore it anytime from the same panel. An info badge explains how to get it back if you hide it accidentally.
- **Privacy badge** — the Voice Input settings section carries a circled-i badge explaining that audio is transcribed entirely on your device and never leaves your machine — part of Grom's accessibility and privacy ethos.
- **Cross-platform audio** — Windows uses DirectShow device enumeration; macOS enumerates avfoundation devices; Linux probes for a running PulseAudio/PipeWire daemon and falls back to ALSA.

### Improved

- **Tooltip coverage** — Plan/Build mode buttons, provider dropdown, model dropdown, `+` (attach) button, and `/` (slash commands) button all now carry descriptive title tooltips. Provider options in the dropdown each carry a tooltip. Slash menu preset items and built-in commands (`/compact`, `/clear-history`) show their descriptions as tooltips.
- **Button consistency** — voice settings buttons (model picker, mic toggle) use the same style as action buttons throughout the panel. The active model and mic state are indicated with a filled background.

---

## [0.4.4] — 2026-05-17

### Fixed

- **LM Studio RAG embeddings (issue #7)** — Grom now tries the OpenAI-compatible `/v1/embeddings` endpoint as a fallback when `/api/embed` is unsupported. LM Studio returns HTTP 200 with an error body for unknown endpoints; the response body is now validated before being accepted, so Grom correctly falls through to the working endpoint. Full fallback chain: `/api/embed` → `/v1/embeddings` → `/api/embeddings` (legacy Ollama).

### New

- **`@docs` context mention** — type `@docs` in any message to search indexed documentation sources, or `@docs:name` to target a specific source. Configure sources via `grom.docSources` (name + URL pairs). Grom crawls up to 40 pages per source, staying within the configured path. Works with any HTTP/HTTPS URL including local dev servers. JS-rendered (SPA) sites are a known limitation — use a server-side rendered or statically exported URL instead.
- **`@docs` hint** — if `@docs` is used with no sources configured, Grom shows a hint card with an Open Settings button and skips the model call entirely.

### Improved

- **RAG endpoint caching** — the working embedding endpoint is detected once per session and cached. Subsequent indexing and query calls skip the failed endpoints entirely, eliminating redundant round-trips for LM Studio and other non-Ollama providers.
- **RAG incremental re-indexing** — file content is now hashed on each build call. Only files whose content changed are re-chunked and re-embedded; unchanged files keep their existing vectors. Large workspaces re-index significantly faster after file saves.
- **RAG dimension guard** — if the embedding model changes mid-session (e.g. after switching providers), query vectors with a different dimension are silently discarded and BM25 takes over, preventing silent cosine-similarity corruption.
- **RAG failure surfacing** — when an embedding model is configured but all embedding attempts fail, the status bar now reports `BM25 only (embedding unavailable)` instead of showing a healthy-looking chunk count. `getStatus()` exposes `embeddingFailed` and `semantic` flags for richer status bar tooltips.
- **Context window auto-detection for LM Studio** — `fetchContextLength` now probes four endpoints in order: `/api/show` (Ollama/LocalAI), `/api/v1/models` (LM Studio native list — `loaded_context_length`), `/v1/models` (OpenAI-compatible — `max_context_length`), `/props` (llama.cpp/llamafile). LM Studio users now get an accurate token counter instead of a silent null.
- **Context-length endpoint cache** — the first working endpoint per server URL is persisted to VS Code `globalState` and restored on restart. Subsequent connects go straight to the working endpoint; failed probes are never retried, so LM Studio logs stay clean after the first connect.
- **Docs indexer robustness** — crawl scope now stays within the configured path prefix (e.g. `/reference` won't wander to `/blog`). Failures and empty results surface in the status bar instead of silently disappearing. Partial chunks are cleaned up on error. Localhost sources skip the 80ms inter-request delay.

---

## [0.4.3] — 2026-05-14

### New

- **Slash menu filtering** — typing `/` opens the command menu; continuing to type filters the list in real time. Matches on both the display label (`/w` → Write Tests) and the slash command (`/t` → Tests). Arrow keys navigate, Tab or Enter selects, Escape closes.
- **Preset descriptions** — each default preset now shows a short description of what it does alongside the label. Custom presets support an optional `description` field.
- **`/clear-history`** — new slash command (and slash menu entry) clears prompt up/down arrow history in-memory and in global state; shows a confirmation in chat.

### Fixed

- **Resend duplicated messages** — clicking Resend now removes the old user bubble and all following messages from the DOM before resubmitting; previously only session history was trimmed, leaving stale bubbles visible. Resend button is now hidden on all but the last user message to prevent mid-conversation resend ambiguity.
- **Mini Grom logo not updating** — the header logo no longer gets stuck when switching modes or connection states once a conversation is in progress; `updateGromLogo` previously returned early when the empty-state logo element was absent.
- **`/commit` staged changes** — `/commit` now uses `git diff --cached` when staged changes exist, falling back to `git diff HEAD` when nothing is staged. Previously always used `git diff HEAD` regardless of staging state.
- **Preset label/command mismatch** — "Write Tests", "Write Docs", "Code Review" renamed to "Tests", "Docs", "Review" so labels match their slash commands.

---

## [0.4.2] — 2026-05-14

### New

- **Context window auto-detection** — Grom now reads the active model's context length directly from the provider on connect; `/api/show` (Ollama, LM Studio, LocalAI) and `/props` (llama.cpp, llamafile) are tried in order. The detected value replaces any manual `modelPricing` context override for the token counter. Cloud providers fall through silently.
- **Context hint** — when the context window reaches 80 % a Grom hint card appears in chat suggesting `/compact`; includes a one-click *Run /compact* button. Fires once per session and resets after compact or session delete. Controlled by the new `grom.hints` toggle (default on). More hint types will be added in future releases.
- **`grom.hints` setting** — boolean, default `true`; disabling it suppresses all in-chat Grom hint cards.

### Fixed

- **Gemma-4 large tool calls (issue #5)** — `write_file` calls with large content (~9 000 chars, e.g. a full Dart widget file) were silently dropped. The old Pattern 4b parser converted the Gemma-4 `<|tool_call>` format to JSON using regexes, which corrupted content containing braces, colons, and backslashes. Rewritten to parse key-value pairs directly without any JSON conversion; handles arbitrary content in both `<|"|>…<|"|>` and standard `"…"` delimiters.
- **Raw tool-call text in chat** — when the model prefixed a tool call with visible `<|tool_call>…` text, that text remained visible in the chat bubble after the tool ran. A `clearToolCallChunk` message now strips the raw token from the bubble before the *Using tool…* badge appears.

---

## [0.4.1] — 2026-05-10

### Fixed

- **Context chip clutter** — auto-matched files no longer appear as context chips; chips now only show explicitly `@`-mentioned files. Auto-context still runs silently. Source file allowlist replaces the previous artifact denylist, so unknown future build artifact types are blocked automatically.
- **MCP servers on Windows** — servers using `.bat` or `.cmd` launchers (e.g. `dart`, `flutter`) now spawn correctly. Previously failed with `ENOENT` because `.bat` files require a shell to execute. Fixed by invoking via `cmd.exe /c` on Windows with no `shell: true` (avoids the Node.js arg-escaping deprecation).

---

## [0.4.0] — 2026-05-08

### New

- **Functional idle** — when Grom goes idle (15 s of inactivity), two things happen automatically: for Ollama users, a keep-alive request extends the model's VRAM TTL by 10 minutes so it doesn't get unloaded between prompts; and if the active file has VS Code errors, the count appears in the thought bubble (e.g. `3 errors in main.ts`) as a gentle nudge to fix them.

---

## [0.3.8] — 2026-05-08

### New

- **Prompt history** — up/down arrow cycles through previously sent messages when the input is empty; any edit exits history mode immediately; focus change resets position so each session starts fresh. Hover the input for the hint.
- **`/commit` auto-diff** — typing `/commit` now automatically runs `git diff HEAD` and `git ls-files --others` to include both modified and new untracked files; the model receives the actual diff with no extra `@git` mention needed. If there are no changes, replies instantly without calling the model.
- **Token cost tooltip** — hovering the context-window radial shows estimated cost (e.g. `1,234 / 32,000 tokens (4%) • $0.0012`) when the active model has pricing configured in `grom.modelPricing`. Silent for free/local models.

### Fixed

- **PLAN mode over-engineering** — removed the instruction that forced every message into a plan-format response; PLAN mode now matches tone to the message (brief for casual questions, thorough for architecture) and only suggests BUILD mode when the user is ready to implement.

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
| `grom.autocompleteModel` | *(chat model)* | Dedicated FIM model for completions |
| `grom.ragEnabled` | `true` | Enable codebase indexing |
| `grom.embeddingModel` | *(blank)* | Ollama model for semantic RAG (e.g. `nomic-embed-text`) |
| `grom.agentEnabled` | `true` | Enable built-in file tools in the agentic loop |
| `grom.agentMaxIterations` | `20` | Maximum tool-call rounds per message |
| `grom.mcpServers` | `[]` | MCP server definitions |
| `grom.docSources` | `[]` | Documentation URLs to crawl and index |
| `grom.customProviders` | `[]` | Additional LLM providers shown in the provider picker |
| `grom.theme` | `Grom` | UI theme |
| `grom.robotAnimations` | `true` | Enable robot animations |
| `grom.presets` | *(defaults)* | Prompt preset buttons |
| `grom.customGreeting` | *(blank)* | Override empty-state greeting text |
| `grom.customLogo` | *(blank)* | Override chat logo (URL, data URI, or emoji) |
| `grom.hints` | `true` | Show Grom hint cards in chat (e.g. context-full warning) |
