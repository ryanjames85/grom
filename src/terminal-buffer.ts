/**
 * terminal-buffer.ts
 *
 * Rolling buffer of recent terminal output, used to populate the @terminal context provider.
 * extension.ts pipes all VS Code terminal data events into appendTerminalOutput().
 * context.ts reads from getRecentTerminalOutput() when the user types @terminal in chat.
 *
 * NOTE: This file is intentionally vscode-free — it is pure state with no side effects.
 */

let _buffer = '';
const MAX_BYTES = 5000;

/** Appends new terminal output to the rolling buffer, trimming the oldest content when the limit is exceeded. */
export function appendTerminalOutput(text: string) {
  _buffer += text;
  if (_buffer.length > MAX_BYTES) _buffer = _buffer.slice(_buffer.length - MAX_BYTES);
}

/** Returns the most recent terminal output, up to MAX_BYTES characters. */
export function getRecentTerminalOutput(): string { return _buffer; }
