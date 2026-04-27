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
    fetchStub.resolves({ ok: true, json: async () => ({ model_info: { 'qwen.vision': true, 'qwen.tools': true } }) } as any);
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
});
