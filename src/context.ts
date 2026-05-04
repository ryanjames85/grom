/**
 * context.ts
 *
 * Resolves all user-facing context providers before a message is sent to the model.
 * Handles slash commands, web search, automatic file context, and @ mentions.
 *
 * @ mention providers supported:
 *   @filename     — attaches a workspace file by fuzzy name match
 *   @problems     — all current VS Code errors and warnings
 *   @git          — uncommitted diff (git diff HEAD)
 *   @terminal     — recent terminal output from terminal-buffer.ts
 *   @url:https:// — fetches and strips a web page
 *   @docs         — searches the DocsIndex (all sources)
 *   @docs:name    — searches a specific doc source by name
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getRecentTerminalOutput } from './terminal-buffer';
import type { DocsIndex } from './docs-index';
import { stripHtml } from './utils';

/** Expands a /slash command into its full prompt, appending the active editor's content.
 *  Also loads any custom prompts defined in .grom/*.md — so teams can add their own commands. */
export async function resolveSlashCommand(text: string): Promise<string> {
  const editor = vscode.window.activeTextEditor;
  const fileContent = editor ? `\n\n\`\`\`\n${editor.document.getText().slice(0, 8000)}\n\`\`\`` : '';
  const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
  const fileList = allFiles.map(f => vscode.workspace.asRelativePath(f)).join('\n');
  const commands: Record<string, string> = {
    '/explain': `Explain this code clearly. Describe what it does, how it works, and any important patterns:${fileContent}`,
    '/refactor': `Refactor this code for clarity, maintainability, and best practices. Explain the changes you made:${fileContent}`,
    '/fix': `Find and fix any bugs in this code. Explain what was wrong and what you changed:${fileContent}`,
    '/tests': `Write comprehensive unit tests for this code. Cover edge cases, happy paths, and error conditions:${fileContent}`,
    '/docs': `Write clear documentation for this code. Include descriptions, parameters, return values, and usage examples:${fileContent}`,
    '/review': `Review this code for bugs, security issues, performance problems, and style. Be thorough and specific:${fileContent}`,
    '/commit': `Based on the code changes shown, write a concise git commit message following conventional commits format:${fileContent}`,
    '/compose': `You are about to make changes across multiple files. The workspace contains these files:\n${fileList}\n\nDescribe what changes you want to make, and I will output the full updated content for each affected file.\n\nFor each file you modify, use this exact format:\n### path/to/file.ext\n\`\`\`lang\n<full file content>\n\`\`\`\n\nOnly include files that actually need to change.${fileContent}`,
  };

  // Load custom prompts from .grom/*.md in the workspace
  const customFiles = await vscode.workspace.findFiles('.grom/**/*.md', null, 50);
  for (const f of customFiles) {
    const name = path.basename(f.fsPath, '.md').toLowerCase();
    try {
      const bytes = await vscode.workspace.fs.readFile(f);
      commands[`/${name}`] = Buffer.from(bytes).toString() + fileContent;
    } catch { /* skip unreadable */ }
  }

  const cmd = Object.keys(commands).find(k => text.trim().toLowerCase().startsWith(k));
  return cmd ? commands[cmd] : text;
}

/** Returns the list of custom /commands from .grom/*.md — sent to the webview to populate the preset menu. */
export async function getCustomPrompts(): Promise<Array<{ label: string; text: string }>> {
  const files = await vscode.workspace.findFiles('.grom/**/*.md', null, 50);
  const result: Array<{ label: string; text: string }> = [];
  for (const f of files) {
    const base = path.basename(f.fsPath, '.md');
    result.push({ label: base, text: `/${base.toLowerCase()}` });
  }
  return result;
}

/** Handles /search <query> by calling DuckDuckGo's instant-answer API and returning formatted results.
 *  Returns null if the text isn't a /search command, so the caller can fall through to normal handling. */
export async function resolveWebSearch(text: string): Promise<string | null> {
  const match = text.match(/^\/search\s+(.+)/i);
  if (!match) return null;
  const query = match[1].trim();
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const data: any = await res.json();
    const results: string[] = [];
    if (data.AbstractText) results.push(`Summary: ${data.AbstractText}`);
    if (data.RelatedTopics?.length) {
      data.RelatedTopics.slice(0, 5).forEach((t: any) => {
        if (t.Text) results.push(`- ${t.Text}`);
      });
    }
    if (!results.length) return `No results found for "${query}". Please answer from your training knowledge.`;
    return `Web search results for "${query}":\n\n${results.join('\n')}\n\nBased on these results, please answer the query.`;
  } catch {
    return `Web search failed. Please answer from your training knowledge about: ${query}`;
  }
}

/** Auto-attaches workspace files whose names fuzzy-match words in the user's message.
 *  usedFiles prevents the same file being attached twice across multiple context passes. */
