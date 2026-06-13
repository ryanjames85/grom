/**
 * providers.ts
 *
 * All LLM provider implementations live here. Adding a new provider means adding a class
 * that implements ILLMProvider and wiring it into createProvider().
 *
 * Supported providers:
 *   - Ollama          — local, /api/chat + /api/tags
 *   - OpenAI-compat   — any /v1/chat/completions server (OpenAI, Gemini, Groq, Mistral, etc.)
 *   - Anthropic       — native /v1/messages API (Claude models)
 *
 * Intentionally vscode-free and utils-free to keep the dependency graph acyclic.
 */

// ── Shared types ──────────────────────────────────────────────────────────────

export type AuthType = 'bearer' | 'x-api-key' | 'none';
export type ProviderFormat = 'ollama' | 'openai' | 'anthropic';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];        // base64-encoded image data
  tool_call_id?: string;    // set on role:'tool' messages (native tool result feedback)
  /** OpenAI-format tool_calls — set on the assistant message that triggered the tool call */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

export interface ModelCapabilities {
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
}

/** A tool definition forwarded to the provider when native tool calling is available. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema object
}

/** Returned by streamChat. toolCall is populated when the provider handled the call natively. */
export interface ToolCallResult {
  text: string;
  toolCall?: { id: string; name: string; args: Record<string, any> };
}

// Monotonic counter for tool call IDs — avoids Date.now() collisions on rapid sequential calls
let _toolCallSeq = 0;
function nextToolCallId(prefix: string): string { return `${prefix}-${++_toolCallSeq}`; }

export interface ILLMProvider {
  getModels(signal?: AbortSignal): Promise<string[]>;
  getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities>;
  streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean, tools?: ToolDefinition[]): Promise<ToolCallResult>;
  chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

