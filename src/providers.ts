/**
 * providers.ts: barrel
 *
 * Re-exports all provider types and implementations. Adding a new provider means
 * creating a src/provider-<name>.ts file and wiring it into createProvider() below.
 *
 * Intentionally vscode-free to keep the dependency graph acyclic.
 */

export type { ChatMessage } from './message-utils';
export type { AuthType, ProviderFormat, ModelCapabilities, ToolDefinition, ToolCallResult, ILLMProvider } from './provider-types';

export { OllamaProvider } from './provider-ollama';
export { OpenAICompatibleProvider } from './provider-openai';
export { AnthropicProvider } from './provider-anthropic';

import type { AuthType, ProviderFormat, ILLMProvider } from './provider-types';
import { OllamaProvider } from './provider-ollama';
import { OpenAICompatibleProvider } from './provider-openai';
import { AnthropicProvider } from './provider-anthropic';

export function createProvider(baseUrl: string, useOllama: boolean, apiKey?: string, authType?: AuthType, providerFormat?: ProviderFormat): ILLMProvider {
  if (useOllama) return new OllamaProvider(baseUrl);
  if (providerFormat === 'anthropic') return new AnthropicProvider(baseUrl, apiKey);
  return new OpenAICompatibleProvider(baseUrl, apiKey, authType);
}
