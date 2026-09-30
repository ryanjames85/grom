/**
 * mcp-parser.ts
 *
 * Pure, vscode-free parsing utilities for MCP (Model Context Protocol) tool calls.
 * Responsible for two things:
 *   1. Detecting and extracting tool call JSON from raw model output (parseToolCall)
 *   2. Building the system prompt that instructs the model how to call tools (buildToolSystemPrompt)
 *
 * Models don't always emit clean JSON; they may wrap it in markdown fences, use prose prefixes,
 * or use function-call syntax. Four patterns are tried in priority order to handle this.
 *
 * NOTE: This file is intentionally vscode-free so it can be imported in tests without stubs.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface ParsedToolCall {
  tool: string;
  args: Record<string, any>;
  raw: string;
}

/**
 * Finds the index of the closing paren matching the paren at `openIdx`, respecting quoted
 * strings so a literal ')' inside a quoted arg value (e.g. fn(path="notes (draft).txt")) doesn't
 * end the scan early. A plain `[^)]*` capture would stop at that inner ')', truncating the args
 * string and silently dropping every argument on the JSON.parse/regex failure that follows.
 * Returns -1 if no balanced close is found.
 */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0, inStr = false, quote = '', escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === '\\') escape = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Ordered list of parsing strategies. Each pattern attempts to extract a tool call
 * from the raw model output text. The first successful match wins.
 */
