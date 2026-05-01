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
