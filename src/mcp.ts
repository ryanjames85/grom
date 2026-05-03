/**
 * mcp.ts
 *
 * MCP (Model Context Protocol) server management and tool invocation.
 * Spawns and communicates with external MCP servers over stdio using JSON-RPC 2.0.
 * Each configured server is launched as a child process; tool calls are sent as
 * JSON-RPC requests and results are returned as strings to the agent loop.
 *
 * McpManager is the public interface — it reads server config from VS Code settings,
 * launches all configured servers on initialize(), and exposes their tools via getAllTools().
 * Tool names are namespaced as "serverName__toolName" to avoid collisions across servers.
 *
 * Re-exports parseToolCall and buildToolSystemPrompt from mcp-parser.ts so callers
 * only need to import from this one file.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
export { McpTool, ParsedToolCall, parseToolCall, buildToolSystemPrompt } from './mcp-parser';
import type { McpTool } from './mcp-parser';

export interface McpServer {
  name: string;
  tools: McpTool[];
  call(toolName: string, args: Record<string, any>): Promise<string>;
  dispose(): void;
}

const INIT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 30000;
const MAX_RESULT_CHARS = 8000;

class StdioMcpServer implements McpServer {
  name: string;
  tools: McpTool[] = [];
  private _proc: cp.ChildProcess;
  private _pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  private _nextId = 1;
  private _buf = '';
  private _dead = false;

  constructor(name: string, command: string, args: string[], env?: Record<string, string>) {
    this.name = name;
    this._proc = cp.spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    this._proc.stdout?.on('data', (chunk: Buffer) => {
      this._buf += chunk.toString('utf8');
      // MCP uses newline-delimited JSON; process all complete lines
      let nl: number;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).trim();
        this._buf = this._buf.slice(nl + 1);
        if (!line) continue;
        try { this._onMessage(JSON.parse(line)); } catch (e) {
          console.warn(`[MCP:${name}] invalid JSON from server:`, line.slice(0, 200));
        }
      }
    });

    this._proc.stderr?.on('data', (d: Buffer) => {
      console.warn(`[MCP:${name}] stderr:`, d.toString('utf8').slice(0, 500));
    });

    this._proc.on('exit', (code) => {
      this._dead = true;
      console.warn(`[MCP:${name}] process exited (code ${code})`);
      this._pending.forEach(p => {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${name}" exited unexpectedly`));
      });
      this._pending.clear();
    });

    this._proc.on('error', (err) => {
      this._dead = true;
      this._pending.forEach(p => {
        clearTimeout(p.timer);
        p.reject(err);
      });
      this._pending.clear();
    });
  }

  private _onMessage(msg: any) {
    // Handle JSON-RPC responses (have id) and ignore notifications (no id)
    if (msg.id === undefined || msg.id === null) return;
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    clearTimeout(handler.timer);
    this._pending.delete(msg.id);
    if (msg.error) {
      handler.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      handler.resolve(msg.result);
    }
  }

  private _send(method: string, params: any, timeoutMs: number): Promise<any> {
    if (this._dead) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP timeout after ${timeoutMs}ms for method "${method}"`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this._proc.stdin?.write(msg, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Performs the MCP handshake and fetches the full tool list, following pagination cursors. */
  async initialize(): Promise<void> {
    const initResult = await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'grom', version: '0.1.0' }
    }, INIT_TIMEOUT_MS);

    // Send initialized notification (no id, fire-and-forget)
    const notif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n';
    this._proc.stdin?.write(notif);

    // Some servers paginate tools; follow cursor if present
    let cursor: string | undefined;
    const allTools: any[] = [];
    do {
      const params: any = {};
      if (cursor) params.cursor = cursor;
      const result = await this._send('tools/list', params, INIT_TIMEOUT_MS);
      allTools.push(...(result?.tools || []));
      cursor = result?.nextCursor;
    } while (cursor);

    this.tools = allTools.map((t: any) => ({
      name: t.name,
      description: (t.description || '').slice(0, 200),
      inputSchema: t.inputSchema || { type: 'object', properties: {} }
    }));

    console.log(`[Grom] MCP "${this.name}" ready — ${this.tools.length} tools, protocol ${initResult?.protocolVersion ?? 'unknown'}`);
  }

  /** Calls a tool by name and returns its output as a string, truncated to MAX_RESULT_CHARS. */
  async call(toolName: string, args: Record<string, any>): Promise<string> {
    if (this._dead) throw new Error(`MCP server "${this.name}" is not running`);
    const result = await this._send('tools/call', { name: toolName, arguments: args }, CALL_TIMEOUT_MS);
    const content: any[] = result?.content || [];
    const text = content.map((c: any) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource') return `[Resource: ${c.resource?.uri ?? 'unknown'}]\n${c.resource?.text ?? ''}`;
      return JSON.stringify(c);
    }).join('\n');
    // Truncate very large results to protect context window
    return text.length > MAX_RESULT_CHARS
      ? text.slice(0, MAX_RESULT_CHARS) + `\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]`
      : text;
  }

  dispose() {
    this._dead = true;
    this._pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('disposed')); });
    this._pending.clear();
    try { this._proc.kill('SIGTERM'); } catch {}
  }
}

