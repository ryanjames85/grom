import { expect } from 'chai';
import * as sinon from 'sinon';
import { AnthropicProvider } from '../provider-anthropic';
import type { ChatMessage } from '../message-utils';

// Minimal SSE stream helper: returns a readable stream of text/event-stream lines.
function sseStream(...events: string[]) {
  const encoder = new TextEncoder();
  const chunks = events.map(e => encoder.encode(e + '\n'));
  let i = 0;
  return {
    getReader: () => ({
      read: async () => i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined }
    })
  };
}

// Builds the SSE payload for a single Anthropic text_delta event.
const textDelta = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}`;

const DONE = 'data: {"type":"message_stop"}';

describe('AnthropicProvider — message merging', () => {
  let fetchStub: sinon.SinonStub;
  let provider: AnthropicProvider;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis as any, 'fetch');
    provider = new AnthropicProvider('https://api.anthropic.com', 'sk-test');
  });

  afterEach(() => { sinon.restore(); });

  // Helper: capture the parsed request body from the first fetch call.
  const capturedBody = () => JSON.parse(fetchStub.firstCall.args[1].body);
  const capturedHeaders = () => fetchStub.firstCall.args[1].headers as Record<string, string>;

  function okStreamResponse(text: string) {
    return {
      ok: true,
      body: sseStream(textDelta(text), DONE),
    };
  }

  // ── compact marker stripping ──────────────────────────────────────────────

  describe('compact marker handling', () => {
    it('folds compact summary into the system prompt instead of dropping it', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '__compacted__\n\ndecisions: chose SQLite\nconstraints: no ORM' },
        { role: 'user', content: 'What did we decide?' },
      ];
      fetchStub.resolves(okStreamResponse('SQLite') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      expect(body.system).to.include('You are helpful.');
      expect(body.system).to.include('decisions: chose SQLite');
      expect(body.system).to.include('constraints: no ORM');
    });

    it('strips the bare __compacted__ sentinel — does not leak it to the model', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '__compacted__' },
        { role: 'user', content: 'Hello.' },
      ];
      fetchStub.resolves(okStreamResponse('Hi') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      expect(body.system).to.equal('You are helpful.');
      expect(body.system).to.not.include('__compacted__');
    });

    it('compact-only history (no real system message) uses summary as the system prompt', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: '__compacted__\n\ndecisions: TypeScript, Postgres' },
        { role: 'user', content: 'Continue.' },
      ];
      fetchStub.resolves(okStreamResponse('ok') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      expect(body.system).to.include('decisions: TypeScript, Postgres');
      expect(body.system).to.not.include('__compacted__');
    });

    it('multiple compact markers are all merged into the system prompt', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '__compacted__\n\ndecisions: SQLite' },
        { role: 'system', content: '__compacted__\n\ndecisions: TypeScript' },
        { role: 'user', content: 'Go.' },
      ];
      fetchStub.resolves(okStreamResponse('ok') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      expect(body.system).to.include('You are helpful.');
      expect(body.system).to.include('decisions: SQLite');
      expect(body.system).to.include('decisions: TypeScript');
    });

    it('compact markers do not appear in the messages array sent to Anthropic', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '__compacted__\n\ndecisions: SQLite' },
        { role: 'user', content: 'Hello.' },
      ];
      fetchStub.resolves(okStreamResponse('ok') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      const roles: string[] = body.messages.map((m: any) => m.role);
      expect(roles).to.not.include('system');
      // Only the user message survives in the messages array
      expect(body.messages).to.have.length(1);
      expect(body.messages[0].content).to.equal('Hello.');
    });
  });

  it('omits the system field entirely when no system message is present', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello.' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'user', content: 'Bye.' },
    ];
    fetchStub.resolves(okStreamResponse('ok') as any);

    await provider.streamChat('claude-opus-4-5', messages, () => {});

    const body = capturedBody();
    expect(body).to.not.have.property('system');
  });

  // ── tool message conversion ───────────────────────────────────────────────

  describe('tool message conversion', () => {
    it('converts role:tool to role:user with tool_result block', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Read the file.' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"foo.ts"}' } }]
        },
        { role: 'tool', content: 'file contents here', tool_call_id: 'call_1' },
        { role: 'user', content: 'Thanks.' },
      ];
      fetchStub.resolves(okStreamResponse('done') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      const toolResultMsg = body.messages.find((m: any) =>
        Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
      );
      expect(toolResultMsg).to.exist;
      expect(toolResultMsg.role).to.equal('user');
      const block = toolResultMsg.content.find((c: any) => c.type === 'tool_result');
      expect(block.tool_use_id).to.equal('call_1');
      expect(block.content).to.equal('file contents here');
    });

    it('converts assistant tool_calls to tool_use blocks with parsed input', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Write a file.' },
        {
          role: 'assistant', content: 'I will write it.',
          tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.ts","content":"hello"}' } }]
        },
        { role: 'tool', content: 'done', tool_call_id: 'call_2' },
      ];
      fetchStub.resolves(okStreamResponse('ok') as any);

      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      const assistantMsg = body.messages.find((m: any) =>
        m.role === 'assistant' && Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === 'tool_use')
      );
      expect(assistantMsg).to.exist;
      const toolUse = assistantMsg.content.find((c: any) => c.type === 'tool_use');
      expect(toolUse.id).to.equal('call_2');
      expect(toolUse.name).to.equal('write_file');
      expect(toolUse.input).to.deep.equal({ path: 'out.ts', content: 'hello' });
      // Prose text is preserved as a text block
      const textBlock = assistantMsg.content.find((c: any) => c.type === 'text');
      expect(textBlock?.text).to.equal('I will write it.');
    });

    it('handles malformed tool_call arguments JSON gracefully (falls back to empty object)', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Do it.' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'read_file', arguments: 'not-valid-json' } }]
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_3' },
      ];
      fetchStub.resolves(okStreamResponse('ok') as any);

      // Should not throw: malformed JSON falls back to empty object
      await provider.streamChat('claude-opus-4-5', messages, () => {});

      const body = capturedBody();
      const assistantMsg = body.messages.find((m: any) =>
        m.role === 'assistant' && Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === 'tool_use')
      );
      const toolUse = assistantMsg?.content.find((c: any) => c.type === 'tool_use');
      expect(toolUse?.input).to.deep.equal({});
    });
  });

  // ── reasoning effort ──────────────────────────────────────────────────────

  describe('reasoning effort', () => {
    it('does not include thinking block when effort is off', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-opus-4-5', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'off');
      expect(capturedBody()).to.not.have.property('thinking');
    });

    const budgetCases: Array<['low' | 'medium' | 'high', number]> = [
      ['low', 2000], ['medium', 5000], ['high', 16000]
    ];
    for (const [effort, budget] of budgetCases) {
      it(`sends thinking block with budget ${budget} for effort=${effort}`, async () => {
        fetchStub.resolves(okStreamResponse('ok') as any);
        await provider.streamChat('claude-opus-4-5', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, effort);
        expect(capturedBody().thinking).to.deep.equal({ type: 'enabled', budget_tokens: budget });
      });
    }

    it('adds anthropic-beta header for claude-3-7-sonnet when thinking is enabled', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-3-7-sonnet-20250219', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'high');
      expect(capturedHeaders()['anthropic-beta']).to.equal('interleaved-thinking-2025-05-14');
    });

    it('does not add anthropic-beta header for claude-4 models', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-opus-4-5', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'high');
      expect(capturedHeaders()).to.not.have.property('anthropic-beta');
    });

    it('does not add anthropic-beta header when effort is off', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-3-7-sonnet-20250219', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'off');
      expect(capturedHeaders()).to.not.have.property('anthropic-beta');
    });

    it('ensures max_tokens exceeds budget_tokens for high effort', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-opus-4-5', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'high');
      const body = capturedBody();
      expect(body.max_tokens).to.be.greaterThan(body.thinking.budget_tokens);
    });

    it('uses adaptive thinking for claude-sonnet-4-6 (4.6+ generation)', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'high');
      const body = capturedBody();
      expect(body.thinking).to.deep.equal({ type: 'adaptive' });
      expect(body.output_config).to.deep.equal({ effort: 'high' });
    });

    for (const effort of ['low', 'medium', 'high'] as const) {
      it(`passes effort=${effort} straight through in output_config for adaptive models`, async () => {
        fetchStub.resolves(okStreamResponse('ok') as any);
        await provider.streamChat('claude-opus-4-6', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, effort);
        const body = capturedBody();
        expect(body.output_config).to.deep.equal({ effort });
        expect(body.thinking).to.not.have.property('effort');
      });
    }

    it('does not send output_config for legacy budget_tokens models', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-opus-4-5', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'high');
      expect(capturedBody()).to.not.have.property('output_config');
    });

    it('does not send output_config when effort is off on adaptive models', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'off');
      const body = capturedBody();
      expect(body).to.not.have.property('output_config');
      expect(body).to.not.have.property('thinking');
    });

    it('does not set budget_tokens for adaptive thinking models', async () => {
      fetchStub.resolves(okStreamResponse('ok') as any);
      await provider.streamChat('claude-opus-4-6', [{ role: 'user', content: 'hi' }], () => {}, undefined, undefined, undefined, 'high');
      const body = capturedBody();
      expect(body.thinking).to.not.have.property('budget_tokens');
    });
  });

  // ── streaming ─────────────────────────────────────────────────────────────

  describe('streaming', () => {
    it('streams text chunks via onChunk and returns full text', async () => {
      fetchStub.resolves({
        ok: true,
        body: sseStream(textDelta('Hello'), textDelta(', world'), DONE),
      } as any);

      const chunks: string[] = [];
      const result = await provider.streamChat(
        'claude-opus-4-5', [{ role: 'user', content: 'Hi' }], c => chunks.push(c)
      );

      expect(chunks).to.deep.equal(['Hello', ', world']);
      expect(result.text).to.equal('Hello, world');
    });

    it('returns empty text on an empty stream', async () => {
      fetchStub.resolves({ ok: true, body: sseStream(DONE) } as any);
      const result = await provider.streamChat(
        'claude-opus-4-5', [{ role: 'user', content: 'Hi' }], () => {}
      );
      expect(result.text).to.equal('');
    });

    it('throws on non-OK response', async () => {
      fetchStub.resolves({ ok: false, text: async () => '{"error":{"message":"Unauthorized"}}' } as any);
      try {
        await provider.streamChat('claude-opus-4-5', [{ role: 'user', content: 'Hi' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Unauthorized');
      }
    });

    it('returns empty text when response body is null', async () => {
      fetchStub.resolves({ ok: true, body: null } as any);
      const result = await provider.streamChat(
        'claude-opus-4-5', [{ role: 'user', content: 'Hi' }], () => {}
      );
      expect(result.text).to.equal('');
    });
  });

  // ── getCapabilities ───────────────────────────────────────────────────────

  describe('getCapabilities', () => {
    it('grants vision, reasoning, and tools to claude-sonnet-4-5', async () => {
      const caps = await provider.getCapabilities('claude-sonnet-4-5');
      expect(caps.vision).to.be.true;
      expect(caps.reasoning).to.be.true;
      expect(caps.tools).to.be.true;
    });

    it('grants vision and tools but not reasoning to claude-3-5-sonnet', async () => {
      const caps = await provider.getCapabilities('claude-3-5-sonnet-20241022');
      expect(caps.vision).to.be.true;
      expect(caps.tools).to.be.true;
      expect(caps.reasoning).to.be.false;
    });

    it('grants reasoning to claude-3-7-sonnet', async () => {
      const caps = await provider.getCapabilities('claude-3-7-sonnet-20250219');
      expect(caps.reasoning).to.be.true;
    });

    it('denies vision and reasoning to claude-instant-1', async () => {
      const caps = await provider.getCapabilities('claude-instant-1');
      expect(caps.vision).to.be.false;
      expect(caps.reasoning).to.be.false;
    });
  });

  // ── getModels ─────────────────────────────────────────────────────────────

  describe('getModels', () => {
    it('returns model IDs from the API when available', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ data: [{ id: 'claude-opus-4-5' }, { id: 'claude-haiku-4-5-20251001' }] }),
      } as any);
      const models = await provider.getModels();
      expect(models).to.include('claude-opus-4-5');
      expect(models).to.include('claude-haiku-4-5-20251001');
    });

    it('falls back to hardcoded model list on API failure', async () => {
      fetchStub.resolves({ ok: false } as any);
      const models = await provider.getModels();
      expect(models.length).to.be.greaterThan(0);
      expect(models.some(m => m.includes('claude'))).to.be.true;
    });

    it('falls back to hardcoded model list on network error', async () => {
      fetchStub.rejects(new Error('ECONNREFUSED'));
      const models = await provider.getModels();
      expect(models.length).to.be.greaterThan(0);
    });
  });

  // ── chat (non-streaming) ──────────────────────────────────────────────────

  describe('chat (non-streaming)', () => {
    it('returns the text content from the response', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'The answer is 42.' }] }),
      } as any);
      const result = await provider.chat('claude-opus-4-5', [{ role: 'user', content: 'What is 6×7?' }]);
      expect(result).to.equal('The answer is 42.');
    });

    it('folds compact summary into system prompt in non-streaming path too', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      } as any);

      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '__compacted__\n\ndecisions: Redis' },
        { role: 'user', content: 'Continue.' },
      ];

      await provider.chat('claude-opus-4-5', messages);

      const body = capturedBody();
      expect(body.system).to.include('You are helpful.');
      expect(body.system).to.include('decisions: Redis');
    });

    it('returns empty string when response has no content', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ content: [] }),
      } as any);
      const result = await provider.chat('claude-opus-4-5', [{ role: 'user', content: 'Hi.' }]);
      expect(result).to.equal('');
    });

    it('throws on non-OK response', async () => {
      fetchStub.resolves({ ok: false, text: async () => '{"error":{"message":"bad request"}}' } as any);
      try {
        await provider.chat('claude-opus-4-5', [{ role: 'user', content: 'Hi.' }]);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('bad request');
      }
    });
  });
});
