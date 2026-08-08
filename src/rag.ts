/**
 * rag.ts
 *
 * Codebase indexing and retrieval (RAG — Retrieval Augmented Generation).
 * Builds a searchable index from pre-read workspace files using BM25 keyword
 * scoring (always) and optional semantic embeddings via an embedding model.
 *
 * Usage:
 *   - extension.ts reads files from the workspace and calls ragIndex.build(files, embConfig)
 *   - provider.ts calls ragIndex.queryAsync(text) to retrieve relevant chunks for each message
 *
 * Hybrid retrieval uses Reciprocal Rank Fusion (RRF) to merge BM25 and cosine ranking lists
 * when embeddings are available, or pure BM25 when no embedding model is configured.
 *
 * Embedding endpoint resolution order (cached after first success per session):
 *   1. /api/embed       — Ollama native batch endpoint
 *   2. /v1/embeddings   — OpenAI-compatible (LM Studio, OpenRouter, etc.)
 *   3. /api/embeddings  — Legacy Ollama single-text endpoint
 *
 * NOTE: This file is intentionally vscode-free. All file discovery, config reading,
 * and status bar updates live in extension.ts. This makes the indexing logic independently
 * testable and reusable outside of VS Code.
 */

import * as path from 'path';

/** A single workspace file passed in by extension.ts for indexing. */
export interface RagFile {
  path: string;    // Workspace-relative path, e.g. "src/foo.ts"
  content: string; // Full file text
}

/** Ollama embedding configuration — passed in from extension.ts which reads VS Code settings. */
export interface EmbeddingConfig {
  model: string;  // e.g. "nomic-embed-text"
  apiUrl: string; // e.g. "http://127.0.0.1:11434"
}

interface IndexedChunk {
  file: string;
  line: number;
  text: string;
  terms: Map<string, number>;
  bigrams: Set<string>;
  dl: number;        // Document length (token count) for BM25 length normalisation
  vector?: Float32Array; // Only present when an embedding model is configured
}

const CHUNK_LINES = 30;
const CHUNK_OVERLAP = 5;
const EMBED_BATCH = 20;

// BM25 hyperparameters — standard defaults that work well across code corpora
const BM25_K1 = 1.5; // Term saturation: controls diminishing returns for repeated terms
const BM25_B  = 0.75; // Length normalisation: penalises longer chunks relative to average

/** File extensions eligible for indexing. */
export const INDEXED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.rb', '.php', '.swift', '.kt', '.md', '.json', '.yaml', '.yml', '.toml', '.env.example', '.ipynb']);
/** Directories skipped during file discovery in extension.ts. Exported so extension.ts can use the same list. */
export const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', 'vendor']);
/** Files larger than this are skipped to avoid slow indexing and context flooding. */
export const MAX_FILE_KB = 200;

export class RagIndex {
  private _chunks: IndexedChunk[] = [];
  private _idf: Map<string, number> = new Map();
  private _avgDl = 0;
  private _indexed = false;
  private _indexing = false;
  private _hasEmbeddings = false;
  private _embConfig?: EmbeddingConfig;

  // Endpoint cache — set on first successful call, skips re-probing for the session lifetime
  private _workingEndpoint: 'ollama' | 'openai' | 'legacy' | null = null;
  // Expected vector dimension — guards against silent corruption when the model changes mid-session
  private _embDim = 0;
  // Per-file content hashes — enables incremental re-indexing on file changes
  private _fileHashes: Map<string, string> = new Map();
  // Set when an embedding model is configured but all embedding attempts fail
  private _embeddingFailed = false;
  // Set when build(force=true) arrives while a build is already running.
  // The in-progress build checks this on completion and re-runs immediately.
  private _pendingRebuild: { files: RagFile[]; embConfig?: EmbeddingConfig } | null = null;