/**
 * Manages the lifecycle of all configured MCP servers.
 * Created once in provider.ts and re-initialized whenever grom.mcpServers config changes.
 */
export class McpManager {
  private _servers: McpServer[] = [];
  private _ready = false;
  private _initPromise: Promise<void> | null = null;

  /**
   * Disposes any running servers, then reads grom.mcpServers from VS Code settings
   * and launches each configured server. Failed servers are reported as warnings — they
   * don't prevent other servers from starting.
   */
  async initialize(): Promise<void> {
    this._ready = false;
    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    this._servers.forEach(s => s.dispose());
    this._servers = [];

    const configs = vscode.workspace.getConfiguration('grom').get<any[]>('mcpServers') || [];
    const results = await Promise.allSettled(
      configs.filter(c => c?.command).map(async (cfg) => {
        const server = new StdioMcpServer(cfg.name || cfg.command, cfg.command, cfg.args || [], cfg.env || {});
        await server.initialize();
        return server;
      })
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        this._servers.push(r.value);
      } else {
        const name = configs[i]?.name || configs[i]?.command;
        console.error(`[Grom] MCP server "${name}" failed:`, r.reason?.message);
        vscode.window.showWarningMessage(`Grom: MCP server "${name}" failed to connect — ${r.reason?.message}`);
      }
    }
    this._ready = true;
  }

  async waitForReady(timeoutMs = 5000): Promise<void> {
    if (this._ready) return;
    if (!this._initPromise) return;
    await Promise.race([
      this._initPromise,
      new Promise(r => setTimeout(r, timeoutMs))
    ]);
  }

  isReady(): boolean { return this._ready; }

  /** Returns all tools from all running servers, namespaced as "serverName__toolName". */
  getAllTools(): McpTool[] {
    return this._servers.flatMap(s =>
      s.tools.map(t => ({ ...t, name: `${s.name}__${t.name}` }))
    );
  }

  /** Routes a namespaced "serverName__toolName" call to the correct server. */
  async callTool(qualifiedName: string, args: Record<string, any>): Promise<string> {
    const sep = qualifiedName.indexOf('__');
    if (sep === -1) throw new Error(`Invalid tool name "${qualifiedName}" — expected "serverName__toolName"`);
    const serverName = qualifiedName.slice(0, sep);
    const toolName = qualifiedName.slice(sep + 2);
    const server = this._servers.find(s => s.name === serverName);
    if (!server) throw new Error(`MCP server "${serverName}" not found (available: ${this._servers.map(s => s.name).join(', ') || 'none'})`);
    return server.call(toolName, args);
  }

  hasTools(): boolean { return this._servers.some(s => s.tools.length > 0); }

  dispose() { this._servers.forEach(s => s.dispose()); this._servers = []; }
}