export async function findRelevantContext(text: string, usedFiles: Set<string>): Promise<string> {
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  let content = "";
  for (const word of words) {
    const matches = await vscode.workspace.findFiles(`**/*${word}*`, '**/node_modules/**', 2);
    for (const uri of matches) {
      const name = uri.fsPath.split(/[\\\/]/).pop() || "";
      if (!usedFiles.has(name)) {
        usedFiles.add(name);
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          content += `[File: ${name}]\n${Buffer.from(data).toString().slice(0, 2000)}\n\n`;
        } catch { /* file may have been deleted or is unreadable */ }
      }
    }
  }
  return content;
}

/** Scans the user's message for @ mentions and resolves each one to its context block.
 *  Returns a concatenated string ready to prepend to the system/user message. */
export async function resolveMentions(text: string, usedFiles: Set<string>, docsIndex?: DocsIndex): Promise<string> {
  const MAX_FILE_BYTES = 100_000;
  const matches = [...text.matchAll(/@(\S+)/g)];
  let content = "";

  for (const match of matches) {
    const name = match[1];

    // @problems — VS Code diagnostics (errors + warnings)
    if (name === 'problems') {
      const diags = vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, ds] of diags) {
        for (const d of ds) {
          if (d.severity <= vscode.DiagnosticSeverity.Warning) {
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
            lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1} [${sev}] ${d.message}`);
          }
        }
      }
      if (lines.length) content += `[Problems — ${lines.length} issue${lines.length > 1 ? 's' : ''}]\n${lines.slice(0, 60).join('\n')}\n\n`;
      else content += `[Problems]\nNo errors or warnings in workspace.\n\n`;
      continue;
    }

    // @git — current git diff
    if (name === 'git') {
      try {
        const { execSync } = require('child_process') as typeof import('child_process');
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
          const stat = execSync('git diff HEAD --stat', { cwd: root, timeout: 5000 }).toString().trim();
          const diff = execSync('git diff HEAD', { cwd: root, timeout: 5000 }).toString().slice(0, 8000);
          const combined = [stat, diff].filter(Boolean).join('\n\n');
          content += combined ? `[Git diff]\n${combined}\n\n` : `[Git diff]\nNo uncommitted changes.\n\n`;
        }
      } catch { content += `[Git diff]\nCould not retrieve git diff.\n\n`; }
      continue;
    }

    // @selection — currently selected text in the active editor
    if (name === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const selected = editor.document.getText(editor.selection);
        const lang = editor.document.languageId;
        const filename = editor.document.fileName.split(/[\\\/]/).pop() || '';
        content += `[Selection from ${filename}]\n\`\`\`${lang}\n${selected.slice(0, 8000)}\n\`\`\`\n\n`;
      } else {
        content += `[Selection]\nNo text selected in the active editor.\n\n`;
      }
      continue;
    }

    // @terminal — recent terminal output
    if (name === 'terminal') {
      const out = getRecentTerminalOutput().trim();
      content += out ? `[Terminal output]\n${out}\n\n` : `[Terminal output]\nNo recent terminal output captured.\n\n`;
      continue;
    }

    // @url:https://... — fetch a web page
    const urlMatch = name.match(/^url:(.+)/);
    if (urlMatch) {
      const rawUrl = urlMatch[1];
      try {
        const res = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) });
        const html = await res.text();
        const stripped = stripHtml(html).slice(0, 6000);
        content += `[URL: ${rawUrl}]\n${stripped}\n\n`;
      } catch {
        content += `[URL: ${rawUrl}]\nCould not fetch URL.\n\n`;
      }
      continue;
    }

    // @docs or @docs:sourcename — search indexed documentation
    const docsMatch = name.match(/^docs(?::(.+))?$/);
    if (docsMatch) {
      if (!docsIndex) { content += `[Docs]\nNo documentation sources indexed. Add URLs via grom.docSources.\n\n`; continue; }
      const sourceName = docsMatch[1];
      const sources = docsIndex.getSources();
      if (!sources.length) {
        content += `[Docs]\nNo documentation indexed yet. Indexing may still be in progress — try again in a moment.\n\n`;
        continue;
      }
      const result = docsIndex.query(text, sourceName, 4);
      const label = sourceName ? `Docs (${sourceName})` : `Docs (${sources.join(', ')})`;
      content += result ? `[${label}]\n${result}\n\n` : `[${label}]\nNo relevant documentation found.\n\n`;
      continue;
    }

    // @filename — workspace file
    const results = await vscode.workspace.findFiles(`**/${name}*`, '**/node_modules/**', 1);
    if (results.length > 0 && !usedFiles.has(name)) {
      usedFiles.add(name);
      try {
        const stat = await vscode.workspace.fs.stat(results[0]);
        if (stat.size > MAX_FILE_BYTES) {
          content += `[Attached: ${name}]\n*(file too large to include — ${Math.round(stat.size / 1024)}KB)*\n\n`;
          continue;
        }
        const data = await vscode.workspace.fs.readFile(results[0]);
        content += `[Attached: ${name}]\n${Buffer.from(data).toString()}\n\n`;
      } catch { /* file may have been deleted or is unreadable */ }
    }
  }
  return content;
}
