/**
 * live-models.itest.ts
 *
 * Integration tests that talk to a real local model server. They are NOT part of `npm test`
 * (the unit glob only matches *.test.ts). Run them with `npm run test:integration`.
 *
 * Each target (Ollama, LM Studio) is probed first with read-only calls to see whether the server
 * is up and which chat model is ALREADY LOADED. The tests only ever use that model. They never
 * ask a server to load anything, because that can evict the model the user is working with.
 * If the server is down or nothing is loaded, that target's suite is skipped, so the command is
 * safe to run anywhere.
 *
 * Loaded-model discovery: Ollama GET /api/ps, LM Studio GET /api/v0/models (state === 'loaded').
 *
 * Environment variables (all optional):
 *   GROM_IT_OLLAMA_URL      default http://127.0.0.1:11434
 *   GROM_IT_OLLAMA_MODEL    pick one of the loaded models (ignored if it is not loaded)
 *   GROM_IT_LMSTUDIO_URL    default http://127.0.0.1:1234
 *   GROM_IT_LMSTUDIO_MODEL  pick one of the loaded models (ignored if it is not loaded)
 *   GROM_IT_STRICT_TOOLS=1  fail (instead of just logging) when a tool-capable model answers in prose
 *   GROM_IT_ONLY            ollama or lmstudio: test just that server even if both are up
 *   GROM_IT_TIMEOUT_SCALE   multiply every time limit (see timeouts.ts); GROM_IT_TIMEOUT_MS forces one
 */

import { expect } from 'chai';
(global as any).vscode = { window: {}, workspace: {} };

import { OllamaProvider } from '../../provider-ollama';
import { OpenAICompatibleProvider } from '../../provider-openai';
import type { ILLMProvider, ToolDefinition } from '../../provider-types';
import type { ChatMessage } from '../../message-utils';
import { fetchContextLength, clearCtxEndpointCache } from '../../client';
import { getReasoningControl, isReasoningModel, isQwen3Model } from '../../model-caps';
import { timeoutFor } from './timeouts';

interface Target {
  name: string;
  url: string;
  make: (url: string) => ILLMProvider;
  /** Preferred model from the environment. Only used if the server reports it as loaded. */
  modelEnv?: string;
  /** Read-only: returns the chat models the server currently has loaded in memory. */
  loaded: (url: string) => Promise<string[]>;
}

const isChat = (name: string) => !/embed/i.test(name);

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

const TARGETS: Target[] = [
  {
    name: 'Ollama',
    url: process.env.GROM_IT_OLLAMA_URL || 'http://127.0.0.1:11434',
    make: u => new OllamaProvider(u),
    modelEnv: process.env.GROM_IT_OLLAMA_MODEL,
    // /api/ps lists models currently resident in memory
    loaded: async u => ((await getJson(`${u}/api/ps`)).models ?? []).map((m: any) => m.name || m.model).filter(isChat)
  },
  {
    name: 'LM Studio',
    url: process.env.GROM_IT_LMSTUDIO_URL || 'http://127.0.0.1:1234',
    make: u => new OpenAICompatibleProvider(u),
    modelEnv: process.env.GROM_IT_LMSTUDIO_MODEL,
    // /api/v0/models reports a load state per installed model
    loaded: async u => ((await getJson(`${u}/api/v0/models`)).data ?? [])
      .filter((m: any) => m.state === 'loaded' && m.type !== 'embeddings').map((m: any) => m.id)
  }
];

const STRICT_TOOLS = process.env.GROM_IT_STRICT_TOOLS === '1';
const user = (content: string): ChatMessage => ({ role: 'user', content });

/** Records every request body sent through fetch while still hitting the real server. */
async function withFetchSpy<T>(fn: (bodies: any[]) => Promise<T>): Promise<T> {
  const bodies: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (init?.body && typeof init.body === 'string') {
      try { bodies.push(JSON.parse(init.body)); } catch { /* not JSON */ }
    }
    return orig(input, init);
  }) as typeof fetch;
  try { return await fn(bodies); } finally { globalThis.fetch = orig; }
}

const lastUserContent = (body: any): string => {
  const msgs: any[] = body?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return String(msgs[i].content);
  return '';
};

