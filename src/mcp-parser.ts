/**
 * mcp-parser.ts
 *
 * Pure, vscode-free parsing utilities for MCP (Model Context Protocol) tool calls.
 * Responsible for two things:
 *   1. Detecting and extracting tool call JSON from raw model output (parseToolCall)
 *   2. Building the system prompt that instructs the model how to call tools (buildToolSystemPrompt)
 *
 * Models don't always emit clean JSON — they may wrap it in markdown fences, use prose prefixes,
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
 * Ordered list of parsing strategies. Each pattern attempts to extract a tool call
 * from the raw model output text. The first successful match wins.
 */
const PATTERNS: Array<(text: string) => ParsedToolCall | null> = [

  // Pattern 1 — strict JSON object anywhere in the text (most common for well-behaved models)
  (text) => {
    const candidates = extractJsonObjects(text);
    for (const obj of candidates) {
      const name = obj.tool ?? obj.name ?? obj.function;
      const args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {};
      if (typeof name === 'string' && name.length > 0 && typeof args === 'object' && args !== null) {
        return { tool: name, args, raw: JSON.stringify(obj) };
      }
    }
    return null;
  },

  // Pattern 2 — JSON inside a markdown code fence (models sometimes wrap tool calls in ```)
  (text) => {
    const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
    if (!fence) return null;
    try {
      const obj = JSON.parse(fence[1].trim());
      const name = obj.tool ?? obj.name ?? obj.function;
      const args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {};
      if (typeof name === 'string' && name.length > 0) return { tool: name, args: args || {}, raw: fence[0] };
    } catch {}
    return null;
  },

  // Pattern 3 — loose key-value text: "tool: read_file\nargs: {"path":"..."}"
  // Requires "tool:" at the start of a line to avoid false-positives in prose like
  // "I'll use the tool: write_file to help you"
  (text) => {
    const nameMatch = text.match(/(?:^|\n)\s*tool\s*[:=]\s*["']?([a-zA-Z0-9_:.-]+)["']?/i);
    if (!nameMatch) return null;
    const argsMatch = text.match(/\bargs?\s*[:=]\s*(\{[\s\S]*?\})/i);
    let args: Record<string, any> = {};
    if (argsMatch) {
      try { args = JSON.parse(argsMatch[1]); } catch {}
    }
    return { tool: nameMatch[1], args, raw: nameMatch[0] };
  },

  // Pattern 4b — gemma-4 / Qwen style: <|tool_call>call:tool_name{...}<tool_call|>
  // These models use unquoted keys AND <|"|>...<|"|> string delimiters for values with special chars.
  (text) => {
    const m = text.match(/<\|?tool_call\|?>\s*(?:call:)?([a-zA-Z0-9_]+)\s*(\{[\s\S]*\})\s*(?:<tool_call\|>|$)/i);
    if (!m) return null;
    try {
      // Step 1: replace <|"|>value<|"|> string delimiters with properly JSON-escaped strings
      let raw = m[2].replace(/<\|"\|>([\s\S]*?)<\|"\|>/g, (_: string, val: string) =>
        '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
      );
      // Step 2: strip type annotations before string values e.g. content:markdown:"..." → content:"..."
      raw = raw.replace(/:\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:(\s*")/g, ':$1');
      // Step 3: quote unquoted keys
      raw = raw.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      // Step 4: escape any raw newlines/tabs inside string values so JSON.parse doesn't choke
      raw = raw.replace(/"((?:[^"\\]|\\.)*)"/g, (_: string, inner: string) =>
        '"' + inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
      );
      const args = JSON.parse(raw);
      return { tool: m[1], args: typeof args === 'object' && args !== null ? args : {}, raw: m[0] };
    } catch { return null; }
  },

  // Pattern 4c — <tool_code> tags: gemma-4 wraps calls in <tool_code>fn(args)</tool_code>
  (text) => {
    const block = text.match(/<tool_code>\s*([\s\S]*?)\s*<\/tool_code>/i);
    if (!block) return null;
    const inner = block[1].trim();
    const fnMatch = inner.match(/^([a-zA-Z0-9_]+)\s*\(([^)]*)\)/s);
    if (!fnMatch) return null;
    let args: Record<string, any> = {};
    const body = fnMatch[2].trim();
    if (body.startsWith('{')) {
      try { args = JSON.parse(body); } catch {}
    } else {
      for (const m of body.matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g)) {
        args[m[1]] = m[2] ?? m[3] ?? m[4];
      }
    }
    return { tool: fnMatch[1], args, raw: block[0] };
  },

  // Pattern 4 — function-call syntax: tool_name({"key":"val"}) or tool_name(key="val", ...)
  // Requires double-underscore (server__tool) to avoid matching normal function calls in prose.
  // Single-name built-in functions are caught by Pattern 4c above.
  (text) => {
    const fnMatch = text.match(/\b([a-zA-Z0-9_]{2,}__[a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
    if (!fnMatch) return null;
    let args: Record<string, any> = {};
    const body = fnMatch[2].trim();
    if (body.startsWith('{')) {
      try { args = JSON.parse(body); } catch {}
    } else {
      for (const m of body.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
        args[m[1]] = m[2] ?? m[3] ?? m[4];
      }
    }
    return { tool: fnMatch[1], args, raw: fnMatch[0] };
  }
];

/**
 * Attempts to extract a tool call from raw model output text.
 * Tries four patterns in priority order — returns the first match, or null if none found.
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
      try { results.push(JSON.parse(text.slice(i, j + 1))); } catch {}
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
export function buildToolSystemPrompt(tools: McpTool[]): string {
  if (tools.length === 0) return '';
  const list = tools.map(t => {
    const props = t.inputSchema?.properties ?? {};
    const required: string[] = t.inputSchema?.required ?? [];
    const params = Object.entries(props).map(([k, v]: [string, any]) => {
      const req = required.includes(k) ? ' (required)' : ' (optional)';
      return `    - ${k}${req}: ${v.description || v.type || 'any'}`;
    }).join('\n');
    return `• ${t.name}\n  ${t.description}${params ? '\n  Parameters:\n' + params : ''}`;
  }).join('\n\n');

  return `\n\n---\nYOU HAVE TOOLS AVAILABLE. When a task requires fetching data, reading files, or any action a tool can perform, you MUST call it — do not guess or make up results.\n\nTo call a tool, output ONLY a JSON object in this exact format (nothing else on that turn):\n{"tool":"<tool_name>","args":{"param":"value"}}\n\nAvailable tools:\n${list}\n\nAfter you receive the tool result, continue your response. If no tool is needed, respond normally.`;
}
