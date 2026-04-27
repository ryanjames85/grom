import { expect } from 'chai';
import { parseComposerResponse, diffLines } from '../composer';

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
