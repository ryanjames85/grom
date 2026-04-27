# Grom — Manual Testing Runbook

All scenarios below must be tested by hand. Run `npm test` first to confirm all 120 unit tests pass before starting.

---

## Prerequisites

1. Build and install the extension:
   ```
   npm run package
   code --install-extension grom-0.1.0.vsix
   ```
2. Open a workspace folder in VS Code (the extension requires an open folder).
3. Start LM Studio (or Ollama) and load a model. Confirm the server is reachable at `http://localhost:1234` (or your configured URL).

---

## 1. First-Run Configuration

| Step | Expected |
|------|----------|
| Open the Grom panel (sidebar icon) | Panel loads, shows an empty chat and a settings gear |
| Open settings, set Base URL and model name, click Save | Settings persist after closing and reopening VS Code |
| Send any message | Response streams in; no errors in the Output panel |

---

## 2. Plan Mode (default)

Plan mode is for discussion only — the model must not execute any tools.

| Step | Expected |
|------|----------|
| Confirm the mode toggle shows **PLAN** | Badge visible in the chat header |
| Ask "create a file called hello.txt" | Model replies with a plan or explanation; **no approval card appears**; no file is created |
| Ask "what files are in this project?" | Model replies conversationally; does not call `list_directory` |
| Model response should mention switching to BUILD to take action | Verify the reply nudges the user to switch mode |

---

## 3. Build Mode — File Write with Approval

| Step | Expected |
|------|----------|
| Click the mode toggle to switch to **BUILD** | Badge changes to BUILD |
| Ask "create a file called test-output.txt with the content 'hello world'" | An approval card appears in the chat: **Write file: test-output.txt** |
| Click **Deny** | No file is created; model acknowledges the denial |
| Repeat the request | Approval card appears again |
| Click **Approve** | File is created in the workspace; VS Code opens it in a preview tab |
| Verify file content | `test-output.txt` contains `hello world` |

---

## 4. Build Mode — Agent Does Not Loop After Completion

This covers a previously fixed bug where the agent kept calling tools after finishing.

| Step | Expected |
|------|----------|
| In BUILD mode, ask "create a file called loop-test.txt with content 'done'" | Approval card appears; approve it |
| After the file is written | Model sends a single completion message ("Done" / "File created") and stops |
| No further tool calls or approval cards appear | Conversation is idle after one exchange |

---

## 5. Build Mode — Terminal Command with Approval

| Step | Expected |
|------|----------|
| Ask "run the command: echo hello" | An approval card appears: **Run terminal: echo hello** |
| Click **Approve** | Command runs in the VS Code terminal; output `hello` is fed back to the model |
| Model acknowledges the output | Response mentions the command result |

---

## 6. Active File Context

| Step | Expected |
|------|----------|
| Open any source file in the editor | File is shown as active in VS Code |
| In BUILD mode, ask "what does the open file do?" | Model describes the currently open file (not a different one) |
| Ask "add a comment at the top" | Model proposes an edit referencing the correct file |

---

## 7. Multi-Turn Conversation (Follow-up)

| Step | Expected |
|------|----------|
| In BUILD mode, ask "create a file called jokes.txt with 3 jokes" | File created after approval |
| Ask "add 2 more jokes to that file" | Model reads the existing file and appends new jokes; approval card for write appears |
| Approve | File now contains 5 jokes |

---

## 8. Session Management

### Create a new session
| Step | Expected |
|------|----------|
| Click the **+** button in the session list | New session appears named "Untitled"; chat is empty |
| Send a message | Session title auto-updates to the first ~25 chars of your message |

### Switch between sessions
| Step | Expected |
|------|----------|
| Create a second session and send a different message | Both sessions appear in the list with distinct titles |
| Click the first session | Chat history switches to the first session's history |

### Rename a session
| Step | Expected |
|------|----------|
| Click the pencil icon next to a session | Inline rename input appears |
| Type a new name and confirm | Session title updates in the list |

