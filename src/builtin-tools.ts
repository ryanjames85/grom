/**
 * builtin-tools.ts
 *
 * Built-in file and terminal tools that are always available in the agent loop,
 * regardless of whether any MCP servers are configured. These give Grom the ability
 * to read, write, search, and run commands in the workspace out of the box.
 *
 * Tool definitions (BUILTIN_TOOLS) follow the same McpTool shape used by MCP tools
 * so they can be passed to buildToolSystemPrompt() alongside any MCP tools.
 *
 * NOTE: write_file, delete_file, and run_terminal are considered destructive — they
 * modify state that may be hard to reverse. provider.ts gates these on user approval
 * before execution. read_file, list_directory, and search_files are safe and auto-execute.
 */

import * as vscode from 'vscode';
import { stripHtml } from './utils';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, any>; required?: string[] };
}

/** All built-in tools exposed to the agent loop. Passed to buildToolSystemPrompt() at chat time. */
export const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Returns the file text.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path to the file' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the given content. Creates parent directories automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file' },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a workspace path. Excludes node_modules, .git, out, dist.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path to list (omit for root)' } }
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace (moves to trash so it can be recovered).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path to the file' } },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description: 'Search for a text or regex pattern across workspace files. Returns matching lines with file:line references.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex to search for' },
        glob: { type: 'string', description: 'File glob filter, e.g. "**/*.ts" (defaults to all files)' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'run_terminal',
    description: 'Run a shell command in the workspace and return its stdout/stderr output. Use for build, test, lint, and install commands.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute' } },
      required: ['command']
    }
  },
  {
    name: 'browse_web',
    description: 'Fetch a web page and return its readable text content. Use to read documentation, check live APIs, or research topics online. Safe — read only.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to fetch, e.g. https://example.com/docs' } },
      required: ['url']
    }
  }
];

/** Directories excluded from list_directory results to avoid noise. */
const BLOCKED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', '__pycache__']);

/** Returns true if the given tool name is a built-in (vs an MCP tool). */
export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOLS.some(t => t.name === name);
}

/**
 * Executes a built-in tool by name with the given args.
 * All file paths are validated through safePath() to prevent directory traversal.
 * Returns a string result that is fed back to the model as the tool's output.
 */
