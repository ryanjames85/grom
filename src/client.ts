/**
 * client.ts
 *
 * HTTP client for communicating with local LLM servers.
 * Supports two provider formats — Ollama (/api/chat) and OpenAI-compatible (/v1/chat/completions).
 * The correct provider is selected at construction time via the `useOllamaFormat` flag.
 *
 * NOTE: This file is intentionally vscode-free. All VS Code glue (webview posting,
 * status bar updates) lives in provider.ts. This file only knows about HTTP and messages.
 */

import { parseHttpError } from './utils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[]; // Base64-encoded image data (Ollama vision models only)
}

export interface ModelCapabilities {
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
}

/** Common interface both provider implementations must satisfy. */
interface ILLMProvider {
  getModels(signal?: AbortSignal): Promise<string[]>;
  getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities>;
  streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean): Promise<string>;
  chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

/** Talks to an Ollama server using the /api/chat and /api/tags endpoints. */
class OllamaProvider implements ILLMProvider {
  private baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Returns all model names currently pulled in Ollama. */
  async getModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!res.ok) throw new Error(`Ollama error: ${res.statusText}`);
    const data: any = await res.json();
    return data.models?.map((m: any) => m.name) || [];
  }

  /**
   * Detects vision, reasoning, and tool-use capabilities by inspecting the model's
   * metadata returned from /api/show. Falls back to safe defaults on any error.
   */
  async getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    try {
        const res = await fetch(`${this.baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model }),
            signal
        });
        if (!res.ok) return { vision: false, reasoning: false, tools: false };
        const data: any = await res.json();
        const info = JSON.stringify(data).toLowerCase();
        return {
            vision: info.includes('vision') || info.includes('multimodal'),
            reasoning: info.includes('think') || info.includes('reasoning') || model.toLowerCase().includes('r1'),
            tools: info.includes('tools') || info.includes('functions') || info.includes('call')
        };
    } catch { return { vision: false, reasoning: false, tools: false }; }
  }

  /**
   * Streams a chat response from Ollama, calling onChunk for each token as it arrives.
   * When jsonMode is true, adds `format: "json"` to the request body — this constrains
   * Ollama to emit valid JSON output, used by the agent loop to enforce tool-call format.
   */
  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, ...(jsonMode ? { format: 'json' } : {}) }),
      signal
    });
    if (!res.ok) {
        throw new Error(parseHttpError(await res.text()));
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer for the next iteration
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const json = JSON.parse(line);
            if (json.message?.content) {
                onChunk(json.message.content);
                fullText += json.message.content;
            }
        } catch (e) {
            console.error('[Ollama] Error parsing JSON line:', e, line);
        }
      }
    }
    return fullText;
  }

  /** Non-streaming chat — waits for the full response before returning. Used for title generation. */
  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal
    });
    if (!res.ok) {
        throw new Error(parseHttpError(await res.text()));
    }
    const data: any = await res.json();
    return data.message?.content || "";
  }
}

/**
 * Talks to any OpenAI-compatible server (LM Studio, OpenCode, OpenAI, etc.)
 * using the /v1/chat/completions and /v1/models endpoints.
 */
class OpenAICompatibleProvider implements ILLMProvider {
  private baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Returns model IDs from the /v1/models endpoint. */
  async getModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, { signal });
    if (!res.ok) throw new Error(`Provider error: ${res.statusText}`);
    const data: any = await res.json();
    return data.data?.map((m: any) => m.id) || [];
  }

  /**
   * Detects capabilities first by model name heuristics (fast, no extra request),
   * then refines against the /v1/models response if available.
   * Name-based detection handles common open-source model naming conventions.
   */
  async getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    const m = model.toLowerCase();
    // Strip provider prefix (e.g. "google/gemma-4-e4b" → "gemma-4-e4b")
    const shortName = m.includes('/') ? m.split('/').pop()! : m;
    const nameBased = {
      vision: ['vision', 'vl', 'multimodal', 'llava', 'bakllava', 'moondream', 'gemma-4', 'gemma4', 'pixtral', 'qwen-vl', 'internvl', 'cogvlm', 'phi-3-vision', 'phi3-vision', 'qwen3'].some(k => shortName.includes(k)),
      reasoning: ['think', 'reason', 'r1', 'qwq', 'deepseek-r', 'marco-o1'].some(k => shortName.includes(k)),
      tools: ['tool', 'function', 'agent', 'qwen3', 'qwen2.5', 'mistral-nemo', 'command-r', 'firefunction', 'gemma-4', 'gemma4', 'llama-3', 'llama3', 'mistral', 'phi-4', 'phi4'].some(k => shortName.includes(k))
    };
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal });
      if (!res.ok) return nameBased;
      const data: any = await res.json();
      const entry = data.data?.find((e: any) => e.id === model || e.id === shortName);
      if (!entry) return nameBased;
      const caps = entry.capabilities || {};
      const info = JSON.stringify(entry).toLowerCase();
      return {
        vision: !!(caps.vision || caps.image_input || info.includes('vision') || info.includes('vlm') || info.includes('multimodal') || nameBased.vision),
        reasoning: !!(caps.reasoning || info.includes('reasoning') || info.includes('thinking') || nameBased.reasoning),
        tools: !!(caps.tools || caps.tool_use || caps.function_calling || info.includes('tool_use') || info.includes('function_call') || nameBased.tools)
      };
    } catch { return nameBased; }
  }

  /**
   * Streams a chat response from an OpenAI-compatible server using SSE (server-sent events).
   * Images are converted to the OpenAI vision content-array format before sending.
   * NOTE: jsonMode is accepted but not forwarded — OpenAI-compat providers vary too much
   * in their support for response_format; we rely on Ollama's format constraint instead.
   */
  async streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, _jsonMode?: boolean): Promise<string> {
    const formattedMessages = messages.map(msg => {
        if (msg.images && msg.images.length > 0) {
            return {
                role: msg.role,
                content: [
                    { type: 'text', text: msg.content },
                    ...msg.images.map(img => ({
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${img}` }
                    }))
                ]
            };
        }
        return msg;
    });

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: formattedMessages, stream: true }),
      signal
    });
    if (!res.ok) {
      throw new Error(parseHttpError(await res.text()));
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine || !cleanLine.startsWith('data: ')) continue;

        const jsonStr = cleanLine.slice(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
            const json = JSON.parse(jsonStr);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
                onChunk(content);
                fullText += content;
            }
        } catch (e) {
            console.error('[OpenAI] Error parsing JSON line:', e, jsonStr);
        }
      }
    }
    return fullText;
  }

  /** Non-streaming chat — waits for the full response before returning. Used for title generation. */
  async chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal
    });
    if (!res.ok) {
        throw new Error(parseHttpError(await res.text()));
    }
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
}

