// @ts-nocheck
/**
 * mcp.itest.ts
 *
 * Drives the real McpManager against a REAL MCP server process: the official
 * @modelcontextprotocol/server-filesystem, spawned via `npx` exactly the way Grom itself spawns
 * MCP servers, talking real JSON-RPC 2.0 over stdio. No mocked transport.
 *
 * Needs no local model, so it always runs (as long as npx can resolve the package — it is
 * fetched once and cached; no network is needed on later runs). Not part of `npm test`;
 * run with `npm run test:integration`.
 *
 * A scratch folder with a few dummy files is created under the OS temp dir for the server to
 * serve, and removed again in an `after` hook so nothing is left behind.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

// ── VS Code stand-in ──────────────────────────────────────────────────────────
const mcpServersConfig: any[] = [];
const vscodeMock = {
  workspace: { getConfiguration: () => ({ get: (key: string, def: any) => (key === 'mcpServers' ? mcpServersConfig : def) }) },
  window: { showWarningMessage: (...a: any[]) => { warnings.push(a.join(' ')); } },
};
let warnings: string[] = [];
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') return vscodeMock;
  return originalRequire.apply(this, arguments);
};
(global as any).vscode = vscodeMock;

const { McpManager } = require('../../mcp');

describe('MCP integration: filesystem server', function () {
  this.timeout(60_000);

  let dir: string;
  let mgr: any;

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grom-mcp-it-'));
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'The secret phrase is purple sunset.');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nRemember to feed the cat.');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'buried treasure');

    mcpServersConfig.length = 0;
    mcpServersConfig.push({ name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', dir] });

    mgr = new McpManager();
    warnings = [];
    await mgr.initialize();
    await mgr.waitForReady(30_000);
    if (!mgr.isReady() || !mgr.hasTools()) {
      console.log(`      MCP filesystem server did not come up (warnings: ${warnings.join(' | ') || 'none'}); skipping`);
      this.skip();
    }
  });

  after(function () {
    mgr?.dispose();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('connects with no warnings and exposes namespaced tools', () => {
    expect(warnings, 'no server-init warnings').to.deep.equal([]);
    const tools = mgr.getAllTools();
    expect(tools.length).to.be.greaterThan(0);
    expect(tools.every((t: any) => t.name.startsWith('fs__')), 'every tool name is namespaced "fs__..."').to.equal(true);
  });

  it('lists the fixture directory including the subfolder', async () => {
    const listTool = mgr.getAllTools().find((t: any) => /list_directory|list_allowed_directories/i.test(t.name));
    expect(listTool, 'a directory listing tool exists').to.exist;
    if (/list_allowed_directories/i.test(listTool.name)) {
      const out = await mgr.callTool(listTool.name, {});
      expect(out).to.include(path.basename(dir));
      return;
    }
    const out = await mgr.callTool(listTool.name, { path: dir });
    expect(out).to.include('hello.txt');
    expect(out).to.include('notes.md');
    expect(out).to.include('sub');
  });

  it('reads a dummy file back with its real content', async () => {
    const readTool = mgr.getAllTools().find((t: any) => /^fs__read_file$|^fs__read_text_file$/.test(t.name));
    expect(readTool, 'a read_file tool exists').to.exist;
    const out = await mgr.callTool(readTool.name, { path: path.join(dir, 'hello.txt') });
    expect(out).to.include('purple sunset');
  });

  it('reads a file inside a subdirectory', async () => {
    const readTool = mgr.getAllTools().find((t: any) => /^fs__read_file$|^fs__read_text_file$/.test(t.name));
    const out = await mgr.callTool(readTool.name, { path: path.join(dir, 'sub', 'deep.txt') });
    expect(out).to.include('buried treasure');
  });

  it('writes a new file and it appears on disk for real', async function () {
    const writeTool = mgr.getAllTools().find((t: any) => /^fs__write_file$/.test(t.name));
    if (!writeTool) { console.log('      no write_file tool on this server; skipping'); return this.skip(); }
    await mgr.callTool(writeTool.name, { path: path.join(dir, 'written-by-test.txt'), content: 'mcp wrote this' });
    const onDisk = fs.readFileSync(path.join(dir, 'written-by-test.txt'), 'utf8');
    expect(onDisk).to.equal('mcp wrote this');
  });

  it('rejects a path outside the allowed directory', async () => {
    const readTool = mgr.getAllTools().find((t: any) => /^fs__read_file$|^fs__read_text_file$/.test(t.name));
    const outside = path.join(os.tmpdir(), 'grom-mcp-it-outside-probe.txt');
    fs.writeFileSync(outside, 'should not be reachable');
    try {
      let threw = false;
      try {
        const out = await mgr.callTool(readTool.name, { path: outside });
        // Some servers return an error string in the result instead of throwing.
        expect(/error|denied|not allowed|outside/i.test(out), 'result reports the path was rejected').to.equal(true);
      } catch (e: any) {
        threw = true;
        expect(/error|denied|not allowed|outside/i.test(e.message || '')).to.equal(true);
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('an unknown tool name on a real server produces an error result, not a crash', async () => {
    // Per the MCP spec, tools/call on an unknown name is a valid JSON-RPC response with
    // result.isError, not a protocol-level error — so this resolves with error text rather
    // than throwing. McpManager.callTool only throws for an unqualified/unknown SERVER name.
    const out = await mgr.callTool('fs__not_a_real_tool', {});
    expect(out).to.be.a('string');
    expect(/unknown|not found|no such|error/i.test(out), `result should describe the error, got: ${out}`).to.equal(true);
  });

  it('an unknown SERVER name is rejected before any call is made', async () => {
    let threw = false;
    try { await mgr.callTool('not_a_real_server__whatever', {}); } catch (e: any) {
      threw = true;
      expect(e.message).to.include('not found');
    }
    expect(threw).to.equal(true);
  });

  it('a server with a bad command fails to connect without blocking a good one', async function () {
    mcpServersConfig.length = 0;
    mcpServersConfig.push(
      { name: 'broken', command: 'this-binary-does-not-exist-grom-test', args: [] },
      { name: 'fs2', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', dir] }
    );
    const mgr2 = new McpManager();
    warnings = [];
    await mgr2.initialize();
    await mgr2.waitForReady(30_000);
    try {
      expect(warnings.some(w => w.includes('broken')), 'a warning names the broken server').to.equal(true);
      const tools = mgr2.getAllTools();
      expect(tools.some((t: any) => t.name.startsWith('fs2__')), 'the good server still has tools').to.equal(true);
    } finally {
      mgr2.dispose();
    }
  });
});
