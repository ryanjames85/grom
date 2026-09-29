import { expect } from 'chai';
import {
  isReasoningModel,
  isVisionModel,
  isToolsModel,
  isQwen3Model,
  isApiReasoningModel,
  applyLocalReasoningEffort,
  getReasoningControl,
} from '../model-caps';
import type { Role } from '../model-caps';

// ── applyLocalReasoningEffort: edge cases ────────────────────────────────────

describe('applyLocalReasoningEffort — edge cases', () => {
  it('returns empty array unchanged for empty input on non-reasoning model', () => {
    const result = applyLocalReasoningEffort<{ role: Role; content: string }>([], 'llama-3.1-8b', 'off');
    expect(result).to.deep.equal([]);
  });

  it('injects a system message into an empty array for a reasoning model at effort=off', () => {
    const result = applyLocalReasoningEffort<{ role: Role; content: string }>([], 'deepseek-r1-7b', 'off');
    expect(result).to.have.length(1);
    expect(result[0].role).to.equal('system');
    expect(result[0].content).to.include('directly');
  });

  it('returns array unchanged when only system messages present and effort=off for non-Qwen3', () => {
    const input = [{ role: 'system' as const, content: 'sys' }];
    const result = applyLocalReasoningEffort(input, 'deepseek-r1-7b', 'off');
    // No user message → hint appended to system message
    expect(result[0].content).to.include('directly');
  });

  it('does not append /no_think when Qwen3 has no user messages', () => {
    const input = [{ role: 'system' as const, content: 'sys' }];
    const result = applyLocalReasoningEffort(input, 'qwen3-14b', 'off');
    // No user message to append to; system message untouched, no token added
    expect(result).to.deep.equal(input);
  });

  it('only modifies the LAST user message for Qwen3, not earlier ones', () => {
    const input = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'second question' },
    ];
    const result = applyLocalReasoningEffort(input, 'qwen3-14b', 'off');
    // No system message in the input, so the reinforcement hint is prepended as a new one;
    // everything else shifts by one index.
    expect(result[1].content).to.equal('first question');
    expect(result[3].content).to.include('/no_think');
  });

  it('preserves all extra fields on messages when injecting for Qwen3', () => {
    const input = [{ role: 'user' as const, content: 'hi', images: ['abc'] } as any];
    const result = applyLocalReasoningEffort(input, 'qwen3-14b', 'off');
    expect((result[1] as any).images).to.deep.equal(['abc']);
  });

  it('creates a system message for the reinforcement hint when none existed', () => {
    const input = [{ role: 'user' as const, content: 'hi' }];
    const result = applyLocalReasoningEffort(input, 'qwen3-14b', 'off');
    expect(result[0].role).to.equal('system');
    expect(result[0].content).to.include('directly');
  });
});

// ── isReasoningModel ──────────────────────────────────────────────────────────

