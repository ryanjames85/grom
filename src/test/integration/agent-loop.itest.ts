// @ts-nocheck
/**
 * agent-loop.itest.ts
 *
 * Drives the real AgentLoop against a real local model that is ALREADY loaded (see discover.ts).
 * VS Code is replaced by a small stand-in and the file/terminal tools are stubbed, so nothing
 * touches disk and every approval prompt is answered "deny". Not part of `npm test`; run with
 * `npm run test:integration`.
 *
 * Small models do not always follow tool instructions. A missed tool call is logged, and only
 * fails the run when GROM_IT_STRICT_TOOLS=1. Structural checks (history shape, Ready message,
 * abort behaviour) are always enforced.
 *
 * Time limits come from timeouts.ts, scaled by how the discovered model behaves; see that file
 * for GROM_IT_TIMEOUT_SCALE / GROM_IT_TIMEOUT_MS. GROM_IT_ONLY=ollama or lmstudio (see discover.ts)
 * runs just one server, for a machine that can only hold one model in memory at a time.
 */

const sinon = require('sinon');
const { expect } = require('chai');

// ── VS Code stand-in, installed before any Grom module is loaded ─────────────
const overrides: Record<string, any> = {};
const vscodeMock = {
  workspace: {
    getConfiguration: () => ({ get: (key: string, def: any) => (key in overrides ? overrides[key] : def) }),
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    fs: { readFile: async () => Buffer.from(''), writeFile: async () => {}, createDirectory: async () => {}, readDirectory: async () => [], delete: async () => {} },
    findFiles: async () => [],
    asRelativePath: (u: any) => String(u?.fsPath ?? u),
    openTextDocument: async () => ({}),
  },
  window: { activeTextEditor: undefined, showTextDocument: () => {}, createTerminal: () => ({ show: () => {}, sendText: () => {} }) },
  Uri: { joinPath: (...a: any[]) => ({ fsPath: a.map(x => x.fsPath || x).join('/') }), file: (p: string) => ({ fsPath: p }) },
  FileType: { File: 1, Directory: 2 },
};
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'vscode') return vscodeMock;
  return originalRequire.apply(this, arguments);
};
(global as any).vscode = vscodeMock;

const builtinTools = require('../../builtin-tools');
const { AgentLoop } = require('../../agent-loop');
const { LocalLLMClient } = require('../../client');
const { getReasoningControl } = require('../../model-caps');
const { SERVERS, pickLoadedModel } = require('./discover');
const { timeoutFor } = require('./timeouts');

const STRICT_TOOLS = process.env.GROM_IT_STRICT_TOOLS === '1';
const SECRET_FILE = 'The secret code is 7-4-2.';
const stripThink = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');

/** Records request bodies sent through fetch while still reaching the real server. */
async function withFetchSpy<T>(fn: (bodies: any[]) => Promise<T>): Promise<T> {
  const bodies: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (init?.body && typeof init.body === 'string') { try { bodies.push(JSON.parse(init.body)); } catch { /* not JSON */ } }
    return orig(input, init);
  }) as typeof fetch;
  try { return await fn(bodies); } finally { globalThis.fetch = orig; }
}

let sessionSeq = 0;
const newSession = (mode: 'plan' | 'build', tools: boolean) => ({
  id: `it-${++sessionSeq}`, title: 'Untitled', history: [], tokens: { input: 0, output: 0 },
  lastModified: Date.now(), mode, agentEnabled: tools
});