  /**
   * @param _onProgress Optional callback invoked with status messages during indexing.
   *                    extension.ts uses this to update the VS Code status bar.
   */
  constructor(private readonly _onProgress?: (msg: string) => void) {}

  /** Returns current indexing status for extension.ts status bar and tooltip display. */
  getStatus(): { indexed: boolean; chunks: number; semantic: boolean; embeddingFailed: boolean } {
    return { indexed: this._indexed, chunks: this._chunks.length, semantic: this._hasEmbeddings, embeddingFailed: this._embeddingFailed };
  }

  /** Returns true once the index has been built at least once. */
  isIndexed() { return this._indexed; }

  /**
   * Builds or incrementally updates the index from the provided file list.
   *
   * - First call (not yet indexed): full build — chunks all files, embeds all chunks.
   * - Subsequent calls without force: incremental — only re-chunks and re-embeds files
   *   whose content hash changed; untouched files keep their existing vectors.
   * - force=true: full rebuild regardless (e.g. when the embedding model changes).
   *
   * Embedding endpoint is probed once per session and cached; subsequent calls skip
   * failed endpoints. Pass force=true to reset the cache when switching providers.
   */
  async build(files: RagFile[], embConfig?: EmbeddingConfig, force = false): Promise<void> {
    if (this._indexing) {
      // Queue the rebuild — the current build will pick it up when it finishes
      if (force) this._pendingRebuild = { files, embConfig };
      return;
    }

    // Invalidate endpoint cache and dimension guard when the provider config changes
    if (embConfig && (embConfig.apiUrl !== this._embConfig?.apiUrl || embConfig.model !== this._embConfig?.model)) {
      this._workingEndpoint = null;
      this._embDim = 0;
    }

    if (!force && this._indexed) {
      await this._incrementalBuild(files, embConfig);
      return;
    }

    // Full rebuild
    this._indexing = true;
    this._chunks = [];
    this._fileHashes = new Map();
    this._hasEmbeddings = false;
    this._embeddingFailed = false;
    this._embConfig = embConfig;
    this._onProgress?.('indexing...');

    try {
      for (let fIdx = 0; fIdx < files.length; fIdx++) {
        if (fIdx % 10 === 0) this._onProgress?.(`indexing ${Math.round(fIdx / files.length * 100)}%…`);
        const file = files[fIdx];
        this._fileHashes.set(file.path, fileHash(file.content));
        this._chunks.push(...this._chunkFile(file));
      }
      this._avgDl = this._chunks.length ? this._chunks.reduce((s, c) => s + c.dl, 0) / this._chunks.length : 1;
      this._buildIdf();
      if (embConfig?.model) await this._embedChunks(this._chunks, embConfig);
      this._indexed = true;
      this._onProgress?.(this._progressLabel());
    } finally {
      this._indexing = false;
      // If a force rebuild was requested while we were busy, run it now
      const pending = this._pendingRebuild;
      if (pending) {
        this._pendingRebuild = null;
        await this.build(pending.files, pending.embConfig, true);
      }
    }
  }