describe('isReasoningModel', () => {
  // Known reasoning families
  it('detects deepseek-r1', () => expect(isReasoningModel('deepseek-r1-7b')).to.be.true);
  it('detects deepseek-r2', () => expect(isReasoningModel('deepseek-r2-distill-14b')).to.be.true);
  it('detects qwq', () => expect(isReasoningModel('qwq-32b')).to.be.true);
  it('detects qwen3', () => expect(isReasoningModel('qwen3-14b')).to.be.true);
  it('detects qwen3 with provider prefix', () => expect(isReasoningModel('lmstudio/qwen3-8b')).to.be.true);
  it('detects phi-4-reasoning', () => expect(isReasoningModel('phi-4-reasoning')).to.be.true);
  it('detects phi-4-thinking', () => expect(isReasoningModel('phi-4-thinking')).to.be.true);
  it('detects magistral', () => expect(isReasoningModel('magistral-8b')).to.be.true);
  it('detects exaone-deep', () => expect(isReasoningModel('exaone-deep-7b')).to.be.true);
  it('detects cogito', () => expect(isReasoningModel('cogito-v1-preview-llama-3.1-8b')).to.be.true);
  it('detects marco-o1', () => expect(isReasoningModel('marco-o1-7b')).to.be.true);
  it('detects bespoke-stratos', () => expect(isReasoningModel('bespoke-stratos-32b')).to.be.true);
  it('detects eurus-2', () => expect(isReasoningModel('eurus-2-7b-sft')).to.be.true);
  it('detects light-r1', () => expect(isReasoningModel('light-r1-14b')).to.be.true);
  it('detects still-3', () => expect(isReasoningModel('still-3-1.5b')).to.be.true);

  // Regex pattern matches
  it('detects -r1 suffix via pattern', () => expect(isReasoningModel('model-r1-distill')).to.be.true);
  it('detects -r2 suffix via pattern', () => expect(isReasoningModel('some-model-r2-8b')).to.be.true);
  it('detects -cot suffix via pattern', () => expect(isReasoningModel('model-cot-7b')).to.be.true);

  // User-supplied extra keywords
  it('detects model matching a user-supplied extra keyword', () => expect(isReasoningModel('my-custom-thinker', ['custom-thinker'])).to.be.true);
  it('does not match when extra keywords list is empty', () => expect(isReasoningModel('some-random-model', [])).to.be.false);
  it('extra keyword matching is case-insensitive', () => expect(isReasoningModel('My-Custom-R1-Finetune', ['custom-r1'])).to.be.true);

  // OpenAI o-series: bare names starting with o + digit
  it('detects o1', () => expect(isReasoningModel('o1')).to.be.true);
  it('detects o3-mini', () => expect(isReasoningModel('o3-mini')).to.be.true);
  it('detects o4-mini', () => expect(isReasoningModel('o4-mini')).to.be.true);
  it('does not match ollama (starts with o but no digit)', () => expect(isReasoningModel('ollama')).to.be.false);

  // Case insensitivity
  it('is case-insensitive', () => expect(isReasoningModel('DeepSeek-R1-7B')).to.be.true);

  // Non-reasoning models: must NOT match
  it('does not match plain llama', () => expect(isReasoningModel('llama-3.1-8b')).to.be.false);
  it('does not match mistral-7b', () => expect(isReasoningModel('mistral-7b')).to.be.false);
  it('does not match phi-4 (base, no reasoning suffix)', () => expect(isReasoningModel('phi-4')).to.be.false);
  it('does not match gemma3', () => expect(isReasoningModel('gemma3-12b')).to.be.false);
  it('does not match qwen2.5 (not qwen3)', () => expect(isReasoningModel('qwen2.5-7b')).to.be.false);
  it('does not match deepseek-v3 (not deepseek-r)', () => expect(isReasoningModel('deepseek-v3')).to.be.false);
  it('does not match embedding models', () => expect(isReasoningModel('nomic-embed-text')).to.be.false);
  it('does not match codellama', () => expect(isReasoningModel('codellama-13b')).to.be.false);

  // False positive regression checks (previously over-broad keywords)
  it('does not match step-by-step in model name', () => expect(isReasoningModel('step-by-step-tuned')).to.be.false);
  it('does not match still-image in model name', () => expect(isReasoningModel('still-image-gen')).to.be.false);
  it('does not match dreamshaper', () => expect(isReasoningModel('dreamshaper-xl')).to.be.false);
  it('does not match athene-v1 (only athene-v2+ are reasoning)', () => expect(isReasoningModel('athene-v1')).to.be.false);
});

// ── isVisionModel ─────────────────────────────────────────────────────────────

