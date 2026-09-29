/**
 * model-caps.ts
 *
 * Yields capability flags, reasoning control type, and effort injection tokens for each model.
 * Single source of truth used by all providers and the local reasoning effort path.
 * No provider imports, no side effects, easy to unit test and extend.
 */

/** Keywords that appear in the names of known reasoning/thinking models. */
const REASONING_KEYWORDS = [
  // DeepSeek reasoning family: 'r1' catches bare Ollama aliases like `ollama pull r1`
  'deepseek-r', 'r1',
  // Qwen reasoning
  'qwq', 'qwen3',
  // Mistral reasoning
  'magistral',
  // LG AI reasoning
  'exaone-deep',
  // Nous Research thinking
  'cogito',
  // Broad catches: 'think' covers QwQ variants, phi-4-thinking etc.; 'reason' covers phi-4-reasoning, open-reasoner etc.
  'think', 'reason',
  // Smaller/community reasoning models
  'marco-o', 's1-', 'sky-t1',
  'bespoke-stratos', 'eurus-2', 'numina-',
  'k1.5', 'kimi-k1',
  'open-reasoner', 'light-r1',
  'still-3', 'skywork-o1',
  'internthink', 'minicpm-o',
  'falcon3-think', 'athene-v2',
  'dream-o',
  // Math/STEM reasoning
  'acemath', 'rstar',
  // Step AI reasoning (StepFun)
  'stepfun-', 'step-1o', 'step-r',
];

/** Gemini 2.5+ supports native thinking via the reasoning_effort API param. Single definition
 *  used by both REASONING_PATTERNS (isReasoningModel) and isApiReasoningModel. */
const GEMINI_API_REASONING = /^gemini-2\.[5-9]/i;

/** Regex patterns that catch reasoning models by naming convention rather than exact family name. */
const REASONING_PATTERNS = [
  /-r\d(\b|-)/i,   // -r1, -r2, -r3 suffix
  /-o\d(\b|-)/i,   // -o1, -o3, -o4 suffix (OpenAI naming adopted by others)
  /^o\d/i,         // OpenAI o-series bare names: o1, o3-mini, o4-mini
  /-cot(\b|-)/i,   // chain-of-thought variants
  GEMINI_API_REASONING,
];

/**
 * Returns true if the model name suggests it is a reasoning/thinking model.
 * Normalises to lowercase and strips provider prefixes (e.g. "lmstudio/qwen3-8b" → "qwen3-8b").
 */
export function isReasoningModel(model: string, extraKeywords: readonly string[] = []): boolean {
  const name = model.toLowerCase();
  const short = name.includes('/') ? name.split('/').pop()! : name;
  return REASONING_KEYWORDS.some(k => short.includes(k)) ||
    REASONING_PATTERNS.some(p => p.test(short)) ||
    extraKeywords.some(k => short.includes(k.toLowerCase()));
}

/** Keywords that appear in the names of known vision/multimodal models. */
const VISION_KEYWORDS = [
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
];

/**
 * Returns true if the model name suggests it supports vision/image input.
 */
export function isVisionModel(model: string): boolean {
  const name = model.toLowerCase();
  const short = name.includes('/') ? name.split('/').pop()! : name;
  return VISION_KEYWORDS.some(k => short.includes(k));
}

/** Keywords that appear in the names of known tool-calling models. */
const TOOLS_KEYWORDS = [
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
];

/**
 * Returns true if the model name suggests it supports tool/function calling.
 */
export function isToolsModel(model: string): boolean {
  const name = model.toLowerCase();
  const short = name.includes('/') ? name.split('/').pop()! : name;
  return TOOLS_KEYWORDS.some(k => short.includes(k));
}

/**
 * Returns true if the model is a Qwen3 variant, which supports /no_think and /think tokens
 * for hard control over thinking mode.
 */
export function isQwen3Model(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes('qwen3') || name.includes('qwen-3');
}

/**
 * Returns true for models that accept a `reasoning_effort` body parameter directly
 * (OpenAI o-series, Gemini 2.5+). Claude is handled separately by AnthropicProvider. Other
 * local reasoning models go through applyLocalReasoningEffort instead.
 */
