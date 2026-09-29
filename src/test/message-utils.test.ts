import { expect } from 'chai';
import { mergeSystemMessages, normaliseForOllama } from '../message-utils';
import type { ChatMessage } from '../message-utils';

// ── mergeSystemMessages ───────────────────────────────────────────────────────

describe('mergeSystemMessages', () => {
  it('returns messages unchanged when no system messages present', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(mergeSystemMessages(input)).to.deep.equal(input);
  });

  it('keeps a single system message at the front', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
    ];
    const result = mergeSystemMessages(input);
    expect(result[0]).to.deep.equal({ role: 'system', content: 'be helpful' });
    expect(result).to.have.length(2);
  });

  it('merges two system messages into one with double newline separator', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: 'system one' },
      { role: 'user', content: 'question' },
      { role: 'system', content: 'system two' },
    ];
    const result = mergeSystemMessages(input);
    expect(result[0].role).to.equal('system');
    expect(result[0].content).to.equal('system one\n\nsystem two');
    expect(result).to.have.length(2); // merged system + user
  });

  it('strips __compacted__ sentinel from system message content', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: '__compacted__\nThis is the summary.' },
      { role: 'user', content: 'hi' },
    ];
    const result = mergeSystemMessages(input);
    expect(result[0].content).to.equal('This is the summary.');
    expect(result[0].content).not.to.include('__compacted__');
  });

  it('strips __compacted__ and merges with a real system message', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: '__compacted__\nPrevious conversation summary.' },
      { role: 'user', content: 'continue' },
    ];
    const result = mergeSystemMessages(input);
    expect(result[0].content).to.equal('You are a helpful assistant.\n\nPrevious conversation summary.');
    expect(result).to.have.length(2);
  });

  it('discards empty system messages after sentinel stripping', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: '__compacted__\n\n   ' },
      { role: 'user', content: 'hello' },
    ];
    const result = mergeSystemMessages(input);
    expect(result.some(m => m.role === 'system')).to.be.false;
    expect(result).to.have.length(1);
  });

  it('discards blank system messages', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: '   ' },
      { role: 'user', content: 'hello' },
    ];
    const result = mergeSystemMessages(input);
    expect(result.some(m => m.role === 'system')).to.be.false;
  });

  it('preserves non-system message order after merge', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const result = mergeSystemMessages(input);
    expect(result.map(m => m.content)).to.deep.equal(['sys', 'u1', 'a1', 'u2']);
  });

  it('returns empty array when only empty/sentinel system messages present', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: '   ' },
    ];
    expect(mergeSystemMessages(input)).to.deep.equal([]);
  });
});

// ── normaliseForOllama ────────────────────────────────────────────────────────

describe('normaliseForOllama', () => {
  it('passes through a simple user message', () => {
    const input: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const result = normaliseForOllama(input);
    expect(result).to.deep.equal([{ role: 'user', content: 'hello' }]);
  });

  it('merges system messages before conversion', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: 'sys one' },
      { role: 'system', content: 'sys two' },
      { role: 'user', content: 'q' },
    ];
    const result = normaliseForOllama(input);
    expect(result[0]).to.deep.equal({ role: 'system', content: 'sys one\n\nsys two' });
    expect(result).to.have.length(2);
  });

  it('strips __compacted__ sentinel during normalisation', () => {
    const input: ChatMessage[] = [
      { role: 'system', content: '__compacted__\nSummary here.' },
      { role: 'user', content: 'hello' },
    ];
    const result = normaliseForOllama(input);
    expect(result[0].content).to.equal('Summary here.');
  });

  it('includes images array when present', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'describe this', images: ['base64data'] },
    ];
    const result = normaliseForOllama(input);
    expect(result[0].images).to.deep.equal(['base64data']);
  });

  it('omits images field when empty', () => {
    const input: ChatMessage[] = [{ role: 'user', content: 'hi', images: [] }];
    const result = normaliseForOllama(input);
    expect(result[0]).not.to.have.property('images');
  });

  it('includes tool_call_id when present', () => {
    const input: ChatMessage[] = [
      { role: 'tool', content: 'result', tool_call_id: 'tc-1' },
    ];
    const result = normaliseForOllama(input);
    expect(result[0].tool_call_id).to.equal('tc-1');
  });

  it('deserialises tool_calls arguments from JSON string to object', () => {
    const input: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } }],
      },
    ];
    const result = normaliseForOllama(input);
    expect(result[0].tool_calls[0].function.arguments).to.deep.equal({ q: 'cats' });
  });

  it('falls back to raw string when tool_calls arguments are not valid JSON', () => {
    const input: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'search', arguments: 'not-json' } }],
      },
    ];
    const result = normaliseForOllama(input);
    expect(result[0].tool_calls[0].function.arguments).to.equal('not-json');
  });

  it('preserves tool_call id and type alongside deserialised arguments', () => {
    const input: ChatMessage[] = [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'abc', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      },
    ];
    const result = normaliseForOllama(input);
    expect(result[0].tool_calls[0].id).to.equal('abc');
    expect(result[0].tool_calls[0].type).to.equal('function');
  });

  it('does not add tool_calls field when absent', () => {
    const input: ChatMessage[] = [{ role: 'assistant', content: 'plain reply' }];
    const result = normaliseForOllama(input);
    expect(result[0]).not.to.have.property('tool_calls');
  });

  it('handles empty input', () => {
    expect(normaliseForOllama([])).to.deep.equal([]);
  });

  it('produces system message as plain object without extra fields', () => {
    const input: ChatMessage[] = [{ role: 'system', content: 'you are helpful' }];
    const result = normaliseForOllama(input);
    expect(result[0]).to.deep.equal({ role: 'system', content: 'you are helpful' });
  });
});
