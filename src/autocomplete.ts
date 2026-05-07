/**
 * autocomplete.ts
 *
 * Inline code completion provider registered with VS Code's InlineCompletionItemProvider API.
 * Sends FIM (fill-in-the-middle) prompts to the configured LLM and returns ghost-text suggestions.
 *
 * Key behaviours:
 *   - Adaptive debounce: slows down automatically when the user rarely accepts suggestions
 *   - Partial accept: serving one word at a time on re-trigger instead of showing the full completion again
 *   - Extra context: open tabs and recently edited files are prepended to the FIM prompt for better suggestions
 *   - Per-language model overrides: grom.autocompleteLanguageModels lets you pin a fast model for completions
 *
 * NOTE: Only active for file types listed in CODE_LANGUAGES. The status bar item shows the current state
 * and doubles as a toggle button.
 */

import * as vscode from 'vscode';
import { LocalLLMClient } from './client';

const MAX_PREFIX_LINES = 50;
const MAX_SUFFIX_LINES = 20;
const MAX_CONTEXT_LINES = 40;
const DEBOUNCE_MIN = 300;
const DEBOUNCE_MAX = 1500;
const DEBOUNCE_DEFAULT = 500;

// Adaptive debounce: if the user rarely accepts suggestions, slow down to avoid wasting calls
let _debounceMs = DEBOUNCE_DEFAULT;
let _shown = 0;
let _accepted = 0;
const TUNE_EVERY = 30;
let _autocompleteContext: vscode.ExtensionContext | undefined;

function _recordShown() {
  _shown++;
  if (_shown % TUNE_EVERY === 0) _tuneDebounce();
}
function _recordAccepted() { _accepted++; }
function _tuneDebounce() {
  if (_shown < TUNE_EVERY) return;
  const rate = _accepted / _shown;
  if (rate < 0.1) _debounceMs = Math.min(_debounceMs + 150, DEBOUNCE_MAX);
  else if (rate > 0.4) _debounceMs = Math.max(_debounceMs - 75, DEBOUNCE_MIN);
  _autocompleteContext?.globalState.update('grom.autocomplete.debounceMs', _debounceMs);
  // Reset window
  _shown = 0; _accepted = 0;
  _updateTooltip();
}
function _updateTooltip() {
  if (!_statusBar) return;
  const enabled = vscode.workspace.getConfiguration('grom').get<boolean>('autocomplete', true);
  if (!enabled) return;
  const rate = _shown > 0 ? Math.round((_accepted / _shown) * 100) : '—';
  _statusBar.tooltip = `Grom autocomplete — accept rate: ${rate}%  ·  debounce: ${_debounceMs}ms`;
}

// Track recently edited files for context
const _recentEdits = new Map<string, { text: string; line: number }>();
/** Records the most recent edit position for a document so it can be included as context in future completions. */
export function trackEdit(document: vscode.TextDocument, line: number) {
  _recentEdits.set(document.fileName, { text: document.getText(), line });
  if (_recentEdits.size > 5) {
    const oldest = _recentEdits.keys().next().value;
    if (oldest) _recentEdits.delete(oldest);
  }
}

let _statusBar: vscode.StatusBarItem | undefined;

const CODE_LANGUAGES = new Set([
  'typescript','typescriptreact','javascript','javascriptreact','python','go','rust',
  'java','csharp','cpp','c','ruby','php','swift','kotlin','scala','r','lua','perl',
  'shellscript','powershell','sql','html','css','scss','less','json','yaml','toml','markdown'
]);

