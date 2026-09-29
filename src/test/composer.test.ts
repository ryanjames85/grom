import { expect } from 'chai';
import { parseComposerResponse, diffLines, languageFromPath } from '../composer';

// ── parseComposerResponse ─────────────────────────────────────────────────────

describe('parseComposerResponse', () => {
  it('returns empty array for empty string', () => {
    expect(parseComposerResponse('')).to.deep.equal([]);
  });

  it('returns empty array when no file headers are present', () => {
    expect(parseComposerResponse('Here is some explanation without any files.')).to.deep.equal([]);
  });

  it('extracts a single ### path + fence block', () => {
    const response = '### src/index.ts\n```typescript\nconsole.log("hello");\n```';
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/index.ts');
    expect(patches[0].content).to.include('console.log');
  });

  it('extracts a ## path (single hash) block', () => {
    const response = '## src/index.ts\n```\nconsole.log("hello");\n```';
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/index.ts');
  });

  it('extracts a // FILE: path block', () => {
    const response = '// FILE: src/utils.ts\n```typescript\nexport const x = 1;\n```';
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/utils.ts');
  });

  it('extracts a /* FILE: path block', () => {
    const response = '/* FILE: src/utils.ts\n```\nexport const x = 1;\n```';
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/utils.ts');
  });

  it('extracts multiple files from one response', () => {
    const response = [
      '### src/a.ts\n```typescript\nconst a = 1;\n```',
      '### src/b.ts\n```typescript\nconst b = 2;\n```',
      '### src/c.ts\n```\nconst c = 3;\n```',
    ].join('\n\n');
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(3);
    expect(patches.map(p => p.path)).to.deep.equal(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('trims whitespace from the path', () => {
    const response = '###   src/index.ts   \n```\ncode\n```';
    const patches = parseComposerResponse(response);
    expect(patches[0].path).to.equal('src/index.ts');
  });

  it('preserves fence content including blank lines', () => {
    const response = '### foo.ts\n```\nline1\n\nline3\n```';
    const patches = parseComposerResponse(response);
    expect(patches[0].content).to.include('line1');
    expect(patches[0].content).to.include('line3');
  });

  it('ignores headers without an extension in the path', () => {
    // "README" has no dot, so it won't match \.[\w]+ requirement
    const response = '### README\n```\ncontent\n```';
    expect(parseComposerResponse(response)).to.deep.equal([]);
  });

  it('is case-insensitive on fence language tag', () => {
    const response = '### src/App.TSX\n```TypeScript\nconst x = 1;\n```';
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/App.TSX');
  });

  it('handles prose between file blocks', () => {
    const response = 'Here is file one:\n### a.ts\n```\nconst a = 1;\n```\nAnd file two:\n### b.ts\n```\nconst b = 2;\n```';
    const patches = parseComposerResponse(response);
    expect(patches).to.have.length(2);
  });
});

// ── diffLines ─────────────────────────────────────────────────────────────────

describe('diffLines', () => {
  it('returns empty sets for two empty arrays', () => {
    const result = diffLines([], []);
    expect(result.added).to.deep.equal([]);
    expect(result.modified).to.deep.equal([]);
  });

  it('returns empty sets for identical arrays', () => {
    const result = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(result.added).to.deep.equal([]);
    expect(result.modified).to.deep.equal([]);
  });

  it('marks all suggested lines as added when original is empty', () => {
    // The LCS backtracking walk is high-to-low so insertion order is reversed;
    // use members (order-independent) rather than deep.equal.
    const result = diffLines([], ['a', 'b', 'c']);
    expect(result.added).to.have.members([0, 1, 2]);
    expect(result.modified).to.deep.equal([]);
  });

  it('returns empty sets when suggested is empty (pure deletion)', () => {
    const result = diffLines(['a', 'b', 'c'], []);
    expect(result.added).to.deep.equal([]);
    expect(result.modified).to.deep.equal([]);
  });

  it('marks a changed line as modified (substitution)', () => {
    const result = diffLines(['a'], ['b']);
    expect(result.modified).to.include(0);
    expect(result.added).to.not.include(0);
  });

  it('marks new line appended at end as added (no deletion)', () => {
    const result = diffLines(['a', 'b'], ['a', 'b', 'c']);
    expect(result.added).to.include(2);
    expect(result.modified).to.not.include(2);
  });

  it('marks replacement line as modified, extra lines as added', () => {
    // original: ['a'], suggested: ['b', 'c']
    // 'a' is deleted, 'b' replaces it (modified at idx 0), 'c' is pure addition
    const result = diffLines(['a'], ['b', 'c']);
    expect(result.modified).to.include(0);
    expect(result.added).to.include(1);
  });

  it('handles single-line change in the middle of unchanged lines', () => {
    const result = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(result.modified).to.include(1);
    expect(result.added).to.deep.equal([]);
  });

  it('marks multiple new lines at end as added', () => {
    const result = diffLines(['a'], ['a', 'b', 'c']);
    expect(result.added).to.include(1);
    expect(result.added).to.include(2);
    expect(result.modified).to.deep.equal([]);
  });
});

// ── languageFromPath ──────────────────────────────────────────────────────────

describe('languageFromPath', () => {
  const cases: [string, string][] = [
    ['src/index.ts', 'typescript'],
    ['src/App.tsx', 'typescriptreact'],
    ['src/main.js', 'javascript'],
    ['src/App.jsx', 'javascriptreact'],
    ['src/utils.mjs', 'javascript'],
    ['app.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['App.java', 'java'],
    ['Program.cs', 'csharp'],
    ['main.c', 'c'],
    ['app.cpp', 'cpp'],
    ['config.json', 'json'],
    ['config.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['config.toml', 'toml'],
    ['README.md', 'markdown'],
    ['query.sql', 'sql'],
    ['deploy.sh', 'shellscript'],
    ['script.ps1', 'powershell'],
    ['style.css', 'css'],
    ['style.scss', 'scss'],
    ['index.html', 'html'],
    ['Makefile.mk', 'makefile'],
    ['shader.glsl', 'glsl'],
  ];

  for (const [path, expected] of cases) {
    it(`maps ${path.split('.').pop()} → ${expected}`, () => {
      expect(languageFromPath(path)).to.equal(expected);
    });
  }

  it('returns plaintext for an unknown extension', () => {
    expect(languageFromPath('file.xyz123')).to.equal('plaintext');
  });

  it('returns plaintext for a file with no extension that is not in the map', () => {
    // split('.').pop() returns the full name for dotless files, only known names like
    // 'makefile' or 'dockerfile' map to a language; truly unknown ones fall back to plaintext.
    expect(languageFromPath('UNKNOWN_DOTLESS_FILE')).to.equal('plaintext');
  });

  it('is case-insensitive for extensions', () => {
    expect(languageFromPath('src/App.TS')).to.equal('typescript');
    expect(languageFromPath('src/App.PY')).to.equal('python');
  });
});