### Delete a session
| Step | Expected |
|------|----------|
| Delete a non-active session | Session disappears from the list; active session unchanged |
| Delete the active session | Switches to another session automatically |
| Delete all sessions until one remains | Last session is cleared (not removed); list still shows one entry |

---

## 9. Context Compaction

| Step | Expected |
|------|----------|
| Have a multi-turn conversation (at least 5–6 exchanges) | Token counter increments each turn |
| Type `/compact` in the chat input and send | A compact notice appears in the chat ("Context compacted") |
| Continue the conversation | Model still responds coherently; token count resets to a lower number |

---

## 10. Custom System Prompt (per session)

| Step | Expected |
|------|----------|
| Open session settings (gear icon) | System prompt text area is visible |
| Enter "You are a pirate. Respond only in pirate speak." and save | Prompt saved |
| Send any message | Model responds in pirate speak |
| Switch to a different session | That session uses its own system prompt (not the pirate one) |

---

## 11. Sad Path / Error Handling

### Server unavailable
| Step | Expected |
|------|----------|
| Stop LM Studio, then send a message | Error shown in chat ("Could not connect" or similar); no crash, no spinner stuck forever |
| Restart LM Studio, send another message | Conversation resumes; prior history intact |

### Invalid configuration
| Step | Expected |
|------|----------|
| Set Base URL to a non-existent address (e.g. `http://localhost:9999`) | Clear error in chat on send; not a silent hang |
| Set model name to a model that doesn't exist on the server | Error message returned from server shown in chat |
| Leave Base URL empty and send a message | Graceful error, not a crash |

### Approval — deny path
| Step | Expected |
|------|----------|
| In BUILD mode, ask it to create a file, then click **Deny** | No file created; model receives denial and responds without looping |
| Deny a terminal command | No command runs; model acknowledges and stops |
| Approve a write, immediately send another message before the model responds | Second message queued correctly; no duplicate writes |

### Session edge cases
| Step | Expected |
|------|----------|
| Delete all sessions one by one until one remains | Last session cleared to empty rather than removed; list still shows one entry |
| Try to switch to a session that no longer exists (e.g. via state corruption) | Falls back to default session; no crash |
| Run `/compact` on a brand-new empty session | Nothing happens or a notice saying "nothing to compact" |
| Run `/compact` immediately after a previous `/compact` | Idempotent — history not corrupted or duplicated |

### File system edge cases
| Step | Expected |
|------|----------|
| Ask model to write a file to a read-only path (e.g. `C:\Windows\test.txt`) | Error surfaced in chat; no crash |
| Ask model to read a file that doesn't exist | Error message from tool returned to model; model responds gracefully |
| Ask model to list a directory that doesn't exist | Error message returned; not a silent empty result |

### Large input
| Step | Expected |
|------|----------|
| Paste a very large block of text (>10,000 chars) as a message | Extension does not hang; message sent or a size warning shown |
| Open a very large file (>500 lines) as active context | Extension does not hang; file is truncated at the 300-line cap |

### Model produces malformed output
| Step | Expected |
|------|----------|
| Use a model known to produce garbled output | Extension does not crash; partial/garbled text shown in chat |
| Model response has no tool call but is in BUILD mode with tools available | Response shown as plain text; no phantom tool execution |

---

## 12. Reload Persistence

| Step | Expected |
|------|----------|
| Create two sessions with conversation history | Both visible in the session list |
| Close and reopen VS Code (full restart, not just Reload Window) | Both sessions and their histories are restored |
| Active session is the one that was active before closing | Correct session selected on reload |

---

## Known Limitations

- **Reload Window** (`Ctrl+R`) does not reload the extension host — use **Shift+F5** then **F5** when developing.
- Webview UI changes require a full extension reload to take effect.
- There are no automated UI tests; all webview behaviour is verified manually.
