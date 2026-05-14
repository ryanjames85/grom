/**
 * client.ts
 *
 * Public facade over the LLM provider implementations in providers.ts.
 * Callers use LocalLLMClient and never interact with individual providers directly.
 *
 * Types are re-exported here so existing importers (session.ts, utils.ts, agent-loop.ts, etc.)
 * don't need to change their import paths.
 */

export { AuthType, ProviderFormat, ChatMessage, ModelCapabilities, ILLMProvider } from './providers';
import { AuthType, ProviderFormat, ChatMessage, ModelCapabilities, createProvider } from './providers';

export class LocalLLMClient {
  private provider: import('./providers').ILLMProvider;
  private model: string;

  constructor(baseUrl: string, model: string, useOllamaFormat: boolean, apiKey?: string, authType?: AuthType, providerFormat?: ProviderFormat) {
    this.model = model;
    this.provider = createProvider(baseUrl, useOllamaFormat, apiKey, authType, providerFormat);
  }

  async getAvailableModels(signal?: AbortSignal): Promise<string[]> {
    return this.provider.getModels(signal);
  }

  async getCapabilities(signal?: AbortSignal): Promise<ModelCapabilities> {
    try { return await this.provider.getCapabilities(this.model, signal); } catch { return { vision: false, reasoning: false, tools: false }; }
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    return this.provider.chat(this.model, messages, signal);
  }

  async streamChatWithCallback(messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean): Promise<string> {
    return this.provider.streamChat(this.model, messages, onChunk, signal, jsonMode);
  }
}

/**
 * Tries to auto-detect the context window size from the provider.
 * Attempted in order:
 *   1. POST /api/show  — Ollama, LM Studio (recent), LocalAI
 *   2. GET  /props     — llama.cpp server, llamafile, LM Studio (llama.cpp-based)
 * Returns null if neither endpoint responds with a usable value.
 */
export async function fetchContextLength(url: string, model: string): Promise<number | null> {
  // 1. Ollama / LM Studio / LocalAI
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${url}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }), signal: ctrl.signal
    });
    clearTimeout(t);
    if (res.ok) {
      const d = await res.json();
      const n = d?.model_info?.['llama.context_length']
        ?? d?.model_info?.['context_length']
        ?? d?.parameters?.num_ctx
        ?? null;
      if (n) return Number(n);
    }
  } catch { /* not supported */ }

  // 2. llama.cpp server / llamafile
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${url}/props`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const d = await res.json();
      const n = d?.default_generation_settings?.n_ctx ?? d?.n_ctx ?? null;
      if (n) return Number(n);
    }
  } catch { /* not supported */ }

  return null;
}