/** Creates the status bar item that shows autocomplete state and wires up the toggle command. */
export function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);

  const refreshBar = () => {
    const enabled = vscode.workspace.getConfiguration('grom').get<boolean>('autocomplete', true);
    _statusBar!.text = enabled ? '$(sparkle) Grom' : '$(circle-slash) Grom';
    _statusBar!.tooltip = enabled ? 'Grom autocomplete active — click to disable' : 'Grom autocomplete disabled — click to enable';
    _statusBar!.command = 'grom.toggleAutocomplete';
  };

  context.subscriptions.push(vscode.commands.registerCommand('grom.toggleAutocomplete', async () => {
    const cfg = vscode.workspace.getConfiguration('grom');
    const current = cfg.get<boolean>('autocomplete', true);
    await cfg.update('autocomplete', !current, vscode.ConfigurationTarget.Global);
    refreshBar();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('grom.autocomplete')) refreshBar();
  }));

  refreshBar();

  // Only show in code files
  const updateVisibility = (editor?: vscode.TextEditor) => {
    if (editor && CODE_LANGUAGES.has(editor.document.languageId)) {
      _statusBar!.show();
    } else {
      _statusBar!.hide();
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateVisibility));
  updateVisibility(vscode.window.activeTextEditor);

  return _statusBar;
}