/**
 * Public facade over the two provider implementations.
 * Callers never interact with OllamaProvider or OpenAICompatibleProvider directly —
 * they only use LocalLLMClient.
 */
export class LocalLLMClient {
  private provider: ILLMProvider;
  private model: string;

  /** Selects Ollama or OpenAI-compatible transport based on useOllamaFormat. */
  constructor(baseUrl: string, model: string, useOllamaFormat: boolean) {
    this.model = model;
    this.provider = useOllamaFormat
        ? new OllamaProvider(baseUrl)
        : new OpenAICompatibleProvider(baseUrl);
  }

  /** Returns all model names available on the configured server. */
  async getAvailableModels(signal?: AbortSignal): Promise<string[]> {
    return await this.provider.getModels(signal);
  }

  /** Returns vision/reasoning/tools capability flags for the configured model. Never throws. */
  async getCapabilities(signal?: AbortSignal): Promise<ModelCapabilities> {
    try { return await this.provider.getCapabilities(this.model, signal); } catch { return { vision: false, reasoning: false, tools: false }; }
  }

  /** Non-streaming completion — waits for the full response. Used for short tasks like title generation. */
  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    return await this.provider.chat(this.model, messages, signal);
  }

  /**
   * Streams a response, calling onChunk for each token as it arrives.
   * This is the primary streaming API — all streaming goes through this method.
   * When jsonMode is true, Ollama is instructed to emit valid JSON only (used by the agent loop).
   */
  async streamChatWithCallback(messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean): Promise<string> {
    return this.provider.streamChat(this.model, messages, onChunk, signal, jsonMode);
  }
}
