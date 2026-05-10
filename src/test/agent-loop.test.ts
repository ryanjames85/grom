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

describe('findRelevantContext', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  beforeEach(() => {
    vscodeMock.workspace.findFiles.reset();
    vscodeMock.workspace.findFiles.resolves([]);
    vscodeMock.workspace.fs.readFile.reset();
    vscodeMock.workspace.fs.readFile.resolves(Buffer.from('file content'));
  });

  it('ignores words shorter than 6 characters', async () => {
    await contextModule.findRelevantContext('fix the bug with item view', new Set());
    expect(vscodeMock.workspace.findFiles.called).to.be.false;
  });

  it('searches for words of 6+ characters', async () => {
    await contextModule.findRelevantContext('refactor the controller', new Set());
    expect(vscodeMock.workspace.findFiles.called).to.be.true;
  });

  it('skips files with non-source extensions', async () => {
    vscodeMock.workspace.findFiles.resolves([
      { fsPath: '/project/build/foo.obj' },
      { fsPath: '/project/build/bar.tlog' },
      { fsPath: '/project/.dart_tool/package.transitive_digest' },
      { fsPath: '/project/build/app.snapshot' },
      { fsPath: '/project/somefile.unknown_future_artifact' },
    ]);
    const used = new Set();
    const result = await contextModule.findRelevantContext('refactor controller', used);
    expect(used.size).to.equal(0);
    expect(result).to.equal('');
    expect(vscodeMock.workspace.fs.readFile.called).to.be.false;
  });

  it('includes source files that match', async () => {
    vscodeMock.workspace.findFiles.resolves([{ fsPath: '/project/src/shopping_controller.dart' }]);
    const used = new Set();
    const result = await contextModule.findRelevantContext('fix the shopping controller', used);
    expect(used.has('shopping_controller.dart')).to.be.true;
    expect(result).to.include('shopping_controller.dart');
  });

  it('deduplicates files across multiple word matches', async () => {
    vscodeMock.workspace.findFiles.resolves([{ fsPath: '/project/src/shopping_controller.dart' }]);
    const used = new Set();
    await contextModule.findRelevantContext('shopping controller refactor', used);
    expect(used.size).to.equal(1);
    expect(vscodeMock.workspace.fs.readFile.callCount).to.equal(1);
  });
});

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
      agentEnabled: true,
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
      agentEnabled: true,
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
      agentEnabled: true,
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
      agentEnabled: true,
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

  it('returns a direct response for sentinel-prefixed slash commands without calling the model', async () => {
    contextModule.resolveSlashCommand.resolves('\x00No uncommitted changes to commit.');

    const session = { id: 's1', history: [], tokens: { input: 0, output: 0 }, mode: 'plan' };
    const saveState = sinon.stub();
    await loop.run('/commit', undefined, 'plan', session, saveState, () => {});

    expect(deps.postMessage.calledWith(sinon.match({ type: 'chunk', text: 'No uncommitted changes to commit.' }))).to.be.true;
    expect(deps.postMessage.calledWith(sinon.match({ type: 'status', text: 'Ready' }))).to.be.true;
    expect(clientStub.streamChatWithCallback.called).to.be.false;
    expect(session.history).to.have.lengthOf(1);
    expect(session.history[0].content).to.equal('/commit');
    expect(saveState.called).to.be.true;
  });

  it('filesUsed message only contains explicit @-mentioned files, not auto-context files', async () => {
    const session = { id: 's1', history: [], tokens: { input: 0, output: 0 }, mode: 'plan' };

    // Auto-context finds a file by word-match
    contextModule.findRelevantContext.callsFake(async (text, usedFiles) => {
      usedFiles.add('auto_matched.dart');
      return '[File: auto_matched.dart]\nsome content\n\n';
    });
    // Manual @mention resolves one file
    contextModule.resolveMentions.callsFake(async (text, usedFiles) => {
      usedFiles.add('explicitly_mentioned.dart');
      return '[File: explicitly_mentioned.dart]\nsome content\n\n';
    });

    clientStub.streamChatWithCallback.callsFake(async (msgs, onChunk) => {
      onChunk('Done.');
      return 'Done.';
    });

    await loop.run('fix @explicitly_mentioned.dart', undefined, 'plan', session, () => {}, () => {});

    const filesUsedCall = deps.postMessage.getCalls().find(c => c.args[0]?.type === 'filesUsed');
    expect(filesUsedCall).to.exist;
    const names = filesUsedCall.args[0].files.map(f => f.name);
    expect(names).to.include('explicitly_mentioned.dart');
    expect(names).to.not.include('auto_matched.dart');
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
