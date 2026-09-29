import { expect } from 'chai';
import * as sinon from 'sinon';
import { DocsIndex } from '../docs-index';

// Helper: builds a valid-looking fetch response for a given body text and optional links.
function htmlResponse(text: string, links: string[] = []) {
  const anchors = links.map(l => `<a href="${l}">link</a>`).join('');
  return {
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => `<html><body>${text}${anchors}</body></html>`,
  };
}

// Enough readable text to pass the 80-char threshold per page, tokenise well, and produce chunks.
const RICH_CONTENT = 'React hooks useState functional components state management. '.repeat(5);

describe('DocsIndex', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis as any, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  // ── initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('isIndexed returns false for any source before indexing', () => {
      const idx = new DocsIndex();
      expect(idx.isIndexed('react')).to.be.false;
    });

    it('getSources returns empty array initially', () => {
      const idx = new DocsIndex();
      expect(idx.getSources()).to.deep.equal([]);
    });

    it('query returns empty string when nothing is indexed', () => {
      const idx = new DocsIndex();
      expect(idx.query('useState')).to.equal('');
    });
  });

  // ── indexSource ────────────────────────────────────────────────────────────

  describe('indexSource', () => {
    it('marks source as indexed after a successful crawl', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });
      expect(idx.isIndexed('react')).to.be.true;
      expect(idx.getSources()).to.include('react');
    });

    it('skips a source that is already indexed', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });
      const callsAfterFirst = fetchStub.callCount;

      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });
      expect(fetchStub.callCount).to.equal(callsAfterFirst);
    });

    it('does not mark as indexed when fetch rejects (network error)', async () => {
      fetchStub.rejects(new Error('ECONNREFUSED'));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'docs', url: 'http://localhost/docs' });
      expect(idx.isIndexed('docs')).to.be.false;
    });

    it('does not mark as indexed when all pages return non-OK status', async () => {
      fetchStub.resolves({ ok: false });
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'docs', url: 'http://localhost/docs' });
      expect(idx.isIndexed('docs')).to.be.false;
    });

    it('does not mark as indexed when page text is too short (<80 chars)', async () => {
      fetchStub.resolves(htmlResponse('Short.'));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'docs', url: 'http://localhost/docs' });
      expect(idx.isIndexed('docs')).to.be.false;
    });

    it('reports progress during crawling via the onProgress callback', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const progress: string[] = [];
      const idx = new DocsIndex((msg: string) => { if (msg) progress.push(msg); });
      await idx.indexSource({ name: 'docs', url: 'http://localhost/docs' });
      expect(progress.length).to.be.greaterThan(0);
      expect(progress.some(m => m.includes('docs'))).to.be.true;
    });

    it('emits an "indexed" progress message on success', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const progress: string[] = [];
      const idx = new DocsIndex((msg: string) => { if (msg) progress.push(msg); });
      await idx.indexSource({ name: 'docs', url: 'http://localhost/docs' });
      expect(progress.some(m => m.includes('indexed'))).to.be.true;
    });

    it('leaves other sources intact when one fails', async () => {
      const idx = new DocsIndex();

      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      fetchStub.reset();
      fetchStub.rejects(new Error('boom'));
      await idx.indexSource({ name: 'docs', url: 'http://localhost/docs' });

      expect(idx.isIndexed('react')).to.be.true;
      expect(idx.isIndexed('docs')).to.be.false;
    });
  });

  // ── clearSource ────────────────────────────────────────────────────────────

  describe('clearSource', () => {
    it('removes an indexed source so isIndexed returns false', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });
      expect(idx.isIndexed('react')).to.be.true;

      idx.clearSource('react');
      expect(idx.isIndexed('react')).to.be.false;
      expect(idx.getSources()).to.not.include('react');
    });

    it('does not throw when clearing a source that was never indexed', () => {
      const idx = new DocsIndex();
      expect(() => idx.clearSource('ghost')).to.not.throw();
    });

    it('only removes chunks belonging to the cleared source, not others', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      fetchStub.reset();
      fetchStub.resolves(htmlResponse(
        'Vue framework reactive components template syntax composition api. '.repeat(5)
      ));
      await idx.indexSource({ name: 'vue', url: 'http://localhost/vue' });

      idx.clearSource('react');

      expect(idx.isIndexed('react')).to.be.false;
      expect(idx.isIndexed('vue')).to.be.true;
    });
  });

  // ── query ──────────────────────────────────────────────────────────────────

  describe('query', () => {
    it('returns relevant chunks for a matching query', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      const result = idx.query('useState React hook');
      expect(result.length).to.be.greaterThan(0);
      expect(result).to.include('react');
    });

    it('result format includes [source — url] header', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      const result = idx.query('useState');
      expect(result).to.match(/\[react —/);
    });

    it('filters by sourceName when provided', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      const withSource = idx.query('useState', 'react');
      expect(withSource.length).to.be.greaterThan(0);

      const wrongSource = idx.query('useState', 'vue');
      expect(wrongSource).to.equal('');
    });

    it('returns empty string when query terms have no TF-IDF overlap with indexed content', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      const result = idx.query('zzz xyzzy completelyrandom');
      expect(result).to.equal('');
    });

    it('respects topK limit (default 4)', async () => {
      const bigContent = 'useState hook React functional component state setter callback. '.repeat(60);
      fetchStub.resolves(htmlResponse(bigContent));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });

      const result = idx.query('useState', undefined, 2);
      // At most 2 chunks → at most 1 separator
      const separators = (result.match(/---/g) || []).length;
      expect(separators).to.be.at.most(1);
    });
  });

  // ── indexAll ───────────────────────────────────────────────────────────────

  describe('indexAll', () => {
    it('indexes multiple sources', async () => {
      fetchStub.callsFake(async (url: string) => {
        const content = url.includes('react')
          ? 'React hooks useState functional state management. '.repeat(5)
          : 'Vue framework reactive template composition api. '.repeat(5);
        return htmlResponse(content);
      });

      const idx = new DocsIndex();
      await idx.indexAll([
        { name: 'react', url: 'http://localhost/react' },
        { name: 'vue', url: 'http://localhost/vue' },
      ]);

      expect(idx.isIndexed('react')).to.be.true;
      expect(idx.isIndexed('vue')).to.be.true;
    });

    it('skips sources already indexed', async () => {
      fetchStub.resolves(htmlResponse(RICH_CONTENT));
      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/react' });
      const callsAfterFirst = fetchStub.callCount;

      await idx.indexAll([{ name: 'react', url: 'http://localhost/react' }]);
      expect(fetchStub.callCount).to.equal(callsAfterFirst);
    });

    it('handles an empty sources array without throwing', async () => {
      const idx = new DocsIndex();
      await idx.indexAll([]);
      expect(idx.getSources()).to.deep.equal([]);
    });
  });

  // ── same-origin / path-prefix link filtering ───────────────────────────────

  describe('same-origin link filtering', () => {
    it('does not crawl links outside the configured path prefix', async () => {
      fetchStub.onFirstCall().resolves(
        htmlResponse(RICH_CONTENT, ['/reference/hooks', '/about'])
      );
      fetchStub.resolves(htmlResponse(RICH_CONTENT));

      const idx = new DocsIndex();
      await idx.indexSource({ name: 'react', url: 'http://localhost/reference' });

      const fetched: string[] = fetchStub.getCalls().map((c: sinon.SinonSpyCall) => c.args[0] as string);
      expect(fetched.some(u => u.includes('/about'))).to.be.false;
      expect(fetched.some(u => u.includes('/reference'))).to.be.true;
    });
  });
});
