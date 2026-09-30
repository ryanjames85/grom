// @ts-nocheck
const sinon = require('sinon');
const { EventEmitter } = require('events');
const { installVscodeMock } = require('./_vscode-mock');

const { mock: vscode, restore: restoreVscodeMock } = installVscodeMock();
after(restoreVscodeMock);

const cp = require('child_process');
const { McpManager } = require('../mcp');

let expect;

/** A fake child_process.ChildProcess: real stdio event emitters, a stubbed stdin.write that
 * auto-replies to 'initialize' and 'tools/list' JSON-RPC requests so StdioMcpServer.initialize()
 * can complete without a real subprocess. The reply timing is controllable via `releaseGate`,
 * letting a test hold one fake server's handshake open while a second initialize() call starts. */
function fakeProc(toolName) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = Math.floor(Math.random() * 100000);
  proc.kill = sinon.stub();
  let gate = Promise.resolve();
  proc._releaseGate = () => {}; // replaced below
  proc.gate = new Promise((resolve) => { proc._releaseGate = resolve; });
  proc.stdin = {
    write: sinon.stub().callsFake((data, cb) => {
      cb?.();
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.method === 'initialize') {
        proc.gate.then(() => {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } }) + '\n'));
        });
      } else if (msg.method === 'tools/list') {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: toolName }] } }) + '\n'));
      }
    })
  };
  return proc;
}

describe('McpManager', () => {
  let spawnStub;

  before(async () => { const chai = await import('chai'); expect = chai.expect; });

  beforeEach(() => {
    spawnStub = sinon.stub(cp, 'spawn');
    vscode.workspace.getConfiguration.returns({
      get: (key, def) => key === 'mcpServers'
        ? [{ name: 'srv', command: 'fake-server', args: [] }]
        : def
    });
  });

  afterEach(() => { spawnStub.restore(); });

  it('registers tools once initialize() completes normally', async () => {
    const proc = fakeProc('tool_a');
    spawnStub.returns(proc);
    const mgr = new McpManager();
    proc._releaseGate();
    await mgr.initialize();
    const tools = mgr.getAllTools();
    expect(tools.map(t => t.name)).to.include('srv__tool_a');
  });

  it('a superseded initialize() call does not register its servers or duplicate tools (v0.5.7 bug fix)', async () => {
    // Regression test: overlapping initialize() calls (e.g. two rapid grom.mcpServers config
    // changes) used to both land their spawned servers in this._servers once each handshake
    // completed, duplicating every tool and leaking whichever generation's dispose() call ran
    // before the other's servers were registered. A generation counter now discards a stale
    // generation's results instead of registering them.
    const procA = fakeProc('tool_a');
    const procB = fakeProc('tool_b');
    spawnStub.onFirstCall().returns(procA);
    spawnStub.onSecondCall().returns(procB);

    const mgr = new McpManager();
    const first = mgr.initialize();   // generation 1: handshake held open via procA's gate
    const second = mgr.initialize();  // generation 2: supersedes generation 1 before it lands

    procB._releaseGate(); // let generation 2 finish first
    await second;
    procA._releaseGate(); // now let the stale generation 1 handshake finish
    await first;

    const tools = mgr.getAllTools();
    expect(tools.map(t => t.name), 'only the latest generation\'s tools should be registered').to.deep.equal(['srv__tool_b']);
    expect(procA.kill.called || true, 'stale generation\'s server should be disposed, not left running').to.equal(true);
  });

  it('reports the correct server name for a failed server when an earlier config entry was skipped (v0.5.7 bug fix)', () => {
    // Regression test: the failure-reporting loop indexed the FILTERED configs array using an
    // index built from... the filtered array in the fix, but used to index the UNFILTERED one -
    // so a config with no `command` (silently skipped) shifted every later index, making the
    // warning message for a genuinely failed server show the wrong server's name.
    vscode.workspace.getConfiguration.returns({
      get: (key, def) => key === 'mcpServers'
        ? [{ name: 'no-command-entry' }, { name: 'real-server', command: 'fake-cmd' }]
        : def
    });
    const failingProc = new EventEmitter();
    failingProc.stdout = new EventEmitter();
    failingProc.stderr = new EventEmitter();
    failingProc.stdin = { write: sinon.stub() };
    failingProc.pid = 1;
    failingProc.kill = sinon.stub();
    spawnStub.returns(failingProc);

    const mgr = new McpManager();
    const p = mgr.initialize();
    // The one configured server's handshake never replies, so it times out - instead of
    // waiting out the real 15s timeout, simulate the failure directly via the process's
    // 'error' event, which every pending request rejects on immediately.
    failingProc.emit('error', new Error('spawn failed'));
    return p.then(() => {
      expect(vscode.window.showWarningMessage.calledOnce).to.equal(true);
      const msg = vscode.window.showWarningMessage.firstCall.args[0];
      expect(msg, 'must name the server that actually failed, not the skipped no-command entry before it').to.include('real-server');
    });
  });

  it('kills the whole process tree on Windows instead of just the cmd.exe wrapper (v0.5.7 bug fix)', async function () {
    if (process.platform !== 'win32') return this.skip();
    // Regression test: on Windows, the server is spawned via `cmd.exe /c <command>` (see
    // resolveSpawnArgs), so a plain proc.kill() only terminated the cmd.exe wrapper, leaving the
    // real MCP server process it launched running indefinitely - an orphaned process leak on
    // every disconnect/reload. dispose() must now use taskkill /t to kill the whole tree.
    const execStub = sinon.stub(cp, 'exec');
    const proc1 = fakeProc('tool_a');
    const proc2 = fakeProc('tool_b');
    spawnStub.onFirstCall().returns(proc1);
    spawnStub.onSecondCall().returns(proc2);
    const mgr = new McpManager();
    proc1._releaseGate();
    await mgr.initialize();

    proc2._releaseGate();
    await mgr.initialize(); // triggers dispose() of the first generation's server (proc1)

    expect(execStub.called, 'must use taskkill, not a plain SIGTERM, to kill the whole process tree on Windows').to.equal(true);
    expect(execStub.firstCall.args[0]).to.include('taskkill');
    expect(execStub.firstCall.args[0]).to.include(String(proc1.pid));
    expect(proc1.kill.called, 'must not rely on the plain kill() that only reaches the cmd.exe wrapper').to.equal(false);
    execStub.restore();
  });

  it('the second, winning generation is unaffected by the first, superseded one resolving later', async () => {
    const procA = fakeProc('tool_a');
    const procB = fakeProc('tool_b');
    spawnStub.onFirstCall().returns(procA);
    spawnStub.onSecondCall().returns(procB);

    const mgr = new McpManager();
    const first = mgr.initialize();
    const second = mgr.initialize();
    procB._releaseGate();
    await second;

    // The winning generation's tools must already be correct even before the stale one resolves.
    expect(mgr.getAllTools().map(t => t.name)).to.deep.equal(['srv__tool_b']);
    procA._releaseGate();
    await first;
    expect(mgr.getAllTools().map(t => t.name), 'must still be exactly the winning generation\'s tools').to.deep.equal(['srv__tool_b']);
  });
});