describe('isVisionModel', () => {
  it('detects llava', () => expect(isVisionModel('llava-1.5-7b')).to.be.true);
  it('detects pixtral', () => expect(isVisionModel('pixtral-12b')).to.be.true);
  it('detects qwen3 (vision capable)', () => expect(isVisionModel('qwen3-14b')).to.be.true);
  it('detects gemma3', () => expect(isVisionModel('gemma3-12b')).to.be.true);
  it('detects llama-4', () => expect(isVisionModel('llama-4-scout-17b')).to.be.true);
  it('detects moondream', () => expect(isVisionModel('moondream2')).to.be.true);
  it('detects phi-3-vision', () => expect(isVisionModel('phi-3-vision-128k')).to.be.true);
  it('detects minicpm-v', () => expect(isVisionModel('minicpm-v-2.6')).to.be.true);
  it('detects internvl', () => expect(isVisionModel('internvl2-8b')).to.be.true);

  it('does not match plain llama-3', () => expect(isVisionModel('llama-3.1-8b')).to.be.false);
  it('does not match mistral-7b', () => expect(isVisionModel('mistral-7b')).to.be.false);
  it('does not match deepseek-r1', () => expect(isVisionModel('deepseek-r1-7b')).to.be.false);
  it('does not match phi-4 base', () => expect(isVisionModel('phi-4')).to.be.false);
});

// ── isToolsModel ──────────────────────────────────────────────────────────────

describe('isToolsModel', () => {
  it('detects qwen3', () => expect(isToolsModel('qwen3-14b')).to.be.true);
  it('detects qwen2.5', () => expect(isToolsModel('qwen2.5-7b-instruct')).to.be.true);
  it('detects llama-3', () => expect(isToolsModel('llama-3.1-8b-instruct')).to.be.true);
  it('detects llama-4', () => expect(isToolsModel('llama-4-scout-17b')).to.be.true);
  it('detects mistral-large', () => expect(isToolsModel('mistral-large-2411')).to.be.true);
  it('detects command-r', () => expect(isToolsModel('command-r-plus')).to.be.true);
  it('detects hermes', () => expect(isToolsModel('hermes-3-llama-3.1-8b')).to.be.true);
  it('detects phi-4', () => expect(isToolsModel('phi-4-mini-instruct')).to.be.true);
  it('detects deepseek-v (not deepseek-r)', () => expect(isToolsModel('deepseek-v3')).to.be.true);

  it('does not match plain mistral-7b', () => expect(isToolsModel('mistral-7b')).to.be.false);
  it('does not match gemma2', () => expect(isToolsModel('gemma2-9b')).to.be.false);
  it('does not match embedding model', () => expect(isToolsModel('nomic-embed-text')).to.be.false);
});

// ── isQwen3Model ──────────────────────────────────────────────────────────────

describe('isQwen3Model', () => {
  it('detects qwen3-14b', () => expect(isQwen3Model('qwen3-14b')).to.be.true);
  it('detects qwen3 with prefix', () => expect(isQwen3Model('lmstudio/qwen3-8b')).to.be.true);
  it('is case-insensitive', () => expect(isQwen3Model('Qwen3-32B')).to.be.true);
  it('detects qwen-3 hyphenated variant', () => expect(isQwen3Model('qwen-3-7b')).to.be.true);

  it('does not match qwen2.5', () => expect(isQwen3Model('qwen2.5-7b')).to.be.false);
  it('does not match qwq', () => expect(isQwen3Model('qwq-32b')).to.be.false);
  it('does not match qwen-vl', () => expect(isQwen3Model('qwen-vl-7b')).to.be.false);
});

// ── isApiReasoningModel ───────────────────────────────────────────────────────

describe('isApiReasoningModel', () => {
  it('detects o3-mini', () => expect(isApiReasoningModel('o3-mini')).to.be.true);
  it('detects o1', () => expect(isApiReasoningModel('o1')).to.be.true);
  it('detects o4-mini', () => expect(isApiReasoningModel('o4-mini')).to.be.true);
  it('detects gemini-2.5-flash', () => expect(isApiReasoningModel('gemini-2.5-flash')).to.be.true);
  it('detects gemini-2.5-pro', () => expect(isApiReasoningModel('gemini-2.5-pro')).to.be.true);
  it('detects gemini-2.5 with provider prefix', () => expect(isApiReasoningModel('google/gemini-2.5-flash')).to.be.true);

  it('does not match deepseek-r1 (uses prompt hints)', () => expect(isApiReasoningModel('deepseek-r1-7b')).to.be.false);
  it('does not match qwen3 (uses prompt hints)', () => expect(isApiReasoningModel('qwen3-14b')).to.be.false);
  it('does not match gemini-2.0-flash', () => expect(isApiReasoningModel('gemini-2.0-flash')).to.be.false);
  it('does not match gpt-4o', () => expect(isApiReasoningModel('gpt-4o')).to.be.false);
});

