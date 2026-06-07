import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { parseComposerResponse, diffLines, languageFromPath } from '../composer';

const editorSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'editor.ts'), 'utf8');

describe('parseComposerResponse', () => {

  it('parses a single file block with ### header', () => {
    const res = `### src/utils/helper.ts\n\`\`\`typescript\nexport function add(a: number, b: number) { return a + b; }\n\`\`\``;
    const patches = parseComposerResponse(res);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/utils/helper.ts');
    expect(patches[0].content).to.include('export function add');
  });

  it('parses multiple file blocks', () => {
    const res = [
      '### src/a.ts',
      '```typescript',
      'const a = 1;',
      '```',
      '',
      '### src/b.ts',
      '```typescript',
      'const b = 2;',
      '```'
    ].join('\n');
    const patches = parseComposerResponse(res);
    expect(patches).to.have.length(2);
    expect(patches[0].path).to.equal('src/a.ts');
    expect(patches[1].path).to.equal('src/b.ts');
  });

  it('parses FILE: comment style header', () => {
    const res = `// FILE: src/config.json\n\`\`\`json\n{"key":"value"}\n\`\`\``;
    const patches = parseComposerResponse(res);
    expect(patches).to.have.length(1);
    expect(patches[0].path).to.equal('src/config.json');
  });

  it('returns empty array for plain prose with no file blocks', () => {
    const patches = parseComposerResponse('Here is my explanation of the code.');
    expect(patches).to.have.length(0);
  });

  it('preserves multi-line file content', () => {
    const content = 'line one\nline two\nline three';
    const res = `### src/multi.ts\n\`\`\`typescript\n${content}\n\`\`\``;
    const patches = parseComposerResponse(res);
    expect(patches[0].content.trim()).to.equal(content);
  });

  it('handles various file extensions', () => {
    const exts = ['ts', 'py', 'go', 'rs', 'json', 'yaml', 'md'];
    for (const ext of exts) {
      const res = `### src/file.${ext}\n\`\`\`\ncode\n\`\`\``;
      const patches = parseComposerResponse(res);
      expect(patches).to.have.length(1, `failed for .${ext}`);
      expect(patches[0].path).to.equal(`src/file.${ext}`);
    }
  });
});

describe('diffLines', () => {
  it('returns empty for identical content', () => {
    const lines = ['a', 'b', 'c'];
    const { added, modified } = diffLines(lines, lines);
    expect(added).to.be.empty;
    expect(modified).to.be.empty;
  });

  it('detects a single added line', () => {
    const orig = ['a', 'b', 'c'];
    const sugg = ['a', 'b', 'NEW', 'c'];
    const { added, modified } = diffLines(orig, sugg);
    expect([...added, ...modified]).to.have.length(1);
  });

  it('detects a modified line', () => {
    const orig = ['a', 'b', 'c'];
    const sugg = ['a', 'CHANGED', 'c'];
    const { added, modified } = diffLines(orig, sugg);
    expect([...added, ...modified]).to.have.length(1);
  });

  it('handles completely replaced content', () => {
    const orig = ['old1', 'old2'];
    const sugg = ['new1', 'new2'];
    const { added, modified } = diffLines(orig, sugg);
    expect([...added, ...modified]).to.have.length(2);
  });

  it('handles empty original', () => {
    const { added, modified } = diffLines([], ['a', 'b']);
    expect([...added, ...modified]).to.have.length(2);
  });

  it('handles empty suggested (all removed)', () => {
    const { added, modified } = diffLines(['a', 'b', 'c'], []);
    expect([...added, ...modified]).to.have.length(0);
  });

  it('handles both inputs empty', () => {
    const { added, modified } = diffLines([], []);
    expect(added).to.be.empty;
    expect(modified).to.be.empty;
  });
});

describe('parseComposerResponse sad path', () => {
  it('returns empty array for empty string', () => {
    expect(parseComposerResponse('')).to.deep.equal([]);
  });

  it('ignores file header with no following code fence', () => {
    const patches = parseComposerResponse('### src/foo.ts\nJust some prose, no fence.');
    expect(patches).to.have.length(0);
  });

  it('ignores code fence with no preceding file header', () => {
    const patches = parseComposerResponse('```typescript\nconst x = 1;\n```');
    expect(patches).to.have.length(0);
  });

  it('does not crash on very large input', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    expect(() => parseComposerResponse(big)).to.not.throw();
  });
});

