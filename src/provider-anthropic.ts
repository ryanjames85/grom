/**
 * provider-anthropic.ts
 *
 * Anthropic provider: native /v1/messages API (Claude models).
 */

import type { ChatMessage } from './message-utils';
import { mergeSystemMessages } from './message-utils';
import type { ModelCapabilities, ILLMProvider, ToolDefinition, ToolCallResult } from './provider-types';
import { parseHttpError } from './provider-types';

const THINKING_BUDGET: Record<string, number> = { low: 2000, medium: 5000, high: 16000 };
const MIN_RESPONSE_TOKENS = 4096;

function isAdaptiveThinkingModel(model: string): boolean {
  const m = model.toLowerCase();
  // claude-FAMILY-4.N where N >= 6, or claude-FAMILY-5+
  return /claude-(opus|sonnet|haiku)-4-[6-9]\d*/.test(m) || /claude-(opus|sonnet|haiku)-[5-9]/.test(m);
}

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

  async getCapabilities(model: string, _signal?: AbortSignal): Promise<ModelCapabilities> {
    const m = model.toLowerCase();
    // claude-2 and claude-instant have no vision; claude-3+ and claude-4+ do
    const hasVision = (m.includes('claude-3') || m.includes('claude-4') || m.includes('claude-sonnet') || m.includes('claude-haiku') || m.includes('claude-opus')) && !m.includes('claude-2') && !m.includes('claude-instant');
    // Extended thinking: claude-3-7-sonnet and all claude-4 models (opus-4, sonnet-4, haiku-4)
    const hasReasoning = m.includes('claude-3-7') || m.includes('opus-4') || m.includes('sonnet-4') || m.includes('haiku-4');
    return { vision: hasVision, reasoning: hasReasoning, tools: m.includes('claude') };
  }

  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, _jsonMode?: boolean, tools?: ToolDefinition[], reasoningEffort?: 'off' | 'low' | 'medium' | 'high'): Promise<ToolCallResult> {
    // Merge system messages first so compact summaries (embedded in __compacted__ markers)
    // are folded into the single system prompt rather than silently dropped.
    const merged = mergeSystemMessages(messages);
    const system = merged[0]?.role === 'system' ? merged[0].content : undefined;

    // Convert messages to Anthropic format; tool results use content arrays, not role:'tool'
    const anthropicMessages = merged.filter(m => m.role !== 'system').map(msg => {
      if (msg.role === 'tool') {
        // Anthropic tool results must be role:'user' with a tool_result content block
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content }] };
      }
      if (msg.tool_calls) {
        // Assistant message that triggered a tool call; include any prose text before the tool_use block.
        // Anthropic requires a text block when content is non-empty; omitting it causes a validation error.
        const toolUseBlocks = msg.tool_calls.map(tc => ({
          type: 'tool_use', id: tc.id, name: tc.function.name,
          input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
        }));
        return {
          role: 'assistant',
          content: msg.content ? [{ type: 'text', text: msg.content }, ...toolUseBlocks] : toolUseBlocks
        };
      }
      if (msg.images?.length) {
        return { role: msg.role, content: [{ type: 'text', text: msg.content }, ...msg.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } }))] };
      }
      return { role: msg.role, content: msg.content };
    });

    const body: any = { model, max_tokens: 8096, messages: anthropicMessages, stream: true };
    if (system) body.system = system;
    if (reasoningEffort && reasoningEffort !== 'off') {
      if (isAdaptiveThinkingModel(model)) {
        // Claude 4.6+: adaptive thinking, no fixed budget; effort lives in output_config, not in thinking
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: reasoningEffort };
      } else {
        // Claude 3.7 / 4.5: explicit budget_tokens
        const budget = THINKING_BUDGET[reasoningEffort];
        body.thinking = { type: 'enabled', budget_tokens: budget };
        // max_tokens must exceed budget_tokens; leave MIN_RESPONSE_TOKENS for the actual response
        body.max_tokens = Math.max(body.max_tokens, budget + MIN_RESPONSE_TOKENS);
      }
    }
    // Layer 1 (Anthropic native): tools use input_schema instead of parameters
    if (tools?.length) {
      body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)', ...this.authHeader };
    // claude-3-7-sonnet requires the interleaved-thinking beta header; claude-4 models do not
    if (body.thinking && model.toLowerCase().includes('claude-3-7')) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }
    const res = await fetch(`${this.baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    if (!res.body) return { text: '' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';
    let toolUse: { id: string; name: string; inputJson: string } | undefined;

    // Layer 1 (Anthropic): tool_use blocks arrive as content_block_start/delta/stop events.
    const handleEvent = (line: string) => {
      const clean = line.trim();
      if (!clean.startsWith('data: ')) return;
      try {
        const j = JSON.parse(clean.slice(6));
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') { onChunk(j.delta.text); fullText += j.delta.text; }
        if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use' && !toolUse) {
          toolUse = { id: j.content_block.id, name: j.content_block.name, inputJson: '' };
        }
        if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta' && toolUse) {
          toolUse.inputJson += j.delta.partial_json || '';
        }
      } catch {}
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleEvent(line);
    }
    if (buffer.trim()) handleEvent(buffer);

    if (toolUse) {
      try {
        const args = JSON.parse(toolUse.inputJson || '{}');
        return { text: fullText, toolCall: { id: toolUse.id, name: toolUse.name, args } };
      } catch {
        return { text: fullText, toolsDropped: true };
      }
    }
    return { text: fullText };
  }

  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const merged = mergeSystemMessages(messages);
    const system = merged[0]?.role === 'system' ? merged[0].content : undefined;
    const body: any = {
      model, max_tokens: 8096, stream: false,
      messages: merged.filter(m => m.role !== 'system').map(msg => {
        if (msg.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content }] };
        if (msg.tool_calls) { const tb = msg.tool_calls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })() })); return { role: 'assistant', content: msg.content ? [{ type: 'text', text: msg.content }, ...tb] : tb }; }
        return { role: msg.role, content: msg.content };
      })
    };
    if (system) body.system = system;
    const res = await fetch(`${this.baseUrl}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Grom/0.5.6 (rc85)', ...this.authHeader }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(parseHttpError(await res.text()));
    const data: any = await res.json();
    return data.content?.[0]?.text || '';
  }
}