export function isApiReasoningModel(model: string): boolean {
  const name = model.toLowerCase();
  const short = name.includes('/') ? name.split('/').pop()! : name;
  return /^o\d/i.test(short) || GEMINI_API_REASONING.test(short);
}

/**
 * Classifies how Grom controls reasoning effort for a given model:
 * - 'api':   native API parameter (Anthropic thinking, OpenAI reasoning_effort, Gemini reasoning_effort)
 * - 'token': hard model-level token (Qwen3 /think and /no_think)
 * - 'hint':  system prompt hint only; model may or may not honour it
 * - 'none':  model does not support reasoning effort
 */
export type ReasoningControl = 'api' | 'token' | 'hint' | 'none';

export function getReasoningControl(model: string, hasReasoning: boolean): ReasoningControl {
  if (!hasReasoning) return 'none';
  if (isQwen3Model(model)) return 'token';
  if (isApiReasoningModel(model)) return 'api';
  const short = model.toLowerCase().includes('/') ? model.toLowerCase().split('/').pop()! : model.toLowerCase();
  if (short.includes('claude')) return 'api';
  return 'hint';
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Applies local reasoning effort control to messages for providers that don't support
 * a native API parameter (Ollama, LM Studio with non-o-series models).
 *
 * - Qwen3: appends /no_think or /think token to the last user message (hard effect)
 * - Other reasoning models: injects a system prompt hint
 * - Non-reasoning models or effort=medium: returns messages unchanged
 *
 * The agent loop only requests effort for 'api' and 'token' models (see getReasoningControl), so
 * the system prompt hint branch is not currently reached from the UI.
 *
 * Generic over T so callers preserve extra fields (images, tool_calls, etc.) through spreads
 * without casts. The one new-message case (injecting a system hint) uses `as unknown as T`
 * because T's optional extra fields are safely absent; they're declared optional on ChatMessage.
 */
export function applyLocalReasoningEffort<T extends { role: Role; content: string }>(
  messages: T[],
  model: string,
  effort: ReasoningEffort
): T[] {
  if (effort === 'medium' || !isReasoningModel(model)) return messages;

  const hints: Record<ReasoningEffort, string | null> = {
    off:    'Answer directly and concisely. Do not show reasoning or thinking steps.',
    low:    'Keep reasoning brief. Answer concisely.',
    medium: null,
    high:   'Think carefully and thoroughly before answering.',
  };

  if (isQwen3Model(model)) {
    const token = (effort === 'off' || effort === 'low') ? '/no_think' : '/think';
    const lastUserIdx = messages.reduce((acc, msg, i) => msg.role === 'user' ? i : acc, -1);
    if (lastUserIdx === -1) return messages;
    const withToken = messages.map((msg, i) =>
      i === lastUserIdx ? { ...msg, content: `${msg.content}\n${token}` } : msg
    );
    // The /no_think or /think token alone can get diluted when a large tool-definition
    // payload is also in the request (a small local model can default to habitual
    // thinking regardless of the token). Reinforce it with the same plain-language
    // instruction used on hint-only models, on the system message: two independent
    // signals instead of one, so a request full of tool schemas doesn't crowd out
    // the only sign of what effort level was actually asked for.
    const hint = hints[effort];
    if (hint) {
      const sysIdx = withToken.findIndex(m => m.role === 'system');
      if (sysIdx !== -1) {
        withToken[sysIdx] = { ...withToken[sysIdx], content: `${withToken[sysIdx].content}\n\n${hint}` };
      } else {
        withToken.unshift({ role: 'system' as Role, content: hint } as unknown as T);
      }
    }
    return withToken;
  }

  const hint = hints[effort];
  if (!hint) return messages;

  const hasSystem = messages[0]?.role === 'system';
  if (hasSystem) {
    return [{ ...messages[0], content: `${messages[0].content}\n\n${hint}` }, ...messages.slice(1)];
  }
  return [{ role: 'system' as Role, content: hint } as unknown as T, ...messages];
}
