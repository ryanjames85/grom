// @ts-nocheck
const sinon = require('sinon');

// Mock vscode
const vscodeMock = {
  workspace: {
    getConfiguration: sinon.stub().returns({
      get: (key, def) => def,
    }),
    workspaceFolders: [{ uri: { fsPath: '/test' } }],
    fs: { readFile: sinon.stub(), writeFile: sinon.stub(), createDirectory: sinon.stub(), readDirectory: sinon.stub(), delete: sinon.stub() },
    findFiles: sinon.stub().resolves([]),
    asRelativePath: (uri) => (uri.fsPath || uri || '').replace('/test/', ''),
    openTextDocument: sinon.stub().resolves({}),
  },
  window: {
    activeTextEditor: undefined,
    showTextDocument: sinon.stub(),
    createTerminal: sinon.stub().returns({ show: sinon.stub(), sendText: sinon.stub() }),
  },
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => a.fsPath || a).join('/') }),
    file: (path) => ({ fsPath: path }),
  },
  FileType: { File: 1, Directory: 2 },
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'vscode') return vscodeMock;
  // Stub builtin-tools so it is never cached with this partial mock,
  // allowing builtin-tools.test.ts to load it fresh with its own mock.
  if (id.includes('builtin-tools')) return {
    BUILTIN_TOOLS: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'delete_file' }, { name: 'list_directory' }, { name: 'search_files' }, { name: 'run_terminal' }, { name: 'browse_web' }],
    isBuiltinTool: (name) => ['read_file','write_file','delete_file','list_directory','search_files','run_terminal','browse_web'].includes(name),
    executeBuiltinTool: sinon.stub().resolves('ok'),
  };
  return originalRequire.apply(this, arguments);
};

// @ts-ignore
global.vscode = vscodeMock;

const clientModule = require('../client');
const contextModule = require('../context');
const mcpModule = require('../mcp');
const { AgentLoop } = require('../agent-loop');

let expect;

