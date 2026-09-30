import { expect } from 'chai';
import { messagesToMarkdown, markdownToMessages } from '../session-markdown';
import type { ChatMessage } from '../client';

// ── messagesToMarkdown ────────────────────────────────────────────────────────

describe('messagesToMarkdown', () => {
  it('returns an empty string for an empty history', () => {
    expect(messagesToMarkdown([])).to.equal('');
  });

  it('renders a user message under a "### User" heading', () => {
    const md = messagesToMarkdown([{ role: 'user', content: 'hello there' }]);
    expect(md).to.include('### User');
    expect(md).to.include('hello there');
  });

  it('renders an assistant message under a "### Assistant" heading', () => {
    const md = messagesToMarkdown([{ role: 'assistant', content: 'hi back' }]);
    expect(md).to.include('### Assistant');
    expect(md).to.include('hi back');
  });

  it('omits plain system messages entirely', () => {
    const md = messagesToMarkdown([{ role: 'system', content: 'be helpful' }]);
    expect(md).to.equal('');
  });

  it('renders a compact marker as a horizontal rule with a note, not its raw content', () => {
    const md = messagesToMarkdown([{ role: 'system', content: '__compacted__\n\nsummary text' }]);
    expect(md).to.include('---');
    expect(md).to.include('Earlier messages were compacted.');
    expect(md).to.not.include('summary text');
  });

  it('preserves message order across a mixed history', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ];
    const md = messagesToMarkdown(history);
    expect(md.indexOf('first')).to.be.lessThan(md.indexOf('second'));
    expect(md.indexOf('second')).to.be.lessThan(md.indexOf('third'));
  });
});

// ── markdownToMessages ────────────────────────────────────────────────────────

describe('markdownToMessages', () => {
  it('returns the default title and empty history for empty input', () => {
    const result = markdownToMessages('');
    expect(result.title).to.equal('Imported Chat');
    expect(result.history).to.deep.equal([]);
  });

  it('extracts the title from a "# Chat Session: <title>" header', () => {
    const result = markdownToMessages('# Chat Session: My Chat\n\n### User\nhi\n');
    expect(result.title).to.equal('My Chat');
  });

  it('parses a user message section', () => {
    const result = markdownToMessages('### User\nhello there\n');
    expect(result.history).to.deep.equal([{ role: 'user', content: 'hello there' }]);
  });

  it('parses an assistant message section', () => {
    const result = markdownToMessages('### Assistant\nhi back\n');
    expect(result.history).to.deep.equal([{ role: 'assistant', content: 'hi back' }]);
  });

  it('parses multiple alternating user/assistant sections in order', () => {
    const raw = '### User\nquestion one\n### Assistant\nanswer one\n### User\nquestion two\n';
    const result = markdownToMessages(raw);
    expect(result.history).to.deep.equal([
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'question two' },
    ]);
  });

  it('joins multi-line message content and trims trailing blank lines', () => {
    const raw = '### User\nline one\nline two\n\n### Assistant\nok\n';
    const result = markdownToMessages(raw);
    expect(result.history[0].content).to.equal('line one\nline two');
  });

  it('ignores blockquote lines (the import-instructions note)', () => {
    const raw = '# Chat Session: X\n\n> Import this file into Grom to continue the conversation.\n\n### User\nreal content\n';
    const result = markdownToMessages(raw);
    expect(result.history).to.deep.equal([{ role: 'user', content: 'real content' }]);
  });

  it('inserts a __compacted__ system marker on a horizontal rule line', () => {
    const raw = '### User\nfirst\n---\n### Assistant\nafter compact\n';
    const result = markdownToMessages(raw);
    expect(result.history).to.deep.equal([
      { role: 'user', content: 'first' },
      { role: 'system', content: '__compacted__' },
      { role: 'assistant', content: 'after compact' },
    ]);
  });

  it('round-trips messagesToMarkdown -> markdownToMessages back to the original content', () => {
    const original: ChatMessage[] = [
      { role: 'user', content: 'what is 2+2' },
      { role: 'assistant', content: 'it is 4' },
    ];
    const { history } = markdownToMessages(messagesToMarkdown(original));
    expect(history).to.deep.equal(original);
  });
});
