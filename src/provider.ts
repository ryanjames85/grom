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
import { LocalLLMClient, ChatMessage } from './client';
import { SessionManager, ChatSession, TaskLogEntry } from './session';
import { getCustomPrompts } from './context';
import { insertCode, applyCode, diffCode, acceptDiff, diffAgentWrite } from './editor';
import { RagIndex } from './rag';
import { DocsIndex } from './docs-index';
import { McpManager } from './mcp';
import { AgentLoop } from './agent-loop';
import { estimateTokens, estimateHistoryTokens, getNonSystemMessages } from './utils';

export class LocalChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _sessionManager: SessionManager;
  private _mcp: McpManager;
  private _agentLoop: AgentLoop;
  private _pendingApprovals = new Map<string, (result: 'allow' | 'allowAll' | 'deny') => void>();
  private _isStreaming = false;

  constructor(private readonly _context: vscode.ExtensionContext, private readonly _rag?: RagIndex, private readonly _docs?: DocsIndex) {
    this._mcp = new McpManager();
    this._mcp.initialize();
    const initialSessions = this._context.workspaceState.get<Record<string, ChatSession>>('sessions', {
      'default': { id: 'default', title: 'Untitled', history: [], tokens: { input: 0, output: 0 }, lastModified: Date.now(), mode: 'plan' }
    });
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

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._context.extensionUri] };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

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
        if (e.affectsConfiguration('grom.mcpServers')) this._mcp.initialize();
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
          break;
        case 'send': await this._handleChat(data.text, data.images, data.mode); break;
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
        case 'newSession': this._createNewSession(); break;
        case 'switchSession': this._switchSession(data.sessionId); break;
        case 'deleteSession': this._deleteSession(data.sessionId); break;
        case 'compactSession': this._compactSession(); break;
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
          webviewView.webview.postMessage({ type: 'memorySaved' });
          break;
        }
        case 'setSystemPrompt': {
          const current = this._sessionManager.getCurrentSession();
          this._sessionManager.setSystemPrompt(current.id, data.prompt);
          this._saveState();
          webviewView.webview.postMessage({ type: 'systemPromptSaved' });
          break;
        }
        case 'getSystemPrompt': {
          const current = this._sessionManager.getCurrentSession();
          webviewView.webview.postMessage({ type: 'showSystemPrompt', prompt: current.systemPrompt || '' });
          break;
        }
        case 'updateMode': this._updateMode(data.mode); break;
        case 'updateHistory': await this._updateSessionHistory(data.text); break;
        case 'retryConnection': this._checkConnection(); break;
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
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-llm-dev.grom');
          break;
        case 'getFiles': {
          const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
          webviewView.webview.postMessage({ type: 'fileList', files: files.map(f => ({ name: f.fsPath.split(/[\\\/]/).pop(), path: f.fsPath })) });
          break;
        }
        case 'changeModel':
          await vscode.workspace.getConfiguration('grom').update('model', data.model, vscode.ConfigurationTarget.Global);
          await this._checkConnection();
          break;
        case 'changeProvider': {
          let newUrl: string;
          let isOllama: boolean;
          if (data.providerId === 'custom') {
            newUrl = data.url;
            isOllama = data.useOllamaFormat ?? false;
          } else {
            isOllama = data.providerId === 'ollama';
            newUrl = 'http://127.0.0.1:11434';
            if (data.providerId === 'lmstudio') newUrl = 'http://127.0.0.1:1234';
            else if (data.providerId === 'opencode') newUrl = 'https://api.opencode.ai';
            else if (data.providerId === 'openai') newUrl = 'https://api.openai.com';
          }
          await vscode.workspace.getConfiguration('grom').update('useOllamaFormat', isOllama, vscode.ConfigurationTarget.Global);
          await vscode.workspace.getConfiguration('grom').update('apiUrl', newUrl, vscode.ConfigurationTarget.Global);
          await this._checkConnection(newUrl, data.model || 'qwen2.5-coder', isOllama);
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
    const customGreeting = config.get<string>('customGreeting', '') || "Hey. I'm Grom. Ready when you are.";
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
      taskLog: current.taskLog || []
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
    this._sessionManager.createNewSession();
    this._saveState();
    this._loadAllSessions();
  }

  private _switchSession(id: string) {
    if (this._sessionManager.switchSession(id)) {
      this._saveState();
      this._loadAllSessions();
    }
  }

  private _deleteSession(id: string) {
    this._sessionManager.deleteSession(id);
    this._saveState();
    this._loadAllSessions();
  }

  private _compactSession() {
    const current = this._sessionManager.getCurrentSession();
    if (this._sessionManager.compactSession(current.id)) {
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
          const titleClient = new LocalLLMClient(cfg.get<string>('apiUrl') || 'http://127.0.0.1:11434', cfg.get<string>('model') || 'qwen2.5-coder', cfg.get<boolean>('useOllamaFormat') ?? true);
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
    try {
      const client = new LocalLLMClient(url, model, useOllama);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const models = await client.getAvailableModels(controller.signal);
      const caps = await client.getCapabilities(controller.signal);
      clearTimeout(timeout);
      const agentEnabled = vscode.workspace.getConfiguration('grom').get<boolean>('agentEnabled', true);
      const mcpToolCount = this._mcp.getAllTools().length;
      // Tools icon: show if model supports it OR Grom's own agent/MCP tools are active
      if (agentEnabled || mcpToolCount > 0) caps.tools = true;
      const customProviders = vscode.workspace.getConfiguration('grom').get<any[]>('customProviders') || [];
      this._view?.webview.postMessage({ type: 'statusUpdate', status: 'Connected', color: 'var(--vscode-testing-iconPassedColor)', url, model, models, caps, useOllama, customProviders });
    } catch (err: any) {
      const isNetworkError = err.message?.includes('fetch failed') || err.name === 'AbortError' || err.message?.includes('ECONNREFUSED');
      this._view?.webview.postMessage({ type: 'statusUpdate', status: isNetworkError ? 'Disconnected' : 'Error', color: 'var(--vscode-errorForeground)', url, useOllama });
    }
  }

  /** Calculates token counts and estimated cost for the current session and sends them to the webview footer. */
  private _updateUsageDisplay() {
    const sessions = this._sessionManager.getSessions();
    const s = sessions[this._sessionManager.getCurrentSessionId()];
    if (!s || !this._view) return;
    const pricing = vscode.workspace.getConfiguration('grom').get<Record<string, any>>('modelPricing') || {};
    const model = vscode.workspace.getConfiguration('grom').get<string>('model') || 'qwen2.5-coder';
    const modelKey = Object.keys(pricing).find(k => model.toLowerCase().includes(k.toLowerCase()));
    // 8192 default is more representative of typical local models than 32000
    const p = modelKey ? pricing[modelKey] : { input: 0, output: 0, context: 8192 };
    // Derive live token count from actual history so the circle fills as the conversation grows
    const liveTokens = estimateHistoryTokens(s.history) + s.tokens.output;
    this._view.webview.postMessage({
      type: 'usageUpdate',
      inputTokens: s.tokens.input,
      outputTokens: s.tokens.output,
      inputCost: (s.tokens.input / 1000000) * p.input,
      outputCost: (s.tokens.output / 1000000) * p.output,
      contextPercent: Math.min(100, Math.round((liveTokens / (p.context || 8192)) * 100)),
      contextWindow: p.context || 8192
    });
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
    const idleSvgRaw = stripSvgDecl(fs.readFileSync(path.join(this._context.extensionUri.fsPath, 'resources', 'idle-grom-logo.svg'), 'utf8'));
    const buildSvgRaw = stripSvgDecl(fs.readFileSync(path.join(this._context.extensionUri.fsPath, 'resources', 'building-grom-logo.svg'), 'utf8'));
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
      .replace(/\{\{LOGO_DEFAULT\}\}/g, resourceUri('idle-grom-logo.svg'))
      .replace('{{LOGO_BUILDING}}', resourceUri('building-grom-logo.svg'))
      .replace('{{LOGO_DISCONNECTED}}', resourceUri('not connected-grom-logo.svg'))
      .replace('{{LOGO_ERROR}}', resourceUri('error-grom-logo.svg'));
  }
}