// Inlined to avoid a circular dep with utils.ts (which imports ChatMessage from client.ts).
function parseHttpError(raw: string): string {
  try { const j = JSON.parse(raw); return j.error?.message || j.error || j.message || raw; } catch { return raw; }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

export class OllamaProvider implements ILLMProvider {
  private baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl.replace(/\/+$/, ''); }

  async getModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!res.ok) throw new Error(`Ollama error: ${res.statusText}`);
    const data: any = await res.json();
    return data.models?.map((m: any) => m.name) || [];
  }

  async getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    try {
      let res = await fetch(`${this.baseUrl}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: model }), signal });
      if (!res.ok && !model.includes(':')) {
        // Try with :latest if untagged name fails
        res = await fetch(`${this.baseUrl}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${model}:latest` }), signal });
      }
      if (!res.ok) return { vision: false, reasoning: false, tools: false };
      const rawInfo = await res.json();
      const infoStr = JSON.stringify(rawInfo).toLowerCase();
      const details = rawInfo.details || {};
      const families = (details.families || []).map((f: string) => f.toLowerCase());
      
      return {
        vision: infoStr.includes('projector') || infoStr.includes('vision') || infoStr.includes('vlm') || infoStr.includes('multimodal') || families.some((f: string) => f.includes('mllm') || f.includes('vision') || f.includes('clip') || f.includes('vlm')),
        reasoning: infoStr.includes('think') || infoStr.includes('reasoning') || model.toLowerCase().includes('r1'),
        // Tools: look for explicit tool support or common architecture keywords
        tools: infoStr.includes('"tools"') || infoStr.includes('"functions"') || infoStr.includes('parameter')
      };
    } catch { return { vision: false, reasoning: false, tools: false }; }
  }

  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean, tools?: ToolDefinition[]): Promise<ToolCallResult> {
    const ollamaMessages = messages.map(msg => {
      const base: any = { role: msg.role, content: msg.content };
      if (msg.images?.length) base.images = msg.images;
      if (msg.tool_calls) base.tool_calls = msg.tool_calls;
      return base;
    });

    const body: any = { model, messages: ollamaMessages, stream: true };
    if (jsonMode) body.format = 'json';
    // Layer 2: pass tools array — Ollama supports OpenAI-style tool calling for capable models
    if (tools?.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    if (!res.body) return { text: '' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';
    let nativeToolCall: ToolCallResult['toolCall'] | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.message?.content) { onChunk(j.message.content); fullText += j.message.content; }
          // Layer 2: Ollama returns tool_calls as objects with function.arguments already parsed
          if (j.message?.tool_calls?.length && !nativeToolCall) {
            const tc = j.message.tool_calls[0];
            nativeToolCall = {
              id: nextToolCallId('ollama'),
              name: tc.function?.name || '',
              args: tc.function?.arguments || {}
            };
          }
        } catch {}
      }
    }
    return { text: fullText, toolCall: nativeToolCall };
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const ollamaMessages = messages.map(msg => ({ role: msg.role, content: msg.content, ...(msg.images?.length ? { images: msg.images } : {}) }));
    const res = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: ollamaMessages, stream: false }), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    const data: any = await res.json();
    return data.message?.content || '';
  }
}

// ── OpenAI-compatible ─────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements ILLMProvider {
  private baseUrl: string;
  private authHeader: Record<string, string>;
  // Cached from last getModels() call — consumed once by getCapabilities() to avoid a second fetch.
  private _lastModelsRaw: any = null;

  constructor(baseUrl: string, apiKey?: string, authType: AuthType = 'bearer') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    if (!apiKey || authType === 'none') this.authHeader = {};
    else if (authType === 'x-api-key') this.authHeader = { 'x-api-key': apiKey };
    else this.authHeader = { 'Authorization': `Bearer ${apiKey}` };
  }

  async getModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeader, signal });
    if (!res.ok) throw new Error(`Provider error: ${res.statusText}`);
    const data: any = await res.json();
    this._lastModelsRaw = data;
    return data.data?.map((m: any) => m.id) || [];
  }

  async getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    const m = model.toLowerCase();
    const shortName = m.includes('/') ? m.split('/').pop()! : m;
    const nameBased = {
      // Vision: families where vision is standard across all sizes, plus explicit -vl/-vision suffixes.
      vision: [
        'vision', '-vl', 'vlm',
        'llava', 'bakllava', 'moondream', 'pixtral',
        'qwen-vl', 'qwen3',
        'internvl', 'cogvlm', 'ovis',
        'phi-3-vision', 'phi3-vision',
        'gemma-4', 'gemma4', 'gemma3', 'gemma-3',
        'llama-4',
        'mistral-small-3',
        'minicpm-v',
        'paligemma',
        'molmo',
        'janus',
        'idefics',
        'florence',
      ].some(k => shortName.includes(k)),
      reasoning: ['think', 'reason', 'r1', 'qwq', 'deepseek-r', 'marco-o1', 's1-', 'sky-t1'].some(k => shortName.includes(k)),
      // Tools: families/variants reliably trained for function calling.
      // Server-reported caps take precedence; name-based is a fallback for servers that don't report caps.
      tools: [
        'tool', 'function', 'agent',
        'qwen3', 'qwen2.5', 'qwen2',
        'gemma-4', 'gemma4',
        'llama3', 'llama-3', 'llama-4',
        'mistral-nemo', 'mistral-small', 'mistral-large',
        'command-r', 'firefunction',
        'hermes',
        'phi-3', 'phi3', 'phi-4', 'phi4',
        'deepseek-v',
        'nemotron',
      ].some(k => shortName.includes(k))
    };
    try {
      // Reuse data from the preceding getModels() call if available — avoids a second network request.
      const cached = this._lastModelsRaw;
      this._lastModelsRaw = null;
      const data: any = cached || await (async () => {
        const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeader, signal });
        return res.ok ? res.json() : null;
      })();
      if (!data) return nameBased;
      const entry = data.data?.find((e: any) => e.id === model || e.id === shortName);
      if (!entry) return nameBased;
      const caps = entry.capabilities || {};
      const info = JSON.stringify(entry).toLowerCase();
      // Only trust server-reported tool caps when the entry has explicit capability fields.
      // This prevents servers returning minimal model info from silently disabling tool detection.
      const hasExplicitCaps = Object.keys(caps).length > 0;
      // tool_calls is LM Studio's field name; tool_use / function_calling are used by other servers.
      const serverTools = !!(caps.tools || caps.tool_use || caps.tool_calls || caps.function_calling || info.includes('tool_use') || info.includes('tool_calls') || info.includes('function_call'));
      return {
        vision: !!(caps.vision || caps.image_input || caps.image_url || caps.images || caps.multimodal || info.includes('vision') || info.includes('vlm') || info.includes('multimodal') || nameBased.vision),
        reasoning: !!(caps.reasoning || caps.thinking || info.includes('reasoning') || info.includes('thinking') || nameBased.reasoning),
        tools: hasExplicitCaps ? serverTools : nameBased.tools
      };
    } catch { return nameBased; }
  }

  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, _jsonMode?: boolean, tools?: ToolDefinition[]): Promise<ToolCallResult> {
    const formattedMessages = messages.map(msg => {
      if (msg.role === 'tool') {
        // Native tool result — OpenAI format. tool_call_id is required; a missing one means
        // a bug in the calling code (buildFeedback always sets it from nativeTc.id).
        if (!msg.tool_call_id) throw new Error('tool_call_id is required on role:tool messages');
        return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id };
      }
      if (msg.tool_calls) {
        // Assistant message that triggered a tool call — must include tool_calls array
        return { role: msg.role, content: msg.content, tool_calls: msg.tool_calls };
      }
      if (msg.images?.length) {
        return { role: msg.role, content: [{ type: 'text', text: msg.content }, ...msg.images.map(img => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }))] };
      }
      return { role: msg.role, content: msg.content };
    });

    const body: any = { model, messages: formattedMessages, stream: true };
    // Layer 1: send tools array — provider returns structured tool_calls instead of free-form text
    if (tools?.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }

    let res = await fetch(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.authHeader }, body: JSON.stringify(body), signal });
    // If the server rejected the request and tools were included, retry without them.
    // Some older/custom OpenAI-compat servers return 400 on unknown fields — this prevents regression.
    if (!res.ok && body.tools) {
      const errText = await res.text();
      const lower = errText.toLowerCase();
      // Only retry without tools on explicit 400s that mention tools/functions — not auth, quota, or generic errors.
      // Broad keywords like 'unknown'/'invalid' would swallow real server errors (e.g. 503 "Service temporarily invalid").
      const isToolRejection = res.status === 400 && (lower.includes('tool') || lower.includes('function'));
      if (isToolRejection) {
        delete body.tools;
        res = await fetch(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.authHeader }, body: JSON.stringify(body), signal });
        if (!res.ok) throw new Error(parseHttpError(await res.text()));
      } else {
        throw new Error(parseHttpError(errText));
      }
    } else if (!res.ok) {
      throw new Error(parseHttpError(await res.text()));
    }
    if (!res.body) return { text: '' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';
    // Accumulate tool_call deltas — arguments stream in chunks that must be concatenated
    const accTC = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const clean = line.trim();
        if (!clean.startsWith('data: ')) continue;
        const jsonStr = clean.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const j = JSON.parse(jsonStr);
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) { onChunk(delta.content); fullText += delta.content; }
          // Layer 1: accumulate streaming tool_calls deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!accTC.has(idx)) accTC.set(idx, { id: '', name: '', args: '' });
              const entry = accTC.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }
        } catch {}
      }
    }

    // If any tool_calls were accumulated, return the first one as a native tool call
    if (accTC.size > 0) {
      const first = accTC.get(0)!;
      try {
        const args = JSON.parse(first.args || '{}');
        return { text: fullText, toolCall: { id: first.id || nextToolCallId('call'), name: first.name, args } };
      } catch { /* malformed args — fall through to text path so heuristic parser gets a chance */ }
    }

    return { text: fullText };
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeader },
      body: JSON.stringify({ model, messages, stream: false }),
      signal
    });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────

const ANTHROPIC_FALLBACK_MODELS = [
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'
];

export class AnthropicProvider implements ILLMProvider {
  private baseUrl: string;
  private authHeader: Record<string, string>;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authHeader = {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      'anthropic-version': '2023-06-01'
    };
  }

  async getModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeader, signal });
      if (!res.ok) return ANTHROPIC_FALLBACK_MODELS;
      const data: any = await res.json();
      return data.data?.map((m: any) => m.id) || ANTHROPIC_FALLBACK_MODELS;
    } catch { return ANTHROPIC_FALLBACK_MODELS; }
  }

  async getCapabilities(model: string): Promise<ModelCapabilities> {
    const m = model.toLowerCase();
    return {
      vision: m.includes('claude'),
      reasoning: m.includes('claude-3-7') || m.includes('opus-4'),
      tools: m.includes('claude')
    };
  }

  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, _jsonMode?: boolean, tools?: ToolDefinition[]): Promise<ToolCallResult> {
    const system = messages.find(m => m.role === 'system')?.content;

    // Convert messages to Anthropic format — tool results use content arrays, not role:'tool'
    const anthropicMessages = messages.filter(m => m.role !== 'system').map(msg => {
      if (msg.role === 'tool') {
        // Anthropic tool results must be role:'user' with a tool_result content block
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content }] };
      }
      if (msg.tool_calls) {
        // Assistant message that triggered a tool call — wrap in content array with tool_use block
        return {
          role: 'assistant',
          content: msg.tool_calls.map(tc => ({
            type: 'tool_use', id: tc.id, name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
          }))
        };
      }
      if (msg.images?.length) {
        return { role: msg.role, content: [{ type: 'text', text: msg.content }, ...msg.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } }))] };
      }
      return { role: msg.role, content: msg.content };
    });

    const body: any = { model, max_tokens: 8096, messages: anthropicMessages, stream: true };
    if (system) body.system = system;
    // Layer 1 (Anthropic native): tools use input_schema instead of parameters
    if (tools?.length) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }

    const res = await fetch(`${this.baseUrl}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.authHeader }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    if (!res.body) return { text: '' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';
    let toolUse: { id: string; name: string; inputJson: string } | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const clean = line.trim();
        if (!clean.startsWith('data: ')) continue;
        try {
          const j = JSON.parse(clean.slice(6));
          if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') { onChunk(j.delta.text); fullText += j.delta.text; }
          // Layer 1 (Anthropic): tool_use blocks arrive as content_block_start/delta/stop
          if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
            toolUse = { id: j.content_block.id, name: j.content_block.name, inputJson: '' };
          }
          if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta' && toolUse) {
            toolUse.inputJson += j.delta.partial_json || '';
          }
        } catch {}
      }
    }

    if (toolUse) {
      try {
        const args = JSON.parse(toolUse.inputJson || '{}');
        return { text: fullText, toolCall: { id: toolUse.id, name: toolUse.name, args } };
      } catch {}
    }
    return { text: fullText };
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const system = messages.find(m => m.role === 'system')?.content;
    const body: any = {
      model, max_tokens: 8096, stream: false,
      messages: messages.filter(m => m.role !== 'system').map(msg => {
        if (msg.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content }] };
        if (msg.tool_calls) return { role: 'assistant', content: msg.tool_calls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })() })) };
        return { role: msg.role, content: msg.content };
      })
    };
    if (system) body.system = system;
    const res = await fetch(`${this.baseUrl}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.authHeader }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    const data: any = await res.json();
    return data.content?.[0]?.text || '';
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createProvider(baseUrl: string, useOllama: boolean, apiKey?: string, authType?: AuthType, providerFormat?: ProviderFormat): ILLMProvider {
  if (useOllama) return new OllamaProvider(baseUrl);
  if (providerFormat === 'anthropic') return new AnthropicProvider(baseUrl, apiKey);
  return new OpenAICompatibleProvider(baseUrl, apiKey, authType);
}