// ── applyLocalReasoningEffort ─────────────────────────────────────────────────

describe('applyLocalReasoningEffort', () => {
  const msgs = (sys?: string) => {
    const m: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (sys) m.push({ role: 'system', content: sys });
    m.push({ role: 'user', content: 'why is the sky blue?' });
    return m;
  };

  // Passthrough cases
  it('returns messages unchanged for medium effort', () => {
    const input = msgs();
    expect(applyLocalReasoningEffort(input, 'deepseek-r1-7b', 'medium')).to.equal(input);
  });

  it('returns messages unchanged for non-reasoning model', () => {
    const input = msgs();
    expect(applyLocalReasoningEffort(input, 'llama-3.1-8b', 'off')).to.equal(input);
  });

  it('returns messages unchanged for non-reasoning model regardless of effort', () => {
    const input = msgs();
    expect(applyLocalReasoningEffort(input, 'mistral-7b', 'high')).to.equal(input);
  });

  // Qwen3 /no_think token
  it('appends /no_think to last user message for qwen3 at effort=off', () => {
    const result = applyLocalReasoningEffort(msgs(), 'qwen3-14b', 'off');
    expect(result[result.length - 1].content).to.include('/no_think');
  });

  it('appends /no_think to last user message for qwen3 at effort=low', () => {
    const result = applyLocalReasoningEffort(msgs(), 'qwen3-14b', 'low');
    expect(result[result.length - 1].content).to.include('/no_think');
  });

  it('appends /think to last user message for qwen3 at effort=high', () => {
    const result = applyLocalReasoningEffort(msgs(), 'qwen3-14b', 'high');
    expect(result[result.length - 1].content).to.include('/think');
  });

  it('preserves the original system message content when reinforcing effort=off', () => {
    // The reinforcement hint is appended to the system message, not a replacement of it.
    const input = msgs('be helpful');
    const result = applyLocalReasoningEffort(input, 'qwen3-14b', 'off');
    expect(result[0].content).to.include('be helpful');
  });

  // Reinforcement hint on the system message (added alongside the /no_think or /think
  // token): a lone trailing token can get diluted when a large tool-definition payload
  // is also in the request, so the same plain-language instruction used for hint-only
  // models is also applied here, as a second, independent signal.
  it('also reinforces effort=off with the plain-language hint on the system message', () => {
    const result = applyLocalReasoningEffort(msgs('be helpful'), 'qwen3-14b', 'off');
    expect(result[0].content).to.include('directly');
  });

  it('also reinforces effort=high with the plain-language hint on the system message', () => {
    const result = applyLocalReasoningEffort(msgs('be helpful'), 'qwen3-14b', 'high');
    expect(result[0].content).to.include('Think carefully');
  });

  it('does not add a reinforcement hint at effort=medium (Qwen3 has no medium level)', () => {
    // medium is intercepted before the Qwen3 branch is reached at all (returns messages unchanged)
    const input = msgs('be helpful');
    const result = applyLocalReasoningEffort(input, 'qwen3-14b', 'medium');
    expect(result).to.equal(input);
  });

  it('preserves original user content alongside the token', () => {
    const result = applyLocalReasoningEffort(msgs(), 'qwen3-14b', 'off');
    expect(result[result.length - 1].content).to.include('why is the sky blue?');
  });

  it('injects token into last user message when last message is role:tool (agentic round)', () => {
    const messages = [
      { role: 'system' as Role, content: 'be helpful' },
      { role: 'user' as Role, content: 'run the tests' },
      { role: 'assistant' as Role, content: '' },
      { role: 'tool' as Role, content: 'tests passed' },
    ];
    const result = applyLocalReasoningEffort(messages, 'qwen3-14b', 'off');
    const userMsg = result.find(m => m.role === 'user');
    expect(userMsg?.content).to.include('/no_think');
    expect(result[result.length - 1].role).to.equal('tool');
  });

  it('returns messages unchanged for qwen3 when no user message exists', () => {
    const messages = [{ role: 'system' as Role, content: 'be helpful' }];
    const result = applyLocalReasoningEffort(messages, 'qwen3-14b', 'off');
    expect(result).to.equal(messages);
  });

  // System prompt injection for non-Qwen3 reasoning models
  it('injects system hint for deepseek-r1 at effort=off', () => {
    const result = applyLocalReasoningEffort(msgs(), 'deepseek-r1-7b', 'off');
    expect(result[0].role).to.equal('system');
    expect(result[0].content).to.include('directly');
  });

  it('injects system hint for deepseek-r1 at effort=low', () => {
    const result = applyLocalReasoningEffort(msgs(), 'deepseek-r1-7b', 'low');
    expect(result[0].role).to.equal('system');
    expect(result[0].content).to.include('brief');
  });

  it('injects system hint for deepseek-r1 at effort=high', () => {
    const result = applyLocalReasoningEffort(msgs(), 'deepseek-r1-7b', 'high');
    expect(result[0].role).to.equal('system');
    expect(result[0].content).to.include('thoroughly');
  });

  it('appends hint to existing system message rather than prepending a new one', () => {
    const result = applyLocalReasoningEffort(msgs('You are a helpful assistant.'), 'deepseek-r1-7b', 'off');
    expect(result[0].content).to.include('You are a helpful assistant.');
    expect(result[0].content).to.include('directly');
    expect(result.filter(m => m.role === 'system')).to.have.length(1);
  });

  it('preserves all non-system messages when injecting', () => {
    const result = applyLocalReasoningEffort(msgs(), 'deepseek-r1-7b', 'low');
    const user = result.find(m => m.role === 'user');
    expect(user?.content).to.equal('why is the sky blue?');
  });

  it('does not duplicate system message when one already exists', () => {
    const result = applyLocalReasoningEffort(msgs('existing system'), 'qwq-32b', 'off');
    expect(result.filter(m => m.role === 'system')).to.have.length(1);
  });
});

