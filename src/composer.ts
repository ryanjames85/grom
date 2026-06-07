/**
 * composer.ts
 *
 * Pure, vscode-free parsing and diff utilities for the /compose multi-file workflow.
 * Parses model output into file patches, and provides a line-level LCS diff algorithm
 * used to highlight added/modified lines in the diff view.
 *
 * NOTE: This file has zero VS Code imports so it can be unit-tested without stubs.
 * All VS Code integration (applying patches, opening diffs, progress notifications) lives in editor.ts.
 */

export interface FilePatch {
  path: string;
  content: string;
}

/** Parses a /compose model response into a list of file patches by extracting ### path + code-fence blocks. */
export function parseComposerResponse(response: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const fileHeaderRe = /(?:^|\n)(?:###?\s+|\/\/\s*FILE:\s*|\/\*\s*FILE:\s*)([^\n`]+\.[\w]+)\s*\n+```[\w]*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fileHeaderRe.exec(response)) !== null) {
    const filePath = m[1].trim();
    const content = m[2];
    if (filePath && content !== undefined) patches.push({ path: filePath, content });
  }
  return patches;
}

/** LCS-based line diff — returns 0-based line indices in the suggested output that were added or modified. */
export function diffLines(original: string[], suggested: string[]): { added: number[]; modified: number[] } {
  const m = original.length, n = suggested.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = original[i - 1] === suggested[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const added: number[] = [];
  const modified: number[] = [];
  let i = m, j = n;
  const deletedOrigLines = new Set<number>();
  const outputAdded = new Set<number>();

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1] === suggested[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      outputAdded.add(j - 1);
      j--;
    } else {
      deletedOrigLines.add(i - 1);
      i--;
    }
  }

  for (const lineIdx of outputAdded) {
    if (deletedOrigLines.size > 0 && lineIdx < original.length) modified.push(lineIdx);
    else added.push(lineIdx);
  }

  return { added, modified };
}

/** Maps a file extension to its VS Code language identifier for syntax highlighting in diff views.
 *  Used only for new files — existing files use the open document's languageId directly. */
export function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    // Web
    ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
    mjs: 'javascript', cjs: 'javascript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    vue: 'vue', svelte: 'svelte', graphql: 'graphql', gql: 'graphql',
    // Backend / general purpose
    py: 'python', rb: 'ruby', php: 'php', java: 'java', cs: 'csharp',
    go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    dart: 'dart', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
    // Systems
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    m: 'objective-c', mm: 'objective-cpp',
    d: 'd', vb: 'vb',
    // Scripting
    sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'shellscript',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    bat: 'bat', cmd: 'bat',
    lua: 'lua', pl: 'perl', pm: 'perl',
    r: 'r', jl: 'julia',
    ex: 'elixir', exs: 'elixir',
    erl: 'erlang', hrl: 'erlang',
    hs: 'haskell', lhs: 'haskell',
    fs: 'fsharp', fsx: 'fsharp', fsi: 'fsharp',
    ml: 'ocaml', mli: 'ocaml',
    clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
    elm: 'elm', purs: 'purescript',
    nim: 'nim', zig: 'zig', cr: 'crystal',
    // Config / data
    json: 'json', jsonc: 'jsonc',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml', xml: 'xml', svg: 'xml', plist: 'xml',
    md: 'markdown', mdx: 'mdx',
    sql: 'sql', proto: 'proto',
    tf: 'terraform', hcl: 'hcl',
    ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', env: 'dotenv',
    // Build / infra
    dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', cmake: 'cmake',
    // Docs
    tex: 'latex', bib: 'bibtex', rst: 'restructuredtext',
    // Shaders
    glsl: 'glsl', vert: 'glsl', frag: 'glsl', hlsl: 'hlsl', wgsl: 'wgsl',
    // Misc
    coffee: 'coffeescript', erb: 'erb',
  };
  return map[ext] || 'plaintext';
}