for (const server of SERVERS) {
  describe(`agent loop integration: ${server.name}`, function () {
    this.timeout(240_000);

    let model = '';
    let toolsCapable = false;
    let control = 'none';
    let msgs: any[];
    let loop: any;
    let approvals: any[];
    let toolCalls: Array<{ name: string; args: any }>;
    let taskLog: any[];

    const chunkText = () => msgs.filter(m => m.type === 'chunk').map(m => m.text).join('');
    const readyFor = (id: string) => msgs.filter(m => m.type === 'status' && m.text === 'Ready' && m.sessionId === id);

    before(async function () {
      const picked = await pickLoadedModel(server);
      if ('skip' in picked) { console.log(`      [${server.name}] ${picked.skip}; skipping`); this.skip(); }
      model = picked.model;
      const caps = await new LocalLLMClient(server.url, model, server.useOllamaFormat).getCapabilities();
      toolsCapable = caps.tools;
      control = getReasoningControl(model, caps.reasoning);
      console.log(`      [${server.name}] using loaded model=${model} tools=${caps.tools} control=${control}`);
    });

    beforeEach(function () {
      // Limit depends on what the test does and how the discovered model behaves (see timeouts.ts).
      this.currentTest.timeout(timeoutFor(this.currentTest.title, control));
      Object.keys(overrides).forEach(k => delete overrides[k]);
      Object.assign(overrides, {
        apiUrl: server.url, model, useOllamaFormat: server.useOllamaFormat,
        agentEnabled: true, agentMaxIterations: 4,
        // Off keeps Qwen3 fast (/no_think) and is ignored by models without a control.
        reasoningEffort: 'off', showReasoningToggle: true,
      });
      msgs = []; approvals = []; toolCalls = []; taskLog = [];
      sinon.restore();
      sinon.stub(builtinTools, 'executeBuiltinTool').callsFake(async (name: string, args: any) => {
        toolCalls.push({ name, args });
        return name === 'read_file' ? SECRET_FILE : `Error: ${name} is disabled in the integration test`;
      });
      loop = new AgentLoop({
        mcp: { getAllTools: () => [], callTool: async () => '', waitForReady: async () => {}, isReady: () => true },
        postMessage: (m: any) => msgs.push(m),
        requestApproval: async (id: string, tool: string, args: any) => { approvals.push({ tool, args }); return 'deny'; },
        appendTaskLog: (sid: string, tool: string, args: any, result: string) => taskLog.push({ sid, tool, args, result }),
        getMemory: () => '',
      });
    });

    // A test that times out leaves its request running. Abort it so it cannot keep the model busy
    // and bleed into the next test.
    afterEach(() => { loop?.silentAbort(); sinon.restore(); });

    const run = (session: any, text: string) =>
      loop.run(text, undefined, session.mode, session, () => {}, () => {});

    /** Every assistant message with tool_calls must be followed by a tool message, or providers reject the next turn. */
    const expectValidToolShape = (history: any[]) => {
      history.forEach((m, i) => {
        if (m.role === 'assistant' && m.tool_calls?.length) expect(history[i + 1]?.role, `tool result after assistant tool_calls at ${i}`).to.equal('tool');
      });
    };

    it('plain chat streams a reply and reports Ready for its own session', async () => {
      const s = newSession('build', false);
      await run(s, 'Reply with exactly one word: pong');
      expect(stripThink(chunkText()).trim().length, 'visible reply').to.be.greaterThan(0);
      expect(chunkText()).to.not.include('**Error:**');
      expect(readyFor(s.id).length).to.be.greaterThan(0);
      expect(s.history.some((m: any) => m.role === 'user' && m.content.includes('pong'))).to.equal(true);
    });

    it('thinking blocks that stream are opened and closed', async () => {
      const s = newSession('build', false);
      await run(s, 'What is 12 + 30?');
      const text = chunkText();
      const opens = (text.match(/<think>/g) || []).length;
      const closes = (text.match(/<\/think>/g) || []).length;
      expect(closes, 'every <think> is closed').to.equal(opens);
    });

    it('plan mode never runs tools even when Tools is on', async () => {
      const s = newSession('plan', true);
      await run(s, 'Read the file notes.txt and tell me the secret code.');
      expect(toolCalls).to.have.length(0);
      expect(readyFor(s.id).length).to.be.greaterThan(0);
    });

    it('build mode with Tools on completes a tool round trip', async function () {
      if (!toolsCapable && !STRICT_TOOLS) console.log(`      [${server.name}] ${model} does not advertise tools; the heuristic path is being tried`);
      // A hint-only model has no way to shorten its thinking, and every reprompt round repeats it.
      // Two rounds is enough to prove the tool actually gets called.
      overrides.agentMaxIterations = 3;
      const s = newSession('build', true);
      await run(s, 'Use the read_file tool to read notes.txt, then tell me the secret code written in it.');

      expect(chunkText()).to.not.include('**Error:**');
      expect(readyFor(s.id).length).to.be.greaterThan(0);
      expectValidToolShape(s.history);

      const read = toolCalls.find(c => c.name === 'read_file');
      if (!read) {
        const note = `[${server.name}] ${model} answered without calling read_file`;
        if (STRICT_TOOLS) expect.fail(note);
        console.log(`      ${note}`);
        return;
      }
      expect(String(read.args?.path ?? '')).to.include('notes.txt');
      expect(taskLog.some(t => t.tool === 'read_file' && t.sid === s.id), 'tool call logged to the session task log').to.equal(true);
      const answer = stripThink(chunkText());
      const mentionsSecret = /7\s*-?\s*4\s*-?\s*2/.test(answer);
      if (!mentionsSecret) {
        const note = `[${server.name}] ${model} read the file but did not repeat the code`;
        if (STRICT_TOOLS) expect.fail(note);
        console.log(`      ${note}`);
      }
    });

    it('a destructive tool is never executed when approval is denied', async function () {
      // After a denial the model tends to retry, and each round is slow on small hardware.
      // Two rounds is enough to prove the write is never executed.
      overrides.agentMaxIterations = 2;
      const s = newSession('build', true);
      await run(s, 'Create a file called hello.txt containing the word hi. Use the write_file tool.');
      const wrote = toolCalls.filter(c => c.name === 'write_file');
      expect(wrote, 'write_file must not run without approval').to.have.length(0);
      expectValidToolShape(s.history);
      expect(readyFor(s.id).length).to.be.greaterThan(0);
    });

    it('abort mid-stream posts *Cancelled.*, settles quickly and leaves valid history', async () => {
      const s = newSession('build', false);
      let abortedAt = 0;
      const orig = loop.deps.postMessage;
      loop.deps.postMessage = (m: any) => {
        orig(m);
        if (m.type === 'chunk' && !abortedAt) { abortedAt = Date.now(); loop.abort(); }
      };
      await run(s, 'Write the numbers from 1 to 3000 separated by commas.');
      const settledIn = Date.now() - abortedAt;
      expect(abortedAt, 'a chunk arrived to abort on').to.be.greaterThan(0);
      expect(settledIn, 'ms from abort() to run() returning').to.be.lessThan(10_000);
      expect(chunkText()).to.include('*Cancelled.*');
      expectValidToolShape(s.history);
      expect(readyFor(s.id).length).to.be.greaterThan(0);
    });

    it('silentAbort stops the run without a *Cancelled.* message', async () => {
      const s = newSession('build', false);
      let aborted = false;
      const orig = loop.deps.postMessage;
      loop.deps.postMessage = (m: any) => {
        orig(m);
        if (m.type === 'chunk' && !aborted) { aborted = true; loop.silentAbort(); }
      };
      await run(s, 'Write the numbers from 1 to 3000 separated by commas.');
      expect(aborted).to.equal(true);
      expect(chunkText()).to.not.include('*Cancelled.*');
    });

    it('the next message works after an aborted one on the same session', async () => {
      const s = newSession('build', false);
      let aborted = false;
      const orig = loop.deps.postMessage;
      loop.deps.postMessage = (m: any) => {
        orig(m);
        if (m.type === 'chunk' && !aborted) { aborted = true; loop.abort(); }
      };
      await run(s, 'Write the numbers from 1 to 3000 separated by commas.');
      loop.deps.postMessage = orig;
      msgs.length = 0;

      await run(s, 'Reply with exactly one word: pong');
      expect(chunkText()).to.not.include('**Error:**');
      expect(stripThink(chunkText()).trim().length, 'reply after the abort').to.be.greaterThan(0);
      expectValidToolShape(s.history);
    });

    it('sends the Off effort token to Qwen3 through the real loop', async function () {
      if (control !== 'token') return this.skip();
      const s = newSession('build', false);
      const bodies = await withFetchSpy(async b => { await run(s, 'What is 2 + 2?'); return b; });
      const chat = bodies.find(b => Array.isArray(b.messages));
      expect(chat, 'a chat request was sent').to.exist;
      const last = [...chat.messages].reverse().find((m: any) => m.role === 'user');
      expect(String(last.content).endsWith('/no_think')).to.equal(true);
    });

    it('does not inject an effort token for models without a control', async function () {
      if (control === 'token' || control === 'api') return this.skip();
      const s = newSession('build', false);
      const bodies = await withFetchSpy(async b => { await run(s, 'What is 2 + 2?'); return b; });
      const chat = bodies.find(b => Array.isArray(b.messages));
      const last = [...chat.messages].reverse().find((m: any) => m.role === 'user');
      expect(String(last.content)).to.not.match(/\/(no_)?think\s*$/);
    });
  });
}