describe('AgentLoop', () => {
  let deps;
  let loop;
  let clientStub;

  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  beforeEach(() => {
    deps = {
      mcp: {
        getAllTools: sinon.stub().returns([]),
        callTool: sinon.stub(),
        waitForReady: sinon.stub().resolves(),
        isReady: sinon.stub().returns(true),
      },
      rag: {
        isIndexed: sinon.stub().returns(false),
        queryAsync: sinon.stub().resolves(''),
      },
      docs: {
        getSources: sinon.stub().returns([]),
        query: sinon.stub().returns(''),
      },
      postMessage: sinon.stub(),
      requestApproval: sinon.stub().resolves('allow'),
      appendTaskLog: sinon.stub(),
      getMemory: sinon.stub().returns(''),
    };

    loop = new AgentLoop(deps);

    // Mock LocalLLMClient
    clientStub = sinon.createStubInstance(clientModule.LocalLLMClient);
    sinon.stub(clientModule, 'LocalLLMClient').returns(clientStub);

    // Mock context helpers
    sinon.stub(contextModule, 'resolveWebSearch').resolves(null);
    sinon.stub(contextModule, 'resolveSlashCommand').callsFake(async (t) => t);
    sinon.stub(contextModule, 'findRelevantContext').resolves('');
    sinon.stub(contextModule, 'resolveMentions').resolves('');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('runs a simple chat flow without tools', async () => {
    const session = {
      id: 's1',
      history: [],
      tokens: { input: 0, output: 0 },
      mode: 'plan',
    };

    clientStub.streamChatWithCallback.callsFake(async (msgs, onChunk) => {
      onChunk('Hello from AI');
      return 'Hello from AI';
    });

    await loop.run('Hi', undefined, 'plan', session, () => {}, () => {});

    expect(deps.postMessage.calledWith(sinon.match({ type: 'chunk', text: 'Hello from AI' }))).to.be.true;
    expect(session.history).to.have.lengthOf(2);
  });

  it('handles tool calls in build mode', async () => {
    const session = {
      id: 's1',
      history: [],
      tokens: { input: 0, output: 0 },
      mode: 'build',
    };

    const toolCallJson = '{"tool": "read_file", "args": {"path": "test.ts"}}';
    clientStub.streamChatWithCallback.onFirstCall().callsFake(async (msgs, onChunk) => {
      onChunk(toolCallJson);
      return toolCallJson;
    });
    clientStub.streamChatWithCallback.onSecondCall().callsFake(async (msgs, onChunk) => {
      onChunk('I read the file.');
      return 'I read the file.';
    });

    sinon.stub(mcpModule, 'parseToolCall')
      .onFirstCall().returns({ tool: 'read_file', args: { path: 'test.ts' }, raw: toolCallJson })
      .onSecondCall().returns(null);

    await loop.run('Read test.ts', undefined, 'build', session, () => {}, () => {});

    expect(deps.postMessage.calledWith(sinon.match({ type: 'toolCall', tool: 'read_file' }))).to.be.true;
    expect(deps.appendTaskLog.calledOnce).to.be.true;
  });

  it('asks for approval for destructive tools', async () => {
    const session = {
      id: 's1',
      history: [],
      tokens: { input: 0, output: 0 },
      mode: 'build',
    };

    const toolCallJson = '{"tool": "write_file", "args": {"path": "test.ts", "content": "hi"}}';
    clientStub.streamChatWithCallback.onFirstCall().callsFake(async (msgs, onChunk) => {
      onChunk(toolCallJson);
      return toolCallJson;
    });
    clientStub.streamChatWithCallback.onSecondCall().callsFake(async (msgs, onChunk) => {
      onChunk('File written.');
      return 'File written.';
    });

    sinon.stub(mcpModule, 'parseToolCall')
      .onFirstCall().returns({ tool: 'write_file', args: { path: 'test.ts', content: 'hi' }, raw: toolCallJson })
      .onSecondCall().returns(null);

    await loop.run('Write file', undefined, 'build', session, () => {}, () => {});

    expect(deps.requestApproval.calledOnce).to.be.true;
    expect(deps.postMessage.calledWith(sinon.match({ type: 'toolCall', tool: 'write_file' }))).to.be.true;
  });

  it('denies tool execution if user rejects', async () => {
    const session = {
      id: 's1',
      history: [],
      tokens: { input: 0, output: 0 },
      mode: 'build',
    };

    const toolCallJson = '{"tool": "write_file", "args": {"path": "test.ts", "content": "hi"}}';
    clientStub.streamChatWithCallback.onFirstCall().callsFake(async (msgs, onChunk) => {
      onChunk(toolCallJson);
      return toolCallJson;
    });
    clientStub.streamChatWithCallback.onSecondCall().callsFake(async (msgs, onChunk) => {
      onChunk('Okay, I wont write it.');
      return 'Okay, I wont write it.';
    });

    sinon.stub(mcpModule, 'parseToolCall')
      .onFirstCall().returns({ tool: 'write_file', args: { path: 'test.ts', content: 'hi' }, raw: toolCallJson })
      .onSecondCall().returns(null);

    deps.requestApproval.resolves('deny');

    await loop.run('Write file', undefined, 'build', session, () => {}, () => {});

    expect(deps.requestApproval.calledOnce).to.be.true;
    expect(deps.postMessage.calledWith(sinon.match({ type: 'toolDenied', tool: 'write_file' }))).to.be.true;
  });

  it('nudges the model if it writes prose instead of a tool call in build mode', async () => {
    const session = {
      id: 's1',
      history: [],
      tokens: { input: 0, output: 0 },
      mode: 'build',
    };

    const toolCallJson = '{"tool": "read_file", "args": {"path": "test.ts"}}';
    clientStub.streamChatWithCallback.onFirstCall().callsFake(async (msgs, onChunk) => {
      onChunk('I should probably use a tool.');
      return 'I should probably use a tool.';
    });
    clientStub.streamChatWithCallback.onSecondCall().callsFake(async (msgs, onChunk) => {
      onChunk(toolCallJson);
      return toolCallJson;
    });
    clientStub.streamChatWithCallback.onThirdCall().callsFake(async (msgs, onChunk) => {
      onChunk('Done.');
      return 'Done.';
    });

    sinon.stub(mcpModule, 'parseToolCall')
      .onFirstCall().returns(null)
      .onSecondCall().returns({ tool: 'read_file', args: { path: 'test.ts' }, raw: toolCallJson })
      .onThirdCall().returns(null);

    await loop.run('Read file', undefined, 'build', session, () => {}, () => {});

    expect(clientStub.streamChatWithCallback.callCount).to.equal(3);
  });

  it('suppresses built-in tools in Plan mode even if model is tool-capable', async () => {
    const session = { id: 's1', history: [], tokens: { input: 0, output: 0 }, mode: 'plan' };
    
    // Model tries to call a tool (read_file) even though it shouldn't have been told about it
    const toolCallJson = '{"tool": "read_file", "args": {"path": "test.ts"}}';
    clientStub.streamChatWithCallback.resolves(toolCallJson);

    await loop.run('Read file', undefined, 'plan', session, () => {}, () => {});

    // In Plan mode with no MCP tools, the prompt should NOT contain tool instructions,
    // and the system should have ignored the tool call (treated it as prose).
    expect(deps.appendTaskLog.called).to.be.false;
  });
});