export class GromInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private _debounceTimer: NodeJS.Timeout | undefined;
  private _lastRequestId = 0;
  private _partialBuffer = '';
  private _partialPosition?: vscode.Position;

  constructor(context?: vscode.ExtensionContext) {
    if (context) {
      _autocompleteContext = context;
      _debounceMs = context.globalState.get<number>('grom.autocomplete.debounceMs', DEBOUNCE_DEFAULT);
    }
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const config = vscode.workspace.getConfiguration('grom');
    if (!config.get<boolean>('autocomplete', true)) return null;

    // If triggered after partial accept, serve next word from buffer
    if (
      this._partialBuffer &&
      this._partialPosition &&
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
    ) {
      const nextWord = nextWordChunk(this._partialBuffer);
      if (nextWord) {
        this._partialBuffer = this._partialBuffer.slice(nextWord.length);
        return new vscode.InlineCompletionList([
          new vscode.InlineCompletionItem(nextWord, new vscode.Range(position, position))
        ]);
      }
      this._partialBuffer = '';
    }

    return new Promise((resolve) => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        _recordShown();
        if (token.isCancellationRequested) { resolve(null); return; }
        const requestId = ++this._lastRequestId;

        try {
          if (_statusBar) { _statusBar.text = '$(loading~spin) Grom'; _statusBar.tooltip = 'Grom: fetching completion…'; }
          const result = await this._fetchCompletion(document, position, token, config);
          if (_statusBar) { _statusBar.text = '$(sparkle) Grom'; _statusBar.tooltip = 'Grom autocomplete active'; }
          if (requestId !== this._lastRequestId || token.isCancellationRequested) { resolve(null); return; }
          if (!result) { resolve(null); return; }

          // Store full completion for partial accept
          this._partialBuffer = result;
          this._partialPosition = position;
          const firstChunk = nextWordChunk(result);
          this._partialBuffer = result.slice(firstChunk.length);

          const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
          // On accept, clear partial buffer (full accept)
          (item as any).command = { command: 'grom._clearPartial', title: 'Clear partial' };
          resolve(new vscode.InlineCompletionList([item]));
        } catch {
          if (_statusBar) { _statusBar.text = '$(sparkle) Grom'; _statusBar.tooltip = 'Grom autocomplete active'; }
          resolve(null);
        }
      }, _debounceMs);
    });
  }

  /** Clears the partial-accept buffer and records a full accept for the acceptance-rate tracker. */
  clearPartial() { this._partialBuffer = ''; this._partialPosition = undefined; _recordAccepted(); }

  private async _fetchCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    config: vscode.WorkspaceConfiguration
  ): Promise<string | null> {
    const lang = document.languageId;

    // Current file context
    const prefix = document.getText(new vscode.Range(
      new vscode.Position(Math.max(0, position.line - MAX_PREFIX_LINES), 0),
      position
    ));
    const suffix = document.getText(new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + MAX_SUFFIX_LINES), 0)
    ));

    // Extra context from open tabs and recent edits
    const extraContext = buildExtraContext(document, position);

    // Build FIM prompt — extra context goes before the FIM tokens as a comment block
    const contextHeader = extraContext
      ? `// === Related code from workspace ===\n${extraContext}\n// === Current file ===\n`
      : '';

    const fimPrompt = `${contextHeader}<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;

    const messages = [
      {
        role: 'system' as const,
        content: [
          `You are an expert code completion engine for ${lang}.`,
          'Complete the code exactly at the <|fim_middle|> position.',
          'Rules:',
          '- Return ONLY the completion text, nothing else',
          '- No markdown, no code fences, no explanations',
          '- Match the existing indentation and style',
          '- Complete the current expression, statement, or function body',
          '- If already complete, return empty string',
          '- Maximum 10 lines unless completing a full function'
        ].join('\n')
      },
      { role: 'user' as const, content: fimPrompt }
    ];

    const apiUrl = config.get<string>('apiUrl') || 'http://127.0.0.1:11434';
    const autocompleteLangModels = config.get<Record<string, string>>('autocompleteLanguageModels', {});
    const fallbackLangModels = config.get<Record<string, string>>('languageModels', {});
    const model = autocompleteLangModels[lang] || fallbackLangModels[lang] || config.get<string>('autocompleteModel') || config.get<string>('model') || 'qwen2.5-coder';
    const useOllama = config.get<boolean>('useOllamaFormat') ?? true;
    const apiKey = config.get<string>('apiKey', '');
    const client = new LocalLLMClient(apiUrl, model, useOllama, apiKey || undefined);
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    const raw = await client.chat(messages, controller.signal);
    const text = cleanCompletion(raw, lang);
    return text || null;
  }
}

/** Collects extra context from open same-language tabs and recently edited files to improve FIM quality. */
function buildExtraContext(current: vscode.TextDocument, position: vscode.Position): string {
  const chunks: string[] = [];
  const currentPath = current.fileName;
  const currentLang = current.languageId;

  // Open editor tabs — same language, not current file
  for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
    const input = tab.input as any;
    if (!input?.uri) continue;
    const uri: vscode.Uri = input.uri;
    if (uri.fsPath === currentPath) continue;
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    if (!doc || doc.languageId !== currentLang) continue;
    const lines = doc.getText().split('\n');
    // Take lines around imports + first MAX_CONTEXT_LINES meaningful lines
    const relevant = lines.filter(l => l.trim().length > 0).slice(0, MAX_CONTEXT_LINES).join('\n');
    if (relevant.trim()) chunks.push(`// File: ${vscode.workspace.asRelativePath(uri)}\n${relevant}`);
    if (chunks.length >= 2) break;
  }

  // Recently edited files
  for (const [filePath, edit] of _recentEdits) {
    if (filePath === currentPath) continue;
    const lines = edit.text.split('\n');
    const start = Math.max(0, edit.line - 10);
    const snippet = lines.slice(start, start + 20).join('\n');
    if (snippet.trim()) chunks.push(`// Recently edited: ${vscode.workspace.asRelativePath(filePath)}\n${snippet}`);
    if (chunks.length >= 3) break;
  }

  return chunks.join('\n\n').slice(0, 3000);
}

/** Strips markdown fences, FIM tokens, and refusal phrases that models sometimes emit despite instructions. */
function cleanCompletion(raw: string, lang: string): string {
  let text = raw.trim();
  // Strip markdown code fences if model ignored instructions
  text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  // Strip FIM tokens if echoed back
  text = text.replace(/<\|fim_(?:prefix|suffix|middle)\|>/g, '');
  // Strip common refusal phrases
  if (/^(I |Here |Sure|The completion|This code)/i.test(text)) return '';
  return text;
}

/** Returns the next word-boundary chunk from a completion string for partial-accept serving. */
function nextWordChunk(text: string): string {
  // Return up to the next word boundary + trailing space/punctuation
  const match = text.match(/^(\s*\S+\s*)/);
  return match ? match[1] : text;
}
