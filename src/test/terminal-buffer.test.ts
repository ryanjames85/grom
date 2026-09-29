import { expect } from 'chai';
import { appendTerminalOutput, getRecentTerminalOutput, _resetBuffer } from '../terminal-buffer';

describe('terminal-buffer', () => {
  beforeEach(() => { _resetBuffer(); });

  it('buffer is empty initially', () => {
    expect(getRecentTerminalOutput()).to.equal('');
  });

  it('appended text is retrievable', () => {
    appendTerminalOutput('hello world');
    expect(getRecentTerminalOutput()).to.equal('hello world');
  });

  it('multiple appends concatenate', () => {
    appendTerminalOutput('foo');
    appendTerminalOutput('bar');
    expect(getRecentTerminalOutput()).to.equal('foobar');
  });

  it('appending empty string does not change the buffer', () => {
    appendTerminalOutput('initial');
    appendTerminalOutput('');
    expect(getRecentTerminalOutput()).to.equal('initial');
  });

  it('buffer within MAX_BYTES is kept intact', () => {
    const text = 'x'.repeat(4999);
    appendTerminalOutput(text);
    expect(getRecentTerminalOutput()).to.equal(text);
  });

  it('buffer at exactly MAX_BYTES is kept intact', () => {
    const text = 'x'.repeat(5000);
    appendTerminalOutput(text);
    expect(getRecentTerminalOutput().length).to.equal(5000);
  });

  it('buffer exceeding MAX_BYTES retains only the last MAX_BYTES chars', () => {
    appendTerminalOutput('a'.repeat(4000));
    appendTerminalOutput('b'.repeat(2000));  // total 6000 → trimmed to 5000
    const result = getRecentTerminalOutput();
    expect(result.length).to.equal(5000);
    expect(result.endsWith('b'.repeat(2000))).to.be.true;
  });

  it('tail of the most recent content is preserved after trim', () => {
    appendTerminalOutput('DISCARD'.repeat(1000));   // 7000 chars
    appendTerminalOutput('KEEP'.repeat(500));        // 2000 chars
    const result = getRecentTerminalOutput();
    expect(result.endsWith('KEEP'.repeat(500))).to.be.true;
  });

  it('never returns more than MAX_BYTES chars regardless of input volume', () => {
    for (let i = 0; i < 20; i++) appendTerminalOutput('x'.repeat(1000));
    expect(getRecentTerminalOutput().length).to.equal(5000);
  });
});
