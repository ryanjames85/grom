/**
 * provider.ts
 *
 * WebviewViewProvider that drives the Grom chat panel â€” the central hub of the extension.
 *
 * Responsibilities:
 *   - Renders the webview HTML and handles all messages sent from the webview JS
 *   - Manages the agentic loop: streams model output, detects tool calls, executes them,
 *     feeds results back, and repeats until the model produces a final answer
 *   - Per-action approval: destructive tool calls (write_file, delete_file, run_terminal)
 *     and all MCP tools are paused for user Allow / Allow All / Deny before execution
 *   - Session lifecycle: create, switch, delete, compact, rename, export, import
 *   - Context assembly: RAG retrieval, @ mentions, active file, user memory
 *   - Loop hardening: prose suppression in JSON mode, one reprompt when model drifts mid-task
 *
 * NOTE: This file owns the VS Codeâ†”webview boundary. All pure logic (session management,
 * RAG scoring, MCP JSON-RPC) lives in separate vscode-free modules so they stay testable.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LocalLLMClient, ChatMessage, AuthType, ProviderFormat, fetchContextLength } from './client';
import { SessionManager, ChatSession } from './session';
import { getCustomPrompts } from './context';
import { insertCode, applyCode, diffCode, acceptDiff, diffAgentWrite } from './editor';
import { RagIndex } from './rag';
import { DocsIndex } from './docs-index';
import { McpManager } from './mcp';
import { AgentLoop } from './agent-loop';
import { estimateTokens, estimateHistoryTokens } from './utils';
import { log, logError } from './logger';

const MAX_GREETING_LEN = 200;
const BLOCKED_TERMS = [
  'nigger','nigga','faggot','fag','chink','spic','kike','cunt','tranny',
  'retard','rape','kill yourself','kys','go die','fuck you','fuck off',
  'whore','slut','bitch'
];

function _sanitizeGreeting(text: string): string {
  if (!text || text.length > MAX_GREETING_LEN) return '';
  const lower = text.toLowerCase();
  if (BLOCKED_TERMS.some(t => lower.includes(t))) return '';
  return text;
}

export class LocalChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _sessionManager: SessionManager;
  private _mcp: McpManager;
  private _agentLoop: AgentLoop;
  private _pendingApprovals = new Map<string, (result: 'allow' | 'allowAll' | 'deny') => void>();
  private _isStreaming = false;
  private _detectedContextLength: number | null = null;
  private _contextHintSent = new Set<string>(); // session IDs that have already received a context hint

  constructor(private readonly _context: vscode.ExtensionContext, private readonly _rag?: RagIndex, private readonly _docs?: DocsIndex) {
    this._mcp = new McpManager();
    this._mcp.initialize();
    const initialSessions = this._context.workspaceState.get<Record<string, ChatSession>>('sessions', {
      'default': { id: 'default', title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: Date.now(), mode: 'plan', agentEnabled: false }
    });
    // Migration: sessions persisted before v0.3.7 have no agentEnabled field.
    // Only sessions with actual history had tools active; empty sessions get the new default-off.
    for (const session of Object.values(initialSessions)) {
      if (session.agentEnabled === undefined) {
        session.agentEnabled = (session.history?.length ?? 0) > 0;
      }
    }
    const lastSessionId = this._context.workspaceState.get<string>('lastSessionId', 'default');
    this._sessionManager = new SessionManager(initialSessions, lastSessionId);
    this._agentLoop = new AgentLoop({
      mcp: this._mcp,
      rag: this._rag,
      docs: this._docs,
      postMessage: (msg) => this._view?.webview.postMessage(msg),
      requestApproval: (id, tool, args) => this._requestApproval(id, tool, args),
      appendTaskLog: (sid, tool, args, result) => this._appendTaskLog(sid, tool, args, result),
      getMemory: () => this._context.globalState.get<string>('gromMemory', ''),
    });
  }

  /** Resolves the secret storage key, auth type, and wire format for the active provider URL. */
  private async _resolveProviderKey(url: string, useOllama: boolean): Promise<{ key: string | undefined; authType: AuthType; providerFormat: ProviderFormat }> {
    if (useOllama) return { key: undefined, authType: 'none', providerFormat: 'ollama' };
    const customProviders = vscode.workspace.getConfiguration('grom').get<any[]>('customProviders') || [];
    const cp = customProviders.find(p => url.startsWith(p.url.replace(/\/+$/, '')));
    if (cp) {
      const providerFormat: ProviderFormat = cp.providerFormat || 'openai';
      const authType: AuthType = cp.authType || (providerFormat === 'anthropic' ? 'x-api-key' : 'bearer');
      const key = await this._context.secrets.get(`grom.key.custom.${cp.name}`);
      return { key, authType, providerFormat };
    }
    if (url.includes('openai.com')) return { key: await this._context.secrets.get('grom.key.openai'), authType: 'bearer', providerFormat: 'openai' };
    if (url.includes('opencode.ai')) return { key: await this._context.secrets.get('grom.key.opencode'), authType: 'bearer', providerFormat: 'openai' };
    if (url.includes('anthropic.com')) return { key: await this._context.secrets.get('grom.key.anthropic'), authType: 'x-api-key', providerFormat: 'anthropic' };
    if (url.includes('groq.com')) return { key: await this._context.secrets.get('grom.key.groq'), authType: 'bearer', providerFormat: 'openai' };
    if (url.includes('mistral.ai')) return { key: await this._context.secrets.get('grom.key.mistral'), authType: 'bearer', providerFormat: 'openai' };
    if (url.includes('googleapis.com')) return { key: await this._context.secrets.get('grom.key.gemini'), authType: 'bearer', providerFormat: 'openai' };
    return { key: undefined, authType: 'none', providerFormat: 'openai' };
  }

  /** One-time migration: moves any plaintext apiKey values out of settings and into SecretStorage. */
  private async _migrateApiKeys() {
    const cfg = vscode.workspace.getConfiguration('grom');
    // Migrate old top-level grom.apiKey
    const oldKey = cfg.get<string>('apiKey', '');
    if (oldKey) {
      const url = cfg.get<string>('apiUrl') || '';
      const useOllama = cfg.get<boolean>('useOllamaFormat') ?? true;
      if (!useOllama && url) {
        const customProviders = cfg.get<any[]>('customProviders') || [];
        const cp = customProviders.find(p => url.startsWith(p.url.replace(/\/+$/, '')));
        if (cp) await this._context.secrets.store(`grom.key.custom.${cp.name}`, oldKey);
        else if (url.includes('openai.com')) await this._context.secrets.store('grom.key.openai', oldKey);
        else if (url.includes('opencode.ai')) await this._context.secrets.store('grom.key.opencode', oldKey);
        else if (url.includes('anthropic.com')) await this._context.secrets.store('grom.key.anthropic', oldKey);
      }
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
    }
    // Migrate apiKey fields embedded in customProviders array entries
    const customProviders = cfg.get<any[]>('customProviders') || [];
    let dirty = false;
    const cleaned = await Promise.all(customProviders.map(async (cp) => {
      if (cp.apiKey) {
        await this._context.secrets.store(`grom.key.custom.${cp.name}`, cp.apiKey);
        const { apiKey: _, ...rest } = cp;
        dirty = true;
        return rest;
      }
      return cp;
    }));
    if (dirty) await cfg.update('customProviders', cleaned, vscode.ConfigurationTarget.Global);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._context.extensionUri] };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    void this._migrateApiKeys();

    // Keep the webview alive when the user switches to another panel so that
    // in-flight streaming chunks and approval cards are not lost.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && !this._isStreaming) {
        this._checkConnection();
        this._updateTheme();
        this._loadAllSessions();
        this._updateActiveContext();
      }
    });

    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('grom')) {
        this._checkConnection();
        this._updateTheme();
        this._loadAllSessions();
        if (e.affectsConfiguration('grom.mcpServers')) {
          this._mcp.initialize().then(() => this._checkConnection());
        }
      }
    });

    const editorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
      this._updateActiveContext();
    });

    webviewView.onDidDispose(() => {
      configWatcher.dispose();
      editorWatcher.dispose();
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'ready':
          this._checkConnection();
          this._updateTheme();
          this._loadAllSessions();
          this._updateActiveContext();
          const isDev = this._context.extensionMode === vscode.ExtensionMode.Development;
          if (isDev || !this._context.globalState.get('grom.welcomed')) {
            if (!isDev) void this._context.globalState.update('grom.welcomed', true);
            const iconUri = webviewView.webview.asWebviewUri(
              vscode.Uri.joinPath(this._context.extensionUri, 'resources', 'grom-plan.svg')
            ).toString();
            setTimeout(() => this._view?.webview.postMessage({ type: 'welcome', iconUri }), 150);
          }
          break;
        case 'send': {
          const ph = this._context.globalState.get<string[]>('promptHistory', []);
          if (data.text && (ph.length === 0 || ph[ph.length - 1] !== data.text)) {
            ph.push(data.text);
            if (ph.length > 50) ph.shift();
            void this._context.globalState.update('promptHistory', ph);
          }
          await this._handleChat(data.text, data.images, data.mode);
          break;
        }
        case 'abort': this._agentLoop.abort(); break;
        case 'insertCode': insertCode(data.code); break;
        case 'applyCode': await applyCode(data.code); break;
        case 'diffCode': await diffCode(data.code); break;
        case 'acceptDiff': await acceptDiff(data.code); break;
        case 'runInTerminal': {
          const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Grom');
          terminal.show(true);
          terminal.sendText(data.code);
          break;
        }
        case 'openFile': {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders?.length) break;
          const normalised = (data.path as string).replace(/\\/g, '/').replace(/^\/+/, '');
          const uri = vscode.Uri.joinPath(folders[0].uri, normalised);
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch (e) {
            vscode.window.showErrorMessage(`Could not open ${data.path}. Make sure it exists in the workspace.`);
          }
          break;
        }
        case 'newSession': this._createNewSession(); break;
        case 'switchSession': this._switchSession(data.sessionId); break;
        case 'deleteSession': this._deleteSession(data.sessionId); break;
        case 'compactSession': this._compactSession(); break;
        case 'clearPromptHistory': void this._context.globalState.update('promptHistory', []); break;
        case 'renameSession': this._renameSession(data.title, data.sessionId); break;
        case 'exportChat': this._exportChat(); break;
        case 'importChat': this._importChat(); break;
        case 'openMemory': {
          const memory = this._context.globalState.get<string>('gromMemory', '');
          webviewView.webview.postMessage({ type: 'showMemory', memory });
          break;
        }
        case 'saveMemory': {
          await this._context.globalState.update('gromMemory', data.memory);
          // Update the system message in the current session so memory applies immediately
          const memSession = this._sessionManager.getCurrentSession();
          if (memSession.history.length > 0 && memSession.history[0].role === 'system') {
            const base = memSession.history[0].content.replace(/\n\nUSER MEMORY:[\s\S]*?(?=\n\nSESSION INSTRUCTIONS:|$)/, '');
            const memSection = data.memory.trim() ? `\n\nUSER MEMORY:\n${data.memory.trim()}` : '';
            memSession.history[0] = { ...memSession.history[0], content: base + memSection };
            this._saveState();
          }
          webviewView.webview.postMessage({ type: 'memorySaved', hasMemory: !!(data.memory || '').trim() });
          break;
        }
        case 'setSystemPrompt': {
          const current = this._sessionManager.getCurrentSession();
          this._sessionManager.setSystemPrompt(current.id, data.prompt);
          this._saveState();
          webviewView.webview.postMessage({ type: 'systemPromptSaved', hasSystemPrompt: !!(data.prompt || '').trim() });
          break;
        }
        case 'getSystemPrompt': {
          const current = this._sessionManager.getCurrentSession();
          webviewView.webview.postMessage({ type: 'showSystemPrompt', prompt: current.systemPrompt || '' });
          break;
        }
        case 'revertAgentChanges': {
          const backups = this._agentLoop.getBackups();
          if (!backups.size) break;
          const folders = vscode.workspace.workspaceFolders;
          const root = folders?.[0]?.uri;
          if (!root) break;
          const items = [...backups.entries()].map(([rel, orig]) => ({
            label: rel,
            description: orig === null ? 'new file — will be deleted' : 'will be restored to previous content',
            rel, orig
          }));
          const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true, placeHolder: 'Select files to revert', title: 'Undo agent writes'
          });
          if (!picked?.length) break;
          for (const { rel, orig } of picked) {
            const uri = vscode.Uri.joinPath(root, rel);
            if (orig === null) {
              await vscode.workspace.fs.delete(uri, { useTrash: true });
            } else {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(orig, 'utf8'));
            }
          }
          vscode.window.showInformationMessage(`Grom: reverted ${picked.length} file${picked.length > 1 ? 's' : ''}.`);
          break;
        }
        case 'updateMode': this._updateMode(data.mode); break;
        case 'toggleAgent': {
          const session = this._sessionManager.getCurrentSession();
          this._sessionManager.setAgentEnabled(session.id, data.enabled);
          this._saveState();
          break;
        }
        case 'updateHistory': await this._updateSessionHistory(data.text); break;
        case 'resend': {
          const session = this._sessionManager.getCurrentSession();
          const text = this._sessionManager.trimLastExchange(session.id);
          if (text !== null) {
            this._saveState();
            this._view?.webview.postMessage({ type: 'resendText', text });
          }
          break;
        }
        case 'retryConnection': this._checkConnection(); break;
        case 'idleStart': {
          const cfg = vscode.workspace.getConfiguration('grom');
          const useOllama = cfg.get<boolean>('useOllamaFormat') ?? true;
          if (useOllama) {
            const url = (cfg.get<string>('apiUrl') || 'http://127.0.0.1:11434').replace(/\/$/, '');
            const model = cfg.get<string>('model') || 'qwen2.5-coder';
            fetch(`${url}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, messages: [], keep_alive: '10m' })
            }).catch(() => {});
          }
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const errors = vscode.languages.getDiagnostics(editor.document.uri)
              .filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            if (errors.length > 0) {
              const fname = editor.document.fileName.split(/[/\\]/).pop() ?? '';
              this._view?.webview.postMessage({
                type: 'idleHint',
                text: `${errors.length} error${errors.length > 1 ? 's' : ''} in ${fname}`
              });
            }
          }
          break;
        }
        case 'testConnection': {
          const cfg = vscode.workspace.getConfiguration('grom');
          const url = cfg.get<string>('apiUrl') || 'http://127.0.0.1:11434';
          const model = cfg.get<string>('model') || 'qwen2.5-coder';
          try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 5000);
            const useOllama = cfg.get<boolean>('useOllamaFormat') ?? true;
            const endpoint = useOllama ? `${url}/api/tags` : `${url}/v1/models`;
            const res = await fetch(endpoint, { signal: controller.signal });
            if (res.ok) {
              webviewView.webview.postMessage({ type: 'testConnectionResult', ok: true, message: `Connected to ${url} (model: ${model})` });
            } else {
              webviewView.webview.postMessage({ type: 'testConnectionResult', ok: false, message: `Server responded with ${res.status} ${res.statusText}` });
            }
          } catch (e: any) {
            webviewView.webview.postMessage({ type: 'testConnectionResult', ok: false, message: e.name === 'AbortError' ? `Timeout â€” is ${url} running?` : e.message });
          }
          break;
        }
        case 'getMcpStatus': {
          const tools = this._mcp.getAllTools();
          webviewView.webview.postMessage({ type: 'mcpStatus', tools: tools.map(t => ({ name: t.name, description: t.description })) });
          break;
        }
        case 'createFile': {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders?.length) break;
          const normalised = (data.path as string).replace(/\\/g, '/').replace(/^\/+/, '');
          if (normalised.includes('..')) break;
          const uri = vscode.Uri.joinPath(folders[0].uri, normalised);
          const parentUri = vscode.Uri.joinPath(uri, '..');
          const content = data.content as string;
          let isNew = false;
          try { await vscode.workspace.fs.stat(uri); } catch { isNew = true; }
          if (isNew) {
            try { await vscode.workspace.fs.createDirectory(parentUri); } catch {}
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
            webviewView.webview.postMessage({ type: 'fileCreated', path: data.path });
          } else {
            await diffAgentWrite(data.path as string, content);
            const action = await vscode.window.showInformationMessage(
              `Apply Grom's changes to ${normalised.split('/').pop()}?`,
              { modal: false },
              'Apply', 'Skip'
            );
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            if (action === 'Apply') {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
              const doc = await vscode.workspace.openTextDocument(uri);
              await vscode.window.showTextDocument(doc, { preview: false });
              webviewView.webview.postMessage({ type: 'fileCreated', path: data.path });
            }
          }
          break;
        }
        case 'showAlert': vscode.window.showInformationMessage(data.message); break;
        case 'toolApprovalResponse': {
          const resolver = this._pendingApprovals.get(data.id);
          if (resolver) { this._pendingApprovals.delete(data.id); resolver(data.result); }
          break;
        }
        case 'viewAgentDiff': {
          await diffAgentWrite(data.path, data.content);
          break;
        }
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this._context.extension.id}`);
          break;
        case 'getFiles': {
          // Collect open tabs first — these are highest priority
          const openPaths = new Set<string>();
          const openFiles: { name: string; path: string; group: string }[] = [];
          for (const tg of vscode.window.tabGroups.all) {
            for (const tab of tg.tabs) {
              const input = tab.input as any;
              if (input?.uri) {
                const p = input.uri.fsPath;
                if (!openPaths.has(p)) {
                  openPaths.add(p);
                  openFiles.push({ name: p.split(/[\\\/]/).pop()!, path: p, group: 'open' });
                }
              }
            }
          }
          // Workspace files excluding already-open ones
          const wsFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 80);
          const allFiles = [
            ...openFiles,
            ...wsFiles
              .filter(f => !openPaths.has(f.fsPath))
              .map(f => ({ name: f.fsPath.split(/[\\\/]/).pop()!, path: f.fsPath, group: 'file' }))
          ];
          webviewView.webview.postMessage({ type: 'fileList', files: allFiles });
          break;
        }
        case 'changeModel':
          await vscode.workspace.getConfiguration('grom').update('model', data.model, vscode.ConfigurationTarget.Global);
          this._sessionManager.getCurrentSession().model = data.model;
          this._saveState();
          await this._checkConnection();
          break;
        case 'changeProvider': {
          const cfg = vscode.workspace.getConfiguration('grom');
          let newUrl: string;
          let isOllama: boolean;
          if (data.providerId === 'custom') {
            newUrl = data.url;
            isOllama = data.useOllamaFormat ?? false;
            if (!isOllama) {
              const cp = (cfg.get<any[]>('customProviders') || []).find((p: any) => p.name === data.providerName);
              const authType: AuthType = cp?.authType || 'bearer';
              if (authType !== 'none') {
                const existing = await this._context.secrets.get(`grom.key.custom.${data.providerName}`);
                if (!existing) {
                  const entered = await vscode.window.showInputBox({ prompt: `Enter API key for ${data.providerName}`, password: true, ignoreFocusOut: true, placeHolder: 'sk-...' });
                  if (entered?.trim()) await this._context.secrets.store(`grom.key.custom.${data.providerName}`, entered.trim());
                }
              }
            }
          } else {
            isOllama = data.providerId === 'ollama';
            newUrl = 'http://127.0.0.1:11434';
            if (data.providerId === 'lmstudio') newUrl = 'http://127.0.0.1:1234';
            else if (data.providerId === 'opencode') {
              newUrl = 'https://api.opencode.ai';
              const existing = await this._context.secrets.get('grom.key.opencode');
              if (!existing) {
                const entered = await vscode.window.showInputBox({ prompt: 'Enter your OpenCode API key', password: true, ignoreFocusOut: true, placeHolder: 'sk-...' });
                if (entered?.trim()) await this._context.secrets.store('grom.key.opencode', entered.trim());
              }
            } else if (data.providerId === 'openai') {
              newUrl = 'https://api.openai.com';
              const existing = await this._context.secrets.get('grom.key.openai');
              if (!existing) {
                const entered = await vscode.window.showInputBox({ prompt: 'Enter your OpenAI API key', password: true, ignoreFocusOut: true, placeHolder: 'sk-...' });
                if (entered?.trim()) await this._context.secrets.store('grom.key.openai', entered.trim());
              }
            } else if (data.providerId === 'anthropic') {
              newUrl = 'https://api.anthropic.com';
              const existing = await this._context.secrets.get('grom.key.anthropic');
              if (!existing) {
                const entered = await vscode.window.showInputBox({ prompt: 'Enter your Anthropic API key', password: true, ignoreFocusOut: true, placeHolder: 'sk-ant-...' });
                if (entered?.trim()) await this._context.secrets.store('grom.key.anthropic', entered.trim());
              }
            } else if (data.providerId === 'groq') {
              newUrl = 'https://api.groq.com/openai';
              const existing = await this._context.secrets.get('grom.key.groq');
              if (!existing) {
                const entered = await vscode.window.showInputBox({ prompt: 'Enter your Groq API key', password: true, ignoreFocusOut: true, placeHolder: 'gsk_...' });
                if (entered?.trim()) await this._context.secrets.store('grom.key.groq', entered.trim());
              }
            } else if (data.providerId === 'mistral') {
              newUrl = 'https://api.mistral.ai';
              const existing = await this._context.secrets.get('grom.key.mistral');
              if (!existing) {
                const entered = await vscode.window.showInputBox({ prompt: 'Enter your Mistral API key', password: true, ignoreFocusOut: true, placeHolder: 'sk-...' });
                if (entered?.trim()) await this._context.secrets.store('grom.key.mistral', entered.trim());
              }
            } else if (data.providerId === 'gemini') {
              newUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
              const existing = await this._context.secrets.get('grom.key.gemini');
              if (!existing) {
                const entered = await vscode.window.showInputBox({ prompt: 'Enter your Google AI API key', password: true, ignoreFocusOut: true, placeHolder: 'AIza...' });
                if (entered?.trim()) await this._context.secrets.store('grom.key.gemini', entered.trim());
              }
            }
          }
          await cfg.update('useOllamaFormat', isOllama, vscode.ConfigurationTarget.Global);
          await cfg.update('apiUrl', newUrl, vscode.ConfigurationTarget.Global);
          await this._checkConnection(newUrl, data.model || 'qwen2.5-coder', isOllama);
          break;
        }
        case 'setProviderKey': {
          const label = data.providerName || data.providerId;
          const secretKey = data.providerName ? `grom.key.custom.${data.providerName}` : `grom.key.${data.providerId}`;
          const entered = await vscode.window.showInputBox({ prompt: `API key for ${label} (leave blank to clear)`, password: true, ignoreFocusOut: true, placeHolder: 'sk-...' });
          if (entered !== undefined) {
            if (entered.trim()) await this._context.secrets.store(secretKey, entered.trim());
            else await this._context.secrets.delete(secretKey);
            await this._checkConnection();
          }
          break;
        }
      }
    });
  }

  /** Sends a message to the webview â€” used by extension.ts to inject triggered actions (explain, refactor, etc.). */
  public postMessageToWebview(m: any) { this._view?.webview.postMessage(m); }

  /** Notifies the webview of the currently active file so the context badge stays in sync. */
  private async _updateActiveContext() {
    if (!this._view) return;
    const editor = vscode.window.activeTextEditor;
    const files = [];
    if (editor) {
      const name = editor.document.fileName.split(/[\\\/]/).pop() || "";
      const text = editor.document.getText();
      const tokens = estimateTokens(text);
      files.push({ name, tokens });
    }
    this._view.webview.postMessage({ type: 'filesUsed', files });
  }

  private _updateTheme() {
    const theme = vscode.workspace.getConfiguration('grom').get<string>('theme') || 'Claude';
    this._view?.webview.postMessage({ type: 'setTheme', theme });
  }

  /** Persists all sessions and the active session ID to workspaceState so they survive VS Code restarts. */
  private _saveState() {
    this._context.workspaceState.update('sessions', this._sessionManager.getSessions());
    this._context.workspaceState.update('lastSessionId', this._sessionManager.getCurrentSessionId());
  }

  private async _loadAllSessions() {
    const sessions = this._sessionManager.getSessions();
    const current = this._sessionManager.getCurrentSession();
    const config = vscode.workspace.getConfiguration('grom');
    const configPresets = config.get<any[]>('presets') || [];
    const customPrompts = await getCustomPrompts();
    const robotAnimations = config.get<boolean>('robotAnimations') !== false;
    const customLogo = config.get<string>('customLogo', '');
    const rawGreeting = (config.get<string>('customGreeting', '') || '').trim();
    const customGreeting = _sanitizeGreeting(rawGreeting) || "Hey. I'm Grom. Ready when you are.";
    const fontSize = config.get<string>('fontSize', 'medium');
    // Custom .grom/ prompts appear after built-in presets, deduplicated by text
    const seenTexts = new Set(configPresets.map((p: any) => p.text));
    const mergedPresets = [...configPresets, ...customPrompts.filter(p => !seenTexts.has(p.text))];

    this._view?.webview.postMessage({
      type: 'loadSessions',
      sessions: Object.values(sessions).sort((a, b) => b.lastModified - a.lastModified),
      currentSessionId: current.id,
      history: current.history,
      mode: current.mode || 'plan',
      customLogo,
      customGreeting,
      presets: mergedPresets,
      robotAnimations,
      fontSize,
      taskLog: current.taskLog || [],
      hasMemory: !!(this._context.globalState.get<string>('gromMemory', '') || '').trim(),
      hasSystemPrompt: !!(current.systemPrompt || '').trim(),
      agentEnabled: current.agentEnabled ?? false,
      promptHistory: this._context.globalState.get<string[]>('promptHistory', [])
    });
    this._updateUsageDisplay();
  }

  public async refreshPresets() {
    await this._loadAllSessions();
  }

  /** Pauses the agent loop and shows an approval card in the webview. Returns when the user clicks Allow/Allow All/Deny.
   *  For write_file, reads the existing file content so the webview can render a before/after diff inline. */
  private async _requestApproval(id: string, tool: string, args: Record<string, any>): Promise<'allow' | 'allowAll' | 'deny'> {
    // For write_file, read existing content so the webview can show a diff
    let existingContent: string | null = null;
    if (tool === 'write_file' && args.path) {
      const folders = vscode.workspace.workspaceFolders;
      if (folders?.length) {
        const normalised = (args.path as string).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalised.includes('..')) {
          try {
            const uri = vscode.Uri.joinPath(folders[0].uri, normalised);
            existingContent = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          } catch { existingContent = null; }
        }
      }
    }
    return new Promise<'allow' | 'allowAll' | 'deny'>((resolve) => {
      this._pendingApprovals.set(id, resolve);
      this._view?.webview.postMessage({ type: 'toolApproval', id, tool, args, existingContent });
    });
  }

  /** Appends a tool execution record to the session's task log and notifies the webview for live updates. */
  private _appendTaskLog(sessionId: string, tool: string, args: Record<string, any>, result: string) {
    const sessions = this._sessionManager.getSessions();
    const s = sessions[sessionId];
    if (!s) return;
    if (!s.taskLog) s.taskLog = [];
    const argsSummary = Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
    s.taskLog.push({ ts: Date.now(), tool, argsSummary, snippet: result.slice(0, 200) });
    // Keep last 200 entries per session
    if (s.taskLog.length > 200) s.taskLog = s.taskLog.slice(-200);
    this._saveState();
    // Notify webview so task log tab can update live
    this._view?.webview.postMessage({ type: 'taskLogEntry', entry: s.taskLog[s.taskLog.length - 1] });
  }

  private _createNewSession() {
    const toolsDefault = vscode.workspace.getConfiguration('grom').get<boolean>('toolsEnabledByDefault', false);
    this._sessionManager.createNewSession(toolsDefault);
    this._saveState();
    this._loadAllSessions();
  }

  private async _switchSession(id: string) {
    if (this._sessionManager.switchSession(id)) {
      const session = this._sessionManager.getCurrentSession();
      this._saveState();
      if (session.model) {
        // Config watcher fires _checkConnection + _loadAllSessions when model changes
        await vscode.workspace.getConfiguration('grom').update('model', session.model, vscode.ConfigurationTarget.Global);
      } else {
        this._loadAllSessions();
      }
    }
  }

  private _deleteSession(id: string) {
    const toolsDefault = vscode.workspace.getConfiguration('grom').get<boolean>('toolsEnabledByDefault', false);
    this._sessionManager.deleteSession(id, toolsDefault);
    this._contextHintSent.delete(id);
    this._saveState();
    this._loadAllSessions();
  }

  private _compactSession() {
    const current = this._sessionManager.getCurrentSession();
    if (this._sessionManager.compactSession(current.id)) {
      // Allow the context hint to fire again after a compact — history just shrank
      this._contextHintSent.delete(current.id);
      this._saveState();
      this._updateUsageDisplay();
      // Tell the webview to show a compact notice inline without wiping the chat
      this._view?.webview.postMessage({ type: 'compacted' });
    } else {
      vscode.window.showInformationMessage('Nothing to compact.');
    }
  }

  private _updateMode(mode: 'plan' | 'build') {
    const current = this._sessionManager.getCurrentSession();
    this._sessionManager.updateMode(current.id, mode);
    this._saveState();
  }

  private _renameSession(title: string, sessionId?: string) {
    const id = sessionId || this._sessionManager.getCurrentSession().id;
    this._sessionManager.renameSession(id, title);
    this._saveState();
    this._postSessionTitleUpdate(id, title);
    // Also send the updated session list so the sidebar reflects the new name
    // even if the DOM-side title element update was missed
    const sessions = this._sessionManager.getSessions();
    this._view?.webview.postMessage({
      type: 'sessionListUpdate',
      sessions: Object.values(sessions).sort((a, b) => b.lastModified - a.lastModified),
      currentSessionId: this._sessionManager.getCurrentSessionId()
    });
  }

  private async _exportChat() {
    const current = this._sessionManager.getCurrentSession();
    if (current.history.length === 0) return;
    let markdown = `# Chat Session: ${current.title}\n\n> Import this file into Grom to continue the conversation.\n\n`;
    current.history.forEach(msg => {
      if (msg.role === 'system' && msg.content === '__compacted__') markdown += `---\n*Earlier messages were compacted.*\n\n`;
      else if (msg.role !== 'system') markdown += `### ${msg.role === 'user' ? 'User' : 'Assistant'}\n${msg.content}\n\n`;
    });
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`grom-chat-${current.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.md`), filters: { 'Markdown': ['md'] } });
    if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown)); vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`); }
  }

  private async _importChat() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Markdown': ['md'] }, title: 'Import Grom Chat' });
    if (!uris || uris.length === 0) return;
    const raw = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
    const lines = raw.split('\n');
    const history: ChatMessage[] = [];
    let title = 'Imported Chat';
    let currentRole: 'user' | 'assistant' | null = null;
    let currentContent: string[] = [];

    const flush = () => {
      if (currentRole && currentContent.length > 0) {
        history.push({ role: currentRole, content: currentContent.join('\n').trim() });
        currentRole = null; currentContent = [];
      }
    };

    for (const line of lines) {
      if (line.startsWith('# ')) { title = line.slice(2).replace('Chat Session: ', '').trim(); }
      else if (line === '---') { flush(); history.push({ role: 'system', content: '__compacted__' }); }
      else if (line === '### User') { flush(); currentRole = 'user'; }
      else if (line === '### Assistant') { flush(); currentRole = 'assistant'; }
      else if (currentRole && !line.startsWith('> ')) { currentContent.push(line); }
    }
    flush();

    if (history.length === 0) { vscode.window.showWarningMessage('No messages found in file.'); return; }

    const id = this._sessionManager.createNewSession();
    const sessions = this._sessionManager.getSessions();
    sessions[id].title = title;
    sessions[id].history = history;
    sessions[id].tokens.input = estimateHistoryTokens(history);
    this._saveState();
    this._loadAllSessions();
    vscode.window.showInformationMessage(`Imported "${title}" â€” ${history.filter(m => m.role !== 'system').length} messages.`);
  }

  private async _updateSessionHistory(text: string) {
    if (!text.trim()) return; // never store empty assistant messages
    const sessions = this._sessionManager.getSessions();
    const s = sessions[this._sessionManager.getCurrentSessionId()];
    if (s) {
      s.history.push({ role: 'assistant', content: text });
      s.tokens.output += estimateTokens(text);
      s.lastModified = Date.now();
      const firstUserMsg = s.history.find(m => m.role === 'user');
      if (s.title === 'Untitled' && firstUserMsg) {
        s.title = firstUserMsg.content.slice(0, 25) + '...';
        this._saveState();
        this._postSessionTitleUpdate(s.id, s.title);
        try {
          const userMsg = firstUserMsg.content.slice(0, 200);
          const prompt = `Summarize this user request into a concise 3-word title (no quotes, no punctuation): "${userMsg}"`;
          const cfg = vscode.workspace.getConfiguration('grom');
          const titleUrl = cfg.get<string>('apiUrl') || 'http://127.0.0.1:11434';
          const titleUseOllama = cfg.get<boolean>('useOllamaFormat') ?? true;
          const { key: titleKey, authType: titleAuthType, providerFormat: titleFormat } = await this._resolveProviderKey(titleUrl, titleUseOllama);
          const titleClient = new LocalLLMClient(titleUrl, cfg.get<string>('model') || 'qwen2.5-coder', titleUseOllama, titleKey, titleAuthType, titleFormat);
          const titleAbort = new AbortController();
          const titleTimeout = setTimeout(() => titleAbort.abort(), 8000);
          const aiTitle = await titleClient.chat([{ role: 'user', content: prompt }], titleAbort.signal);
          clearTimeout(titleTimeout);
          if (aiTitle) {
            const freshSessions = this._sessionManager.getSessions();
            if (freshSessions[s.id]) {
              freshSessions[s.id].title = aiTitle.replace(/["'.!]/g, '').trim().slice(0, 30);
              this._saveState();
              this._postSessionTitleUpdate(s.id, freshSessions[s.id].title);
            }
          }
        } catch {}
      } else {
        this._saveState();
        this._updateUsageDisplay();
      }
    }
  }

  /** Updates just the session title in the sidebar without re-rendering the full chat. */
  private _postSessionTitleUpdate(sessionId: string, title: string) {
    this._view?.webview.postMessage({ type: 'sessionTitleUpdate', sessionId, title });
  }

  /** Pings the LLM server, fetches available models and capabilities, and posts the status to the webview. */
  private async _checkConnection(overrideUrl?: string, overrideModel?: string, overrideOllama?: boolean) {
    const config = vscode.workspace.getConfiguration('grom');
    const rawUrl = overrideUrl || config.get<string>('apiUrl') || 'http://127.0.0.1:11434';
    const model = overrideModel || config.get<string>('model') || 'qwen2.5-coder';
    const useOllama = overrideOllama ?? (config.get<boolean>('useOllamaFormat') ?? true);
    let url: string;
    try { new URL(rawUrl); url = rawUrl; } catch {
      this._view?.webview.postMessage({ type: 'statusUpdate', status: 'Invalid URL', color: 'var(--vscode-errorForeground)', url: rawUrl, useOllama });
      return;
    }
    log(`[connection] checking ${url} model=${model}`);
    try {
      await this._mcp.waitForReady(2000); // Wait briefly for MCP servers on first connect
      const { key, authType, providerFormat } = await this._resolveProviderKey(url, useOllama);
      const client = new LocalLLMClient(url, model, useOllama, key, authType, providerFormat);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const models = await client.getAvailableModels(controller.signal);
      clearTimeout(timeout);

      // If the stored model isn't served by this provider, snap to the first available one.
      const activeModel = models.length > 0 && !models.includes(model) ? models[0] : model;
      if (activeModel !== model) {
        await vscode.workspace.getConfiguration('grom').update('model', activeModel, vscode.ConfigurationTarget.Global);
      }

      const mcpToolCount = this._mcp.getAllTools().length;
      const rawProviders = vscode.workspace.getConfiguration('grom').get<any[]>('customProviders') || [];
      const customProviders = await Promise.all(rawProviders.map(async (cp: any) => ({
        name: cp.name, url: cp.url, useOllamaFormat: cp.useOllamaFormat, authType: cp.authType || 'bearer',
        hasKey: !!(await this._context.secrets.get(`grom.key.custom.${cp.name}`))
      })));

      // For OpenAI-compat providers, getCapabilities() reuses the /v1/models response
      // already fetched by getAvailableModels() — no extra network request.
      const capsClient = activeModel !== model
        ? new LocalLLMClient(url, activeModel, useOllama, key, authType, providerFormat)
        : client;
      const caps = await capsClient.getCapabilities();
      if (mcpToolCount > 0) caps.tools = true;

      // Auto-detect context length — cloud providers won't respond and fall through silently
      const detectedCtx = await fetchContextLength(url, activeModel);
      if (detectedCtx) {
        this._detectedContextLength = detectedCtx;
        log(`[connection] detected context length: ${this._detectedContextLength}`);
      }

      log(`[connection] connected — model=${activeModel} models=[${models.join(', ')}] caps=${JSON.stringify(caps)} mcpTools=${mcpToolCount}`);
      this._view?.webview.postMessage({ type: 'statusUpdate', status: 'Connected', color: 'var(--vscode-testing-iconPassedColor)', url, model: activeModel, models, caps, useOllama, customProviders });
    } catch (err: any) {
      const isNetworkError = err.message?.includes('fetch failed') || err.name === 'AbortError' || err.message?.includes('ECONNREFUSED');
      logError(`[connection] failed (${isNetworkError ? 'network' : 'error'})`, err);
      this._view?.webview.postMessage({ type: 'statusUpdate', status: isNetworkError ? 'Disconnected' : 'Error', color: 'var(--vscode-errorForeground)', url, useOllama });
    }
  }

  /** Calculates token counts and estimated cost for the current session and sends them to the webview footer. */
  private _updateUsageDisplay() {
    const sessions = this._sessionManager.getSessions();
    const s = sessions[this._sessionManager.getCurrentSessionId()];
    if (!s || !this._view) return;
    const config = vscode.workspace.getConfiguration('grom');
    const pricing = config.get<Record<string, any>>('modelPricing') || {};
    const model = config.get<string>('model') || 'qwen2.5-coder';
    const modelKey = Object.keys(pricing).find(k => model.toLowerCase().includes(k.toLowerCase()));
    // 8192 default is more representative of typical local models than 32000
    const p = modelKey ? pricing[modelKey] : { input: 0, output: 0, context: 8192 };
    // Prefer auto-detected context length over manual config over default
    const contextLength = this._detectedContextLength ?? p.context ?? 8192;
    // Derive live token count from actual history so the circle fills as the conversation grows
    const liveTokens = estimateHistoryTokens(s.history) + s.tokens.output;
    const contextPercent = Math.min(100, Math.round((liveTokens / contextLength) * 100));
    this._view.webview.postMessage({
      type: 'usageUpdate',
      inputTokens: s.tokens.input,
      outputTokens: s.tokens.output,
      inputCost: (s.tokens.input / 1000000) * p.input,
      outputCost: (s.tokens.output / 1000000) * p.output,
      contextPercent,
      contextWindow: contextLength
    });

    // Fire a once-per-session hint when context is 80%+ full
    const hintsEnabled = config.get<boolean>('hints', true);
    const sessionId = this._sessionManager.getCurrentSessionId();
    if (hintsEnabled && contextPercent >= 80 && !this._contextHintSent.has(sessionId)) {
      this._contextHintSent.add(sessionId);
      this._view.webview.postMessage({ type: 'gromHint', hint: 'context', percent: contextPercent });
    }
  }

  /** Delegates to AgentLoop.run() — context assembly, tool execution, and streaming all happen there. */
  private async _handleChat(text: string, images?: string[], mode: 'plan' | 'build' = 'plan') {
    if (!this._view) return;
    this._isStreaming = true;
    try {
      const session = this._sessionManager.getCurrentSession();
      await this._agentLoop.run(text, images, mode, session,
        () => this._saveState(),
        () => this._updateUsageDisplay()
      );
      const backups = this._agentLoop.getBackups();
      if (backups.size > 0) {
        this._view?.webview.postMessage({ type: 'agentWritesDone', files: [...backups.keys()] });
      }
    } finally {
      this._isStreaming = false;
      this._checkConnection();
      if (!this._view?.visible) {
        const summary = (text.slice(0, 60) + (text.length > 60 ? '…' : '')).replace(/"/g, "'");
        // Show within VS Code notification area
        vscode.window.showInformationMessage(`Grom — task complete: "${summary}"`);
        // Also fire a Windows OS toast so it surfaces when VS Code is minimized
        if (process.platform === 'win32') {
          const { exec } = require('child_process') as typeof import('child_process');
          exec(`powershell -NoProfile -WindowStyle Hidden -Command "` +
            `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;` +
            `$t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02;` +
            `$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t);` +
            `$x.GetElementsByTagName('text')[0].AppendChild($x.CreateTextNode('Grom')) | Out-Null;` +
            `$x.GetElementsByTagName('text')[1].AppendChild($x.CreateTextNode('${summary}')) | Out-Null;` +
            `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Grom').Show([Windows.UI.Notifications.ToastNotification]::new($x));"`,
            { timeout: 5000 }
          );
        }
      }
    }
  }

  /** Loads the webview HTML from media/webview.html and substitutes the CSP and asset URIs.
   *  Keeping markup in a separate file makes it editable without recompiling TypeScript. */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const mediaUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', file)).toString();
    const resourceUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'resources', file)).toString();
    const stripSvgDecl = (s: string) => s.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '').trim();
    const idleSvgRaw = stripSvgDecl(fs.readFileSync(path.join(this._context.extensionUri.fsPath, 'resources', 'grom-plan.svg'), 'utf8'));
    const buildSvgRaw = stripSvgDecl(fs.readFileSync(path.join(this._context.extensionUri.fsPath, 'resources', 'grom-build.svg'), 'utf8'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; connect-src http://127.0.0.1:* http://localhost:* https: ws://127.0.0.1:* ws://localhost:*;`;
    const htmlPath = path.join(this._context.extensionUri.fsPath, 'media', 'webview.html');
    return fs.readFileSync(htmlPath, 'utf8')
      .replace('{{CSP}}', csp)
      .replace('{{MARKED_JS}}', mediaUri('marked.min.js'))
      .replace('{{GITHUB_DARK_CSS}}', mediaUri('github-dark.min.css'))
      .replace('{{HIGHLIGHT_JS}}', mediaUri('highlight.min.js'))
      .replace('{{STYLES_CSS}}', mediaUri('styles.css'))
      .replace('{{MAIN_JS}}', mediaUri('main.js'))
      .replace('{{LOGO_INLINE_SVG}}', idleSvgRaw)
      .replace('{{LOGO_BUILD_SVG}}', buildSvgRaw)
      .replace(/\{\{LOGO_DEFAULT\}\}/g, resourceUri('grom-plan.svg'))
      .replace('{{LOGO_BUILDING}}', resourceUri('grom-build.svg'))
      .replace('{{LOGO_DISCONNECTED}}', resourceUri('grom-disconnect.svg'))
      .replace('{{LOGO_ERROR}}', resourceUri('grom-error.svg'));
  }
}