describe('languageFromPath', () => {
  it('returns correct id for core web extensions', () => {
    expect(languageFromPath('app.ts')).to.equal('typescript');
    expect(languageFromPath('app.tsx')).to.equal('typescriptreact');
    expect(languageFromPath('app.js')).to.equal('javascript');
    expect(languageFromPath('app.jsx')).to.equal('javascriptreact');
    expect(languageFromPath('index.html')).to.equal('html');
    expect(languageFromPath('styles.css')).to.equal('css');
    expect(languageFromPath('styles.scss')).to.equal('scss');
    expect(languageFromPath('styles.less')).to.equal('less');
    expect(languageFromPath('App.vue')).to.equal('vue');
    expect(languageFromPath('App.svelte')).to.equal('svelte');
  });

  it('returns correct id for backend / general purpose languages', () => {
    expect(languageFromPath('main.py')).to.equal('python');
    expect(languageFromPath('main.go')).to.equal('go');
    expect(languageFromPath('main.rs')).to.equal('rust');
    expect(languageFromPath('Main.java')).to.equal('java');
    expect(languageFromPath('Program.cs')).to.equal('csharp');
    expect(languageFromPath('main.swift')).to.equal('swift');
    expect(languageFromPath('main.kt')).to.equal('kotlin');
    expect(languageFromPath('main.dart')).to.equal('dart');
    expect(languageFromPath('main.scala')).to.equal('scala');
    expect(languageFromPath('main.rb')).to.equal('ruby');
    expect(languageFromPath('index.php')).to.equal('php');
  });

  it('returns correct id for systems languages', () => {
    expect(languageFromPath('main.c')).to.equal('c');
    expect(languageFromPath('header.h')).to.equal('c');
    expect(languageFromPath('main.cpp')).to.equal('cpp');
    expect(languageFromPath('main.cc')).to.equal('cpp');
    expect(languageFromPath('main.cxx')).to.equal('cpp');
    expect(languageFromPath('header.hpp')).to.equal('cpp');
    expect(languageFromPath('AppDelegate.m')).to.equal('objective-c');
    expect(languageFromPath('App.mm')).to.equal('objective-cpp');
  });

  it('returns correct id for scripting languages', () => {
    expect(languageFromPath('script.sh')).to.equal('shellscript');
    expect(languageFromPath('script.bash')).to.equal('shellscript');
    expect(languageFromPath('script.zsh')).to.equal('shellscript');
    expect(languageFromPath('script.ps1')).to.equal('powershell');
    expect(languageFromPath('run.bat')).to.equal('bat');
    expect(languageFromPath('run.cmd')).to.equal('bat');
    expect(languageFromPath('main.lua')).to.equal('lua');
    expect(languageFromPath('main.ex')).to.equal('elixir');
    expect(languageFromPath('main.erl')).to.equal('erlang');
    expect(languageFromPath('Main.hs')).to.equal('haskell');
    expect(languageFromPath('Main.fs')).to.equal('fsharp');
    expect(languageFromPath('core.clj')).to.equal('clojure');
    expect(languageFromPath('main.ml')).to.equal('ocaml');
    expect(languageFromPath('Main.elm')).to.equal('elm');
  });

  it('returns correct id for config and data formats', () => {
    expect(languageFromPath('config.json')).to.equal('json');
    expect(languageFromPath('config.jsonc')).to.equal('jsonc');
    expect(languageFromPath('config.yaml')).to.equal('yaml');
    expect(languageFromPath('config.yml')).to.equal('yaml');
    expect(languageFromPath('config.toml')).to.equal('toml');
    expect(languageFromPath('data.xml')).to.equal('xml');
    expect(languageFromPath('icon.svg')).to.equal('xml');
    expect(languageFromPath('README.md')).to.equal('markdown');
    expect(languageFromPath('schema.proto')).to.equal('proto');
    expect(languageFromPath('main.tf')).to.equal('terraform');
    expect(languageFromPath('.env')).to.equal('dotenv');
    expect(languageFromPath('config.ini')).to.equal('ini');
  });

  it('returns correct id for build and infra files', () => {
    expect(languageFromPath('Dockerfile')).to.equal('dockerfile');
    expect(languageFromPath('Makefile')).to.equal('makefile');
    expect(languageFromPath('rules.mk')).to.equal('makefile');
    expect(languageFromPath('CMakeLists.cmake')).to.equal('cmake');
    expect(languageFromPath('build.gradle')).to.equal('groovy');
  });

  it('returns correct id for shader files', () => {
    expect(languageFromPath('shader.glsl')).to.equal('glsl');
    expect(languageFromPath('shader.vert')).to.equal('glsl');
    expect(languageFromPath('shader.frag')).to.equal('glsl');
    expect(languageFromPath('shader.hlsl')).to.equal('hlsl');
    expect(languageFromPath('shader.wgsl')).to.equal('wgsl');
  });

  it('returns plaintext for unknown extensions', () => {
    expect(languageFromPath('file.xyz')).to.equal('plaintext');
    expect(languageFromPath('file.unknown')).to.equal('plaintext');
    expect(languageFromPath('noextension')).to.equal('plaintext');
  });

  it('is case-insensitive for extensions', () => {
    expect(languageFromPath('main.TS')).to.equal('typescript');
    expect(languageFromPath('main.PY')).to.equal('python');
    expect(languageFromPath('main.CPP')).to.equal('cpp');
  });

  it('uses the final extension segment for paths with multiple dots', () => {
    expect(languageFromPath('src/app.test.ts')).to.equal('typescript');
    expect(languageFromPath('src/app.spec.js')).to.equal('javascript');
  });
});

describe('diffAgentWrite — language detection layers', () => {
  it('layer 1: uses openTextDocument(targetUri) for existing files', () => {
    expect(editorSrc).to.include('openTextDocument(targetUri)');
    expect(editorSrc).to.include('lang = existingDoc.languageId');
  });

  it('layer 2: falls back to languageFromPath for new files', () => {
    expect(editorSrc).to.include('let lang = languageFromPath(normalised)');
  });

  it('layer 3: ghost untitled URI detection for unknown extensions on new files', () => {
    expect(editorSrc).to.include("scheme: 'untitled'");
    expect(editorSrc).to.include("if (tempDoc.languageId !== 'plaintext')");
  });

  it('ghost URI uses filename only (no directory path)', () => {
    expect(editorSrc).to.include("normalised.split('/').pop() ?? 'file'");
  });

  it('diffCode uses editor.document.languageId directly (no map needed)', () => {
    const diffCodeFn = editorSrc.slice(editorSrc.indexOf('async function diffCode'));
    expect(diffCodeFn).to.include('editor.document.languageId');
    expect(diffCodeFn).to.not.include('languageFromPath');
  });
});
