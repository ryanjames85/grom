import { expect } from 'chai';
import * as sinon from 'sinon';

(global as any).vscode = { window: {}, workspace: {} };

import { LocalLLMClient, fetchContextLength, clearCtxEndpointCache } from '../client';

const makeStreamBody = (chunks: string[]) => {
  let callCount = 0;
  const encoder = new TextEncoder();
  return {
    getReader: () => ({
      read: async () => {
        if (callCount < chunks.length) {
          return { done: false, value: encoder.encode(chunks[callCount++]) };
        }
        return { done: true, value: undefined };
      }
    })
  };
};

describe('LocalLLMClient', () => {
  let fetchStub: sinon.SinonStub;
  const webview = { postMessage: sinon.stub() } as any;

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch');
    (webview.postMessage as sinon.SinonStub).reset();
  });

  afterEach(() => {
    fetchStub.restore();
  });

  // --- Capabilities ---

  it('detects vision and tools for Ollama models', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'qwen2.5-coder', true);
    fetchStub.resolves({ 
      ok: true, 
      json: async () => ({ 
        details: { families: ['vision'] },
        model_info: { 'projector.0': 'clip', 'tools': true } 
      }) 
    } as any);
    const caps = await client.getCapabilities();
    expect(caps.vision).to.be.true;
    expect(caps.tools).to.be.true;
  });

  it('detects reasoning for R1 models', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'deepseek-r1', true);
    fetchStub.resolves({ ok: true, json: async () => ({}) } as any);
    const caps = await client.getCapabilities();
    expect(caps.reasoning).to.be.true;
  });

  it('returns safe defaults when Ollama capabilities endpoint fails', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'some-model', true);
    fetchStub.rejects(new Error('Network error'));
    const caps = await client.getCapabilities();
    expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
  });

  it('detects OpenAI vision models by name', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4-vision', false);
    const caps = await client.getCapabilities();
    expect(caps.vision).to.be.true;
  });

  it('detects OpenAI reasoning models by name', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'o1-reasoning', false);
    const caps = await client.getCapabilities();
    expect(caps.reasoning).to.be.true;
  });

  // --- OpenAI-compat capability detection ---

  describe('OpenAI-compat getCapabilities', () => {
    const minimalModelEntry = (id: string, extra: Record<string, any> = {}) => ({
      ok: true,
      json: async () => ({ data: [{ id, ...extra }] })
    } as any);

    // Name-based detection (server returns no capabilities block)

    it('detects vision for llava by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'llava:13b', false);
      fetchStub.resolves(minimalModelEntry('llava:13b'));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('detects vision for gemma-4 by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gemma-4-4b', false);
      fetchStub.resolves(minimalModelEntry('gemma-4-4b'));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('detects vision for namespaced gemma-4 model (google/gemma-4-e4b)', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'google/gemma-4-e4b', false);
      fetchStub.resolves(minimalModelEntry('google/gemma-4-e4b'));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('detects tools for gemma-4 by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gemma-4-4b', false);
      fetchStub.resolves(minimalModelEntry('gemma-4-4b'));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('detects tools for qwen2.5 by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'qwen2.5-coder:7b', false);
      fetchStub.resolves(minimalModelEntry('qwen2.5-coder:7b'));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('detects tools for qwen3 by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'qwen3:8b', false);
      fetchStub.resolves(minimalModelEntry('qwen3:8b'));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('does NOT flag plain llama3 as vision or tools when server gives no caps', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'llama3.1:8b', false);
      fetchStub.resolves(minimalModelEntry('llama3.1:8b'));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.false;
      expect(caps.tools).to.be.false;
    });

    // Server-reported capabilities take precedence

    it('uses server-reported vision=true when capabilities block present', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.resolves(minimalModelEntry('some-model', { capabilities: { vision: true } }));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('uses server-reported tool_calls field (LM Studio naming)', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.resolves(minimalModelEntry('some-model', { capabilities: { tool_calls: true } }));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('uses server-reported tool_use field', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.resolves(minimalModelEntry('some-model', { capabilities: { tool_use: true } }));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('uses server-reported function_calling field', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.resolves(minimalModelEntry('some-model', { capabilities: { function_calling: true } }));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('overrides name-based tools=true with server-reported tools=false when caps block exists', async () => {
      // Server explicitly says no tools — trust it over the name
      const client = new LocalLLMClient('http://localhost:1234', 'mistral-nemo', false);
      fetchStub.resolves(minimalModelEntry('mistral-nemo', { capabilities: { tools: false } }));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.false;
    });

    it('falls back to name-based tools when server returns no capabilities block', async () => {
      // No capabilities key at all → hasExplicitCaps=false → name-based
      const client = new LocalLLMClient('http://localhost:1234', 'command-r', false);
      fetchStub.resolves(minimalModelEntry('command-r'));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('detects vision via multimodal keyword in entry JSON', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.resolves(minimalModelEntry('some-model', { type: 'multimodal' }));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('returns nameBased when model entry not found in list', async () => {
      // Model in settings is not in the /v1/models response
      const client = new LocalLLMClient('http://localhost:1234', 'missing-model', false);
      fetchStub.resolves({ ok: true, json: async () => ({ data: [{ id: 'other-model' }] }) } as any);
      const caps = await client.getCapabilities();
      // missing-model has no name-based match → all false
      expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
    });

    it('returns nameBased when /v1/models returns non-ok', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-vision-model', false);
      fetchStub.resolves({ ok: false, statusText: 'Unauthorized' } as any);
      const caps = await client.getCapabilities();
      // 'some-vision-model' → shortName includes 'vision' → nameBased.vision=true
      expect(caps.vision).to.be.true;
    });

    it('returns safe defaults when fetch throws entirely', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.rejects(new Error('ECONNREFUSED'));
      const caps = await client.getCapabilities();
      expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
    });

    // _lastModelsRaw optimisation: no second /v1/models fetch after getModels()

    it('reuses /v1/models response from getModels — only one fetch for both calls', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gemma-4-4b', false);
      const modelsResponse = { data: [{ id: 'gemma-4-4b', capabilities: { vision: true, tool_calls: true } }] };
      fetchStub.resolves({ ok: true, json: async () => modelsResponse } as any);
      await client.getAvailableModels();
      const caps = await client.getCapabilities();
      // Only one fetch should have fired (getModels sets _lastModelsRaw, getCapabilities consumes it)
      expect(fetchStub.callCount).to.equal(1);
      expect(caps.vision).to.be.true;
      expect(caps.tools).to.be.true;
    });

    it('makes a second fetch when getCapabilities called without prior getModels', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gemma-4-4b', false);
      fetchStub.resolves({ ok: true, json: async () => ({ data: [{ id: 'gemma-4-4b' }] }) } as any);
      await client.getCapabilities();
      expect(fetchStub.callCount).to.equal(1);
    });

    it('clears _lastModelsRaw after first getCapabilities call so second call re-fetches', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gemma-4-4b', false);
      fetchStub.resolves({ ok: true, json: async () => ({ data: [{ id: 'gemma-4-4b' }] }) } as any);
      await client.getAvailableModels();         // 1 fetch, sets cache
      await client.getCapabilities();            // consumes cache (still 1 fetch)
      await client.getCapabilities();            // cache cleared, fetches again (now 2)
      expect(fetchStub.callCount).to.equal(2);
    });

    // Namespaced model IDs (e.g. google/gemma-4-e4b)

    it('matches namespaced model by full ID', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'google/gemma-4-e4b', false);
      fetchStub.resolves({ ok: true, json: async () => ({
        data: [{ id: 'google/gemma-4-e4b', capabilities: { vision: true } }]
      }) } as any);
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('matches namespaced model by short name when full ID not in list', async () => {
      // Server only lists the short name without the namespace
      const client = new LocalLLMClient('http://localhost:1234', 'google/gemma-4-e4b', false);
      fetchStub.resolves({ ok: true, json: async () => ({
        data: [{ id: 'gemma-4-e4b', capabilities: { vision: true } }]
      }) } as any);
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    // Reasoning detection

    it('detects reasoning for deepseek-r1 model by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'deepseek-r1:7b', false);
      fetchStub.resolves(minimalModelEntry('deepseek-r1:7b'));
      const caps = await client.getCapabilities();
      expect(caps.reasoning).to.be.true;
    });

    it('detects reasoning for qwq model by name', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'qwq-32b', false);
      fetchStub.resolves(minimalModelEntry('qwq-32b'));
      const caps = await client.getCapabilities();
      expect(caps.reasoning).to.be.true;
    });

    it('detects reasoning via server-reported reasoning field', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'some-model', false);
      fetchStub.resolves(minimalModelEntry('some-model', { capabilities: { reasoning: true } }));
      const caps = await client.getCapabilities();
      expect(caps.reasoning).to.be.true;
    });
  });

  // --- Ollama-specific capability detection ---

  describe('Ollama getCapabilities', () => {
    const ollamaShowResponse = (fields: Record<string, any>) => ({
      ok: true,
      json: async () => fields
    } as any);

    it('detects vision via projector component in model_info', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'llava:13b', true);
      // Real Ollama /api/show for vision models includes projector keys in model_info
      fetchStub.resolves(ollamaShowResponse({ model_info: { 'projector.type': 'mlp', 'projector.0.weight': '...' } }));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('detects vision via mllm family tag', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'vision-model', true);
      fetchStub.resolves(ollamaShowResponse({ details: { families: ['mllm', 'qwen2'] } }));
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
    });

    it('detects tools via "tools" key in response JSON', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'qwen2.5-coder:7b', true);
      fetchStub.resolves(ollamaShowResponse({ capabilities: ['tools', 'vision'] }));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('detects tools via parameter_size field (contains "parameter")', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'qwen2.5-coder:7b', true);
      fetchStub.resolves(ollamaShowResponse({ details: { parameter_size: '7B', family: 'qwen2' } }));
      const caps = await client.getCapabilities();
      expect(caps.tools).to.be.true;
    });

    it('retries with :latest suffix when first /api/show fails for untagged model', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'qwen2.5-coder', true);
      fetchStub
        .onFirstCall().resolves({ ok: false } as any)
        .onSecondCall().resolves(ollamaShowResponse({ details: { parameter_size: '7B' } }));
      const caps = await client.getCapabilities();
      expect(fetchStub.callCount).to.equal(2);
      expect(fetchStub.secondCall.args[1].body).to.include(':latest');
      expect(caps.tools).to.be.true;
    });

    it('does NOT retry with :latest when model name already has a tag', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'qwen2.5-coder:7b', true);
      fetchStub.resolves({ ok: false } as any);
      await client.getCapabilities();
      expect(fetchStub.callCount).to.equal(1);
    });

    it('returns safe defaults when /api/show returns non-ok for both attempts', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'unknown-model', true);
      fetchStub.resolves({ ok: false } as any);
      const caps = await client.getCapabilities();
      expect(caps).to.deep.equal({ vision: false, reasoning: false, tools: false });
    });

    it('detects reasoning for r1 model by name even when /api/show returns empty', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'deepseek-r1:7b', true);
      fetchStub.resolves(ollamaShowResponse({}));
      const caps = await client.getCapabilities();
      expect(caps.reasoning).to.be.true;
    });

    it('sends POST to /api/show with model name in body', async () => {
      const client = new LocalLLMClient('http://localhost:11434', 'llama3.1:8b', true);
      fetchStub.resolves(ollamaShowResponse({}));
      await client.getCapabilities();
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.include('/api/show');
      expect(opts.method).to.equal('POST');
      expect(JSON.parse(opts.body).name).to.equal('llama3.1:8b');
    });
  });

  // --- getAvailableModels ---

  it('returns Ollama model list', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: true, json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }) } as any);
    const models = await client.getAvailableModels();
    expect(models).to.deep.equal(['llama3', 'mistral']);
  });

  it('returns OpenAI model list', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false);
    fetchStub.resolves({ ok: true, json: async () => ({ data: [{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }] }) } as any);
    const models = await client.getAvailableModels();
    expect(models).to.deep.equal(['gpt-4', 'gpt-3.5-turbo']);
  });

  it('throws when Ollama model list endpoint fails', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: false, statusText: 'Service Unavailable' } as any);
    try {
      await client.getAvailableModels();
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('Ollama error');
    }
  });

  // --- streamChatWithCallback ---

  it('streams Ollama chunks via callback', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    const lines = [
      JSON.stringify({ message: { content: 'Hello' } }) + '\n',
      JSON.stringify({ message: { content: ' world' } }) + '\n',
    ];
    fetchStub.resolves({ ok: true, body: makeStreamBody(lines) } as any);
    const chunks: string[] = [];
    await client.streamChatWithCallback([], (c) => chunks.push(c));
    expect(chunks).to.deep.equal(['Hello', ' world']);
  });

  it('streams OpenAI SSE chunks via callback', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false);
    const lines = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ' there' } }] }) + '\n',
      'data: [DONE]\n',
    ];
    fetchStub.resolves({ ok: true, body: makeStreamBody(lines) } as any);
    const chunks: string[] = [];
    await client.streamChatWithCallback([], (c) => chunks.push(c));
    expect(chunks).to.deep.equal(['Hi', ' there']);
  });

  it('returns full text after successful stream', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    const lines = [JSON.stringify({ message: { content: 'done' } }) + '\n'];
    fetchStub.resolves({ ok: true, body: makeStreamBody(lines) } as any);
    const result = await client.streamChatWithCallback([], () => {});
    expect(result).to.equal('done');
  });

  it('throws when Ollama stream returns non-ok', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: false, text: async () => 'model not found' } as any);
    try {
      await client.streamChatWithCallback([], () => {});
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('model not found');
    }
  });

  it('throws when OpenAI stream returns non-ok', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false);
    fetchStub.resolves({ ok: false, text: async () => 'unauthorized' } as any);
    try {
      await client.streamChatWithCallback([], () => {});
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('unauthorized');
    }
  });

  it('throws AbortError when aborted', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    const abort = new Error('aborted'); abort.name = 'AbortError';
    fetchStub.rejects(abort);
    try {
      await client.streamChatWithCallback([], () => {});
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.name).to.equal('AbortError');
    }
  });

  it('formats images correctly for OpenAI providers', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4-vision', false);
    fetchStub.resolves({ ok: true, body: makeStreamBody([]) } as any);
    const messages: any[] = [{ role: 'user', content: 'describe this', images: ['abc123'] }];
    await client.streamChatWithCallback(messages, () => {});
    const body = JSON.parse(fetchStub.lastCall.args[1].body);
    expect(body.messages[0].content).to.be.an('array');
    expect(body.messages[0].content[1].image_url.url).to.equal('data:image/jpeg;base64,abc123');
  });

  // --- chat (non-streaming) ---

  it('returns content from Ollama chat', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: true, json: async () => ({ message: { content: 'test response' } }) } as any);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result).to.equal('test response');
  });

  it('returns content from OpenAI chat', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false);
    fetchStub.resolves({ ok: true, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) } as any);
    const result = await client.chat([{ role: 'user', content: 'hi' }]);
    expect(result).to.equal('hello');
  });

  it('throws on Ollama chat error', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: false, text: async () => 'bad request' } as any);
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('bad request');
    }
  });

  // --- Sad path ---

  it('throws when fetch rejects entirely (network down)', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.rejects(new Error('ECONNREFUSED'));
    try {
      await client.streamChatWithCallback([], () => {});
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('ECONNREFUSED');
    }
  });

  it('throws when stream body is null', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: true, body: null } as any);
    try {
      await client.streamChatWithCallback([], () => {});
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e).to.exist;
    }
  });

  it('handles empty message array without throwing', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: true, body: makeStreamBody([]) } as any);
    const result = await client.streamChatWithCallback([], () => {});
    expect(result).to.equal('');
  });

  it('handles malformed JSON chunks gracefully (does not throw)', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: true, body: makeStreamBody(['not json at all\n', JSON.stringify({ message: { content: 'ok' } }) + '\n']) } as any);
    const chunks: string[] = [];
    await client.streamChatWithCallback([], (c) => chunks.push(c));
    expect(chunks).to.include('ok');
  });

  it('returns empty string from OpenAI stream with no content delta', async () => {
    const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false);
    const lines = [
      'data: ' + JSON.stringify({ choices: [{ delta: {} }] }) + '\n',
      'data: [DONE]\n',
    ];
    fetchStub.resolves({ ok: true, body: makeStreamBody(lines) } as any);
    const result = await client.streamChatWithCallback([], () => {});
    expect(result).to.equal('');
  });

  it('returns empty array from getAvailableModels when response has no models field', async () => {
    const client = new LocalLLMClient('http://localhost:11434', 'llama3', true);
    fetchStub.resolves({ ok: true, json: async () => ({}) } as any);
    const models = await client.getAvailableModels();
    expect(models).to.be.an('array');
  });

  // --- Auth types (OpenAI-compatible) ---

  describe('authType', () => {
    it('sends Authorization: Bearer header for bearer auth', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false, 'my-key', 'bearer');
      fetchStub.resolves({ ok: true, json: async () => ({ data: [] }) } as any);
      await client.getAvailableModels();
      const headers = fetchStub.lastCall.args[1].headers;
      expect(headers['Authorization']).to.equal('Bearer my-key');
    });

    it('sends x-api-key header for x-api-key auth', async () => {
      const client = new LocalLLMClient('http://localhost:1234', 'gpt-4', false, 'my-key', 'x-api-key');
      fetchStub.resolves({ ok: true, json: async () => ({ data: [] }) } as any);
      await client.getAvailableModels();
      const headers = fetchStub.lastCall.args[1].headers;
      expect(headers['x-api-key']).to.equal('my-key');
      expect(headers['Authorization']).to.be.undefined;
    });

    it('sends no auth header for none auth', async () => {
      const client = new LocalLLMClient('http://localhost:8080', 'local-model', false, undefined, 'none');
      fetchStub.resolves({ ok: true, json: async () => ({ data: [] }) } as any);
      await client.getAvailableModels();
      const headers = fetchStub.lastCall.args[1].headers;
      expect(headers['Authorization']).to.be.undefined;
      expect(headers['x-api-key']).to.be.undefined;
    });

    it('sends no auth header when no key provided', async () => {
      const client = new LocalLLMClient('http://localhost:8080', 'local-model', false);
      fetchStub.resolves({ ok: true, json: async () => ({ data: [] }) } as any);
      await client.getAvailableModels();
      const headers = fetchStub.lastCall.args[1].headers;
      expect(headers['Authorization']).to.be.undefined;
    });
  });

  // --- Anthropic provider ---

  describe('providerFormat: anthropic', () => {
    const anthropicClient = () => new LocalLLMClient('https://api.anthropic.com', 'claude-sonnet-4-5', false, 'sk-ant-key', undefined, 'anthropic');

    it('sends x-api-key and anthropic-version headers', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, json: async () => ({ data: [] }) } as any);
      await client.getAvailableModels();
      const headers = fetchStub.lastCall.args[1].headers;
      expect(headers['x-api-key']).to.equal('sk-ant-key');
      expect(headers['anthropic-version']).to.equal('2023-06-01');
    });

    it('fetches models from /v1/models', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, json: async () => ({ data: [{ id: 'claude-opus-4-5' }, { id: 'claude-sonnet-4-5' }] }) } as any);
      const models = await client.getAvailableModels();
      expect(models).to.deep.equal(['claude-opus-4-5', 'claude-sonnet-4-5']);
      expect(fetchStub.lastCall.args[0]).to.include('/v1/models');
    });

    it('returns fallback model list when /v1/models fails', async () => {
      const client = anthropicClient();
      fetchStub.rejects(new Error('Network error'));
      const models = await client.getAvailableModels();
      expect(models).to.be.an('array').that.is.not.empty;
      expect(models.some((m: string) => m.includes('claude'))).to.be.true;
    });

    it('detects vision and tools capabilities for claude models', async () => {
      const client = anthropicClient();
      const caps = await client.getCapabilities();
      expect(caps.vision).to.be.true;
      expect(caps.tools).to.be.true;
    });

    it('posts to /v1/messages not /v1/chat/completions', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, body: makeStreamBody([]) } as any);
      await client.streamChatWithCallback([{ role: 'user', content: 'hi' }], () => {});
      expect(fetchStub.lastCall.args[0]).to.include('/v1/messages');
      expect(fetchStub.lastCall.args[0]).to.not.include('/v1/chat/completions');
    });

    it('extracts system message to top-level system field', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, body: makeStreamBody([]) } as any);
      const messages: any[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];
      await client.streamChatWithCallback(messages, () => {});
      const body = JSON.parse(fetchStub.lastCall.args[1].body);
      expect(body.system).to.equal('You are a helpful assistant.');
      expect(body.messages.every((m: any) => m.role !== 'system')).to.be.true;
    });

    it('includes max_tokens in request body', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, body: makeStreamBody([]) } as any);
      await client.streamChatWithCallback([{ role: 'user', content: 'hi' }], () => {});
      const body = JSON.parse(fetchStub.lastCall.args[1].body);
      expect(body.max_tokens).to.be.a('number').and.greaterThan(0);
    });

    it('streams content_block_delta text_delta events', async () => {
      const client = anthropicClient();
      const lines = [
        'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }) + '\n',
        'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }) + '\n',
        'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n',
      ];
      fetchStub.resolves({ ok: true, body: makeStreamBody(lines) } as any);
      const chunks: string[] = [];
      const result = await client.streamChatWithCallback([{ role: 'user', content: 'hi' }], (c) => chunks.push(c));
      expect(chunks).to.deep.equal(['Hello', ' world']);
      expect(result).to.equal('Hello world');
    });

    it('ignores non-text-delta SSE events', async () => {
      const client = anthropicClient();
      const lines = [
        'data: ' + JSON.stringify({ type: 'message_start', message: {} }) + '\n',
        'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n',
        'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }) + '\n',
        'data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n',
        'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n',
      ];
      fetchStub.resolves({ ok: true, body: makeStreamBody(lines) } as any);
      const chunks: string[] = [];
      await client.streamChatWithCallback([{ role: 'user', content: 'hi' }], (c) => chunks.push(c));
      expect(chunks).to.deep.equal(['Hi']);
    });

    it('returns content[0].text from non-streaming chat', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hello there' }] }) } as any);
      const result = await client.chat([{ role: 'user', content: 'hi' }]);
      expect(result).to.equal('Hello there');
    });

    it('non-streaming chat also posts to /v1/messages', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } as any);
      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(fetchStub.lastCall.args[0]).to.include('/v1/messages');
    });

    it('formats images in Anthropic source format', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: true, body: makeStreamBody([]) } as any);
      const messages: any[] = [{ role: 'user', content: 'describe this', images: ['abc123'] }];
      await client.streamChatWithCallback(messages, () => {});
      const body = JSON.parse(fetchStub.lastCall.args[1].body);
      const content = body.messages[0].content;
      expect(content).to.be.an('array');
      const imageBlock = content.find((c: any) => c.type === 'image');
      expect(imageBlock).to.exist;
      expect(imageBlock.source.type).to.equal('base64');
      expect(imageBlock.source.data).to.equal('abc123');
    });

    it('throws on non-ok streaming response', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: false, text: async () => '{"error":{"message":"invalid api key"}}' } as any);
      try {
        await client.streamChatWithCallback([{ role: 'user', content: 'hi' }], () => {});
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('invalid api key');
      }
    });

    it('throws on non-ok chat response', async () => {
      const client = anthropicClient();
      fetchStub.resolves({ ok: false, text: async () => 'rate limit exceeded' } as any);
      try {
        await client.chat([{ role: 'user', content: 'hi' }]);
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e.message).to.include('rate limit exceeded');
      }
    });
  });
});