export async function executeBuiltinTool(name: string, args: Record<string, any>): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders?.[0]?.uri;

  /**
   * Resolves a workspace-relative path to a VS Code URI, rejecting any attempt
   * to escape the workspace root via ".." or absolute paths.
   */
  function safePath(raw: string): { uri: vscode.Uri; rel: string } | { error: string } {
    if (!root) return { error: 'No workspace folder open.' };
    // Normalize and prevent absolute paths or traversal
    const rel = (raw as string).replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.includes('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
      return { error: 'Path traversal or absolute paths not allowed.' };
    }
    return { uri: vscode.Uri.joinPath(root, rel), rel };
  }

  switch (name) {
    case 'read_file': {
      const p = safePath(args.path);
      if ('error' in p) return `Error: ${p.error}`;
      try {
        const bytes = await vscode.workspace.fs.readFile(p.uri);
        let text = Buffer.from(bytes).toString('utf8');
        if ((args.path as string).endsWith('.ipynb')) {
          try {
            const nb = JSON.parse(text);
            if (Array.isArray(nb.cells)) {
              text = nb.cells.map((c: any, i: number) => {
                const src = Array.isArray(c.source) ? c.source.join('') : (c.source || '');
                return `# Cell ${i + 1} [${c.cell_type || 'code'}]\n${src}`;
              }).filter((s: string) => s.trim()).join('\n\n');
            }
          } catch { /* return raw if parse fails */ }
        }
        // Cap output to avoid flooding the model's context window
        return text.length > 20000 ? text.slice(0, 20000) + `\n...(truncated, ${text.length} total bytes)` : text;
      } catch (e: any) { return `Error reading ${args.path}: ${e.message}`; }
    }

    case 'write_file': {
      const p = safePath(args.path);
      if ('error' in p) return `Error: ${p.error}`;
      try {
        const parentUri = vscode.Uri.joinPath(p.uri, '..');
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(p.uri, Buffer.from(args.content as string, 'utf8'));
        // Open the file in a preview tab so the user can see what was written
        const doc = await vscode.workspace.openTextDocument(p.uri);
        vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        return `Written ${p.rel} (${(args.content as string).length} bytes)`;
      } catch (e: any) { return `Error writing ${args.path}: ${e.message}`; }
    }

    case 'list_directory': {
      const p = safePath((args.path as string) || '');
      if ('error' in p) return `Error: ${p.error}`;
      try {
        const uri = p.uri;
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const lines = entries
          .filter(([n]) => !BLOCKED_DIRS.has(n))
          .map(([n, t]) => `${t === vscode.FileType.Directory ? '[dir] ' : '[file]'} ${n}`);
        return lines.join('\n') || '(empty directory)';
      } catch (e: any) { return `Error listing ${args.path || 'root'}: ${e.message}`; }
    }

    case 'delete_file': {
      const p = safePath(args.path);
      if ('error' in p) return `Error: ${p.error}`;
      try {
        // useTrash ensures the file can be recovered from the OS trash if the agent makes a mistake
        await vscode.workspace.fs.delete(p.uri, { useTrash: true });
        return `Deleted ${p.rel} (moved to trash)`;
      } catch (e: any) { return `Error deleting ${args.path}: ${e.message}`; }
    }

    case 'search_files': {
      const pattern = args.pattern as string;
      const glob = (args.glob as string) || '**/*';
      const exclude = Array.from(BLOCKED_DIRS).map(d => `**/${d}/**`).join(',');
      try {
        let re: RegExp;
        try { re = new RegExp(pattern, 'gi'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); }

        async function performSearch(regex: RegExp): Promise<string[]> {
          const files = await vscode.workspace.findFiles(glob, `{${exclude}}`, 300);
          const results: string[] = [];
          for (const uri of files) {
            if (results.length >= 60) { results.push('...(more results omitted)'); break; }
            try {
              const bytes = await vscode.workspace.fs.readFile(uri);
              const text = Buffer.from(bytes).toString('utf8');
              const lines = text.split('\n');
              const rel = vscode.workspace.asRelativePath(uri);
              for (let i = 0; i < lines.length && results.length < 60; i++) {
                regex.lastIndex = 0;
                if (regex.test(lines[i])) results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
              }
            } catch { /* unreadable file — skip */ }
          }
          return results;
        }

        let matches = await performSearch(re);

        // Deep Dive Fallback: if no results found with regex, try a case-insensitive literal search
        if (matches.length === 0) {
          const fuzzyRe = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          matches = await performSearch(fuzzyRe);
        }

        return matches.length > 0 ? matches.join('\n') : 'No matches found.';
      } catch (e: any) { return `Error searching: ${e.message}`; }
    }

    case 'run_terminal': {
      const command = args.command as string;
      // Capture output via child_process so the result can be fed back to the model.
      // We show the terminal but don't send text to it to avoid double-execution.
      const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Grom Agent');
      terminal.show(true);
      return new Promise((resolve) => {
        const { exec } = require('child_process') as typeof import('child_process');
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        exec(command, { cwd, timeout: 30000, maxBuffer: 200000 }, (err, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
          const result = combined.slice(0, 6000) || (err ? `Process exited with code ${err.code}` : 'Command completed with no output');
          resolve(result);
        });
      });
    }

    case 'browse_web': {
      const url = args.url as string;
      if (!url?.startsWith('http')) return 'Error: url must start with http:// or https://';
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Grom/1.0)' } });
        if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;
        const html = await res.text();
        const text = stripHtml(html).slice(0, 8000);
        return `[${url}]\n\n${text}`;
      } catch (e: any) { return `Error fetching ${url}: ${e.message}`; }
    }

    default:
      return `Unknown built-in tool: ${name}`;
  }
}