  /**
   * Incremental update: computes content hashes for all incoming files, re-chunks and
   * re-embeds only the files that changed, removes chunks for deleted files, and
   * rebuilds IDF + avgDl. Returns immediately if nothing changed.
   */
  private async _incrementalBuild(files: RagFile[], embConfig?: EmbeddingConfig): Promise<void> {
    this._indexing = true;
    this._embConfig = embConfig;

    try {
      const incoming = new Map(files.map(f => [f.path, f]));

      // Files whose content changed or that are new to the workspace
      const changedFiles: RagFile[] = [];
      for (const [p, f] of incoming) {
        const hash = fileHash(f.content);
        if (this._fileHashes.get(p) !== hash) {
          changedFiles.push(f);
          this._fileHashes.set(p, hash);
        }
      }

      // Files removed from the workspace
      const deletedPaths = new Set<string>();
      for (const p of this._fileHashes.keys()) {
        if (!incoming.has(p)) { deletedPaths.add(p); this._fileHashes.delete(p); }
      }

      if (changedFiles.length === 0 && deletedPaths.size === 0) return;

      // Drop stale chunks; keep everything else (including their existing vectors)
      const stale = new Set([...changedFiles.map(f => f.path), ...deletedPaths]);
      this._chunks = this._chunks.filter(c => !stale.has(c.file));

      // Chunk and embed only the changed files
      const newChunks: IndexedChunk[] = [];
      for (const f of changedFiles) newChunks.push(...this._chunkFile(f));
      if (embConfig?.model && newChunks.length > 0) await this._embedChunks(newChunks, embConfig);
      this._chunks.push(...newChunks);

      this._avgDl = this._chunks.length ? this._chunks.reduce((s, c) => s + c.dl, 0) / this._chunks.length : 1;
      this._buildIdf();
      this._onProgress?.(this._progressLabel());
    } finally {
      this._indexing = false;
    }
  }

