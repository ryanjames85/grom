/**
 * docs-index.ts
 *
 * Web documentation indexer for the @docs context provider.
 * Crawls configured documentation URLs (same-origin links only, up to 40 pages per source),
 * strips HTML to plain text, chunks the content, and builds a TF-IDF index for retrieval.
 *
 * Usage:
 *   - extension.ts calls docsIndex.indexAll(sources) on startup and on config change
 *   - context.ts calls docsIndex.query(text, sourceName?) when the user types @docs in chat
 *
 * Doc sources are configured via grom.docSources in VS Code settings, but this file
 * never reads VS Code config directly — sources are passed in by the caller.
 *
 * NOTE: This file is intentionally vscode-free. All config reading and status bar
 * updates live in extension.ts. Progress messages are emitted via the onProgress callback.
 */

import { stripHtml } from './utils';

export interface DocSource {
  name: string; // Short identifier shown in @docs results, e.g. "react"
  url: string;  // Root URL to crawl, e.g. "https://react.dev/reference"
}

interface DocChunk {
  source: string;
  url: string;
  text: string;
  terms: Map<string, number>;
}

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 100;
const MAX_PAGES_PER_SOURCE = 40;

export class DocsIndex {
  private _chunks: DocChunk[] = [];
  private _idf: Map<string, number> = new Map();
  private _indexed = new Set<string>();   // Sources that have been fully indexed
  private _indexing = new Set<string>();  // Sources currently being crawled (prevents double-indexing)

  /**
   * @param _onProgress Optional callback invoked with status messages during crawling.
   *                    extension.ts uses this to update the VS Code status bar.
   *                    Pass an empty string to signal that the status bar should be hidden.
   */
  constructor(private readonly _onProgress?: (msg: string) => void) {}

  /** Returns true if the named source has been fully indexed. */
  isIndexed(name: string) { return this._indexed.has(name); }

  /**
   * Crawls and indexes a single documentation source.
   * Skips sources already indexed or currently being indexed.
   * Crawls up to MAX_PAGES_PER_SOURCE same-origin pages with an 80ms polite delay between requests.
   */
  async indexSource(source: DocSource): Promise<void> {
    if (this._indexing.has(source.name) || this._indexed.has(source.name)) return;
    this._indexing.add(source.name);
    this._onProgress?.(`indexing docs (${source.name})…`);

    try {
      const pages = await this._crawl(source.url, source.name);
      for (const page of pages) {
        const chunks = this._chunkText(page.text);
        for (const chunk of chunks) {
          if (chunk.trim().length < 40) continue;
          const tokens = tokenize(chunk);
          this._chunks.push({ source: source.name, url: page.url, text: chunk, terms: termFreq(tokens) });
        }
      }
      this._buildIdf();
      this._indexed.add(source.name);
      this._onProgress?.(`docs indexed (${source.name})`);
    } catch {
      this._onProgress?.(''); // Signal status bar to hide on failure
    } finally {
      this._indexing.delete(source.name);
    }
  }

  /**
   * Indexes all provided sources sequentially.
   * Sources already indexed are skipped. Called by extension.ts on startup
   * and whenever grom.docSources changes in VS Code settings.
   */
  async indexAll(sources: DocSource[]): Promise<void> {
    for (const s of sources) {
      await this.indexSource(s);
    }
  }

  /**
   * Removes all indexed chunks for a source and marks it as unindexed.
   * Called before re-indexing a source to avoid duplicate chunks.
   */
  clearSource(name: string) {
    this._chunks = this._chunks.filter(c => c.source !== name);
    this._indexed.delete(name);
    this._buildIdf();
  }

  /**
   * Retrieves the most relevant documentation chunks for a query using TF-IDF scoring.
   * Optionally filters to a specific source when sourceName is provided (e.g. @docs:react).
   */
  query(query: string, sourceName?: string, topK = 4): string {
    const pool = sourceName ? this._chunks.filter(c => c.source === sourceName) : this._chunks;
    if (!pool.length) return '';
    const qTerms = termFreq(tokenize(query));
    const scores = pool.map((chunk, i) => ({ i, score: this._score(qTerms, chunk) }));
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK).filter(s => s.score > 0);
    if (!top.length) return '';
    return top.map(s => {
      const c = pool[s.i];
      return `[${c.source} — ${c.url}]\n${c.text}`;
    }).join('\n\n---\n\n');
  }

  /** Returns the names of all successfully indexed sources. */
  getSources(): string[] { return [...this._indexed]; }

  /**
   * Crawls a documentation site starting from startUrl, following same-origin links.
   * Stops at MAX_PAGES_PER_SOURCE pages. Skips non-HTML content and fragment-only URLs.
   * Uses an 80ms delay between requests to avoid hammering documentation servers.
   */
  private async _crawl(startUrl: string, sourceName: string): Promise<Array<{ url: string; text: string }>> {
    let origin: string;
    try { origin = new URL(startUrl).origin; } catch { return []; }

    const visited = new Set<string>();
    const queue = [startUrl];
    const pages: Array<{ url: string; text: string }> = [];

    while (queue.length > 0 && pages.length < MAX_PAGES_PER_SOURCE) {
      const current = queue.shift()!;
      // Strip fragments — we treat fragment URLs as the same page
      const normalised = current.split('#')[0];
      if (visited.has(normalised)) continue;
      visited.add(normalised);

      try {
        const res = await fetch(current, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('html') && !ct.includes('text')) continue;
        const html = await res.text();
        const text = stripHtml(html);
        if (text.length > 80) pages.push({ url: normalised, text });

        if (pages.length >= MAX_PAGES_PER_SOURCE) break;

        // Extract same-origin links for the crawl queue
        const linkRe = /href=["']([^"'#?][^"']*?)["']/g;
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(html)) !== null) {
          try {
            const abs = new URL(m[1], current).href.split('#')[0].split('?')[0];
            if (abs.startsWith(origin) && !visited.has(abs)) queue.push(abs);
          } catch { /* malformed href — skip */ }
        }

        this._onProgress?.(`docs (${sourceName}) — ${pages.length} pages…`);
      } catch { /* timeout or network error — skip this page and continue */ }

      // Polite delay to avoid rate-limiting documentation servers
      await new Promise(r => setTimeout(r, 80));
    }

    return pages;
  }

  /** Splits a long text string into overlapping chunks for indexing. */
  private _chunkText(text: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
      if (i + CHUNK_SIZE >= text.length) break;
    }
    return chunks;
  }

  /** Computes IDF weights for all terms across all indexed chunks. */
  private _buildIdf() {
    const df = new Map<string, number>();
    for (const chunk of this._chunks) {
      for (const term of chunk.terms.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    const N = this._chunks.length;
    this._idf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((N + 1) / (d + 1))]));
  }

  /** Scores a single chunk against a query using TF-IDF. */
  private _score(qTerms: Map<string, number>, chunk: DocChunk): number {
    let score = 0;
    for (const [term, qTf] of qTerms) {
      const dTf = chunk.terms.get(term) || 0;
      if (dTf > 0) score += qTf * dTf * (this._idf.get(term) || 1);
    }
    return score;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Tokenizes text into lowercase words of 2+ characters for TF-IDF indexing. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length >= 2);
}

/** Counts token frequency across an array of tokens. */
function termFreq(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  return freq;
}
