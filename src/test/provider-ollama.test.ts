import { expect } from 'chai';
import * as sinon from 'sinon';
import { OllamaProvider } from '../provider-ollama';

// ── NDJSON stream helpers ─────────────────────────────────────────────────────

function ndjsonStream(...objects: any[]) {
  const encoder = new TextEncoder();
  const data = objects.map(o => JSON.stringify(o) + '\n').join('');
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

function textLine(content: string, isDone = false) {
  return { message: { role: 'assistant', content }, done: isDone };
}

function toolLine(name: string, args: Record<string, any>) {
  return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false };
}

function doneLine() {
  return { done: true };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaProvider', () => {
  let fetchStub: sinon.SinonStub;
  let provider: OllamaProvider;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis as any, 'fetch');
    provider = new OllamaProvider('http://localhost:11434');
  });

  afterEach(() => { sinon.restore(); });

  // ── getModels ───────────────────────────────────────────────────────────────

  describe('getModels', () => {
    it('returns model names from /api/tags', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.1:8b' }, { name: 'mistral:7b' }] })
      } as any);

      const models = await provider.getModels();
      expect(models).to.deep.equal(['llama3.1:8b', 'mistral:7b']);
    });

    it('returns empty array when models list is absent', async () => {
      fetchStub.resolves({ ok: true, json: async () => ({}) } as any);
      const models = await provider.getModels();
      expect(models).to.deep.equal([]);
    });

    it('throws when /api/tags is non-OK', async () => {
      fetchStub.resolves({ ok: false, statusText: 'Not Found' } as any);

      try {
        await provider.getModels();
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Not Found');
      }
    });

    it('strips trailing slashes from baseUrl', () => {
      const p = new OllamaProvider('http://localhost:11434///');
      fetchStub.resolves({ ok: true, json: async () => ({ models: [] }) } as any);
      return p.getModels().then(() => {
        const calledUrl: string = fetchStub.firstCall.args[0];
        expect(calledUrl).to.equal('http://localhost:11434/api/tags');
      });
    });
  });

  // ── getCapabilities ─────────────────────────────────────────────────────────

  describe('getCapabilities', () => {
    function showResponse(overrides: Record<string, any> = {}) {
      return {
        ok: true,
        json: async () => ({
          details: { families: [] },
          model_info: {},
          template: '',
          ...overrides
        })
      };
    }

    describe('capabilities list from /api/show (Ollama 0.6.4+)', () => {
      it('trusts the list: no vision even if the JSON mentions vision tokens', async () => {
        fetchStub.resolves(showResponse({
          capabilities: ['completion', 'tools', 'thinking'],
          template: '<|vision_start|><|image_pad|><|vision_end|>'
        }) as any);
        const caps = await provider.getCapabilities('qwen3:4b');
        expect(caps).to.deep.equal({ vision: false, reasoning: true, tools: true });
      });

      it('reports vision and tools when listed', async () => {
        fetchStub.resolves(showResponse({ capabilities: ['completion', 'vision', 'tools'] }) as any);
        const caps = await provider.getCapabilities('gemma3:4b');
        expect(caps.vision).to.be.true;
        expect(caps.tools).to.be.true;
      });

      it('reports no tools when the list omits them, even if the template mentions tools', async () => {
        fetchStub.resolves(showResponse({
          capabilities: ['completion'],
          template: '{% if tools %}x{% endif %}'
        }) as any);
        const caps = await provider.getCapabilities('some-model:7b');
        expect(caps.tools).to.be.false;
      });

      it('still flags a reasoning model by name when the list has no thinking entry', async () => {
        fetchStub.resolves(showResponse({ capabilities: ['completion'] }) as any);
        const caps = await provider.getCapabilities('deepseek-r1:7b');
        expect(caps.reasoning).to.be.true;
      });

      it('falls back to the old detection when the list is absent or empty', async () => {
        fetchStub.resolves(showResponse({ capabilities: [], template: '{% if tools %}x{% endif %}' }) as any);
        const caps = await provider.getCapabilities('mistral:7b');
        expect(caps.tools).to.be.true;
      });
    });

    it('detects tools via chat template {% if tools %}', async () => {
      fetchStub.resolves(showResponse({
        template: '{% if tools %}<tools>{% endif %}'
      }) as any);

      const caps = await provider.getCapabilities('mistral:7b');
      expect(caps.tools).to.be.true;
    });

    it('detects tools via chat template {% for x in tools %}', async () => {
      fetchStub.resolves(showResponse({
        template: '{%- for tool in tools %}<tool>{%- endfor %}'
      }) as any);

      const caps = await provider.getCapabilities('qwen2.5:7b');
      expect(caps.tools).to.be.true;
    });

    it('detects vision via GGUF tags', async () => {
      fetchStub.resolves(showResponse({
        model_info: { 'general.tags': ['vision', 'chat'] }
      }) as any);

      const caps = await provider.getCapabilities('llava:7b');
      expect(caps.vision).to.be.true;
    });

    it('detects vision via families array', async () => {
      fetchStub.resolves(showResponse({
        details: { families: ['llama', 'clip'] }
      }) as any);

      const caps = await provider.getCapabilities('llava:7b');
      expect(caps.vision).to.be.true;
    });

    it('detects reasoning via GGUF tags', async () => {
      fetchStub.resolves(showResponse({
        model_info: { 'general.tags': ['reasoning'] }
      }) as any);

      const caps = await provider.getCapabilities('deepseek-r1:7b');
      expect(caps.reasoning).to.be.true;
    });

    it('detects reasoning via isReasoningModel name heuristic', async () => {
      fetchStub.resolves(showResponse() as any);
      const caps = await provider.getCapabilities('deepseek-r1:latest');
      expect(caps.reasoning).to.be.true;
    });

    it('retries with :latest suffix when untagged model name returns non-OK', async () => {
      fetchStub.onFirstCall().resolves({ ok: false } as any);
      fetchStub.onSecondCall().resolves(showResponse({
        template: '{% if tools %}yes{% endif %}'
      }) as any);

      const caps = await provider.getCapabilities('mistral');
      expect(caps.tools).to.be.true;
      expect(fetchStub.secondCall.args[1].body).to.include('mistral:latest');
    });

    it('does NOT retry with :latest when model name already contains :', async () => {
      fetchStub.resolves({ ok: false } as any);
      const caps = await provider.getCapabilities('mistral:7b');
      expect(fetchStub.callCount).to.equal(1);
      expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
    });

    it('returns all-false when /api/show is non-OK for tagged model', async () => {
      fetchStub.resolves({ ok: false } as any);
      const caps = await provider.getCapabilities('unknown:latest');
      expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
    });

    it('returns all-false on network error', async () => {
      fetchStub.rejects(new Error('ECONNREFUSED'));
      const caps = await provider.getCapabilities('any');
      expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
    });

    it('detects tools via "tools" JSON key in raw model info', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          details: { families: [] },
          model_info: { tools: true },
          template: ''
        })
      } as any);

      const caps = await provider.getCapabilities('llama3.1:8b');
      expect(caps.tools).to.be.true;
    });
  });

  // ── streamChat ──────────────────────────────────────────────────────────────

  describe('streamChat', () => {
    describe('thinking stream (message.thinking)', () => {
      const thinkLine = (thinking: string) => ({ message: { role: 'assistant', content: '', thinking }, done: false });

      it('forwards message.thinking as a <think> block and keeps it out of the returned text', async () => {
        fetchStub.resolves({ ok: true, body: ndjsonStream(thinkLine('Okay'), thinkLine(', so'), textLine('Four'), doneLine()) } as any);
        const chunks: string[] = [];
        const result = await provider.streamChat('qwen3:4b', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks.join('')).to.equal('<think>Okay, so</think>Four');
        expect(chunks[0]).to.equal('<think>Okay');
        expect(result.text).to.equal('Four');
      });

      it('closes the think block when the stream ends during thinking', async () => {
        fetchStub.resolves({ ok: true, body: ndjsonStream(thinkLine('mulling'), doneLine()) } as any);
        const chunks: string[] = [];
        const result = await provider.streamChat('qwen3:4b', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks.join('')).to.equal('<think>mulling</think>');
        expect(result.text).to.equal('');
      });

      it('closes the think block before a native tool call that follows thinking', async () => {
        fetchStub.resolves({ ok: true, body: ndjsonStream(thinkLine('need the tool'), toolLine('read_file', { path: 'a.ts' }), doneLine()) } as any);
        const chunks: string[] = [];
        const result = await provider.streamChat('qwen3:4b', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks.join('')).to.equal('<think>need the tool</think>');
        expect(result.toolCall?.name).to.equal('read_file');
      });

      it('adds no think markup when the model sends no thinking', async () => {
        fetchStub.resolves({ ok: true, body: ndjsonStream(textLine('plain'), doneLine()) } as any);
        const chunks: string[] = [];
        await provider.streamChat('llama3', [{ role: 'user', content: 'hi' }], c => chunks.push(c));
        expect(chunks).to.deep.equal(['plain']);
      });
    });

    it('streams text and returns accumulated result', async () => {
      fetchStub.resolves({
        ok: true,
        body: ndjsonStream(textLine('Hello'), textLine(', world'), doneLine())
      } as any);

      const chunks: string[] = [];
      const result = await provider.streamChat(
        'llama3.1:8b', [{ role: 'user', content: 'Hi' }], c => chunks.push(c)
      );

      expect(chunks).to.deep.equal(['Hello', ', world']);
      expect(result.text).to.equal('Hello, world');
    });

    it('returns empty text when body is null', async () => {
      fetchStub.resolves({ ok: true, body: null } as any);
      const result = await provider.streamChat('llama3.1:8b', [{ role: 'user', content: 'hi' }], () => {});
      expect(result.text).to.equal('');
    });

    it('captures native tool call with object args', async () => {
      fetchStub.resolves({
        ok: true,
        body: ndjsonStream(toolLine('read_file', { path: 'foo.ts' }), doneLine())
      } as any);

      const result = await provider.streamChat(
        'mistral:7b', [{ role: 'user', content: 'read it' }], () => {},
        undefined, undefined,
        [{ name: 'read_file', description: 'Read', inputSchema: {} }]
      );

      expect(result.toolCall).to.exist;
      expect(result.toolCall!.name).to.equal('read_file');
      expect(result.toolCall!.args).to.deep.equal({ path: 'foo.ts' });
    });

    it('parses tool call with string args (JSON-stringified)', async () => {
      fetchStub.resolves({
        ok: true,
        body: ndjsonStream(
          { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"out.ts","content":"hello"}' } }] }, done: false },
          doneLine()
        )
      } as any);

      const result = await provider.streamChat('mistral:7b', [{ role: 'user', content: 'write' }], () => {});
      expect(result.toolCall!.args.path).to.equal('out.ts');
      expect(result.toolCall!.args.content).to.equal('hello');
    });

    it('sets jsonMode format field in body', async () => {
      fetchStub.resolves({ ok: true, body: ndjsonStream(doneLine()) } as any);

      await provider.streamChat('llama3.1:8b', [{ role: 'user', content: 'json plz' }], () => {}, undefined, true);

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.format).to.equal('json');
    });

    const toolRetryOnErrorCases: Array<[number, string, string]> = [
      [400, 'tools not supported',                   'retries without tools on 400 error'],
      [500, 'closing bracket expected in tool call', 'retries without tools on 500 with tool-related error'],
    ];
    for (const [status, errText, label] of toolRetryOnErrorCases) {
      it(label, async () => {
        fetchStub.onFirstCall().resolves({
          ok: false, status,
          text: async () => errText
        } as any);
        fetchStub.onSecondCall().resolves({
          ok: true,
          body: ndjsonStream(textLine('ok'), doneLine())
        } as any);

        const result = await provider.streamChat(
          'llama3.1:8b',
          [{ role: 'user', content: 'go' }],
          () => {},
          undefined, undefined,
          [{ name: 'x', description: 'y', inputSchema: {} }]
        );

        expect(fetchStub.callCount).to.equal(2);
        expect(result.text).to.equal('ok');
        const retryBody = JSON.parse(fetchStub.secondCall.args[1].body);
        expect(retryBody).to.not.have.property('tools');
      });
    }

    it('throws on non-tool-related 500 error', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      } as any);

      try {
        await provider.streamChat('llama3.1:8b', [{ role: 'user', content: 'go' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Internal Server Error');
      }
    });

    it('retries without tools on mid-stream error when hadTools and no content yet', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        body: ndjsonStream({ error: 'model does not support tools' })
      } as any);
      fetchStub.onSecondCall().resolves({
        ok: true,
        body: ndjsonStream(textLine('fallback'), doneLine())
      } as any);

      const result = await provider.streamChat(
        'llama3.1:8b',
        [{ role: 'user', content: 'go' }],
        () => {},
        undefined, undefined,
        [{ name: 'x', description: 'y', inputSchema: {} }]
      );

      expect(result.text).to.equal('fallback');
      expect(result.toolsDropped).to.be.true;
      expect(fetchStub.callCount).to.equal(2);
    });

    it('throws on mid-stream error when no tools were sent', async () => {
      fetchStub.resolves({
        ok: true,
        body: ndjsonStream({ error: 'context length exceeded' })
      } as any);

      try {
        await provider.streamChat('llama3.1:8b', [{ role: 'user', content: 'go' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('context length exceeded');
      }
    });

    it('does not retry on mid-stream error when text was already streamed', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        body: ndjsonStream(textLine('partial response'), { error: 'something went wrong' })
      } as any);

      const result = await provider.streamChat(
        'llama3.1:8b',
        [{ role: 'user', content: 'go' }],
        () => {},
        undefined, undefined,
        [{ name: 'x', description: 'y', inputSchema: {} }]
      );

      expect(fetchStub.callCount).to.equal(1);
      expect(result.text).to.equal('partial response');
    });

    it('throws on non-OK without tools', async () => {
      fetchStub.resolves({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable'
      } as any);

      try {
        await provider.streamChat('llama3.1:8b', [{ role: 'user', content: 'hi' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('Service Unavailable');
      }
    });
  });

  // ── chat (non-streaming) ────────────────────────────────────────────────────

  describe('chat', () => {
    it('returns message content from the response', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'Hello there.' } })
      } as any);

      const result = await provider.chat('llama3.1:8b', [{ role: 'user', content: 'hi' }]);
      expect(result).to.equal('Hello there.');
    });

    it('returns empty string when message content is missing', async () => {
      fetchStub.resolves({ ok: true, json: async () => ({ message: {} }) } as any);
      const result = await provider.chat('llama3.1:8b', [{ role: 'user', content: 'hi' }]);
      expect(result).to.equal('');
    });

    it('throws on non-OK response', async () => {
      fetchStub.resolves({ ok: false, text: async () => 'model not found' } as any);

      try {
        await provider.chat('llama3.1:8b', [{ role: 'user', content: 'hi' }]);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('model not found');
      }
    });

    it('sends stream: false in the request body', async () => {
      fetchStub.resolves({ ok: true, json: async () => ({ message: { content: 'ok' } }) } as any);

      await provider.chat('llama3.1:8b', [{ role: 'user', content: 'hi' }]);

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.stream).to.be.false;
    });
  });
});