describe('fetchContextLength', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => { fetchStub = sinon.stub(global, 'fetch'); clearCtxEndpointCache(); });
  afterEach(() => { fetchStub.restore(); });

  const showOk = (body: object) => Promise.resolve({ ok: true, json: async () => body } as any);
  const notOk = () => Promise.resolve({ ok: false } as any);
  const throws = () => Promise.reject(new Error('ECONNREFUSED'));

  // --- /api/show (Ollama / LM Studio / LocalAI) ---

  it('reads llama.context_length from /api/show model_info', async () => {
    fetchStub.resolves(showOk({ model_info: { 'llama.context_length': 131072 } }));
    expect(await fetchContextLength('http://localhost:11434', 'gemma4')).to.equal(131072);
  });

  it('reads context_length (alternate key) from /api/show model_info', async () => {
    fetchStub.resolves(showOk({ model_info: { context_length: 32768 } }));
    expect(await fetchContextLength('http://localhost:11434', 'qwen2')).to.equal(32768);
  });

  it('reads num_ctx from /api/show parameters', async () => {
    fetchStub.resolves(showOk({ parameters: { num_ctx: 8192 } }));
    expect(await fetchContextLength('http://localhost:11434', 'llama3')).to.equal(8192);
  });

  // --- /api/v1/models/{model} (LM Studio native — step 2) ---

  it('reads loaded_instances context_length from LM Studio native /api/v1/models list', async () => {
    fetchStub.onFirstCall().resolves(notOk());  // api/show
    fetchStub.onSecondCall().resolves(showOk({
      models: [{ key: 'llava-v1.6', loaded_instances: [{ config: { context_length: 65536 } }], max_context_length: 131072 }]
    }));
    expect(await fetchContextLength('http://localhost:1234', 'llava-v1.6')).to.equal(65536);
  });

  it('reads max_context_length from LM Studio native list when no loaded instances', async () => {
    fetchStub.onFirstCall().resolves(notOk());  // api/show
    fetchStub.onSecondCall().resolves(showOk({
      models: [{ key: 'gemma3', loaded_instances: [], max_context_length: 131072 }]
    }));
    expect(await fetchContextLength('http://localhost:1234', 'gemma3')).to.equal(131072);
  });

  it('matches namespaced model (google/gemma-4-e4b) via key field in LM Studio native list', async () => {
    fetchStub.onFirstCall().resolves(notOk());  // api/show
    fetchStub.onSecondCall().resolves(showOk({
      models: [{ key: 'google/gemma-4-e4b', loaded_instances: [{ config: { context_length: 4096 } }], max_context_length: 131072 }]
    }));
    expect(await fetchContextLength('http://localhost:1234', 'google/gemma-4-e4b')).to.equal(4096);
  });

  // --- /v1/models fallback (LM Studio, OpenAI-compatible — step 3) ---

  it('reads max_context_length from /v1/models when /api/show returns no usable data (LM Studio)', async () => {
    fetchStub.onFirstCall().resolves(showOk({ error: 'Unexpected endpoint' })); // api/show — LM Studio 200 error
    fetchStub.onSecondCall().resolves(notOk());                                  // lmstudio-native
    fetchStub.onThirdCall().resolves(showOk({ data: [{ id: 'gemma-4-26b-a4b-it', max_context_length: 131072 }] }));
    expect(await fetchContextLength('http://localhost:1234', 'gemma-4-26b-a4b-it')).to.equal(131072);
  });

  it('reads context_length from /v1/models when /api/show returns no usable data', async () => {
    fetchStub.onFirstCall().resolves(notOk());
    fetchStub.onSecondCall().resolves(notOk());                                  // lmstudio-native
    fetchStub.onThirdCall().resolves(showOk({ data: [{ id: 'my-model', context_length: 32768 }] }));
    expect(await fetchContextLength('http://localhost:1234', 'my-model')).to.equal(32768);
  });

  it('matches model by short name in /v1/models when full id is namespaced', async () => {
    fetchStub.onFirstCall().resolves(notOk());
    fetchStub.onSecondCall().resolves(notOk());                                  // lmstudio-native
    fetchStub.onThirdCall().resolves(showOk({ data: [{ id: 'lmstudio/gemma-4-26b-a4b-it', max_context_length: 8192 }] }));
    expect(await fetchContextLength('http://localhost:1234', 'gemma-4-26b-a4b-it')).to.equal(8192);
  });

  it('skips /v1/models entry when model id does not match', async () => {
    fetchStub.onFirstCall().resolves(notOk());
    fetchStub.onSecondCall().resolves(notOk());                                  // lmstudio-native
    fetchStub.onThirdCall().resolves(showOk({ data: [{ id: 'other-model', max_context_length: 4096 }] }));
    fetchStub.onCall(3).resolves(notOk());                                       // props
    expect(await fetchContextLength('http://localhost:1234', 'my-model')).to.be.null;
  });

  // --- /props fallback (llama.cpp server / llamafile — step 4) ---

  it('falls back to /props when all earlier probes return no usable data', async () => {
    fetchStub.onFirstCall().resolves(notOk());                           // api/show
    fetchStub.onSecondCall().resolves(notOk());                          // lmstudio-native
    fetchStub.onThirdCall().resolves(notOk());                           // v1/models
    fetchStub.onCall(3).resolves(showOk({ default_generation_settings: { n_ctx: 4096 } }));
    expect(await fetchContextLength('http://localhost:8080', 'model')).to.equal(4096);
  });

  it('falls back to /props when /api/show throws', async () => {
    fetchStub.onFirstCall().rejects(new Error('ECONNREFUSED'));
    fetchStub.onSecondCall().resolves(notOk());                          // lmstudio-native
    fetchStub.onThirdCall().resolves(notOk());                           // v1/models
    fetchStub.onCall(3).resolves(showOk({ default_generation_settings: { n_ctx: 16384 } }));
    expect(await fetchContextLength('http://localhost:8080', 'model')).to.equal(16384);
  });

  it('reads top-level n_ctx from /props', async () => {
    fetchStub.onFirstCall().resolves(notOk());
    fetchStub.onSecondCall().resolves(notOk());                          // lmstudio-native
    fetchStub.onThirdCall().resolves(notOk());                           // v1/models
    fetchStub.onCall(3).resolves(showOk({ n_ctx: 2048 }));
    expect(await fetchContextLength('http://localhost:8080', 'model')).to.equal(2048);
  });

  // --- endpoint caching ---

  it('caches working endpoint and skips probes on second call', async () => {
    // First call: api/show fails, lmstudio-native succeeds → cache 'lmstudio-native'
    const nativeResp = showOk({ models: [{ key: 'model', loaded_instances: [{ config: { context_length: 65536 } }] }] });
    fetchStub.onFirstCall().resolves(notOk());
    fetchStub.onSecondCall().resolves(nativeResp);
    const first = await fetchContextLength('http://localhost:1234', 'model');
    expect(first).to.equal(65536);
    expect(fetchStub.callCount).to.equal(2);
    // Second call: cached → goes directly to lmstudio-native (1 fetch only, not 2)
    fetchStub.onThirdCall().resolves(nativeResp);
    const second = await fetchContextLength('http://localhost:1234', 'model');
    expect(second).to.equal(65536);
    expect(fetchStub.callCount).to.equal(3); // 2 probes first call + 1 cached second call
  });

  it('separate server URLs maintain independent cache entries', async () => {
    // Ollama at :11434 — api/show works
    fetchStub.onFirstCall().resolves(showOk({ model_info: { 'llama.context_length': 4096 } }));
    // LM Studio at :1234 — api/show returns 200+error, native list endpoint works
    fetchStub.onSecondCall().resolves(showOk({ error: 'Unexpected endpoint' }));
    fetchStub.onThirdCall().resolves(showOk({ models: [{ key: 'model', loaded_instances: [{ config: { context_length: 16384 } }] }] }));
    const r1 = await fetchContextLength('http://localhost:11434', 'llama3');
    const r2 = await fetchContextLength('http://localhost:1234', 'model');
    expect(r1).to.equal(4096);
    expect(r2).to.equal(16384);
  });

  // --- all endpoints unavailable ---

  it('returns null when all endpoints fail', async () => {
    fetchStub.rejects(new Error('ECONNREFUSED'));
    expect(await fetchContextLength('https://api.openai.com', 'gpt-4o')).to.be.null;
  });

  it('returns null when all endpoints return non-ok with no usable data', async () => {
    fetchStub.resolves(notOk());
    expect(await fetchContextLength('http://localhost:11434', 'model')).to.be.null;
  });
});
