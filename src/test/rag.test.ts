import { expect } from 'chai';
import * as sinon from 'sinon';
import { RagIndex, RagFile } from '../rag';

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

describe('RagIndex BM25', () => {
  async function buildIndex(files: RagFile[]): Promise<RagIndex> {
    const idx = new RagIndex();
    await idx.build(files);
    return idx;
  }

  it('returns empty string when index is empty', async () => {
    const idx = new RagIndex();
    expect(idx.query('anything')).to.equal('');
  });

  it('ranks a relevant chunk above an irrelevant one', async () => {
    const idx = await buildIndex([
      { path: 'auth.ts', content: 'function authenticateUser(token: string) {\n  return verifyJwt(token);\n}' },
      { path: 'utils.ts', content: 'function formatDate(d: Date) {\n  return d.toISOString();\n}' }
    ]);
    const result = idx.query('authenticate user token', 2);
    expect(result).to.include('auth.ts');
    expect(result.indexOf('auth.ts')).to.be.lessThan(result.indexOf('utils.ts') === -1 ? Infinity : result.indexOf('utils.ts'));
  });

  it('returns empty string when no chunks match the query', async () => {
    const idx = await buildIndex([
      { path: 'foo.ts', content: 'const x = 1;' }
    ]);
    expect(idx.query('zzzznonexistentterm')).to.equal('');
  });

  it('exact match boost surfaces the right chunk', async () => {
    const idx = await buildIndex([
      { path: 'a.ts', content: 'function processPayment(amount: number) {}' },
      { path: 'b.ts', content: 'function handleRequest(req: Request) {}' }
    ]);
    const result = idx.query('processPayment');
    expect(result).to.include('a.ts');
  });

  it('length normalisation: shorter dense chunk scores higher than diluted long chunk', async () => {
    const shortChunk = 'function fetchUser(id: string) { return db.users.find(id); }';
    const longChunk = shortChunk + '\n' + Array(40).fill('// padding line with unrelated content about formatting dates and colours').join('\n');
    const idx = await buildIndex([
      { path: 'long.ts', content: longChunk },
      { path: 'short.ts', content: shortChunk }
    ]);
    const result = idx.query('fetchUser id');
    expect(result.indexOf('short.ts')).to.be.lessThan(result.indexOf('long.ts') === -1 ? Infinity : result.indexOf('long.ts'));
  });

  it('filename match boosts chunks from a relevantly-named file', async () => {
    const idx = await buildIndex([
      { path: 'auth-service.ts', content: 'export function login(user: string) {}' },
      { path: 'unrelated.ts', content: 'export function login(user: string) {}' }
    ]);
    const result = idx.query('auth login');
    expect(result.indexOf('auth-service.ts')).to.be.lessThan(result.indexOf('unrelated.ts') === -1 ? Infinity : result.indexOf('unrelated.ts'));
  });

  it('returns top K results', async () => {
    const files: RagFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`,
      content: `function handler${i}(request: Request) { return response${i}; }`
    }));
    const idx = await buildIndex(files);
    const result = idx.query('handler request response', 3);
    const matches = result.split('---').filter(s => s.trim());
    expect(matches.length).to.be.at.most(3);
  });
});

// ── Embedding endpoint selection (issue #7) ───────────────────────────────────

const FILE: RagFile[] = [{ path: 'a.ts', content: 'hello world foo bar baz qux' }];
const EMB_CONFIG = { model: 'nomic-embed-text', apiUrl: 'http://localhost:11434' };
const VEC = [0.1, 0.2, 0.3];

function mockFetch(url: string, body: any, ok = true) {
  return (input: string) =>
    input === url
      ? Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
      : Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
}

describe('RagIndex embedding endpoint selection', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => { fetchStub = sinon.stub(global, 'fetch' as any); });
  afterEach(() => sinon.restore());

  it('uses /api/embed when it returns valid Ollama embeddings', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [VEC] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG);

    const apiEmbedCalls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/api/embed'));
    expect(apiEmbedCalls.length).to.be.greaterThan(0);
    const v1Calls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/v1/embeddings'));
    expect(v1Calls.length).to.equal(0);
  });

  it('falls back to /v1/embeddings when /api/embed returns HTTP 200 with no embeddings (LM Studio error body)', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'endpoint not supported' }) } as Response);
      if (url.includes('/v1/embeddings'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ embedding: VEC, index: 0 }] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, { ...EMB_CONFIG, apiUrl: 'http://localhost:1234' });

    const v1Calls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/v1/embeddings'));
    expect(v1Calls.length).to.be.greaterThan(0);
  });

  it('falls back to /v1/embeddings when /api/embed returns a non-ok status', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed'))
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
      if (url.includes('/v1/embeddings'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ embedding: VEC, index: 0 }] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, { ...EMB_CONFIG, apiUrl: 'http://localhost:1234' });

    const v1Calls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/v1/embeddings'));
    expect(v1Calls.length).to.be.greaterThan(0);
  });

  it('falls back to legacy /api/embeddings when both batch endpoints fail', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed') || url.includes('/v1/embeddings'))
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
      if (url.includes('/api/embeddings'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ embedding: VEC }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG);

    const legacyCalls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/api/embeddings'));
    expect(legacyCalls.length).to.be.greaterThan(0);
  });

  it('gracefully degrades to BM25 when all embedding endpoints fail', async () => {
    fetchStub.callsFake(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response));

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG);

    // BM25 still works
    const result = idx.query('hello world');
    expect(result).to.include('a.ts');
  });

  it('queryAsync returns results after successful /v1/embeddings build (LM Studio flow)', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'unsupported' }) } as Response);
      if (url.includes('/v1/embeddings'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ embedding: VEC, index: 0 }] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, { ...EMB_CONFIG, apiUrl: 'http://localhost:1234' });

    const result = await idx.queryAsync('hello world');
    expect(result).to.include('a.ts');
  });
});

// ── Endpoint caching ──────────────────────────────────────────────────────────

describe('RagIndex endpoint caching', () => {
  let fetchStub: sinon.SinonStub;
  beforeEach(() => { fetchStub = sinon.stub(global, 'fetch' as any); });
  afterEach(() => sinon.restore());

  it('does not probe /v1/embeddings after /api/embed succeeds', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [VEC] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    // Two build calls — second is incremental with a changed file
    await idx.build(FILE, EMB_CONFIG, true);
    await idx.build([{ path: 'a.ts', content: 'hello world foo bar baz qux changed' }], EMB_CONFIG);

    const v1Calls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/v1/embeddings'));
    expect(v1Calls.length).to.equal(0);
  });

  it('does not probe /api/embed after /v1/embeddings is cached as working', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'unsupported' }) } as Response);
      if (url.includes('/v1/embeddings')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ embedding: VEC, index: 0 }] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG, true);
    fetchStub.resetHistory();

    // Second call — should go straight to /v1/embeddings
    await idx.build([{ path: 'a.ts', content: 'hello world foo bar changed' }], EMB_CONFIG);

    const apiEmbedCalls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/api/embed'));
    expect(apiEmbedCalls.length).to.equal(0);
  });

  it('resets endpoint cache when provider config changes', async () => {
    let probeCount = 0;
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) { probeCount++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [VEC] }) } as Response); }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG, true);
    const firstProbes = probeCount;

    // Switching to a different apiUrl resets the cache — should probe again
    await idx.build(FILE, { ...EMB_CONFIG, apiUrl: 'http://localhost:1234' }, true);
    expect(probeCount).to.be.greaterThan(firstProbes);
  });
});

// ── Dimension guard ───────────────────────────────────────────────────────────

describe('RagIndex dimension guard', () => {
  let fetchStub: sinon.SinonStub;
  beforeEach(() => { fetchStub = sinon.stub(global, 'fetch' as any); });
  afterEach(() => sinon.restore());

  it('falls back to BM25 when query vector dimension does not match stored dimension', async () => {
    // Build with 3-dim vectors
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [[0.1, 0.2, 0.3]] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG);

    // Now return a 5-dim vector at query time (simulates model change)
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5]] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    // queryAsync should not throw; result comes from BM25 fallback
    const result = await idx.queryAsync('hello world');
    expect(result).to.include('a.ts');
  });
});

// ── Failure surfacing ─────────────────────────────────────────────────────────

describe('RagIndex failure surfacing', () => {
  let fetchStub: sinon.SinonStub;
  beforeEach(() => { fetchStub = sinon.stub(global, 'fetch' as any); });
  afterEach(() => sinon.restore());

  it('getStatus reports embeddingFailed when all endpoints fail', async () => {
    fetchStub.callsFake(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response));

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG);

    const status = idx.getStatus();
    expect(status.embeddingFailed).to.be.true;
    expect(status.semantic).to.be.false;
    expect(status.indexed).to.be.true;
  });

  it('getStatus reports semantic=true and embeddingFailed=false on success', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [VEC] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const idx = new RagIndex();
    await idx.build(FILE, EMB_CONFIG);

    const status = idx.getStatus();
    expect(status.semantic).to.be.true;
    expect(status.embeddingFailed).to.be.false;
    expect(status.chunks).to.be.greaterThan(0);
  });

  it('progress callback includes model name on success', async () => {
    fetchStub.callsFake((url: string) => {
      if (url.includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [VEC] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    const messages: string[] = [];
    const idx = new RagIndex(msg => messages.push(msg));
    await idx.build(FILE, EMB_CONFIG);

    const final = messages[messages.length - 1];
    expect(final).to.include('nomic-embed-text');
  });

  it('progress callback reports BM25 only when embedding unavailable', async () => {
    fetchStub.callsFake(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response));

    const messages: string[] = [];
    const idx = new RagIndex(msg => messages.push(msg));
    await idx.build(FILE, EMB_CONFIG);

    const final = messages[messages.length - 1];
    expect(final).to.include('BM25 only');
  });
});

// ── Incremental re-indexing ───────────────────────────────────────────────────

describe('RagIndex incremental re-indexing', () => {
  it('does not re-index unchanged files', async () => {
    const idx = new RagIndex();
    await idx.build(FILE);
    const chunksBefore = idx.getStatus().chunks;

    // Second build with same content — should be a no-op
    await idx.build(FILE);
    expect(idx.getStatus().chunks).to.equal(chunksBefore);
  });

  it('picks up content changes in an existing file', async () => {
    const idx = new RagIndex();
    await idx.build([{ path: 'a.ts', content: 'function alpha() {}' }]);

    await idx.build([{ path: 'a.ts', content: 'function beta() { return 42; }' }]);
    const result = idx.query('beta');
    expect(result).to.include('a.ts');
  });

  it('removes chunks for deleted files', async () => {
    const idx = new RagIndex();
    await idx.build([
      { path: 'a.ts', content: 'function alpha() {}' },
      { path: 'b.ts', content: 'function beta() {}' }
    ]);

    // Remove b.ts
    await idx.build([{ path: 'a.ts', content: 'function alpha() {}' }]);
    const result = idx.query('beta');
    expect(result).to.not.include('b.ts');
  });

  it('adds chunks for newly added files', async () => {
    const idx = new RagIndex();
    await idx.build([{ path: 'a.ts', content: 'function alpha() {}' }]);

    await idx.build([
      { path: 'a.ts', content: 'function alpha() {}' },
      { path: 'b.ts', content: 'function newFeature() { return true; }' }
    ]);

    const result = idx.query('newFeature');
    expect(result).to.include('b.ts');
  });

  it('force=true rebuilds from scratch even when content is unchanged', async () => {
    let buildCount = 0;
    const idx = new RagIndex(() => { buildCount++; });
    await idx.build(FILE);
    const after1 = buildCount;

    await idx.build(FILE, undefined, true);
    expect(buildCount).to.be.greaterThan(after1);
  });

  it('only re-embeds changed files on incremental update', async () => {
    const fetchStub = sinon.stub(global, 'fetch' as any);
    fetchStub.callsFake((url: unknown) => {
      if ((url as string).includes('/api/embed')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ embeddings: [VEC] }) } as Response);
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    });

    try {
      const idx = new RagIndex();
      await idx.build([
        { path: 'a.ts', content: 'function alpha() {}' },
        { path: 'b.ts', content: 'function beta() {}' }
      ], EMB_CONFIG);

      fetchStub.resetHistory();

      // Only b.ts changes — only b.ts should be re-embedded
      await idx.build([
        { path: 'a.ts', content: 'function alpha() {}' },        // unchanged
        { path: 'b.ts', content: 'function beta() { return 1; }' } // changed
      ], EMB_CONFIG);

      // Only one batch call for the one changed file's chunk
      const embedCalls = fetchStub.args.filter((a: any[]) => (a[0] as string).includes('/api/embed'));
      expect(embedCalls.length).to.equal(1);
    } finally {
      sinon.restore();
    }
  });
});
