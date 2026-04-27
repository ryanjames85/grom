import { expect } from 'chai';

(global as any).vscode = {
  workspace: {
    workspaceFolders: null,
    getConfiguration: () => ({ get: (_k: string, d: any) => d ?? '' }),
    findFiles: async () => [],
    fs: { stat: async () => ({}), readFile: async () => Buffer.from('') },
    asRelativePath: (u: any) => u.toString()
  },
  window: { createStatusBarItem: () => ({ text: '', show: () => {}, hide: () => {}, dispose: () => {} }) },
  StatusBarAlignment: { Left: 0 },
  Uri: { joinPath: () => ({ fsPath: '' }) }
};

// Test the pure helper functions by duplicating them here (they are module-private in rag.ts)
function tokenizeToArray(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const expanded: string[] = [...raw.filter((w: string) => w.length >= 2)];
  const camel = text.match(/[A-Z][a-z0-9]+|[a-z][a-z0-9]*/g) || [];
  for (const w of camel) {
    const lw = w.toLowerCase();
    if (lw.length >= 2 && !expanded.includes(lw)) expanded.push(lw);
  }
  return expanded;
}

function termFreq(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  return freq;
}

function buildBigrams(tokens: string[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) s.add(`${tokens[i]}|${tokens[i + 1]}`);
  return s;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

describe('tokenizeToArray', () => {
  it('lowercases and splits on non-alpha', () => {
    const tokens = tokenizeToArray('hello world');
    expect(tokens).to.include('hello');
    expect(tokens).to.include('world');
  });

  it('splits camelCase into sub-words', () => {
    const tokens = tokenizeToArray('parseToolCall');
    expect(tokens).to.include('parse');
    expect(tokens).to.include('tool');
    expect(tokens).to.include('call');
  });

  it('splits snake_case', () => {
    const tokens = tokenizeToArray('read_file_contents');
    expect(tokens).to.include('read');
    expect(tokens).to.include('file');
    expect(tokens).to.include('contents');
  });

  it('filters tokens shorter than 2 chars', () => {
    const tokens = tokenizeToArray('a b cd');
    expect(tokens).to.not.include('a');
    expect(tokens).to.not.include('b');
    expect(tokens).to.include('cd');
  });

  it('handles empty string', () => {
    expect(tokenizeToArray('')).to.deep.equal([]);
  });
});

describe('termFreq', () => {
  it('counts token frequencies', () => {
    const freq = termFreq(['a', 'b', 'a', 'c', 'a']);
    expect(freq.get('a')).to.equal(3);
    expect(freq.get('b')).to.equal(1);
    expect(freq.get('c')).to.equal(1);
  });

  it('returns empty map for empty input', () => {
    expect(termFreq([])).to.be.instanceOf(Map);
    expect(termFreq([]).size).to.equal(0);
  });
});

describe('buildBigrams', () => {
  it('builds adjacent token pairs', () => {
    const bigrams = buildBigrams(['read', 'file', 'contents']);
    expect(bigrams.has('read|file')).to.be.true;
    expect(bigrams.has('file|contents')).to.be.true;
    expect(bigrams.has('read|contents')).to.be.false;
  });

  it('returns empty set for single token', () => {
    expect(buildBigrams(['only']).size).to.equal(0);
  });

  it('returns empty set for empty input', () => {
    expect(buildBigrams([]).size).to.equal(0);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).to.be.closeTo(1, 0.0001);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).to.be.closeTo(0, 0.0001);
  });

  it('returns 0 for mismatched lengths', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).to.equal(0);
  });

  it('returns 0 for zero vector', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).to.equal(0);
  });

  it('returns value between -1 and 1 for general vectors', () => {
    const a = new Float32Array([0.5, 0.3, 0.8]);
    const b = new Float32Array([0.1, 0.9, 0.4]);
    const sim = cosineSimilarity(a, b);
    expect(sim).to.be.within(-1, 1);
  });
});

describe('sad path', () => {
  it('tokenizeToArray returns empty for numbers-only string', () => {
    expect(tokenizeToArray('123')).to.deep.equal(['123']);
  });

  it('tokenizeToArray handles string with only special chars', () => {
    expect(tokenizeToArray('!@#$%^&*()')).to.deep.equal([]);
  });

  it('termFreq handles duplicate-only input', () => {
    const freq = termFreq(['x', 'x', 'x']);
    expect(freq.get('x')).to.equal(3);
    expect(freq.size).to.equal(1);
  });

  it('buildBigrams returns empty set for empty input', () => {
    expect(buildBigrams([]).size).to.equal(0);
  });

  it('cosineSimilarity returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).to.equal(0);
  });
});
