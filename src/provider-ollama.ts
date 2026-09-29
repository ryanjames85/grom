/**
 * provider-ollama.ts
 *
 * Ollama provider: local LLM inference via /api/chat and /api/tags.
 */

import type { ChatMessage } from './message-utils';
import { normaliseForOllama, mergeSystemMessages } from './message-utils';
import { isReasoningModel, applyLocalReasoningEffort } from './model-caps';
import type { ModelCapabilities, ILLMProvider, ToolDefinition, ToolCallResult } from './provider-types';
import { parseHttpError } from './provider-types';

// Monotonic counter: avoids Date.now() collisions on rapid sequential calls
let _seq = 0;
function nextId(): string { return `ollama-${++_seq}`; }

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

      // Ollama 0.6.4+ lists what the model can do, e.g. ["completion", "tools", "thinking", "vision"].
      // That is authoritative, so use it instead of scanning the JSON for keywords, which mistakes
      // things like vision tokens in a chat template for real vision support.
      const declared: string[] | null = Array.isArray(rawInfo.capabilities) && rawInfo.capabilities.length > 0
        ? rawInfo.capabilities.map((c: unknown) => String(c).toLowerCase())
        : null;
      if (declared) {
        return {
          vision: declared.includes('vision'),
          reasoning: declared.includes('thinking') || isReasoningModel(model),
          tools: declared.includes('tools')
        };
      }

      const details = rawInfo.details || {};
      const families = (details.families || []).map((f: string) => f.toLowerCase());

      // Tier 1: explicit GGUF metadata tags (Ollama 0.4+). Most reliable source.
      const modelInfo = rawInfo.model_info || {};
      const tags: string[] = (modelInfo['general.tags'] || []).map((t: string) => t.toLowerCase());

      // Tier 2: chat template inspection. The template is always present in /api/show and
      // contains tool conditionals ({% if tools %}) for models trained for function calling.
      const template: string = modelInfo['tokenizer.ggml.chat_template'] || rawInfo.template || '';
      const templateHasTools = /\{%-?\s*if\s+tools\b|\{%-?\s*for\s+\w+\s+in\s+tools\b/i.test(template);

      // Tier 3: narrow keyword scan. Only scan the raw JSON string, but NOT for 'parameter'
      // which appears in every model's parameters section and produced false positives.
      const infoStr = JSON.stringify(rawInfo).toLowerCase();

      return {
        vision: tags.some(t => ['vision', 'vlm', 'multimodal', 'mllm', 'clip'].includes(t)) ||
          families.some((f: string) => f.includes('vision') || f.includes('clip') || f.includes('vlm') || f.includes('mllm')) ||
          infoStr.includes('projector') || infoStr.includes('vision') || infoStr.includes('vlm'),
        reasoning: tags.some(t => ['reasoning', 'thinking'].includes(t)) ||
          infoStr.includes('reasoning') || infoStr.includes('thinking') || isReasoningModel(model),
        tools: tags.some(t => t === 'tools' || t === 'function-calling') ||
          templateHasTools ||
          infoStr.includes('"tools"') || infoStr.includes('"function_call"')
      };
    } catch { return { vision: false, reasoning: false, tools: false }; }
  }

  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean, tools?: ToolDefinition[], reasoningEffort?: 'off' | 'low' | 'medium' | 'high'): Promise<ToolCallResult> {
    const merged = mergeSystemMessages(messages);
    const efforted = reasoningEffort ? applyLocalReasoningEffort(merged, model, reasoningEffort) : merged;
    const ollamaMessages = normaliseForOllama(efforted);

    const body: any = { model, messages: ollamaMessages, stream: true };
    if (jsonMode) body.format = 'json';
    // Layer 2: pass tools array, Ollama supports OpenAI-style tool calling for capable models
    if (tools?.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', ...t.inputSchema } } }));
    }
    const hadTools = !!body.tools;

    let res = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)' }, body: JSON.stringify(body), signal });
    // If the model can't handle tools (400 = unsupported, 500 = malformed tool call JSON from
    // the model), retry without them so the heuristic parser handles it instead.
    if (!res.ok && body.tools) {
      const errText = await res.text();
      const lower = errText.toLowerCase();
      const isToolRelated = res.status === 400 ||
        (res.status === 500 && (lower.includes('tool') || lower.includes('function') || lower.includes('closing') || lower.includes('json')));
      if (isToolRelated) {
        delete body.tools;
        res = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)' }, body: JSON.stringify(body), signal });
        if (!res.ok) throw new Error(parseHttpError(await res.text()));
        // Signal to the agent loop that native tools failed so it can re-enable heuristic mode.
        if (!res.body) return { text: '', toolsDropped: true };
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
    let nativeToolCall: ToolCallResult['toolCall'] | undefined;
    let streamError: string | undefined;
    // Thinking models (Qwen3, DeepSeek-R1, etc.) stream their reasoning in message.thinking with an empty
    // content. Forward it to the UI as a <think> block (which the webview already renders) so the reply
    // does not look frozen, but keep it out of the returned text so tool detection sees only the answer.
    let inReasoning = false;
    const closeReasoning = () => { if (inReasoning) { inReasoning = false; onChunk('</think>'); } };

    const parseOllamaLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const j = JSON.parse(line);
        // Ollama can return 200 then stream {"error":"..."} when the model emits malformed JSON.
        if (j.error && !j.message?.content) { streamError = j.error; return; }
        const thinking = j.message?.thinking;
        if (typeof thinking === 'string' && thinking !== '') {
          onChunk(inReasoning ? thinking : `<think>${thinking}`);
          inReasoning = true;
        }
        if (j.message?.content) { closeReasoning(); onChunk(j.message.content); fullText += j.message.content; }
        if (j.message?.tool_calls?.length && !nativeToolCall) {
          const tc = j.message.tool_calls[0];
          const rawArgs = tc.function?.arguments;
          nativeToolCall = {
            id: nextId(),
            name: tc.function?.name || '',
            args: typeof rawArgs === 'string'
              ? (() => { try { return JSON.parse(rawArgs); } catch { return {}; } })()
              : (rawArgs || {})
          };
        }
      } catch {}
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) parseOllamaLine(line);
    }
    if (buffer.trim()) parseOllamaLine(buffer);
    closeReasoning();

    // Stream completed with an in-body error (e.g. malformed tool call JSON from the model).
    // Ollama returns 200 then streams {"error":"..."}, our !res.ok check misses this.
    // Only retry if nothing was chunked to the UI yet (avoids duplicating already-rendered content).
    if (streamError && hadTools && !nativeToolCall && !fullText) {
      delete body.tools;
      return { ...(await this.streamChat(model, messages, onChunk, signal, jsonMode, undefined, reasoningEffort)), toolsDropped: true };
    }
    if (streamError && !fullText && !nativeToolCall) throw new Error(streamError);

    return { text: fullText, toolCall: nativeToolCall, toolsDropped: !body.tools && hadTools };
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const ollamaMessages = normaliseForOllama(messages);
    const res = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: ollamaMessages, stream: false }), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    const data: any = await res.json();
    return data.message?.content || '';
  }
}
