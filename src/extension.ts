/**
 * extension.ts
 *
 * VS Code extension entry point — owns all glue between the extension API and the pure logic modules.
 *
 * Responsibilities:
 *   - RAG: discovers workspace files, reads them, and calls ragIndex.build(). Watches for file changes
 *     and schedules a debounced re-index. Shows a one-time hint if no embedding model is configured.
 *   - Docs: reads grom.docSources from settings, calls docsIndex.indexAll(), and re-indexes on config change.
 *   - Status bar: creates the progress status items consumed by ragIndex and docsIndex onProgress callbacks.
 *   - Terminal error detection: watches terminal output for error patterns and offers a "Debug with Grom" shortcut.
 *   - Commands: registers all grom.* commands and wires them to the appropriate handlers.
 *   - Autocomplete: registers the inline completion provider and the edit-tracking hook.
 *
 * NOTE: No business logic lives here. This file exists only to connect VS Code's lifecycle events
 * to the modules that do the real work (provider.ts, rag.ts, docs-index.ts, autocomplete.ts, etc.).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { LocalChatViewProvider } from './provider';
import { GromInlineCompletionProvider, trackEdit, createStatusBar } from './autocomplete';
import { RagIndex, RagFile, INDEXED_EXTS, IGNORE_DIRS, MAX_FILE_KB } from './rag';
import { DocsIndex, DocSource } from './docs-index';
import { inlineEdit } from './inlineedit';
import { InlineDiffSession, undoLastComposer } from './editor';
import { appendTerminalOutput } from './terminal-buffer';
import { dispose as disposeLogger } from './logger';

function extractNotebookText(content: string): string {
  try {
    const nb = JSON.parse(content);
    if (!Array.isArray(nb.cells)) return content;
    return nb.cells.map((cell: any, i: number) => {
      const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
      return `# Cell ${i + 1} [${cell.cell_type || 'code'}]\n${src}`;
    }).filter((s: string) => s.trim()).join('\n\n');
  } catch { return content; }
}

export function activate(context: vscode.ExtensionContext) {
  const completionProvider = new GromInlineCompletionProvider(context);
  context.subscriptions.push(createStatusBar(context));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
    trackEdit(e.document, e.contentChanges[0]?.range.start.line ?? 0);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom._clearPartial', () => {
    completionProvider.clearPartial();
  }));

  // ── RAG ──────────────────────────────────────────────────────────────────
  const ragStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  context.subscriptions.push(ragStatusItem);

  const ragIndex = new RagIndex((msg) => {
    if (!msg) { ragStatusItem.hide(); return; }
    ragStatusItem.text = `$(sync~spin) Grom: ${msg}`;
    ragStatusItem.show();
    if (!msg.includes('…') && !msg.includes('...')) {
      setTimeout(() => ragStatusItem.hide(), 3000);
    }
  });

  const buildRag = async (force = false) => {
    const config = vscode.workspace.getConfiguration('grom');
    if (!config.get<boolean>('ragEnabled', true)) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;

    const uris = await vscode.workspace.findFiles('**/*', `**/{${[...IGNORE_DIRS].join(',')}}/**`, 2000);
    const files: RagFile[] = [];
    for (const uri of uris) {
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (!INDEXED_EXTS.has(ext)) continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_KB * 1024) continue;
        const bytes = await vscode.workspace.fs.readFile(uri);
        let content = Buffer.from(bytes).toString('utf8');
        if (ext === '.ipynb') content = extractNotebookText(content);
        files.push({ path: vscode.workspace.asRelativePath(uri), content });
      } catch { /* skip unreadable files */ }
    }

    const embeddingModel = config.get<string>('embeddingModel', '');
    const apiUrl = (config.get<string>('apiUrl') || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const embConfig = embeddingModel ? { model: embeddingModel, apiUrl } : undefined;

    await ragIndex.build(files, embConfig, force);

    // One-time hint if no embedding model is configured
    if (!embeddingModel && !context.globalState.get('grom.embeddingHintShown')) {
      await context.globalState.update('grom.embeddingHintShown', true);
      const action = await vscode.window.showInformationMessage(
        'Grom: enable semantic RAG for smarter code search. Run `ollama pull nomic-embed-text` then set it in Grom settings.',
        'Set Embedding Model', 'Dismiss'
      );
      if (action === 'Set Embedding Model') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'grom.embeddingModel');
      }
    }
  };

  buildRag();

  let _reindexTimer: NodeJS.Timeout | undefined;
  const _scheduleReindex = (uri: vscode.Uri) => {
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (!INDEXED_EXTS.has(ext)) return;
    clearTimeout(_reindexTimer);
    _reindexTimer = setTimeout(() => buildRag(true), 3000);
  };
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  fileWatcher.onDidCreate(_scheduleReindex);
  fileWatcher.onDidDelete(_scheduleReindex);
  fileWatcher.onDidChange(_scheduleReindex);
  context.subscriptions.push(fileWatcher);
  // Clear any pending reindex timer on deactivation — prevents the callback firing
  // against a disposed context if a file change triggered the 3-second debounce
  // right before the extension was deactivated.
  context.subscriptions.push({ dispose: () => clearTimeout(_reindexTimer) });

  context.subscriptions.push(vscode.commands.registerCommand('grom.reindex', () => {
    buildRag(true);
    vscode.window.showInformationMessage('Grom: reindexing workspace...');
  }));

  // ── Docs index ───────────────────────────────────────────────────────────
  const docsStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  context.subscriptions.push(docsStatusItem);

  const docsIndex = new DocsIndex((msg) => {
    if (!msg) { docsStatusItem.hide(); return; }
    docsStatusItem.text = `$(sync~spin) Grom: ${msg}`;
    docsStatusItem.show();
    if (!msg.includes('…') && !msg.includes('...')) {
      setTimeout(() => docsStatusItem.hide(), 2500);
    }
  });

  const getDocSources = (): DocSource[] =>
    vscode.workspace.getConfiguration('grom').get<DocSource[]>('docSources', []);

  docsIndex.indexAll(getDocSources());

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('grom.docSources')) {
      const sources = getDocSources();
      for (const s of sources) docsIndex.clearSource(s.name);
      docsIndex.indexAll(sources);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.reindexDocs', () => {
    const sources = getDocSources();
    if (!sources.length) { vscode.window.showInformationMessage('Grom: no doc sources configured. Add URLs via grom.docSources.'); return; }
    for (const s of sources) docsIndex.clearSource(s.name);
    docsIndex.indexAll(sources);
    vscode.window.showInformationMessage(`Grom: reindexing ${sources.length} doc source${sources.length > 1 ? 's' : ''}…`);
  }));

  // ── Provider + webview ───────────────────────────────────────────────────
  const provider = new LocalChatViewProvider(context, ragIndex, docsIndex);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('localChatView', provider, {
    webviewOptions: { retainContextWhenHidden: true }
  }));

  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('grom.popout', {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      provider.restorePopout(panel);
    }
  }));

  const promptWatcher = vscode.workspace.createFileSystemWatcher('**/.grom/**/*.md');
  const _refreshPresets = () => provider.refreshPresets();
  promptWatcher.onDidCreate(_refreshPresets);
  promptWatcher.onDidDelete(_refreshPresets);
  promptWatcher.onDidChange(_refreshPresets);
  context.subscriptions.push(promptWatcher);

  // ── Terminal ─────────────────────────────────────────────────────────────
  // onDidWriteTerminalData is a proposed API — wrap in try/catch so activation doesn't fail
  // in environments that block proposed APIs (published extension installs, stable VS Code).
  let _lastTerminalError = '';
  let _errorDebounce: NodeJS.Timeout | undefined;
  try {
    const onTerminalData = (vscode.window as any).onDidWriteTerminalData;
    if (typeof onTerminalData === 'function') {
      context.subscriptions.push(onTerminalData((e: any) => {
        const text: string = e.data || '';
        appendTerminalOutput(text);
        const errorPatterns = /error:|exception:|traceback|typeerror|syntaxerror|cannot find|failed to|undefined is not|null is not|ENOENT|EACCES|ECONNREFUSED/i;
        if (errorPatterns.test(text)) {
          _lastTerminalError += text;
          clearTimeout(_errorDebounce);
          _errorDebounce = setTimeout(async () => {
            const err = _lastTerminalError.trim().slice(-1000);
            _lastTerminalError = '';
            const action = await vscode.window.showWarningMessage(
              'Grom detected an error in the terminal.',
              'Debug with Grom', 'Dismiss'
            );
            if (action === 'Debug with Grom') {
              await vscode.commands.executeCommand('workbench.view.extension.grom-container');
              provider.postMessageToWebview({ type: 'triggerAction', text: `I'm getting this error in my terminal. How do I fix it?\n\n\`\`\`\n${err}\n\`\`\`` });
            }
          }, 1500);
        }
      }));
    }
  } catch { /* proposed API not available in this VS Code build — @terminal context will be empty */ }

  // ── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(vscode.commands.registerCommand('grom.start', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.grom-container');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.explain', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.document.getText(editor.selection);
      await vscode.commands.executeCommand('workbench.view.extension.grom-container');
      provider.postMessageToWebview({ type: 'triggerAction', text: `Explain this code:\n\n\`\`\`\n${selection}\n\`\`\`` });
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.refactor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.document.getText(editor.selection);
      await vscode.commands.executeCommand('workbench.view.extension.grom-container');
      provider.postMessageToWebview({ type: 'triggerAction', text: `Refactor this code:\n\n\`\`\`\n${selection}\n\`\`\`` });
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.acceptInlineDiff', async () => {
    await InlineDiffSession.getCurrent()?.accept();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.rejectInlineDiff', async () => {
    await InlineDiffSession.getCurrent()?.reject();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.compose', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.grom-container');
    provider.postMessageToWebview({ type: 'triggerAction', text: '/compose' });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.undoComposer', async () => {
    await undoLastComposer();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.inlineEdit', async () => {
    await inlineEdit(context);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.toggleVoiceInput', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.grom-container');
    provider.toggleVoice();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('grom.terminalDebug', async () => {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const clipboard = await vscode.env.clipboard.readText();
    if (clipboard) {
      await vscode.commands.executeCommand('workbench.view.extension.grom-container');
      provider.postMessageToWebview({ type: 'triggerAction', text: `I am getting this error in my terminal. How do I fix it?\n\n\`\`\`\n${clipboard}\n\`\`\`` });
    } else {
      vscode.window.showInformationMessage('Please select the error text in the terminal first.');
    }
  }));

  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    completionProvider
  ));

  context.subscriptions.push({ dispose: disposeLogger });
  // Close the voice browser on deactivation so Chrome doesn't show "Restore pages?" next launch.
  context.subscriptions.push({ dispose: () => void provider.disposeVoice() });
}