const PATTERNS: Array<(text: string) => ParsedToolCall | null> = [

  // Pattern 1: strict JSON object anywhere in the text (most common for well-behaved models)
  (text) => {
    const candidates = extractJsonObjects(text);
    for (const obj of candidates) {
      // obj.tool is the documented field (see buildToolSystemPrompt) and is trusted on its own.
      // obj.name/obj.function are leniency fallbacks for models that echo an OpenAI-style shape
      // instead - but "name" alone is also just an ordinary English word that shows up in plain
      // JSON examples a model might quote in prose (e.g. {"name":"Alice","role":"admin"}), so
      // only trust those fallbacks when an args-shaped field is present too, the way every real
      // tool-call shape (documented or leniency) actually has one.
      const hasArgsField = obj.args !== undefined || obj.arguments !== undefined || obj.parameters !== undefined || obj.input !== undefined;
      const name = obj.tool ?? (hasArgsField ? (obj.name ?? obj.function) : undefined);
      const args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {};
      if (typeof name === 'string' && name.length > 0 && typeof args === 'object' && args !== null) {
        return { tool: name, args, raw: JSON.stringify(obj) };
      }
    }
    return null;
  },

  // Pattern 2: JSON inside a markdown code fence (models sometimes wrap tool calls in ```)
  (text) => {
    const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
    if (!fence) return null;
    const raw = fence[1].trim();
    const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
    const obj = tryParse(raw) ?? tryParse(raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
    if (!obj) return null;
    const name = obj.tool ?? obj.name ?? obj.function;
    const args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {};
    if (typeof name === 'string' && name.length > 0) return { tool: name, args: args || {}, raw: fence[0] };
    return null;
  },

  // Pattern 3: loose key-value text, e.g. "tool: read_file\nargs: {"path":"..."}"
  // Requires "tool:" at the start of a line to avoid false-positives in prose like
  // "I'll use the tool: write_file to help you"
  (text) => {
    const nameMatch = text.match(/(?:^|\n)\s*tool\s*[:=]\s*["']?([a-zA-Z0-9_:.-]+)["']?/i);
    if (!nameMatch) return null;
    // Locate where the args object starts, then find its matching close brace by depth-counting
    // rather than a non-greedy regex capture - `\{[\s\S]*?\}` stops at the FIRST `}`, which is
    // wrong whenever the args contain a nested object (e.g. args: {"query": {"nested": 1}}).
    // That used to truncate the capture into invalid JSON, silently drop to empty args on the
    // JSON.parse failure, and fire the tool call anyway with every argument lost.
    const argsHead = text.match(/\bargs?\s*[:=]\s*\{/i);
    let args: Record<string, any> = {};
    if (argsHead && argsHead.index !== undefined) {
      const openIdx = argsHead.index + argsHead[0].length - 1;
      let depth = 0, closeIdx = -1, inStr = false, escape = false;
      for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (escape) { escape = false; continue; }
        if (inStr) { if (c === '\\') escape = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        if (c === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
      }
      if (closeIdx !== -1) {
        try { args = JSON.parse(text.slice(openIdx, closeIdx + 1)); } catch {}
      }
    }
    return { tool: nameMatch[1], args, raw: nameMatch[0] };
  },

  // Pattern 4b: gemma-4 / Qwen style, <|tool_call>call:tool_name{...}<tool_call|>
  // These models use unquoted keys AND <|"|>...<|"|> string delimiters for values with special chars.
  // Parse key-value pairs directly to avoid regex corruption of large string values (e.g. Dart code
  // with named params like `, listen: false` that would otherwise get treated as JSON keys).
  (text) => {
    const head = text.match(/<\|?tool_call\|?>\s*(?:call:)?([a-zA-Z0-9_]+)\s*\{/i);
    if (!head || head.index === undefined) return null;
    const name = head[1];
    const openIdx = head.index + head[0].length - 1; // index of the opening `{`
    // Find the matching close brace with depth counting, respecting both this format's
    // <|"|>...<|"|> string delimiter and plain "..." strings, so a SECOND <|tool_call|> block
    // later in the text can't get swallowed into this one's body - the old greedy, unanchored
    // `[\s\S]*` regex matched through to the LAST `}` anywhere in the text, corrupting parsing
    // whenever more than one tool call appeared in the same response.
    let depth = 0, closeIdx = -1, inStr = false, escape = false;
    for (let i = openIdx; i < text.length; i++) {
      if (text.startsWith('<|"|>', i)) {
        const end = text.indexOf('<|"|>', i + 5);
        if (end === -1) break;
        i = end + 4; // loop's i++ lands past the closing delimiter
        continue;
      }
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (c === '\\') escape = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      if (c === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx === -1) return null;
    try {
      const args: Record<string, any> = {};
      let body = text.slice(openIdx + 1, closeIdx).trim(); // content between the outer { }

      while (body.length > 0) {
        // Match key with optional type annotation (e.g. content:markdown: → key=content)
        const keyMatch = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:[a-zA-Z_][a-zA-Z0-9_]*)?\s*:/);
        if (!keyMatch) break;
        const key = keyMatch[1];
        body = body.slice(keyMatch[0].length);

        let value: string;
        if (body.startsWith('<|"|>')) {
          // <|"|> delimited string: extract raw content, no escaping needed
          body = body.slice(5);
          const end = body.indexOf('<|"|>');
          if (end === -1) break;
          value = body.slice(0, end);
          body = body.slice(end + 5);
        } else if (body.startsWith('"')) {
          // Regular JSON-quoted string: parse char-by-char respecting escapes
          let i = 1;
          let s = '';
          while (i < body.length) {
            const c = body[i];
            if (c === '\\') { s += body[i] + body[i + 1]; i += 2; }
            else if (c === '"') { i++; break; }
            else { s += c; i++; }
          }
          try { value = JSON.parse('"' + s + '"'); } catch { value = s; }
          body = body.slice(i);
        } else {
          // Unquoted primitive (number, boolean, etc.)
          const vMatch = body.match(/^([^,}]+)/);
          value = vMatch ? vMatch[1].trim() : '';
          body = body.slice(vMatch ? vMatch[0].length : 0);
        }

        args[key] = value;
        body = body.replace(/^\s*,\s*/, '');
      }

      // Consume an immediately-following closing tag as part of the raw match, matching the
      // old regex's behaviour, but it's optional - some models omit it.
      const closeTag = text.slice(closeIdx + 1).match(/^\s*(?:<tool_call\|>)/i);
      const raw = text.slice(head.index, closeIdx + 1 + (closeTag ? closeTag[0].length : 0));
      return { tool: name, args, raw };
    } catch { return null; }
  },

  // Pattern 4c: <tool_code> tags, where gemma-4 wraps calls in <tool_code>fn(args)</tool_code>
  (text) => {
    const block = text.match(/<tool_code>\s*([\s\S]*?)\s*<\/tool_code>/i);
    if (!block) return null;
    const inner = block[1].trim();
    const head = inner.match(/^([a-zA-Z0-9_]+)\s*\(/);
    if (!head || head.index === undefined) return null;
    const openIdx = head.index + head[0].length - 1;
    const closeIdx = findMatchingParen(inner, openIdx);
    if (closeIdx === -1) return null;
    let args: Record<string, any> = {};
    const body = inner.slice(openIdx + 1, closeIdx).trim();
    if (body.startsWith('{')) {
      try { args = JSON.parse(body); } catch {}
    } else {
      for (const m of body.matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g)) {
        args[m[1]] = m[2] ?? m[3] ?? m[4];
      }
    }
    return { tool: head[1], args, raw: block[0] };
  },

  // Pattern 4: function-call syntax, tool_name({"key":"val"}) or tool_name(key="val", ...)
  // Requires double-underscore (server__tool) to avoid matching normal function calls in prose.
  // Single-name built-in functions are caught by Pattern 4c above.
  (text) => {
    const head = text.match(/\b([a-zA-Z0-9_]{2,}__[a-zA-Z0-9_]+)\s*\(/);
    if (!head || head.index === undefined) return null;
    const openIdx = head.index + head[0].length - 1;
    const closeIdx = findMatchingParen(text, openIdx);
    if (closeIdx === -1) return null;
    let args: Record<string, any> = {};
    const body = text.slice(openIdx + 1, closeIdx).trim();
    if (body.startsWith('{')) {
      try { args = JSON.parse(body); } catch {}
    } else {
      for (const m of body.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
        args[m[1]] = m[2] ?? m[3] ?? m[4];
      }
    }
    return { tool: head[1], args, raw: text.slice(head.index, closeIdx + 1) };
  }
];

/**
 * Attempts to extract a tool call from raw model output text.
 * Tries four patterns in priority order, returns the first match, or null if none found.
 */
export function parseToolCall(text: string): ParsedToolCall | null {
  for (const pattern of PATTERNS) {
    try {
      const result = pattern(text);
      if (result) return result;
    } catch {}
  }
  return null;
}

/**
 * Walks a string character-by-character to extract all top-level JSON objects.
 * Used by Pattern 1 to find JSON embedded anywhere in model output prose.
 */
export function extractJsonObjects(text: string): any[] {
  const results: any[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue; }
    let depth = 0, inString = false, escape = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inString) { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth === 0) {
      const slice = text.slice(i, j + 1);
      try {
        results.push(JSON.parse(slice));
      } catch {
        // Models on Windows often emit unescaped backslashes in paths (e.g. ".\setup.ps1").
        // \s, \., etc. are invalid JSON escape sequences; sanitise and retry once.
        try { results.push(JSON.parse(slice.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'))); } catch {}
      }
    }
    i = j + 1;
  }
  return results;
}

/**
 * Builds the system prompt suffix that instructs the model how to call tools.
 * Appended to the existing system message so the model knows the tool list and output format.
 * Returns an empty string when no tools are available so the model isn't confused.
 */
/** Strips characters from MCP-server-supplied strings that could break prompt structure. */
function sanitiseField(raw: string, maxLen = 200): string {
  return (raw ?? '')
    .slice(0, maxLen)
    .replace(/[\r\n]+/g, ' ')   // newlines can escape the bullet-point format
    .replace(/[`"']/g, '')       // quote chars used in prompt-injection patterns
    .trim();
}

export function buildToolSystemPrompt(tools: McpTool[]): string {
  if (tools.length === 0) return '';
  const list = tools.map(t => {
    const props = t.inputSchema?.properties ?? {};
    const required: string[] = t.inputSchema?.required ?? [];
    const params = Object.entries(props).map(([k, v]: [string, any]) => {
      const req = required.includes(k) ? ' (required)' : ' (optional)';
      return `    - ${sanitiseField(k, 40)}${req}: ${sanitiseField(v.description || v.type || 'any', 100)}`;
    }).join('\n');
    return `• ${sanitiseField(t.name, 60)}\n  ${sanitiseField(t.description)}${params ? '\n  Parameters:\n' + params : ''}`;
  }).join('\n\n');

  return `\n\n---\nYOU HAVE TOOLS AVAILABLE. When a task requires fetching data, reading files, or any action a tool can perform, you MUST call it — do not guess or make up results.\n\nTo call a tool, output ONLY a JSON object in this exact format (nothing else on that turn):\n{"tool":"<tool_name>","args":{"param":"value"}}\n\nAvailable tools:\n${list}\n\nAfter you receive the tool result, continue your response. If no tool is needed, respond normally.`;
}
