/**
 * message-utils.ts
 *
 * Pure message-manipulation helpers shared across all provider implementations.
 * No VS Code or provider imports, fully unit-testable in isolation.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Set only on a compact-marker message, to when that compaction ran. Never read by any
   *  provider (they only ever pick role/content/tool_calls off a message), so it costs nothing
   *  in tokens — display only. */
  compactedAt?: number;
}

/**
 * Merges multiple system messages into a single leading one and strips __compacted__
 * sentinels so only the human-readable summary reaches the model. Many Jinja chat
 * templates (Qwen3, Llama-3, Mistral, …) reject or silently drop extra system turns.
 */
export function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const content = msg.content.startsWith('__compacted__')
        ? msg.content.replace(/^__compacted__\n*/, '').trim()
        : msg.content.trim();
      if (content) systemParts.push(content);
    } else {
      rest.push(msg);
    }
  }
  if (systemParts.length === 0) return rest;
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

/**
 * Converts ChatMessage[] to Ollama's wire format. Merges all system messages into a
 * single leading one (most Jinja templates silently drop extras), strips compact
 * sentinels, and deserialises tool_call arguments from JSON strings to objects (Ollama
 * expects parsed objects, not JSON strings).
 */
export function normaliseForOllama(messages: ChatMessage[]): any[] {
  const merged = mergeSystemMessages(messages);
  const result: any[] = [];

  for (const msg of merged) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content });
      continue;
    }
    const base: any = { role: msg.role, content: msg.content };
    if (msg.images?.length) base.images = msg.images;
    if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id;
    if (msg.tool_calls) {
      base.tool_calls = msg.tool_calls.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })()
        }
      }));
    }
    result.push(base);
  }

  return result;
}
