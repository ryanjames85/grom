# Changelog

All notable changes to Grom are documented here.

---

## [0.5.7] — 2026-09-30

### New

- **Prompt History tab** — a third tab in the History panel (alongside Sessions and Task Log) listing every prompt you've sent in the current project, newest first. Hover an entry for a Copy button. History is scoped per workspace folder, not shared globally across every project you open, so a prompt typed in one project never shows up in another's list. Clearing it needs a click-twice confirmation (VS Code webviews block native confirm dialogs, so this is the closest equivalent) and updates the up-arrow input history immediately too.
- **Language-override indicator** — `grom.chatLanguageModels` routing already worked correctly, but nothing showed it was happening, so it was easy to forget you'd set one and be confused about which model actually answered. Two indicators now: a small 🔀 badge appears next to the model dropdown whenever the currently active file's language has an override configured, and a permanent note on the actual reply itself (e.g. "via qwen2.5-coder (python override)") records which model genuinely answered that message, independent of whatever file is active later when you read it back.

### Fixed

- **`/compose`'s absolute-path safety check never actually worked** — `applyComposerPatches` stripped a path's leading slash before checking whether it started with one, so the check could never trigger, and Windows drive-letter paths (`C:\...`) weren't checked at all. Found via new test coverage. Fixed to check before stripping, matching the same guard already used correctly for file tools.
- **Prompt history was a single global list shared across every project** — up-arrow in the input box could surface a prompt typed in a completely different project. Now scoped per workspace folder.
- **Code-block hover buttons could cover several lines of code on narrow blocks** — a file-suggestion code block can carry up to seven buttons (Diff, Apply, Insert, Run, Copy, Accept, Reject); the old positioning pushed a wrapped second row across the block's full width. Now floats as a corner overlay instead, so a wrap stays contained to a small column near the corner rather than stretching across the code.
- **Context usage display stated a guessed context size as if it were a confirmed fact** — when Grom can't detect a model's real context window (unusual, but happens with some local server setups), it falls back to a hardcoded 8192 estimate so the usage ring and `/compact` threshold still have a number to work with. The usage tooltip and the "context nearly full" hint card used to show that fallback with the same confident percentage as a real detected value, with no indication it was a guess. Both now say plainly when the size is unknown and the percentage shown is an estimate, instead of stating it as fact. The auto-compact skip guard itself was already correct and unaffected — this was a display-only issue.
- **`/compose` "Apply All" wrote changed files to disk before the diff review session captured what the file used to look like, so Reject silently did nothing** — the file was written with the new content first, then handed to the same review session used everywhere else, which reads the file's current text as "the original." Since the file already held the new content by that point, original and suggested were identical from the session's point of view, and choosing Reject on that file "restored" it to the content it already had. The write now happens through the review session itself, the same way a per-file review does, so Reject actually reverts.
- **A model's real context window could get stuck permanently undetectable after a model or server change** — once Grom found a working detection endpoint for a server URL, it cached that endpoint and never tried the others again, even if that specific probe later started returning nothing (a different model loaded on the same server, a restart). Auto-compact was then permanently treated as "unknown" for that server until the extension itself restarted. A failed cached probe now falls back to trying the full detection chain again instead of giving up.
- **Switching sessions while `/compact` or auto-compact was still summarising could stamp the "conversation compacted" notice onto the wrong conversation** — compaction runs an up-to-20-second background call to summarise what's being trimmed; if you switched to a different session before it finished, the notice landed on whatever session happened to be on screen when it completed, not the one that was actually compacted. The notice is now tagged with the session it belongs to and only renders if that session is still the one you're looking at.
- **The agent could silently discard its final answer on the very last tool-call round** — if the model responded with plain text instead of a tool call on the last allowed round, Grom queued up a "use a tool" nudge that then never got sent (no rounds were left to send it), and skipped showing the model's actual reply. You'd see only the generic "reached the maximum number of rounds" message with no trace of what the model had actually said. The nudge is no longer attempted on the final round, so the reply is always shown instead.
- **A missing or malformed `pattern` argument to the `search_files` tool silently matched every line of every file instead of erroring** — unlike `read_file`/`write_file`/`delete_file`/`run_terminal`, `search_files` didn't validate its required argument; a missing pattern compiled to a regex that matches everything, flooding the model with meaningless results instead of a clear, correctable error.
- **The same absolute-path check order bug fixed in `/compose` also existed (harmlessly, for now) in the builtin file tools' own path safety check** — same root cause, aligned to check before stripping the leading slash for consistency and defense in depth, even though the current file-lookup method wasn't actually exploitable by it.
- **An SSRF filter bypass via IPv4-mapped IPv6 addresses** — `@url`'s private-address block (also used by the builtin fetch tool) checked hostnames like `127.0.0.1` and `169.254.169.254` directly, but an IPv4-mapped IPv6 literal (`::ffff:127.0.0.1`, which browsers and Node's URL parser normalise to `::ffff:7f00:1`) matched none of those patterns, silently bypassing the block on loopback, link-local metadata, and private-network addresses alike. The hex-mapped form is now unwrapped back to its real IPv4 address before checking.
- **Overlapping MCP server re-initialization could duplicate every tool and leak child processes** — if `grom.mcpServers` config changed twice in quick succession (or a manual re-init raced a config-change one), both re-initializations' spawned servers could land in the registered tool list, duplicating every tool, and the loser's processes were never disposed since neither generation's cleanup step knew about the other's still-connecting servers. A generation counter now discards a superseded initialization's results instead of registering them.
- **A failed MCP server's name in the connection-failure warning was sometimes wrong** — if an earlier `grom.mcpServers` entry was missing its `command` field (silently skipped), every server after it in the list was reported under the wrong name in the failure warning, since the reporting loop indexed the full config list with an index built from the filtered one.
- **MCP server processes could survive disconnect/reload on Windows** — servers are spawned via `cmd.exe /c <command>` on Windows so `.bat`/`.cmd` launchers resolve; disposing only killed that `cmd.exe` wrapper, not the actual server process it launched, leaving it running indefinitely. Disposal now kills the whole process tree on Windows.
- **A model quoting an ordinary JSON example in its reply could get misread as a tool call** — the heuristic tool-call parser accepted any JSON object anywhere in a response with a bare `name` field (e.g. `{"name":"Alice","role":"admin"}` from an example API response) as a tool call with empty arguments, since `name` alone was trusted unconditionally. It's now only trusted when paired with an actual args-shaped field, the way every real tool-call shape (documented or otherwise) has one.
- **Two tool calls in one model response could corrupt each other and delete real chat content from the display** — the Gemma/Qwen `<|tool_call|>` tag parser's body match was greedy and unanchored, so with two tool-call blocks in one response it read from the first call through to the very last `}` anywhere in the text. The text stripped from the visible chat (to hide the raw tool-call syntax) extended into the second block and everything between them, silently deleting content the user should have seen.
- **A file-watcher-triggered index update arriving while another index build was already running was silently dropped** — the RAG index only queued a rebuild request that arrived mid-build when it was an explicit force rebuild; a plain incremental update (the common case for a single file changing) just did nothing, leaving that file's change unindexed until some later build happened to include it again. Now queued regardless.
- **Awaiting a queued index rebuild could resolve before the rebuild actually ran** — a rebuild request that arrived while indexing was already in progress got queued and its promise resolved immediately, before the real rebuild (which only runs afterward) had done anything. Code that rebuilt then immediately queried the index could see stale data. The promise now resolves only once the queued rebuild has actually completed.
- **Two different `@mention` spellings for the same file could attach its content twice** — `@app` and `@App.ts` in the same message, if they resolved to the same underlying file, both passed the duplicate check since it compared the raw typed text rather than the resolved file's real name.
- **The last ~1-2 seconds of a long voice recording could be silently dropped from the transcript** — the extension allowed recording up to 30 seconds, but the webview only ever transcribes once, on the final chunk, and truncates anything beyond 28 seconds of audio with no partial transcript for what was cut. Recording is now capped at 28 seconds so nothing spoken can end up past that truncation point.
- **A dictation session left running past when it should timed out could leak its internal timers** — closing the extension or webview mid-recording didn't clear the max-length or chunk timers, so they could still fire afterward against an already-torn-down webview, and the chunk timer had nothing to ever stop it from re-firing indefinitely.
- **Accepting a partial autocomplete suggestion, then switching files, could show leftover ghost text from the previous file at an unrelated location in the new one** — the inline completion provider is registered once for every file; the partial-accept buffer was reused on the next automatic trigger without checking it was still the same document the buffer was generated for.
- **A terminal-error debounce timer wasn't cleaned up on deactivate** — unlike Grom's other timers, this one had no disposal registered; if the extension deactivated within its 1.5-second debounce window it could still fire afterward against an already-torn-down provider.
- **The `search_files` tool could hang the extension host indefinitely on a catastrophic-backtracking pattern** — `pattern` comes from the model, gets compiled into a regex, and was tested directly against every line of every matched file with no timeout. A pattern like `(a+)+b` against an ordinary line can take exponential time; each match is now run inside a sandboxed script with a real timeout, so a runaway pattern is treated as "no match on this line" instead of freezing everything.
- **An SSRF filter bypass via the older, deprecated IPv4-compatible IPv6 address form** — the fix for `::ffff:127.0.0.1`-style addresses only covered the IPv4-*mapped* form; `::127.0.0.1` (no `ffff:`, RFC 4291's older IPv4-*compatible* form) normalises to a different but equally unblocked hex form and slipped through the same way. Both forms are now unwrapped and checked.
- **A malformed `@mention` (unbalanced glob-special characters like `@file[test`) could abort every other mention in the same message** — `resolveMentions`'s file lookup wasn't wrapped in error handling, unlike the read that follows it; one bad mention threw and silently dropped whatever came after it in the loop.
- **Pasting a very large block of text (a log dump, a long document) into chat could stall sending the message** — the auto-context matcher scanned every distinct word over 5 characters with its own filesystem search, with no cap; a large paste could mean hundreds of sequential scans before the message even reached the model. Now capped and deduplicated.
- **A heuristic tool call with a nested JSON object in its arguments (e.g. `args: {"query": {"nested": 1}, "limit": 5}`) silently lost every argument** — the loose key-value parser's non-greedy regex capture stopped at the first `}`, truncating the JSON into something that failed to parse, and fell back to empty args with no error surfaced. Same root-cause fix as the `<|tool_call|>` tag parser fixed earlier: proper brace-depth matching instead of a regex capture.
- **A heuristic tool call whose string argument contained a literal `)` (e.g. a file path like `"notes (draft).txt"`) also silently lost every argument** — the function-call-style parsers (`tool_name(...)` and `<tool_code>fn(...)</tool_code>`) had the identical truncate-at-first-close-paren bug. Fixed with the same depth-aware matching, shared between both parsers.
- **Two sessions created in very quick succession could silently overwrite each other** — session IDs were `Date.now().toString()`, which has 1ms resolution; two `createNewSession()` calls landing in the same millisecond (two queued "New Chat" clicks, or importing a chat while creating a new one) produced identical IDs, and the second call clobbered the first session's entry with no warning. IDs now include a monotonic counter alongside the timestamp, guaranteeing uniqueness regardless of timing.

### Internal

- **`npm test` was silently skipping an entire test file's suite with no error for about five months, since May 2026** — several test files patched Node's global module loading to mock the `vscode` API and never restored it afterward. A real source module is a singleton within one process, so whichever test file happened to load first permanently decided what every later file saw when it required the same module, and one file's tests could silently run against a completely different file's mock. In the worst case this made `builtin-tools.test.ts`'s entire 36-test suite vanish from `npm test`'s output with no failure, no error, nothing, across every release since v0.3.2. Fixed by giving every test file its own real process (`scripts/run-tests.mjs`, now what `npm test` runs) instead of one shared process loading every file's glob, plus a shared, explicit mock helper (`src/test/_vscode-mock.ts`) replacing the ad-hoc per-file patches.
- **New test coverage for `inline-diff.ts`, `inlineedit.ts`, and the new Prompt History, language-override, and context-honesty features** — the first two had zero tests before; added 24, 11, 13, 8, and 4 respectively.
- **Two rounds of targeted bug-hunt passes across the whole codebase, each finding fixed with a regression test that was verified to fail without the fix** — the second round covered RAG indexing, MCP server lifecycle, the heuristic tool-call parser, context assembly, voice recording, and autocomplete, turning up a real SSRF filter bypass (IPv4-mapped IPv6 addresses), an MCP server-duplication race, a tool-call parser false positive, and several other correctness bugs (all listed individually above). The true test baseline is now 1266 passing, not the old, silently undercounted total.
- **Minor hardening from a targeted bug-hunt pass** — a tool failure that threw a non-`Error` value (some MCP servers do this) could feed the literal text "Error: undefined" back to the model instead of the real detail; a pending tool-approval request left a small, bounded entry behind if the request was aborted before the user answered it; a non-spec-compliant OpenAI-compatible server that indexes streamed tool calls starting at 1 instead of 0 could crash the response handler instead of using the tool call it actually sent. All three fixed, each with a regression test that fails without the fix.
- **New: a real end-to-end webview test suite (`npm run test:e2e`)** — drives an actual, isolated VS Code Extension Development Host headlessly (via `playwright-core`'s CDP connection, no mocking) and inspects Grom's real rendered webview: a real `<think>`-block DOM structure, a real postMessage round trip for the language-override badge, and a real click-through-to-extension-host round trip for the memory panel. This proves behavior that mocked-`vscode` unit tests structurally cannot — a real DOM update from real message traffic, not an assertion that the code that produces one exists. Slow and not part of `npm test`; each run launches and fully tears down its own disposable VS Code instance (isolated `--user-data-dir`, no interference with a real dev profile), verified to leave no orphaned processes or temp directories behind.
- **A dedicated edge-case pass across the codebase (empty/huge/malformed input, 3+-way concurrency, unusual formats and encodings) turned up 8 further real bugs**, all listed individually above, each with a regression test verified to fail without the fix. Two of this session's earlier concurrency fixes (the MCP re-initialization generation counter, the RAG rebuild queue) were specifically re-checked against 3+ simultaneous callers, not just the original two-caller case, and both hold up correctly. The true test baseline is now 1272 passing.

---

## [0.5.6] — 2026-09-29

### New

- **Reasoning effort control** — a kettlebell icon in the toolbar lets you control how hard the model thinks before answering. The available states and their effect depend on what the model actually supports — Grom does not pretend otherwise. Cloud models (Anthropic, OpenAI o-series, Gemini 2.5+) get four levels (Off / Low / Medium / High) mapped to the provider's native API parameter, so effort is reliably enforced. Qwen3 gets two states (Off / High) using its native `/no_think` and `/think` tokens — a hard binary switch with a clear speed difference. Other local reasoning models (DeepSeek-R1, QwQ, Magistral, phi-4-reasoning) show no icon and `/effort` is blocked for them, because nothing reliably enforces the level and a control that might do nothing is worse than none. Non-reasoning models are unaffected. Reasoning effort is per-session and persists across restarts.
- **`grom.reasoningEffort` setting** — sets the default effort level for new sessions (`off` by default). Override per-session with the toolbar icon or `/effort off|high` (or `low`/`medium` for cloud models).
- **`grom.showReasoningToggle` setting** — set to `false` to hide the kettlebell icon and disable the feature entirely. Use this if you prefer not to use reasoning effort control at all.
- **`grom.reasoningModels` setting** — extend the built-in reasoning model list with your own substrings. Grom ships with detection for the major families but new models appear constantly; add a substring of any model's name here and Grom will treat it as a reasoning model without waiting for an update. Example: `["my-r1-finetune", "local-thinker"]`.
- **Reasoning effort colour coding** — the toolbar icon signals the active level at a glance: grey dim = Off, green = Low, blue = Medium, purple = High. At High a lightning bolt appears inside the kettlebell.
- **Non-reasoning model warning** — if you set effort above Off on a model Grom doesn't recognise as a reasoning model, a warning appears in chat (for `/effort`) or as a VS Code notification (for the toolbar). The warning is suppressed for models in `grom.reasoningModels`.
- **`/effort` slash command** — type `/effort high` (or `off`, `low`, `medium`) to set reasoning effort for the current session without touching the toolbar.
- **`src/model-caps.ts`** — new standalone module centralising all model capability detection (`isReasoningModel`, `isVisionModel`, `isToolsModel`, `isQwen3Model`, `applyLocalReasoningEffort`). Single source of truth used by all providers — no more duplicated keyword lists. Supports both keyword matching and regex patterns for naming conventions like `-r1`, `-o3`, `-cot` suffixes.
- **Compacted-away messages are no longer lost — click the divider to see them** — `/compact` and auto-compact trim the session's history to keep the model's context small, but the trimmed messages used to be discarded permanently. They're now archived to a plain-text file in the extension's own workspace storage before being trimmed, which costs local disk space only, never tokens — nothing archived is ever sent to the model, and how much compaction actually shrinks the context is completely unchanged. The "conversation compacted" divider is clickable: click it and the earlier messages are read back and inserted right where the divider was. The divider stays in place afterward, now showing when that compaction happened, rather than disappearing once expanded. Sessions compacted before this existed have nothing to show, and clicking the divider says so plainly rather than doing nothing. Auto-compact (the automatic version, not just the manual `/compact` command) archives and timestamps the same way.
- **`/reindex` slash command** — forces a full rebuild of the codebase RAG index. The index already updates automatically as files change; this is for when you want to force it explicitly (for example if search results ever look stale). Also available from the `/` menu alongside Compact and Clear-history. Reuses the same file-discovery and rebuild logic as the existing (undiscoverable) `grom.reindex` Command Palette entry.

### Fixed

- **The "conversation compacted" divider silently failed to render whenever a compaction produced a summary** — the check comparing a compact marker's content was an exact match against the bare marker text, but a real compaction almost always attaches a generated summary to it, which fails an exact match. The divider (and now the ability to expand it) simply never appeared in that case — the common case, not an edge case.
- **Anthropic compact markers handled correctly in all cases** — when a session had multiple system messages (e.g. both a real system prompt and a compact summary marker), only the first was forwarded to the API and all compact summaries were silently dropped. Both streaming and non-streaming paths now merge all system and compact messages into a single system field before sending.
- **OpenAI-compatible non-streaming path now folds compact summaries** — `chat()` was passing messages directly without normalising compact markers, so structured summary content could leak as a raw `__compacted__` system message on providers with strict Jinja templates. Fixed to match the streaming path.
- **Anthropic tool JSON parse failure was silent** — when the model's tool call JSON was malformed at end-of-stream, the parse error was caught and swallowed with no signal to the caller. Now returns `toolsDropped: true` so the agent loop can retry without tools rather than hanging.
- **Ollama in-stream error not detected when tool call data was present** — Grom checked `j.error` to catch mid-stream errors, but Ollama sometimes includes both an error field and a partial message object. The check now requires the message content to be empty before treating it as an error, so legitimate tool-call stream events are not discarded.
- **Provider probe functions only covered the HTTP headers phase** — all four probe functions (`_probeOllamaShow`, `_probeLMStudioNative`, `_probeOpenAIV1`, `_probeProps`) used a manual `AbortController + setTimeout` pattern that cancelled only the headers phase of the fetch, leaving body reads hanging until the OS closed the connection. Replaced with `AbortSignal.timeout(2000)` which covers the full request lifecycle.
- **Session-switch history corruption** — switching sessions while a reply was still streaming could write the response to the wrong session's history. The session identity is now threaded from the `status: Ready` signal through to `updateHistory`, so each response is always written to the session that requested it regardless of what is active when it arrives.
- **Compaction triggered on models with unknown context size** — when neither the provider probe nor config had a context window for the current model, the auto-compact logic fell back to 8,192 tokens as an assumed limit and triggered early compaction on every session. Compaction is now skipped entirely when context size is genuinely unknown.
- **Abort during agentic tool call left orphaned history** — if a request was aborted after a tool call completed but before the model produced a final reply, the history was left with an assistant message containing unresolved tool calls and no following tool result. Subsequent turns failed because Anthropic and OpenAI reject this message shape. Orphaned tail messages are now trimmed when an abort occurs.
- **No cancellation message shown after abort** — aborting a streaming request left the chat in a half-finished state with no indication of what happened. A "Cancelled." message is now posted after the loop exits on abort so the state is always visible.
- **Agent loop checked `hitMaxRounds` before the abort signal** — reaching the round limit while simultaneously aborting would show the wrong end message. The abort check now runs first.
- **`activeTools` not tracked when tools dropped mid-loop** — when Ollama dropped tools mid-agentic-loop (streaming back a rejection), the variable tracking available tools was not updated, so subsequent rounds still attempted to send the tool definitions and the prompt continued to reference tools that were no longer active. The active tool set is now tracked explicitly and cleared when dropped.
- **Slash command language routing used wrong editor reference** — `resolveSlashCommand` always called `vscode.window.activeTextEditor`, which returns `undefined` when the webview panel has focus (the common case when typing a slash command). Now receives an optional `getEditor` callback from the caller so it resolves the last known active text editor instead.
- **Input history not reset on session switch** — switching sessions did not reset the up-arrow input history navigation state, so pressing up in the new session could surface entries from the previous one. History index and entries are now reset unconditionally on session load.
- **Stale response chunk delivered after request cancel** — the webview `chunk` event handler did not verify that an arriving chunk belonged to the current in-flight request. A slow response from a cancelled request could append text to the next message. Each request now carries a guard ID that chunks must match to be accepted.
- **Memory save timer not cancelled in `cancelMemory`** — `cancelMemory` cleared the pending save payload but not the debounce timer, so the timer could still fire and attempt a save with stale or empty content. The timer is now cancelled together with the payload.
- **Clipboard write had no error handler** — copy-to-clipboard calls in the webview had no `.catch()`, producing uncaught promise rejections in the extension host when clipboard permission was denied or unavailable. Both copy paths now handle the error silently.
- **Embedding progress report stuck at 0% for first batch** — progress was calculated as `i / chunks.length` where `i` is the batch start index, so the first batch (starting at 0) always reported 0% regardless of how many chunks it contained. Progress now uses the end-of-batch index.
- **`_pendingRebuild` not drained in the incremental RAG build path** — if a rebuild was queued while an incremental build was running, the full build's `finally` block would drain the queue but the incremental path's `finally` block did not, silently dropping the pending rebuild. Both paths now drain the queue on completion.
- **Blank reply when an OpenAI-compatible server fails mid-stream** — LM Studio and similar servers can answer 200 and then stream an error event (for example when a model crashes or fails to load). Grom ignored it and showed an empty reply with no explanation. It now shows the server's message. If some text had already arrived, the partial text is kept.
- **Thinking models looked frozen on LM Studio and other OpenAI-compatible servers** — servers such as LM Studio, vLLM, DeepSeek and OpenRouter stream a model's reasoning in a separate field (`reasoning_content` or `reasoning`). Grom ignored it, so Qwen or Gemma thinking models showed only the loading dots, sometimes for minutes, before the answer appeared. The reasoning now streams live into the chat as a thinking block. It is kept out of the answer text used for tool detection.
- **Model thinking now displays as a dimmed live preview instead of plain unstyled text** — fixing the Ollama and LM Studio "frozen" bugs above exposed a separate gap: the `.think` block that thinking content gets wrapped in had no CSS at all, so it rendered as plain paragraph text indistinguishable from a real answer. While the model thinks, the loading dots stay visible and a dimmed, ~2-line preview of the model's actual current thought fades in underneath them, updating live as it streams. Click it to expand the full thought, click again to collapse. A "Hide block" link turns it off — this is a global, persisted preference (new `grom.showThinking` setting, default on), so once hidden it stays hidden across every chat, not just the one you clicked it in; the loading dots show in its place, same as before thinking content was ever surfaced.
- **Thinking models looked frozen on Ollama** — Ollama streams a thinking model's reasoning (Qwen3, DeepSeek-R1 and similar) in a separate `thinking` field with empty content. Grom only read the content, so a reply could sit on the loading dots for minutes while the model thought. The reasoning now streams live into the chat as a thinking block and is kept out of the answer text used for tool detection.
- **Ollama capability icons guessed from keywords instead of using what Ollama reports** — recent Ollama versions list each model's abilities (for example `completion`, `tools`, `thinking`, `vision`) in `/api/show`. Grom ignored that and searched the raw response for words like "vision", which mislabelled text-only models such as Qwen3 as vision-capable. The list is now used when Ollama provides one, and the older detection remains for older Ollama versions.
- **Embedding models listed when no chat model is loaded** — with nothing loaded, the LM Studio model list fell back to every installed model, including embedding models. It now lists installed chat models only.
- **Text-only LM Studio models shown as vision-capable** — LM Studio reports each model as type `llm` (text) or `vlm` (vision) and lists capabilities as an array such as `["tool_use"]`. Grom only understood the older boolean fields, so it fell back to name keywords and treated models like Qwen3 4B as vision models. The server's type and capabilities array are now trusted when present.
- **`run_terminal` error messages were vague** — all execution errors reported the same generic failure message. Grom now distinguishes the three meaningful cases: timeout after 30 seconds, output truncated by the 200 KB buffer cap, and exit with a specific code and message.
- **Ollama context window sometimes overstated what was actually available** — the context probe read a model's static, architectural maximum from `/api/show` (for example 131072 for a Gemma model), which can be far larger than what the model is actually running with if you've configured a smaller context length in Ollama's own settings. The probe now checks `/api/ps` first for the real, currently-loaded context size, and only falls back to the static maximum when the model isn't loaded there. The circle and auto-compact threshold now reflect what's genuinely available, not just what the model could theoretically support.
- **Context window indicator showed a stale value right after switching provider or model** — the underlying context-length detection refreshed correctly on reconnect, but the toolbar display itself only updated on the next message send, so a fresh connection could show an outdated token count until you sent something. The indicator now refreshes immediately once a connection succeeds.
- **Slash-menu items left the typed command text sitting in the input box** — selecting Compact, Clear-history, or Reindex via keyboard (Tab or Enter while the `/` menu is open) ran the command correctly but never cleared the input box, unlike typing the full command and pressing Enter directly. All three now clear the input themselves.
- **`read_file`, `write_file`, `delete_file`, and `run_terminal` crashed with a raw JavaScript error instead of a clear message when the model sent the wrong argument key** — a missing or mistyped `path` or `command` argument (for example the model using `param` instead of `path`) produced an unhelpful internal error such as "Cannot read properties of undefined" or Node's own generic type error, giving the model no way to understand or correct its mistake. It could then repeat the identical broken call until the agent loop ran out of rounds. All four tools now validate their required arguments up front and return a clear, actionable error naming the missing argument.

### Internal

- **Provider modules split** — `providers.ts` broken into `provider-ollama.ts`, `provider-openai.ts`, `provider-anthropic.ts`, and a thin barrel. Message utilities (`mergeSystemMessages`, `normaliseForOllama`) and shared types extracted to `message-utils.ts` and `provider-types.ts`. No behaviour changes; public API via `client.ts` is unchanged.
- **Reasoning-effort diagnostic logging** — a new debug log line traces the resolved effort value and the model/reasoning-control state for every request, gated behind the existing `grom.debugLogging` setting.
- **Expanded test coverage from live-server manual testing** — new unit tests for the three distinct `run_terminal` error messages (timeout, output cap, exit code), and a new live integration test confirming Qwen3's `/no_think` and `/think` tokens still reach the model correctly when a full tool-definition payload is also present in the request, not just in a bare chat request.

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
