/**
 * provider-openai.ts
 *
 * Native OpenAI-compatible provider: any /v1/chat/completions server (OpenAI, Gemini,
 * Groq, Mistral, LM Studio, etc.).
 */

import type { ChatMessage } from './message-utils';
import { mergeSystemMessages } from './message-utils';
import { isReasoningModel, isVisionModel, isToolsModel, isApiReasoningModel, applyLocalReasoningEffort } from './model-caps';
import type { ModelCapabilities, ILLMProvider, ToolDefinition, ToolCallResult, AuthType } from './provider-types';
import { parseHttpError } from './provider-types';

// Monotonic counter: avoids Date.now() collisions on rapid sequential calls
let _seq = 0;
function nextId(): string { return `call-${++_seq}`; }

export class OpenAICompatibleProvider implements ILLMProvider {
  private baseUrl: string;
  private authHeader: Record<string, string>;
  // Cached from last getModels() call, consumed once by getCapabilities() to avoid a second fetch.
  private _lastModelsRaw: any = null;
  // True when _lastModelsRaw came from /api/v0/models (LM Studio) with explicit capability fields.
  private _lastModelsRawIsV0 = false;

  constructor(baseUrl: string, apiKey?: string, authType: AuthType = 'bearer') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    if (!apiKey || authType === 'none') this.authHeader = {};
    else if (authType === 'x-api-key') this.authHeader = { 'x-api-key': apiKey };
    else this.authHeader = { 'Authorization': `Bearer ${apiKey}` };
  }

  async getModels(signal?: AbortSignal): Promise<string[]> {
    // Prefer LM Studio's /api/v0/models (0.3.5+); it returns explicit boolean capability fields
    // per model, making getCapabilities() much more accurate. Falls through silently for any
    // server that doesn't implement this endpoint.
    try {
      const v0Res = await fetch(`${this.baseUrl}/api/v0/models`, { headers: this.authHeader, signal });
      if (v0Res.ok) {
        const v0Data: any = await v0Res.json();
        const chatModels = (v0Data.data ?? []).filter((m: any) => m.type !== 'embeddings' && m.state !== 'not-loaded');
        if (chatModels.length > 0) {
          this._lastModelsRaw = { ...v0Data, data: chatModels };
          this._lastModelsRawIsV0 = true;
          return chatModels.map((m: any) => m.id);
        }
        // Nothing is loaded. LM Studio loads on demand, so still offer the installed chat models,
        // but never embedding models (the /v1/models fallback below would list those too).
        const installed = (v0Data.data ?? []).filter((m: any) => m.type !== 'embeddings');
        if (installed.length > 0) {
          this._lastModelsRaw = { ...v0Data, data: installed };
          this._lastModelsRawIsV0 = true;
          return installed.map((m: any) => m.id);
        }
      }
    } catch {}
    this._lastModelsRawIsV0 = false;
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
      vision: isVisionModel(model),
      reasoning: isReasoningModel(model),
      // Server-reported caps take precedence; name-based is a fallback for servers that don't report caps.
      tools: isToolsModel(model)
    };
    try {
      // Consume the cache set by getModels(). If getModels() was called first (normal flow),
      // this avoids any additional network request. If not, fetch fresh.
      const cached = this._lastModelsRaw;
      const cachedIsV0 = this._lastModelsRawIsV0;
      this._lastModelsRaw = null;
      this._lastModelsRawIsV0 = false;
      const data: any = cached || await (async () => {
        // No cache: try v0 (LM Studio), fall through to v1 for other servers.
        try {
          const v0Res = await fetch(`${this.baseUrl}/api/v0/models`, { headers: this.authHeader, signal: signal ?? AbortSignal.timeout(3000) });
          if (v0Res.ok) { const d: any = await v0Res.json(); if (d.data?.length > 0) return { data: d.data, _isV0: true }; }
        } catch {}
        const res = await fetch(`${this.baseUrl}/v1/models`, { headers: this.authHeader, signal });
        return res.ok ? await res.json() : null;
      })();
      if (!data) return nameBased;

      const isV0 = cachedIsV0 || !!(data._isV0);
      const entry = data.data?.find((e: any) => e.id === model || e.id === shortName || (isV0 && e.path === model));
      if (!entry) return nameBased;

      const caps = entry.capabilities || {};
      const info = JSON.stringify(entry).toLowerCase();

      // When the entry has explicit LM Studio v0 boolean caps, trust them over heuristics.
      if (isV0 && (typeof caps.vision === 'boolean' || typeof caps.tool_calls === 'boolean' || typeof caps.tools === 'boolean')) {
        return {
          vision: typeof caps.vision === 'boolean' ? caps.vision : (info.includes('vision') || info.includes('vlm') || nameBased.vision),
          reasoning: typeof caps.reasoning === 'boolean' ? caps.reasoning : (info.includes('reasoning') || nameBased.reasoning),
          tools: typeof caps.tool_calls === 'boolean' ? caps.tool_calls : (typeof caps.tools === 'boolean' ? caps.tools : nameBased.tools)
        };
      }

      // Current LM Studio reports type "llm" (text only) or "vlm" (vision) and lists capabilities as an
      // array such as ["tool_use"]. The server is authoritative here: a name keyword like "qwen3" must
      // not turn a text-only model into a vision model. Without a capabilities array, fall back to names.
      if (isV0 && (entry.type === 'llm' || entry.type === 'vlm')) {
        return {
          vision: entry.type === 'vlm',
          reasoning: !!(caps.reasoning || caps.thinking || info.includes('reasoning') || info.includes('thinking') || nameBased.reasoning),
          tools: Array.isArray(entry.capabilities) ? entry.capabilities.includes('tool_use') : nameBased.tools
        };
      }

      // /v1/models path: only trust server-reported tool caps when the entry has explicit capability fields.
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

  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, _jsonMode?: boolean, tools?: ToolDefinition[], reasoningEffort?: 'off' | 'low' | 'medium' | 'high'): Promise<ToolCallResult> {
    // o-series and Gemini 2.5+ use the API body param; other models go through applyLocalReasoningEffort
    // (Qwen3 /think tokens, or prompt hints for other reasoning models)
    const useApiEffort = isApiReasoningModel(model);
    const merged = mergeSystemMessages(messages);
    const baseMessages = (reasoningEffort && !useApiEffort) ? applyLocalReasoningEffort(merged, model, reasoningEffort) : merged;
    const formattedMessages = baseMessages.map(msg => {
      if (msg.role === 'tool') {
        // Native tool result: OpenAI format. tool_call_id is required; a missing one means
        // a bug in the calling code (buildFeedback always sets it from nativeTc.id).
        if (!msg.tool_call_id) throw new Error('tool_call_id is required on role:tool messages');
        return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id };
      }
      if (msg.tool_calls) {
        // Assistant message that triggered a tool call; must include tool_calls array
        return { role: msg.role, content: msg.content, tool_calls: msg.tool_calls };
      }
      if (msg.images?.length) {
        return { role: msg.role, content: [{ type: 'text', text: msg.content }, ...msg.images.map(img => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }))] };
      }
      return { role: msg.role, content: msg.content };
    });

    const body: any = { model, messages: formattedMessages, stream: true };
    if (useApiEffort && reasoningEffort && reasoningEffort !== 'off') body.reasoning_effort = reasoningEffort;
    // Layer 1: send tools array, provider returns structured tool_calls instead of free-form text
    if (tools?.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', ...t.inputSchema } } }));
    }
    const hadTools = !!body.tools;

    let res = await fetch(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)', ...this.authHeader }, body: JSON.stringify(body), signal });
    // If the server rejected the request and tools were included, retry without them.
    // Some older/custom OpenAI-compat servers return 400 on unknown fields; this prevents regression.
    if (!res.ok && body.tools) {
      const errText = await res.text();
      const lower = errText.toLowerCase();
      // Only retry without tools on explicit 400s that mention tools/functions, not auth, quota, or generic errors.
      // Broad keywords like 'unknown'/'invalid' would swallow real server errors (e.g. 503 "Service temporarily invalid").
      const isToolRejection = res.status === 400 && (lower.includes('tool') || lower.includes('function'));
      if (isToolRejection) {
        delete body.tools;
        res = await fetch(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)', ...this.authHeader }, body: JSON.stringify(body), signal });
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
    // Servers such as LM Studio return 200 then stream {"error":{...}} when a model fails to load
    // or the engine dies mid-request. Remember it so an empty reply is reported, not swallowed.
    let streamError = '';
    // Reasoning models on LM Studio, vLLM, DeepSeek and OpenRouter stream their thinking in a separate
    // delta field. Forward it to the UI as a <think> block (which the webview already renders) so the
    // user sees progress, but keep it out of the returned text so tool detection sees only the answer.
    let inReasoning = false;
    const closeReasoning = () => { if (inReasoning) { inReasoning = false; onChunk('</think>'); } };
    // Accumulate tool_call deltas: arguments stream in chunks that must be concatenated
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
          if (j.error && !j.choices?.length) {
            streamError = typeof j.error === 'string' ? j.error : (j.error.message || j.message || 'The model server reported an error');
          }
          const delta = j.choices?.[0]?.delta;
          const reasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (typeof reasoning === 'string' && reasoning !== '') {
            onChunk(inReasoning ? reasoning : `<think>${reasoning}`);
            inReasoning = true;
          }
          if (delta?.content != null && delta.content !== '') { closeReasoning(); onChunk(delta.content); fullText += delta.content; }
          // Layer 1: accumulate streaming tool_calls deltas (current format)
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
          // Legacy function_call format (older OpenAI-compat providers: LocalAI, Jan, older llama.cpp)
          if (delta?.function_call) {
            if (!accTC.has(0)) accTC.set(0, { id: '', name: '', args: '' });
            const entry = accTC.get(0)!;
            if (delta.function_call.name) entry.name += delta.function_call.name;
            if (delta.function_call.arguments) entry.args += delta.function_call.arguments;
          }
        } catch {}
      }
    }

    closeReasoning();

    // Nothing usable arrived and the server said why: surface it instead of returning a blank reply.
    if (streamError && !fullText && accTC.size === 0) throw new Error(streamError);

    // If any tool_calls were accumulated, return the first one as a native tool call
    if (accTC.size > 0) {
      const first = accTC.get(0)!;
      try {
        const args = JSON.parse(first.args || '{}');
        return { text: fullText, toolCall: { id: first.id || nextId(), name: first.name, args } };
      } catch { return { text: fullText, toolsDropped: hadTools }; }
    }

    return { text: fullText };
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)', ...this.authHeader },
      body: JSON.stringify({ model, messages: mergeSystemMessages(messages), stream: false }),
      signal
    });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}