  /** Chunks a single file into overlapping windows. Returns [] for non-indexed or binary files. */
  private _chunkFile(file: RagFile): IndexedChunk[] {
    const ext = path.extname(file.path).toLowerCase();
    if (!INDEXED_EXTS.has(ext)) return [];
    if (file.content.includes('\0')) return []; // skip binary files
    const chunks: IndexedChunk[] = [];
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      const chunk = lines.slice(i, i + CHUNK_LINES).join('\n');
      if (chunk.trim().length < 20) continue;
      const tokens = tokenizeToArray(chunk);
      chunks.push({ file: file.path, line: i + 1, text: chunk, terms: termFreq(tokens), bigrams: buildBigrams(tokens), dl: tokens.length });
    }
    return chunks;
  }

  private _progressLabel(): string {
    if (this._embeddingFailed) return `${this._chunks.length} chunks — BM25 only (embedding unavailable)`;
    const embLabel = this._hasEmbeddings ? ` (${this._embConfig?.model ?? 'semantic'})` : '';
    return `${this._chunks.length} chunks indexed${embLabel}`;
  }

  /**
   * Synchronous TF-IDF query. Fast but lacks semantic understanding.
   * Used as the fallback when no embedding model is configured, and internally
   * as the keyword component when blending with cosine similarity.
   */
  query(query: string, topK = 5): string {
    if (!this._chunks.length) return '';
    const qTokens = tokenizeToArray(query);
    const qTerms = termFreq(qTokens);
    const qBigrams = buildBigrams(qTokens);
    const scores = this._chunks.map((chunk, i) => ({ i, score: this._score(qTerms, qBigrams, chunk, query) }));
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK).filter(s => s.score > 0);
    if (!top.length) return '';
    return top.map(s => {
      const c = this._chunks[s.i];
      return `[${c.file}:${c.line}]\n${c.text}`;
    }).join('\n\n---\n\n');
  }

  /**
   * Async hybrid query using Reciprocal Rank Fusion (RRF) to merge BM25 and cosine
   * ranking lists. RRF avoids the score-normalisation problem of fixed-weight blending:
   * each chunk's contribution is 1/(k+rank) from each list, where k=60 is the standard
   * constant that dampens the outsized influence of top-ranked results.
   * Falls back to synchronous BM25 if no embeddings were generated during build.
   */
  async queryAsync(query: string, topK = 5): Promise<string> {
    if (!this._chunks.length) return '';
    if (!this._hasEmbeddings) return this.query(query, topK);

    const qVecRaw = await this._embed(query, this._embConfig);
    // Guard against dimension mismatch — if the model changed mid-session cosine produces nonsense
    const qVec = (qVecRaw && (this._embDim === 0 || qVecRaw.length === this._embDim))
      ? new Float32Array(qVecRaw)
      : null;
    const qTokens = tokenizeToArray(query);
    const qTerms = termFreq(qTokens);
    const qBigrams = buildBigrams(qTokens);

    const RRF_K = 60;

    // BM25 ranking
    const bm25Ranked = this._chunks
      .map((chunk, i) => ({ i, s: this._score(qTerms, qBigrams, chunk, query) }))
      .sort((a, b) => b.s - a.s);

    // Cosine ranking (only meaningful when vectors exist)
    const cosRanked = qVec
      ? this._chunks
          .map((chunk, i) => ({ i, s: chunk.vector ? cosineSimilarity(qVec, chunk.vector) : 0 }))
          .sort((a, b) => b.s - a.s)
      : null;

    // RRF fusion
    const rrfScores = new Float64Array(this._chunks.length);
    bm25Ranked.forEach((item, rank) => { rrfScores[item.i] += 1 / (RRF_K + rank + 1); });
    cosRanked?.forEach((item, rank) => { rrfScores[item.i] += 1 / (RRF_K + rank + 1); });

    const ranked = Array.from({ length: this._chunks.length }, (_, i) => ({ i, score: rrfScores[i] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter(s => s.score > 0);

    if (!ranked.length) return '';
    return ranked.map(s => {
      const c = this._chunks[s.i];
      return `[${c.file}:${c.line}]\n${c.text}`;
    }).join('\n\n---\n\n');
  }

  /** Computes BM25 IDF weights for all terms across all chunks. */
  private _buildIdf() {
    const df = new Map<string, number>();
    for (const chunk of this._chunks) {
      for (const term of chunk.terms.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    const N = this._chunks.length;
    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1) — always positive, handles rare/common terms better than TF-IDF
    this._idf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((N - d + 0.5) / (d + 0.5) + 1)]));
  }

  /**
   * Scores a single chunk against a query using BM25 with three boosters:
   * - Bigram overlap: rewards matching adjacent word pairs (improves phrase matching)
   * - Exact substring: 2× boost for chunks containing the literal query string
   * - Filename match: 1.3× boost when query terms appear in the file path
   *
   * BM25 improvements over TF-IDF:
   * - Term saturation: the 10th occurrence of a word matters less than the 1st (k1 controls this)
   * - Length normalisation: shorter, denser chunks are not penalised against longer ones (b controls this)
   */
  private _score(qTerms: Map<string, number>, qBigrams: Set<string>, chunk: IndexedChunk, rawQuery: string): number {
    let score = 0;
    const lenNorm = 1 - BM25_B + BM25_B * (chunk.dl / this._avgDl);
    for (const term of qTerms.keys()) {
      const dTf = chunk.terms.get(term) || 0;
      if (dTf > 0) {
        const idf = this._idf.get(term) || 1;
        score += idf * (dTf * (BM25_K1 + 1)) / (dTf + BM25_K1 * lenNorm);
      }
    }
    let bigramMatches = 0;
    for (const bg of qBigrams) { if (chunk.bigrams.has(bg)) bigramMatches++; }
    if (qBigrams.size > 0) score *= 1 + (bigramMatches / qBigrams.size) * 0.5;
    const lq = rawQuery.toLowerCase();
    if (chunk.text.toLowerCase().includes(lq)) score *= 2;
    const lf = chunk.file.toLowerCase();
    for (const term of qTerms.keys()) { if (lf.includes(term)) { score *= 1.3; break; } }
    return score;
  }

  /**
   * Embeds a set of chunks in batches. Used for both full builds and incremental updates.
   * Tries the cached working endpoint first; probes all three on first call.
   * Updates _hasEmbeddings and _embeddingFailed based on results.
   * Embedding is optional — silent failure degrades to BM25.
   */
  private async _embedChunks(chunks: IndexedChunk[], embConfig: EmbeddingConfig): Promise<void> {
    let successCount = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const inputs = batch.map(c => c.text.slice(0, 512));
      try {
        const vectors = await this._embedBatch(embConfig.apiUrl, embConfig.model, inputs);
        if (vectors) {
          for (let j = 0; j < batch.length; j++) {
            if (vectors[j]) batch[j].vector = new Float32Array(vectors[j]);
          }
          successCount += batch.length;
        } else {
          for (let j = 0; j < batch.length; j++) {
            const v = await this._embed(batch[j].text.slice(0, 512), embConfig);
            if (v) { batch[j].vector = new Float32Array(v); successCount++; }
          }
        }
      } catch {}
      this._onProgress?.(`embedding ${Math.round(i / chunks.length * 100)}%…`);
    }
    if (successCount > 0) {
      this._hasEmbeddings = true;
      this._embeddingFailed = false;
    } else if (chunks.length > 0 && !this._hasEmbeddings) {
      // Only flag as failed when this is the first/only embedding attempt
      this._embeddingFailed = true;
    }
  }

  /**
   * Batch embedding with endpoint caching. On the first call, probes /api/embed then
   * /v1/embeddings and stores whichever works. Subsequent calls skip the failed endpoint.
   * Returns null if the cached endpoint stops working (caller falls back to per-chunk _embed).
   */
  private async _embedBatch(apiUrl: string, model: string, inputs: string[]): Promise<number[][] | null> {
    if (this._workingEndpoint === 'legacy') return null; // legacy is single-text only

    const h = { 'Content-Type': 'application/json' };
    const tryOllama = this._workingEndpoint !== 'openai';
    const tryOpenAI = this._workingEndpoint !== 'ollama';

    if (tryOllama) {
      try {
        const res = await fetch(`${apiUrl}/api/embed`, { method: 'POST', headers: h, body: JSON.stringify({ model, input: inputs }), signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          const data: any = await res.json();
          if (Array.isArray(data.embeddings) && data.embeddings.length) {
            this._workingEndpoint ??= 'ollama';
            this._embDim ||= (data.embeddings[0] as number[])?.length ?? 0;
            return data.embeddings;
          }
        }
      } catch {}
    }

    if (tryOpenAI) {
      try {
        const res = await fetch(`${apiUrl}/v1/embeddings`, { method: 'POST', headers: h, body: JSON.stringify({ model, input: inputs }), signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          const data: any = await res.json();
          if (Array.isArray(data.data) && data.data.length) {
            this._workingEndpoint ??= 'openai';
            const vecs = data.data.map((d: any) => d.embedding as number[]);
            this._embDim ||= vecs[0]?.length ?? 0;
            return vecs;
          }
        }
      } catch {}
    }

    return null;
  }

  /**
   * Single-text embedding — delegates to _embedBatch first (Ollama + OpenAI-compat),
   * then falls back to the legacy Ollama /api/embeddings endpoint for older servers.
   * embConfig is optional; returns null when undefined.
   */
  private async _embed(text: string, embConfig: EmbeddingConfig | undefined): Promise<number[] | null> {
    if (!embConfig) return null;
    try {
      const batch = await this._embedBatch(embConfig.apiUrl, embConfig.model, [text]);
      if (batch?.[0]) return batch[0];
      // Skip legacy probe when we already know the working endpoint (it would have succeeded above)
      if (this._workingEndpoint !== null && this._workingEndpoint !== 'legacy') return null;
      // Legacy single-input endpoint for older Ollama versions
      const res = await fetch(`${embConfig.apiUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embConfig.model, prompt: text }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const vec: number[] | null = data.embedding || null;
      if (vec?.length) {
        this._workingEndpoint ??= 'legacy';
        this._embDim ||= vec.length;
        return vec;
      }
      return null;
    } catch { return null; }
  }
}

// ── Conversation RAG ─────────────────────────────────────────────────────────

/**
 * Lightweight BM25 index over conversation turns. Built fresh each call from the
 * session history — no embeddings, no async, negligible cost. Retrieves semantically
 * relevant earlier turns so the model can reconstruct context that was compacted away.
 *
 * Usage: build() from session.history, then query() with the current user text.
 * The excludeLast parameter prevents retrieving turns that are still in the visible
 * context window (the most recent N non-system messages).
 */
export class ConversationRag {
  private _turns: Array<{ role: string; text: string; terms: Map<string, number>; bigrams: Set<string>; dl: number }> = [];
  private _idf: Map<string, number> = new Map();
  private _avgDl = 1;
  private _builtForCount = 0;
  private _builtForLastContent = '';

  build(history: Array<{ role: string; content: string }>) {
    const eligible = history.filter(m => m.role !== 'system' && m.content.trim().length > 0);
    const lastContent = eligible[eligible.length - 1]?.content ?? '';
    if (eligible.length === this._builtForCount && lastContent === this._builtForLastContent) return;
    this._builtForCount = eligible.length;
    this._builtForLastContent = lastContent;
    this._turns = eligible.map(m => {
        const tokens = tokenizeToArray(m.content);
        return { role: m.role, text: m.content, terms: termFreq(tokens), bigrams: buildBigrams(tokens), dl: tokens.length || 1 };
      });
    this._avgDl = this._turns.length
      ? this._turns.reduce((s, t) => s + t.dl, 0) / this._turns.length
      : 1;
    const df = new Map<string, number>();
    for (const turn of this._turns) {
      for (const term of turn.terms.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    const N = this._turns.length || 1;
    this._idf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((N - d + 0.5) / (d + 0.5) + 1)]));
  }

  /** Returns a formatted string of the top-K relevant earlier turns, excluding the most recent ones. */
  query(text: string, topK = 3, excludeLast = 4): string {
    const candidates = this._turns.length > excludeLast ? this._turns.slice(0, -excludeLast) : [];
    if (!candidates.length) return '';
    const qTokens = tokenizeToArray(text);
    const qTerms = termFreq(qTokens);
    const qBigrams = buildBigrams(qTokens);
    const avgDl = this._avgDl;
    const scores = candidates.map((turn, idx) => {
      let score = 0;
      for (const [term, qtf] of qTerms) {
        const tf = turn.terms.get(term) || 0;
        if (!tf) continue;
        const idf = this._idf.get(term) || 0;
        score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * turn.dl / avgDl)) * Math.min(qtf, 3);
      }
      for (const bg of qBigrams) { if (turn.bigrams.has(bg)) score += 2; }
      return { idx, score };
    });
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK).filter(s => s.score > 0);
    if (!top.length) return '';
    return top.map(({ idx }) => {
      const t = candidates[idx];
      const label = t.role === 'user' ? 'User (earlier)' : 'Assistant (earlier)';
      const excerpt = t.text.length > 500 ? t.text.slice(0, 500) + '…' : t.text;
      return `[${label}]: ${excerpt}`;
    }).join('\n\n');
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Fast djb2 hash of file content — used for incremental re-indexing change detection. */
function fileHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = (h * 33 ^ content.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Tokenizes text into lowercase terms, expanding camelCase into component words.
 * e.g. "fetchUserData" → ["fetchuserdata", "fetch", "user", "data"]
 */
function tokenizeToArray(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const expanded: string[] = [...raw.filter(w => w.length >= 2)];
  const camel = text.match(/[A-Z][a-z0-9]+|[a-z][a-z0-9]*/g) || [];
  for (const w of camel) {
    const lw = w.toLowerCase();
    if (lw.length >= 2 && !expanded.includes(lw)) expanded.push(lw);
  }
  return expanded;
}

/** Counts how many times each token appears in the list. */
function termFreq(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  return freq;
}

/** Builds a set of adjacent word pairs (bigrams) for phrase-level matching. */
function buildBigrams(tokens: string[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) s.add(`${tokens[i]}|${tokens[i + 1]}`);
  return s;
}

/** Standard cosine similarity between two equal-length float vectors. Returns 0 if lengths differ. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