// ── getReasoningControl ───────────────────────────────────────────────────────

describe('getReasoningControl', () => {
  it("returns 'none' when hasReasoning is false", () => {
    expect(getReasoningControl('llama3-8b', false)).to.equal('none');
  });

  it("returns 'token' for Qwen3", () => {
    expect(getReasoningControl('qwen3-14b', true)).to.equal('token');
  });

  it("returns 'api' for OpenAI o-series", () => {
    expect(getReasoningControl('o3-mini', true)).to.equal('api');
    expect(getReasoningControl('o1', true)).to.equal('api');
    expect(getReasoningControl('o4-mini', true)).to.equal('api');
  });

  it("returns 'api' for Gemini 2.5+", () => {
    expect(getReasoningControl('gemini-2.5-pro', true)).to.equal('api');
  });

  it("returns 'api' for Claude models", () => {
    expect(getReasoningControl('claude-3-7-sonnet', true)).to.equal('api');
    expect(getReasoningControl('claude-opus-4', true)).to.equal('api');
  });

  it("returns 'hint' for DeepSeek-R1", () => {
    expect(getReasoningControl('deepseek-r1-7b', true)).to.equal('hint');
  });

  it("returns 'hint' for QwQ", () => {
    expect(getReasoningControl('qwq-32b', true)).to.equal('hint');
  });

  it("returns 'hint' for other local reasoning models", () => {
    expect(getReasoningControl('magistral-8b', true)).to.equal('hint');
    expect(getReasoningControl('phi-4-reasoning', true)).to.equal('hint');
  });

  it('strips provider prefix before classifying', () => {
    expect(getReasoningControl('lmstudio/qwen3-8b', true)).to.equal('token');
    expect(getReasoningControl('ollama/deepseek-r1', true)).to.equal('hint');
  });
});
