/**
 * provider-types.ts
 *
 * Shared types, interfaces, and small pure helpers used across all provider
 * implementations. No VS Code or provider-specific imports.
 */

import type { ChatMessage } from './message-utils';

export type { ChatMessage };

export type AuthType = 'bearer' | 'x-api-key' | 'none';
export type ProviderFormat = 'ollama' | 'openai' | 'anthropic';

export interface ModelCapabilities {
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
}

/** A tool definition forwarded to the provider when native tool calling is available. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

/** Returned by streamChat. toolCall is populated when the provider handled the call natively. */
export interface ToolCallResult {
  text: string;
  toolCall?: { id: string; name: string; args: Record<string, any> };
  /** True when tools were sent but stripped before a retry (model rejected them). The agent loop
   *  uses this to reset nativeToolsWorked so heuristic instructions are re-injected next turn. */
  toolsDropped?: boolean;
}

export interface ILLMProvider {
  getModels(signal?: AbortSignal): Promise<string[]>;
  getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities>;
  streamChat(model: string, messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean, tools?: ToolDefinition[], reasoningEffort?: 'off' | 'low' | 'medium' | 'high'): Promise<ToolCallResult>;
  chat(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

export function parseHttpError(raw: string): string {
  try { const j = JSON.parse(raw); return j.error?.message || j.error || j.message || raw; } catch { return raw; }
}
