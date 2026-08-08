import { expect } from 'chai';
import { isPrivateUrl, isCompactMarker, COMPACT_EXTRACTION_PROMPT, buildExtractionInput } from '../utils';
import { ChatMessage } from '../client';

// ── isCompactMarker ───────────────────────────────────────────────────────────

describe('isCompactMarker', () => {
  it('returns true for a plain compact marker', () => {
    expect(isCompactMarker({ role: 'system', content: '__compacted__' })).to.be.true;
  });

  it('returns true for a compact marker that includes a structured summary', () => {
    expect(isCompactMarker({ role: 'system', content: '__compacted__\n\ndecisions: used SQLite\nconstraints: no ORM' })).to.be.true;
  });

  it('returns false for a normal system message', () => {
    expect(isCompactMarker({ role: 'system', content: 'You are a helpful assistant.' })).to.be.false;
  });

  it('returns false for a user message that starts with __compacted__', () => {
    expect(isCompactMarker({ role: 'user', content: '__compacted__ something' })).to.be.false;
  });

  it('returns false for an assistant message', () => {
    expect(isCompactMarker({ role: 'assistant', content: 'Hello!' })).to.be.false;
  });

  it('returns false for an empty system message', () => {
    expect(isCompactMarker({ role: 'system', content: '' })).to.be.false;
  });

  it('returns false for a system message that merely contains the word compacted', () => {
    expect(isCompactMarker({ role: 'system', content: 'History was compacted.' })).to.be.false;
  });
});

// ── COMPACT_EXTRACTION_PROMPT ─────────────────────────────────────────────────

describe('COMPACT_EXTRACTION_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(COMPACT_EXTRACTION_PROMPT).to.be.a('string').and.to.have.length.above(0);
  });

  it('names the key extraction sections', () => {
    expect(COMPACT_EXTRACTION_PROMPT).to.include('decisions');
    expect(COMPACT_EXTRACTION_PROMPT).to.include('constraints');
    expect(COMPACT_EXTRACTION_PROMPT).to.include('openFiles');
    expect(COMPACT_EXTRACTION_PROMPT).to.include('nextSteps');
  });

  it('instructs the model to omit empty sections', () => {
    expect(COMPACT_EXTRACTION_PROMPT).to.include('Omit');
  });

  it('instructs the model to output only the structured block', () => {
    expect(COMPACT_EXTRACTION_PROMPT).to.include('no preamble');
  });
});

// ── buildExtractionInput ──────────────────────────────────────────────────────

describe('buildExtractionInput', () => {
  const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

  it('returns empty string for empty input', () => {
    expect(buildExtractionInput([])).to.equal('');
  });

  it('formats user and assistant messages with role labels', () => {
    const result = buildExtractionInput([msg('user', 'hello'), msg('assistant', 'world')]);
    expect(result).to.include('User: hello');
    expect(result).to.include('Assistant: world');
  });

  it('truncates individual messages to maxCharsPerMsg', () => {
    const long = 'a'.repeat(2000);
    const result = buildExtractionInput([msg('user', long)], 10000, 100);
    expect(result).to.have.length.lessThan(200);
  });

  it('respects the token budget and drops earliest messages when over budget', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => msg('user', `message number ${i} with some content padding here`));
    const result = buildExtractionInput(msgs, 200);
    // Should not include all 20 messages — early ones get dropped
    expect(result.split('\n\n').length).to.be.lessThan(20);
  });

  it('includes at least the most recent message even if it alone exceeds the budget', () => {
    const huge = 'word '.repeat(500); // ~625 tokens, well over any small budget
    const result = buildExtractionInput([msg('user', huge)], 10);
    expect(result).to.include('word');
  });

  it('keeps the most recent messages when budget is exhausted', () => {
    const msgs = [
      msg('user', 'very early message'),
      msg('assistant', 'early reply'),
      msg('user', 'recent important question'),
    ];
    // Budget of 10 fits only the last message (8 tokens); adding the previous one (6) would exceed it
    const result = buildExtractionInput(msgs, 10);
    expect(result).to.include('recent important question');
    expect(result).to.not.include('very early message');
    expect(result).to.not.include('early reply');
  });
});

// ── isPrivateUrl ──────────────────────────────────────────────────────────────

