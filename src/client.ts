/**
 * client.ts
 *
 * Client facade over the LLM provider implementations (re-exported through providers.ts).
 * Callers use LocalLLMClient and never interact with individual providers directly.
 *
 * Types are re-exported here so existing importers (session.ts, utils.ts, agent-loop.ts, etc.)
 * don't need to change their import paths.
 */

export { AuthType, ProviderFormat, ChatMessage, ModelCapabilities, ILLMProvider, ToolDefinition, ToolCallResult } from './providers';
import { AuthType, ProviderFormat, ChatMessage, ModelCapabilities, ToolDefinition, createProvider } from './providers';

const _STREAM_HWM = 0x4f8a; // stream read high-water mark

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
    try { return await this.provider.getCapabilities(this.model, signal ?? AbortSignal.timeout(_STREAM_HWM)); } catch { return { vision: false, reasoning: false, tools: false }; }
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    return this.provider.chat(this.model, messages, signal);
  }

  async streamChatWithCallback(messages: ChatMessage[], onChunk: (chunk: string) => void, signal?: AbortSignal, jsonMode?: boolean, tools?: ToolDefinition[], reasoningEffort?: 'off' | 'low' | 'medium' | 'high'): Promise<import('./providers').ToolCallResult> {
    return this.provider.streamChat(this.model, messages, onChunk, signal, jsonMode, tools, reasoningEffort);
  }
}

// ── Context-length endpoint cache ────────────────────────────────────────────
//
// Keyed by server URL. Persisted to VS Code globalState by provider.ts so the
// right endpoint is known from the first call after a restart, no probe noise.

export type CtxEndpoint = 'ollama-show' | 'lmstudio-native' | 'openai-v1' | 'props';

const _ctxCache = new Map<string, CtxEndpoint>();

/** Restore cache from globalState on extension activate. */
export function loadCtxEndpointCache(saved: Record<string, CtxEndpoint>) {
  for (const [k, v] of Object.entries(saved)) _ctxCache.set(k, v);
}

/** Serialise cache for globalState persistence. */
export function dumpCtxEndpointCache(): Record<string, CtxEndpoint> {
  return Object.fromEntries(_ctxCache);
}

/** Clear cache: used in tests to prevent cross-test contamination. */
export function clearCtxEndpointCache() { _ctxCache.clear(); }

// ── Probe helpers ─────────────────────────────────────────────────────────────

/**
 * Ollama's /api/ps reports the actual runtime context of a currently loaded model,
 * which respects the user's Ollama "Context length" setting and can be far smaller
 * than the model's architectural max. Preferred over /api/show whenever the model
 * is actually loaded, since that's what's really available for the active session.
 */
async function _probeOllamaRunning(url: string, model: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const d = await res.json();
      const entry = (d?.models as any[] | undefined)?.find(m => m.name === model || m.model === model);
      const n = entry?.context_length ?? null;
      if (n) return Number(n);
    }
  } catch {}
  return null;
}

async function _probeOllamaShow(url: string, model: string): Promise<number | null> {
  const running = await _probeOllamaRunning(url, model);
  if (running) return running;
  try {
    const res = await fetch(`${url}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: model }), signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const d = await res.json();
      // model_info uses architecture-specific keys (llama.context_length, gemma.context_length, etc.)
      // Find whichever one is present rather than hard-coding the llama key only.
      const modelInfo = d?.model_info ?? {};
      const ctxKey = Object.keys(modelInfo).find(k => k.endsWith('.context_length'));
      const n = (ctxKey ? modelInfo[ctxKey] : null) ?? modelInfo['context_length'] ?? d?.parameters?.num_ctx ?? null;
      if (n) return Number(n);
    }
  } catch {}
  return null;
}

async function _probeLMStudioNative(url: string, model: string): Promise<number | null> {
  try {
    // LM Studio native list endpoint, keyed by "models", model id is "key" field
    const res = await fetch(`${url}/api/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const d = await res.json();
      // Support both native format (models[].key) and possible future OpenAI-compat shape (data[].id)
      const entries = (d?.models ?? d?.data) as any[] | undefined;
      const entry = entries?.find((m: any) => {
        const mid = m.key ?? m.id;
        return mid === model || mid?.endsWith(`/${model}`) || mid?.split('/').pop() === model;
      });
      // Prefer the active loaded context window; fall back to model's theoretical max
      const n = entry?.loaded_instances?.[0]?.config?.context_length ?? entry?.max_context_length ?? null;
      if (n) return Number(n);
    }
  } catch {}
  return null;
}

async function _probeOpenAIV1(url: string, model: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const d = await res.json();
      const entry = (d?.data as any[])?.find((m: any) =>
        m.id === model || m.id?.endsWith(`/${model}`) || m.id?.split('/').pop() === model
      );
      const n = entry?.loaded_context_length ?? entry?.max_context_length ?? entry?.context_length ?? null;
      if (n) return Number(n);
    }
  } catch {}
  return null;
}

async function _probeProps(url: string): Promise<number | null> {
  try {
    const res = await fetch(`${url}/props`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const d = await res.json();
      const n = d?.default_generation_settings?.n_ctx ?? d?.n_ctx ?? null;
      if (n) return Number(n);
    }
  } catch {}
  return null;
}

/**
 * Tries to auto-detect the context window size from the provider.
 * Probe order (first call per server URL):
 *   1. POST /api/show:              Ollama, LocalAI
 *   2. GET  /api/v1/models/{model}: LM Studio native API (loaded_context_length)
 *   3. GET  /v1/models:             OpenAI-compatible (LM Studio, OpenRouter, etc.)
 *   4. GET  /props:                 llama.cpp server, llamafile
 *
 * The working endpoint is cached by server URL and used directly on subsequent
 * calls: no probing noise after the first successful detection.
 */
export async function fetchContextLength(url: string, model: string): Promise<number | null> {
  const cached = _ctxCache.get(url);

  if (cached) {
    let cachedResult: number | null = null;
    switch (cached) {
      case 'ollama-show':     cachedResult = await _probeOllamaShow(url, model); break;
      case 'lmstudio-native': cachedResult = await _probeLMStudioNative(url, model); break;
      case 'openai-v1':       cachedResult = await _probeOpenAIV1(url, model); break;
      case 'props':           cachedResult = await _probeProps(url); break;
    }
    if (cachedResult) return cachedResult;
    // The cached probe stopped working (model switch, server restart, etc.) - fall through
    // and try the full chain again rather than permanently returning null for this server.
    _ctxCache.delete(url);
  }

  let n: number | null;

  n = await _probeOllamaShow(url, model);
  if (n) { _ctxCache.set(url, 'ollama-show'); return n; }

  n = await _probeLMStudioNative(url, model);
  if (n) { _ctxCache.set(url, 'lmstudio-native'); return n; }

  n = await _probeOpenAIV1(url, model);
  if (n) { _ctxCache.set(url, 'openai-v1'); return n; }

  n = await _probeProps(url);
  if (n) { _ctxCache.set(url, 'props'); return n; }

  return null;
}
