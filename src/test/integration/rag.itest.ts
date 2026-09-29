/**
 * rag.itest.ts
 *
 * Tests codebase retrieval (RagIndex) against a real embedding model that is ALREADY loaded.
 * Nothing is loaded for you: if the server has no embedding model loaded, that suite skips.
 * Not part of `npm test`; run with `npm run test:integration`.
 *
 * Fixture files avoid sharing words with the queries, so a keyword match cannot find them.
 * A correct result therefore proves the embedding path works end to end.
 *
 * GROM_IT_ONLY=ollama or lmstudio runs just one server (see discover.ts). Time limits come from
 * timeouts.ts.
 */

import { expect } from 'chai';
import { RagIndex } from '../../rag';
import type { RagFile, EmbeddingConfig } from '../../rag';
import { SERVERS, loadedEmbeddingModel } from './discover';
import { timeoutFor } from './timeouts';

const RETRY = `// waits a little longer after every failure before trying again
export async function retryWithBackoff(task: () => Promise<string>, attempts: number) {
  let delay = 200;
  for (let i = 0; i < attempts; i++) {
    try { return await task(); } catch { await sleep(delay); delay *= 2; }
  }
  throw new Error('gave up');
}`;

const POOL = `// keeps a set of already opened links to the datastore so callers can borrow one
export class ConnectionPool {
  private idle: Handle[] = [];
  acquire(): Handle { return this.idle.pop() ?? openNewHandle(); }
  release(h: Handle) { this.idle.push(h); }
}`;

const IMAGE = `// makes pictures smaller so they load quickly on phones
export function shrinkPicture(src: Bitmap, maxWidth: number): Bitmap {
  const ratio = maxWidth / src.width;
  return scale(src, ratio);
}`;

const CSV = `// splits one line of comma separated values into its cells
export function splitLine(line: string): string[] {
  return line.split(',').map(c => c.trim());
}`;

const MAILBOX = `// checks that an email address is written correctly
export function isValidMailbox(s: string) { return s.includes('@') && s.split('@')[1].includes('.'); }`;

/** Enough filler that the index needs more than one embedding batch (20 chunks per batch). */
const FILLER = Array.from({ length: 700 }, (_, i) => `const filler${i} = ${i} * 3; // unrelated arithmetic line ${i}`).join('\n');

const files = (): RagFile[] => [
  { path: 'src/retry.ts', content: RETRY },
  { path: 'src/pool.ts', content: POOL },
  { path: 'src/image.ts', content: IMAGE },
  { path: 'src/csv.ts', content: CSV },
  { path: 'src/filler.ts', content: FILLER },
];

const topFiles = (out: string): string[] =>
  [...out.matchAll(/^\[([^\]:]+):\d+\]/gm)].map(m => m[1]);

for (const server of SERVERS) {
  describe(`RAG integration: ${server.name}`, function () {
    this.timeout(120_000);

    let emb: EmbeddingConfig;
    let progress: string[];

    before(async function () {
      const model = await loadedEmbeddingModel(server);
      if (!model) {
        console.log(`      [${server.name}] no embedding model loaded; skipping (this suite never loads one)`);
        this.skip();
      }
      emb = { model: model!, apiUrl: server.url };
      console.log(`      [${server.name}] using loaded embedding model=${model}`);
    });

    beforeEach(function () {
      progress = [];
      this.currentTest!.timeout(timeoutFor(this.currentTest!.title, 'none'));
    });

    const newIndex = () => new RagIndex(msg => progress.push(msg));

    it('builds a semantic index from a real embedding model', async () => {
      const idx = newIndex();
      await idx.build(files(), emb);
      const st = idx.getStatus();
      expect(st.indexed).to.equal(true);
      expect(st.embeddingFailed, 'embedding did not fail').to.equal(false);
      expect(st.semantic, 'vectors were created').to.equal(true);
      expect(st.chunks).to.be.greaterThan(20);
    });

    it('reports embedding progress that never sits at 0% and ends at 100%', async () => {
      const idx = newIndex();
      await idx.build(files(), emb);
      const pct = progress.map(p => /embedding (\d+)%/.exec(p)).filter(Boolean).map(m => Number(m![1]));
      expect(pct.length, 'more than one batch reported').to.be.greaterThan(1);
      expect(pct.every(p => p > 0), 'no batch reports 0%').to.equal(true);
      expect(pct[pct.length - 1]).to.equal(100);
      expect([...pct].sort((a, b) => a - b)).to.deep.equal(pct);
    });

    it('finds code by meaning when the query shares no words with it', async () => {
      const idx = newIndex();
      await idx.build(files(), emb);
      const cases: Array<[string, string]> = [
        ['how do we cope when the network is flaky', 'src/retry.ts'],
        ['reuse open links to the database instead of making new ones', 'src/pool.ts'],
        ['shrink photos for mobile users', 'src/image.ts'],
      ];
      const misses: string[] = [];
      for (const [query, want] of cases) {
        const top = topFiles(await idx.queryAsync(query, 3));
        console.log(`      "${query}" -> ${top.join(', ')}`);
        if (!top.slice(0, 2).includes(want)) misses.push(`${query} (wanted ${want}, got ${top.join(', ')})`);
      }
      expect(misses, 'each expected file should be in the top 2').to.deep.equal([]);
    });

    it('re-embeds only changed files on an incremental rebuild', async () => {
      const idx = newIndex();
      await idx.build(files(), emb);
      const changed = files().map(f => (f.path === 'src/csv.ts' ? { path: f.path, content: MAILBOX } : f));
      progress = [];
      await idx.build(changed, emb);
      const top = topFiles(await idx.queryAsync('is this a well formed mail address', 2));
      expect(top[0]).to.equal('src/csv.ts');
      // Only the small changed file needed embedding, not the 20+ filler chunks.
      // Match the progress lines only: the final summary also contains the model name "…embedding…".
      const embeds = progress.filter(p => /^embedding \d+%/.test(p));
      expect(embeds.length, 'a single small batch').to.equal(1);
    });

    it('applies a forced rebuild that arrives while a build is running', async () => {
      const idx = newIndex();
      const first = idx.build(files(), emb);
      const replacement: RagFile[] = [{ path: 'src/only-new.ts', content: 'export const lighthouse = "a tall tower that warns ships about rocks";' }];
      await idx.build(replacement, emb, true); // returns at once: queued behind the running build
      await first;                             // the queued rebuild runs before this resolves
      const st = idx.getStatus();
      expect(st.chunks, 'index now holds only the replacement file').to.be.lessThan(5);
      const top = topFiles(await idx.queryAsync('beacon for vessels near the coast', 1));
      expect(top[0]).to.equal('src/only-new.ts');
    });
  });
}