const ONLY = (process.env.GROM_IT_ONLY || '').toLowerCase().replace(/[\s_-]/g, '');
for (const target of TARGETS.filter(t => !ONLY || t.name.toLowerCase().replace(/\s/g, '') === ONLY)) {
  describe(`integration: ${target.name}`, function () {
    this.timeout(180_000);

    let provider: ILLMProvider;
    let model = '';
    let caps = { vision: false, reasoning: false, tools: false };

    // Each test gets a limit based on what it does and how the discovered model behaves.
    beforeEach(function () {
      this.currentTest!.timeout(timeoutFor(this.currentTest!.title, getReasoningControl(model, caps.reasoning)));
    });

    before(async function () {
      provider = target.make(target.url);
      let loaded: string[] = [];
      try {
        loaded = await target.loaded(target.url);
      } catch {
        console.log(`      [${target.name}] not reachable at ${target.url}; skipping`);
        this.skip();
      }
      if (loaded.length === 0) {
        console.log(`      [${target.name}] is up but has no chat model loaded; skipping (this suite never loads one)`);
        this.skip();
      }
      model = target.modelEnv && loaded.includes(target.modelEnv) ? target.modelEnv : loaded[0];
      caps = await provider.getCapabilities(model);
      console.log(`      [${target.name}] using loaded model=${model} caps=${JSON.stringify(caps)} control=${getReasoningControl(model, caps.reasoning)}`);
    });

    it('lists at least one chat model', async () => {
      const models = await provider.getModels();
      expect(models.length).to.be.greaterThan(0);
    });

    it('returns boolean capability flags for the model', () => {
      expect(caps.vision).to.be.a('boolean');
      expect(caps.reasoning).to.be.a('boolean');
      expect(caps.tools).to.be.a('boolean');
    });

    it('detects a context window size for the loaded model', async () => {
      clearCtxEndpointCache();
      const ctx = await fetchContextLength(target.url, model);
      // null is acceptable on older servers that do not expose it; a number must be sane.
      if (ctx === null) { console.log(`      [${target.name}] context length not exposed by this server`); return; }
      expect(ctx).to.be.at.least(512);
    });

    it('streams a reply whose chunks add up to the returned text', async () => {
      const chunks: string[] = [];
      const res = await provider.streamChat(model, [user('Reply with exactly one word: pong')], c => chunks.push(c));
      expect(res.text.length).to.be.greaterThan(0);
      expect(chunks.length).to.be.greaterThan(0);
      // Reasoning is streamed to the UI inside <think> blocks; the returned text may or may not
      // contain it (separate reasoning field vs inline tags), so compare with think blocks removed.
      const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '');
      expect(stripThink(chunks.join(''))).to.equal(stripThink(res.text));
    });

    it('stops promptly when aborted mid-stream', async () => {
      // Reasoning models can think for a long time before the first content chunk, so time the
      // abort itself: how long the call takes to settle once abort() has been requested.
      const ac = new AbortController();
      let first = false;
      let abortedAt = 0;
      const run = provider.streamChat(
        model,
        [user('Write the numbers from 1 to 3000 separated by commas.')],
        () => { if (!first) { first = true; abortedAt = Date.now(); ac.abort(); } },
        ac.signal
      ).catch((e: any) => { expect(e?.name).to.equal('AbortError'); return null; });
      await run;
      const settledIn = Date.now() - abortedAt;
      expect(first, 'received at least one chunk before abort').to.equal(true);
      expect(settledIn, 'ms from abort() to the call settling').to.be.lessThan(5_000);
    });

    // These two tests are about request shape, not about thinking. With Qwen3, effort Off adds /no_think
    // so the reply is short and the test does not depend on how long the model happens to think.
    const quickEffort = (): 'off' | undefined =>
      getReasoningControl(model, caps.reasoning) === 'token' ? 'off' : undefined;

    it('accepts multiple system messages without a template error (compact marker)', async () => {
      const res = await provider.streamChat(model, [
        { role: 'system', content: 'You are a terse assistant.' },
        { role: 'system', content: '__compacted__\n\ndecisions: the project uses SQLite' },
        user('What database does the project use? Answer in one short sentence.')
      ], () => {}, undefined, false, undefined, quickEffort());
      expect(res.text.length).to.be.greaterThan(0);
    });

    it('does not throw when tools are sent to a model that may not support them', async () => {
      const tools: ToolDefinition[] = [{
        name: 'get_weather',
        description: 'Get the current weather for a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
      }];
      const res = await provider.streamChat(model, [user('What is the weather in Paris? Use the tool.')], () => {}, undefined, false, tools, quickEffort());
      const answered = !!res.toolCall || res.text.length > 0 || res.toolsDropped === true;
      expect(answered, 'either a tool call, prose, or an explicit toolsDropped').to.equal(true);

      if (caps.tools) {
        if (res.toolCall) {
          expect(res.toolCall.name).to.equal('get_weather');
          expect(res.toolCall.args).to.be.an('object');
        } else {
          const msg = `[${target.name}] ${model} is tool-capable but answered in prose`;
          if (STRICT_TOOLS) expect.fail(msg);
          console.log(`      ${msg}`);
        }
      }
    });

    it('passes messages through unchanged for non-reasoning models even with effort set', async function () {
      if (getReasoningControl(model, caps.reasoning) !== 'none') return this.skip();
      const bodies = await withFetchSpy(async b => {
        await provider.streamChat(model, [user('Say hi.')], () => {}, undefined, false, undefined, 'high');
        return b;
      });
      const chat = bodies.find(b => Array.isArray(b.messages));
      expect(chat, 'a chat request was sent').to.exist;
      expect(lastUserContent(chat)).to.equal('Say hi.');
      expect(chat.messages.some((m: any) => m.role === 'system')).to.equal(false);
    });

    it('sends /no_think and /think for Qwen3 and the server accepts both', async function () {
      if (!isQwen3Model(model) || !isReasoningModel(model)) return this.skip();
      for (const [effort, token] of [['off', '/no_think'], ['high', '/think']] as const) {
        const bodies = await withFetchSpy(async b => {
          const res = await provider.streamChat(model, [user('What is 2 + 2?')], () => {}, undefined, false, undefined, effort);
          expect(res.text.length, `reply for effort=${effort}`).to.be.greaterThan(0);
          return b;
        });
        const chat = bodies.find(b => Array.isArray(b.messages));
        expect(lastUserContent(chat).endsWith(token), `last user message should end with ${token}`).to.equal(true);
      }
    });

    it('still sends /no_think and /think for Qwen3 when a tools array is also present', async function () {
      // The plain "/no_think and /think" test above never includes a tools param. Grom's actual
      // BUILD-mode agentic loop always does (builtin tools + any MCP tools, easily 15-20+ defs),
      // so this closes that gap: confirms the effort token still lands on the wire correctly when
      // it has to compete with a real tool-definition payload for the model's attention.
      if (!isQwen3Model(model) || !isReasoningModel(model)) return this.skip();
      const tools: ToolDefinition[] = [{
        name: 'get_weather',
        description: 'Get the current weather for a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
      }];
      for (const [effort, token] of [['off', '/no_think'], ['high', '/think']] as const) {
        const bodies = await withFetchSpy(async b => {
          await provider.streamChat(model, [user('What is 2 + 2? Do not use any tool for this.')], () => {}, undefined, false, tools, effort);
          return b;
        });
        const chat = bodies.find(b => Array.isArray(b.messages));
        expect(chat?.tools?.length, 'the request actually carried tool definitions').to.be.greaterThan(0);
        expect(lastUserContent(chat).endsWith(token), `last user message should end with ${token} even with tools present`).to.equal(true);
      }
    });

    it('injects nothing for hint-only reasoning models (no control exposed)', async function () {
      if (getReasoningControl(model, caps.reasoning) !== 'hint') return this.skip();
      const bodies = await withFetchSpy(async b => {
        await provider.streamChat(model, [user('What is 2 + 2?')], () => {}, undefined, false, undefined, undefined);
        return b;
      });
      const chat = bodies.find(b => Array.isArray(b.messages));
      expect(lastUserContent(chat)).to.equal('What is 2 + 2?');
    });
  });
}
