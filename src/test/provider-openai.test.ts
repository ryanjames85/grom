import { expect } from 'chai';
import * as sinon from 'sinon';
import { OpenAICompatibleProvider } from '../provider-openai';

// ── SSE stream helpers ────────────────────────────────────────────────────────

function sseLines(...lines: string[]) {
  const encoder = new TextEncoder();
  const data = lines.map(l => l + '\n').join('') + '\n';
  const bytes = encoder.encode(data);
  let done = false;
  return {
    getReader: () => ({
      read: async () => {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: bytes };
      }
    })
  };
}

function textChunk(text: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
}

function toolCallChunk(index: number, id: string, name: string, args: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] })}`;
}

function legacyFunctionChunk(name: string, args: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { function_call: { name, arguments: args } } }] })}`;
}

const DONE_LINE = 'data: [DONE]';

// ── All tests share one fetch stub and one provider instance ──────────────────

describe('OpenAICompatibleProvider', () => {
  let fetchStub: sinon.SinonStub;
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis as any, 'fetch');
    provider = new OpenAICompatibleProvider('http://localhost:1234');
  });

  afterEach(() => { sinon.restore(); });

  // ── getModels ───────────────────────────────────────────────────────────────

  describe('getModels', () => {
    it('uses v0/models when available and filters embeddings + not-loaded models', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          data: [
            { id: 'chat-model', type: 'chat', state: 'loaded' },
            { id: 'embed-model', type: 'embeddings', state: 'loaded' },
            { id: 'unloaded', type: 'chat', state: 'not-loaded' },
          ]
        })
      } as any);

      const models = await provider.getModels();
      expect(models).to.deep.equal(['chat-model']);
    });

    it('lists installed chat models but never embeddings when nothing is loaded', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          data: [
            { id: 'chat-a', type: 'llm', state: 'not-loaded' },
            { id: 'vision-b', type: 'vlm', state: 'not-loaded' },
            { id: 'embed-x', type: 'embeddings', state: 'not-loaded' },
          ]
        })
      } as any);
      const models = await provider.getModels();
      expect(models).to.deep.equal(['chat-a', 'vision-b']);
      expect(fetchStub.callCount).to.equal(1); // did not fall through to /v1/models
    });

    it('falls through to v1/models when v0 returns an empty list', async () => {
      fetchStub.onFirstCall().resolves({ ok: true, json: async () => ({ data: [] }) } as any);
      fetchStub.onSecondCall().resolves({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) } as any);

      const models = await provider.getModels();
      expect(models).to.include('gpt-4o');
      expect(fetchStub.callCount).to.equal(2);
    });

    it('falls through to v1/models when v0 request fails', async () => {
      fetchStub.onFirstCall().rejects(new Error('ECONNREFUSED'));
      fetchStub.onSecondCall().resolves({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) } as any);

      const models = await provider.getModels();
      expect(models).to.include('gpt-4o');
    });

    it('throws when v1/models is non-OK', async () => {
      fetchStub.onFirstCall().rejects(new Error('no v0'));
      fetchStub.onSecondCall().resolves({ ok: false, statusText: 'Unauthorized' } as any);

      try {
        await provider.getModels();
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Unauthorized');
      }
    });

    it('sets authHeader with bearer token when apiKey provided', async () => {
      const p = new OpenAICompatibleProvider('http://localhost:1234', 'sk-test');
      fetchStub.rejects(new Error('no v0'));
      fetchStub.onSecondCall().resolves({ ok: true, json: async () => ({ data: [] }) } as any);

      await p.getModels().catch(() => {});
      const headers = fetchStub.secondCall?.args[1]?.headers;
      expect(headers?.Authorization).to.equal('Bearer sk-test');
    });

    it('uses x-api-key header when authType is x-api-key', async () => {
      const p = new OpenAICompatibleProvider('http://localhost:1234', 'sk-test', 'x-api-key');
      fetchStub.rejects(new Error('no v0'));
      fetchStub.onSecondCall().resolves({ ok: true, json: async () => ({ data: [] }) } as any);

      await p.getModels().catch(() => {});
      const headers = fetchStub.secondCall?.args[1]?.headers;
      expect(headers?.['x-api-key']).to.equal('sk-test');
      expect(headers?.Authorization).to.be.undefined;
    });
  });

  // ── getCapabilities ─────────────────────────────────────────────────────────

  describe('getCapabilities', () => {
    it('trusts v0 explicit boolean caps when available', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          data: [{
            id: 'my-vision-model',
            type: 'chat',
            state: 'loaded',
            capabilities: { vision: true, tool_calls: false, reasoning: false }
          }]
        })
      } as any);

      await provider.getModels();
      const caps = await provider.getCapabilities('my-vision-model');
      expect(caps.vision).to.be.true;
      expect(caps.tools).to.be.false;
      // No extra fetch needed: cache was consumed
      expect(fetchStub.callCount).to.equal(1);
    });

    describe('LM Studio v0 type and capabilities array', () => {
      const v0 = (entry: any) => fetchStub.resolves({ ok: true, json: async () => ({ data: [{ state: 'loaded', ...entry }] }) } as any);

      it('type "llm" means no vision even when the name contains a vision keyword (qwen3)', async () => {
        v0({ id: 'qwen/qwen3-4b', type: 'llm', capabilities: ['tool_use'] });
        await provider.getModels();
        const caps = await provider.getCapabilities('qwen/qwen3-4b');
        expect(caps.vision).to.equal(false);
        expect(caps.tools).to.equal(true);
        expect(caps.reasoning).to.equal(true);
      });

      it('type "vlm" means vision', async () => {
        v0({ id: 'google/gemma-4-e4b', type: 'vlm', capabilities: ['tool_use'] });
        await provider.getModels();
        const caps = await provider.getCapabilities('google/gemma-4-e4b');
        expect(caps.vision).to.equal(true);
        expect(caps.tools).to.equal(true);
      });

      it('a capabilities array without tool_use means no tools', async () => {
        v0({ id: 'some-model', type: 'llm', capabilities: [] });
        await provider.getModels();
        const caps = await provider.getCapabilities('some-model');
        expect(caps.tools).to.equal(false);
      });

      it('no capabilities field falls back to name-based tools', async () => {
        v0({ id: 'llama3-8b', type: 'llm' });
        await provider.getModels();
        const caps = await provider.getCapabilities('llama3-8b');
        expect(caps.tools).to.equal(true);
      });
    });

    it('falls back to name-based heuristics when v0 entry is missing', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ data: [{ id: 'other-model', type: 'chat', state: 'loaded', capabilities: {} }] })
      } as any);
      await provider.getModels();

      const caps = await provider.getCapabilities('gpt-4-vision-preview');
      expect(caps.vision).to.be.true;  // name-based: gpt-4-vision
    });

    it('uses explicit caps from v1/models when capabilities object is non-empty', async () => {
      fetchStub.onFirstCall().rejects(new Error('no v0'));
      // Avoid putting "vision" as a key in the JSON; info.includes('vision') would be a false positive
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: async () => ({
          data: [{ id: 'local-model', capabilities: { tool_calls: true } }]
        })
      } as any);

      const caps = await provider.getCapabilities('local-model');
      expect(caps.tools).to.be.true;
      expect(caps.vision).to.be.false;
    });

    it('falls back to name-based tools when v1 entry has no capability fields', async () => {
      // llama3-8b matches the 'llama3' TOOLS_KEYWORDS entry; isToolsModel returns true.
      fetchStub.onFirstCall().rejects(new Error('no v0'));
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: async () => ({ data: [{ id: 'llama3-8b', capabilities: {} }] })
      } as any);

      const caps = await provider.getCapabilities('llama3-8b');
      expect(caps.tools).to.be.true;
    });

    it('returns name-based caps on network error', async () => {
      fetchStub.rejects(new Error('ECONNREFUSED'));
      const caps = await provider.getCapabilities('gpt-4o');
      expect(caps).to.have.keys(['vision', 'reasoning', 'tools']);
    });
  });

  // ── streamChat ──────────────────────────────────────────────────────────────

  describe('streamChat', () => {
    it('streams text chunks and returns accumulated text', async () => {
      fetchStub.resolves({
        ok: true,
        body: sseLines(textChunk('Hello'), textChunk(', world'), DONE_LINE)
      } as any);

      const chunks: string[] = [];
      const result = await provider.streamChat(
        'gpt-4o', [{ role: 'user', content: 'Hi' }], c => chunks.push(c)
      );

      expect(chunks).to.deep.equal(['Hello', ', world']);
      expect(result.text).to.equal('Hello, world');
    });

    describe('reasoning stream (reasoning_content / reasoning)', () => {
      const reasoningChunk = (field: string, text: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { [field]: text } }] })}`;

      it('forwards reasoning_content as a <think> block and keeps it out of the returned text', async () => {
        fetchStub.resolves({
          ok: true,
          body: sseLines(reasoningChunk('reasoning_content', 'Hmm'), reasoningChunk('reasoning_content', ' ok'), textChunk('Answer'), DONE_LINE)
        } as any);
        const chunks: string[] = [];
        const result = await provider.streamChat('m', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks.join('')).to.equal('<think>Hmm ok</think>Answer');
        expect(chunks[0]).to.equal('<think>Hmm');
        expect(result.text).to.equal('Answer');
      });

      it('also accepts the "reasoning" field used by OpenRouter and vLLM', async () => {
        fetchStub.resolves({ ok: true, body: sseLines(reasoningChunk('reasoning', 'think'), textChunk('done')) } as any);
        const chunks: string[] = [];
        const result = await provider.streamChat('m', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks.join('')).to.equal('<think>think</think>done');
        expect(result.text).to.equal('done');
      });

      it('closes the think block when the stream ends during reasoning', async () => {
        fetchStub.resolves({ ok: true, body: sseLines(reasoningChunk('reasoning_content', 'still thinking'), DONE_LINE) } as any);
        const chunks: string[] = [];
        const result = await provider.streamChat('m', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks.join('')).to.equal('<think>still thinking</think>');
        expect(result.text).to.equal('');
      });

      it('adds no think markup when the model sends no reasoning', async () => {
        fetchStub.resolves({ ok: true, body: sseLines(textChunk('plain'), DONE_LINE) } as any);
        const chunks: string[] = [];
        await provider.streamChat('m', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks).to.deep.equal(['plain']);
      });
    });

    it('throws the server message when the stream carries only an error event', async () => {
      fetchStub.resolves({
        ok: true,
        body: sseLines('event: error', 'data: {"error":{"message":"Engine protocol predict request failed: fetch failed"},"message":"x"}')
      } as any);
      let thrown: any;
      try { await provider.streamChat('qwen/qwen3.6-27b', [{ role: 'user', content: 'hi' }], () => {}); } catch (e) { thrown = e; }
      expect(thrown, 'should have thrown').to.be.instanceOf(Error);
      expect(thrown.message).to.include('Engine protocol predict request failed');
    });

    it('accepts a plain string error field in the stream', async () => {
      fetchStub.resolves({ ok: true, body: sseLines('data: {"error":"model crashed"}') } as any);
      let thrown: any;
      try { await provider.streamChat('m', [{ role: 'user', content: 'hi' }], () => {}); } catch (e) { thrown = e; }
      expect(thrown?.message).to.equal('model crashed');
    });

    it('keeps partial text when an error arrives after content (no throw)', async () => {
      fetchStub.resolves({
        ok: true,
        body: sseLines(textChunk('partial'), 'data: {"error":{"message":"terminated"}}')
      } as any);
      const result = await provider.streamChat('m', [{ role: 'user', content: 'hi' }], () => {});
      expect(result.text).to.equal('partial');
    });

    it('does not treat a normal chunk as an error', async () => {
      fetchStub.resolves({ ok: true, body: sseLines(textChunk('fine'), DONE_LINE) } as any);
      const result = await provider.streamChat('m', [{ role: 'user', content: 'hi' }], () => {});
      expect(result.text).to.equal('fine');
    });

    it('ignores [DONE] sentinel — does not crash', async () => {
      fetchStub.resolves({ ok: true, body: sseLines(DONE_LINE) } as any);
      const result = await provider.streamChat('gpt-4o', [{ role: 'user', content: 'hi' }], () => {});
      expect(result.text).to.equal('');
    });

    it('returns empty text when body is null', async () => {
      fetchStub.resolves({ ok: true, body: null } as any);
      const result = await provider.streamChat('gpt-4o', [{ role: 'user', content: 'hi' }], () => {});
      expect(result.text).to.equal('');
    });

    it('accumulates streaming tool_calls across multiple chunks', async () => {
      fetchStub.resolves({
        ok: true,
        body: sseLines(
          toolCallChunk(0, 'call_1', 'read_file', '{"pa'),
          toolCallChunk(0, '', '', 'th":"foo.ts"}'),
          DONE_LINE
        )
      } as any);

      const result = await provider.streamChat(
        'gpt-4o',
        [{ role: 'user', content: 'read it' }],
        () => {},
        undefined,
        undefined,
        [{ name: 'read_file', description: 'Read a file', inputSchema: { properties: { path: { type: 'string' } } } }]
      );

      expect(result.toolCall).to.exist;
      expect(result.toolCall!.name).to.equal('read_file');
      expect(result.toolCall!.args.path).to.equal('foo.ts');
      expect(result.toolCall!.id).to.equal('call_1');
    });

    it('handles legacy function_call format', async () => {
      fetchStub.resolves({
        ok: true,
        body: sseLines(
          legacyFunctionChunk('read_file', '{"pa'),
          legacyFunctionChunk('', 'th":"bar.ts"}'),
          DONE_LINE
        )
      } as any);

      const result = await provider.streamChat(
        'local-model', [{ role: 'user', content: 'go' }], () => {}
      );

      expect(result.toolCall).to.exist;
      expect(result.toolCall!.name).to.equal('read_file');
      expect(result.toolCall!.args.path).to.equal('bar.ts');
    });

    it('retries without tools on 400 with tool-rejection error', async () => {
      fetchStub.onFirstCall().resolves({
        ok: false,
        status: 400,
        text: async () => 'Unknown field: tools'
      } as any);
      fetchStub.onSecondCall().resolves({
        ok: true,
        body: sseLines(textChunk('ok'), DONE_LINE)
      } as any);

      const result = await provider.streamChat(
        'local-model',
        [{ role: 'user', content: 'go' }],
        () => {},
        undefined,
        undefined,
        [{ name: 'x', description: 'y', inputSchema: {} }]
      );

      expect(result.text).to.equal('ok');
      expect(fetchStub.callCount).to.equal(2);
      const retryBody = JSON.parse(fetchStub.secondCall.args[1].body);
      expect(retryBody).to.not.have.property('tools');
    });

    it('does NOT retry on 400 without tool-related error message', async () => {
      fetchStub.resolves({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"invalid_model"}}'
      } as any);

      try {
        await provider.streamChat('gpt-4o', [{ role: 'user', content: 'hi' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('invalid_model');
      }
      expect(fetchStub.callCount).to.equal(1);
    });

    it('does NOT retry on non-400 error with tools', async () => {
      fetchStub.resolves({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable'
      } as any);

      try {
        await provider.streamChat(
          'gpt-4o',
          [{ role: 'user', content: 'hi' }],
          () => {},
          undefined,
          undefined,
          [{ name: 'x', description: 'y', inputSchema: {} }]
        );
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Service Unavailable');
      }
      expect(fetchStub.callCount).to.equal(1);
    });

    it('throws when tool message is missing tool_call_id', async () => {
      const messages = [
        { role: 'user' as const, content: 'go' },
        { role: 'tool' as const, content: 'result' }
      ];

      try {
        await provider.streamChat('gpt-4o', messages, () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('tool_call_id');
      }
    });

    const apiReasoningCases: Array<[string, string]> = [
      ['o3-mini',          'OpenAI o-series'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ['gemini-2.5-pro',   'Gemini 2.5 Pro'],
    ];
    for (const [model, label] of apiReasoningCases) {
      it(`sends reasoning_effort in body for ${label}`, async () => {
        fetchStub.resolves({ ok: true, body: sseLines(DONE_LINE) } as any);
        await provider.streamChat(model, [{ role: 'user', content: 'solve' }], () => {}, undefined, undefined, undefined, 'high');
        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.reasoning_effort).to.equal('high');
      });
    }

    it('does NOT send reasoning_effort for non-API-reasoning models', async () => {
      fetchStub.resolves({ ok: true, body: sseLines(DONE_LINE) } as any);

      await provider.streamChat(
        'llama3.1-8b', [{ role: 'user', content: 'think' }], () => {},
        undefined, undefined, undefined, 'high'
      );

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body).to.not.have.property('reasoning_effort');
    });

    it('throws on non-OK response with no tools', async () => {
      fetchStub.resolves({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Unauthorized"}}'
      } as any);

      try {
        await provider.streamChat('gpt-4o', [{ role: 'user', content: 'hi' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Unauthorized');
      }
    });

    it('includes compact summary in merged system message', async () => {
      fetchStub.resolves({ ok: true, body: sseLines(DONE_LINE) } as any);

      const messages = [
        { role: 'system' as const, content: 'You are helpful.' },
        { role: 'system' as const, content: '__compacted__\n\ndecisions: Redis' },
        { role: 'user' as const, content: 'Continue.' }
      ];

      await provider.streamChat('gpt-4o', messages, () => {});

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      const sysMsg = body.messages.find((m: any) => m.role === 'system');
      expect(sysMsg?.content).to.include('You are helpful.');
      expect(sysMsg?.content).to.include('decisions: Redis');
    });
  });

  // ── chat (non-streaming) ────────────────────────────────────────────────────

  describe('chat', () => {
    it('returns message content from the response', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'The answer is 42.' } }] })
      } as any);

      const result = await provider.chat('gpt-4o', [{ role: 'user', content: '6×7?' }]);
      expect(result).to.equal('The answer is 42.');
    });

    it('returns empty string when choices is empty', async () => {
      fetchStub.resolves({ ok: true, json: async () => ({ choices: [] }) } as any);
      const result = await provider.chat('gpt-4o', [{ role: 'user', content: 'hi' }]);
      expect(result).to.equal('');
    });

    it('throws on non-OK response', async () => {
      fetchStub.resolves({ ok: false, text: async () => '{"error":{"message":"bad request"}}' } as any);

      try {
        await provider.chat('gpt-4o', [{ role: 'user', content: 'hi' }]);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('bad request');
      }
    });

    it('folds compact summary into messages sent to the API', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] })
      } as any);

      const messages = [
        { role: 'system' as const, content: 'You are helpful.' },
        { role: 'system' as const, content: '__compacted__\n\ndecisions: Redis' },
        { role: 'user' as const, content: 'Continue.' }
      ];

      await provider.chat('gpt-4o', messages);

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      const sysMsg = body.messages.find((m: any) => m.role === 'system');
      expect(sysMsg?.content).to.include('You are helpful.');
      expect(sysMsg?.content).to.include('decisions: Redis');
    });
  });
});
