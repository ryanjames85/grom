import { expect } from 'chai';
import * as sinon from 'sinon';

(global as any).vscode = { window: {}, workspace: {} };

import { LocalLLMClient } from '../client';

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