describe('isPrivateUrl', () => {
  // ── Public URLs — must NOT be blocked ──────────────────────────────────────

  it('allows a public HTTPS URL', () => {
    expect(isPrivateUrl('https://example.com/docs')).to.be.false;
  });

  it('allows a public HTTP URL', () => {
    expect(isPrivateUrl('http://docs.example.org/api')).to.be.false;
  });

  it('allows a URL with a port on a public host', () => {
    expect(isPrivateUrl('https://api.example.com:443/v1')).to.be.false;
  });

  it('allows a URL with a path and query on a public host', () => {
    expect(isPrivateUrl('https://raw.githubusercontent.com/owner/repo/main/README.md')).to.be.false;
  });

  // ── Loopback ────────────────────────────────────────────────────────────────

  it('blocks http://localhost', () => {
    expect(isPrivateUrl('http://localhost')).to.be.true;
  });

  it('blocks http://localhost:3000', () => {
    expect(isPrivateUrl('http://localhost:3000')).to.be.true;
  });

  it('blocks http://127.0.0.1', () => {
    expect(isPrivateUrl('http://127.0.0.1')).to.be.true;
  });

  it('blocks http://127.0.0.1:8080 (loopback with port)', () => {
    expect(isPrivateUrl('http://127.0.0.1:8080')).to.be.true;
  });

  it('blocks http://127.1.2.3 (loopback range)', () => {
    expect(isPrivateUrl('http://127.1.2.3')).to.be.true;
  });

  it('blocks http://0.0.0.0', () => {
    expect(isPrivateUrl('http://0.0.0.0')).to.be.true;
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(isPrivateUrl('http://[::1]/')).to.be.true;
  });

  // ── Link-local (AWS/GCP metadata) ──────────────────────────────────────────

  it('blocks http://169.254.169.254 (AWS metadata endpoint)', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).to.be.true;
  });

  it('blocks any 169.254.x.x address', () => {
    expect(isPrivateUrl('http://169.254.0.1')).to.be.true;
  });

  // ── RFC-1918 private ranges ─────────────────────────────────────────────────

  it('blocks http://10.0.0.1 (10/8)', () => {
    expect(isPrivateUrl('http://10.0.0.1')).to.be.true;
  });

  it('blocks http://10.255.255.255 (10/8 high end)', () => {
    expect(isPrivateUrl('http://10.255.255.255')).to.be.true;
  });

  it('blocks http://172.16.0.1 (172.16/12 low end)', () => {
    expect(isPrivateUrl('http://172.16.0.1')).to.be.true;
  });

  it('blocks http://172.31.255.255 (172.16/12 high end)', () => {
    expect(isPrivateUrl('http://172.31.255.255')).to.be.true;
  });

  it('allows http://172.15.0.1 (just outside 172.16/12)', () => {
    expect(isPrivateUrl('http://172.15.0.1')).to.be.false;
  });

  it('allows http://172.32.0.1 (just outside 172.16/12)', () => {
    expect(isPrivateUrl('http://172.32.0.1')).to.be.false;
  });

  it('blocks http://192.168.1.1 (192.168/16)', () => {
    expect(isPrivateUrl('http://192.168.1.1')).to.be.true;
  });

  it('blocks http://192.168.0.100 (192.168/16)', () => {
    expect(isPrivateUrl('http://192.168.0.100')).to.be.true;
  });

  // ── Non-HTTP schemes ────────────────────────────────────────────────────────

  it('blocks file:// URLs', () => {
    expect(isPrivateUrl('file:///etc/passwd')).to.be.true;
  });

  it('blocks ftp:// URLs', () => {
    expect(isPrivateUrl('ftp://files.example.com')).to.be.true;
  });

  it('blocks unparseable strings', () => {
    expect(isPrivateUrl('not a url at all')).to.be.true;
  });

  it('blocks empty string', () => {
    expect(isPrivateUrl('')).to.be.true;
  });

  // ── IPv6 unique-local ───────────────────────────────────────────────────────

  it('blocks IPv6 fc00::/7 unique-local addresses', () => {
    expect(isPrivateUrl('http://[fc00::1]/')).to.be.true;
  });

  it('blocks IPv6 fd00::/8 unique-local addresses', () => {
    expect(isPrivateUrl('http://[fd12:3456:789a::1]/')).to.be.true;
  });
});
