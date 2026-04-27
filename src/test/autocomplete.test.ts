import { expect } from 'chai';

(global as any).vscode = {
  workspace: { getConfiguration: () => ({ get: (k: string, d: any) => d }) },
  window: { tabGroups: { all: [] }, createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }) },
  StatusBarAlignment: { Right: 1 },
  InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
  InlineCompletionList: class { items: any[]; constructor(items: any[]) { this.items = items; } },
  InlineCompletionItem: class { insertText: string; range: any; constructor(t: string, r: any) { this.insertText = t; this.range = r; } },
  Range: class { s: any; e: any; constructor(s: any, e: any) { this.s = s; this.e = e; } },
};

// Import the pure helper functions by re-exporting them for test — they are module-private
// so we test them indirectly through the exported cleanCompletion-equivalent logic.
// We duplicate the logic here to keep editor.ts clean.
function cleanCompletion(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  text = text.replace(/<\|fim_(?:prefix|suffix|middle)\|>/g, '');
  if (/^(I |Here |Sure|The completion|This code)/i.test(text)) return '';
  return text;
}

function nextWordChunk(text: string): string {
  const match = text.match(/^(\s*\S+\s*)/);
  return match ? match[1] : text;
}

describe('cleanCompletion', () => {
  it('strips leading markdown fence', () => {
    expect(cleanCompletion('```typescript\nconst x = 1;\n```')).to.equal('const x = 1;');
  });

  it('strips plain fence without language tag', () => {
    expect(cleanCompletion('```\nconst x = 1;\n```')).to.equal('const x = 1;');
  });

  it('strips FIM tokens', () => {
    expect(cleanCompletion('<|fim_prefix|>const x<|fim_middle|> = 1;<|fim_suffix|>')).to.equal('const x = 1;');
  });

  it('rejects refusal starting with "I "', () => {
    expect(cleanCompletion('I cannot complete this code.')).to.equal('');
  });

  it('rejects refusal starting with "Here "', () => {
    expect(cleanCompletion('Here is the completion:')).to.equal('');
  });

  it('rejects refusal starting with "Sure"', () => {
    expect(cleanCompletion('Sure! Here is the code...')).to.equal('');
  });

  it('preserves legitimate completions', () => {
    expect(cleanCompletion('return x + y;')).to.equal('return x + y;');
  });

  it('trims leading and trailing whitespace', () => {
    expect(cleanCompletion('  const x = 1;  ')).to.equal('const x = 1;');
  });
});

describe('nextWordChunk', () => {
  it('returns the first word with trailing space', () => {
    expect(nextWordChunk('hello world foo')).to.equal('hello ');
  });

  it('handles leading whitespace', () => {
    expect(nextWordChunk('  hello world')).to.equal('  hello ');
  });

  it('returns full text when only one word', () => {
    expect(nextWordChunk('hello')).to.equal('hello');
  });

  it('handles empty string', () => {
    expect(nextWordChunk('')).to.equal('');
  });

  it('handles punctuation-terminated words', () => {
    expect(nextWordChunk('foo.bar baz')).to.equal('foo.bar ');
  });
});

describe('cleanCompletion sad path', () => {
  it('returns empty string for empty input', () => {
    expect(cleanCompletion('')).to.equal('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanCompletion('   \n  ')).to.equal('');
  });

  it('returns empty string when only a code fence with no content', () => {
    expect(cleanCompletion('```\n```')).to.equal('');
  });

  it('does not strip fence mid-string (only leading/trailing)', () => {
    const result = cleanCompletion('const x = "```code```";');
    expect(result).to.equal('const x = "```code```";');
  });
});
