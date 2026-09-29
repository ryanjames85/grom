// @ts-nocheck
// context.ts is already loaded with the vscode mock by agent-loop.test.ts (which runs first
// alphabetically and patches Module.prototype.require). We stub child_process.execSync on the
// cached module: the inline `const { execSync } = require('child_process')` inside
// resolveSlashCommand destructures at call time, so the stub is picked up correctly.
const sinon = require('sinon');
const childProcess = require('child_process');
const { resolveSlashCommand, resolveMentions, resolveWebSearch } = require('../context');
const terminalBuffer = require('../terminal-buffer');
const pkg = require('../../package.json');

// Grab the vscode mock that context.ts was loaded with (set up by agent-loop.test.ts).
// We add `fs.stat` here since agent-loop's mock only has readFile/writeFile/etc.
const vscode = require('vscode');
if (!vscode.workspace.fs.stat) {
  vscode.workspace.fs.stat = sinon.stub();
}

let expect;

describe('resolveSlashCommand /commit', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  afterEach(() => sinon.restore());

  it('uses git diff --cached when staged changes exist', async () => {
    const execStub = sinon.stub(childProcess, 'execSync');
    execStub.withArgs('git diff --cached', sinon.match.any).returns('diff --git a/foo.ts b/foo.ts\n+added line');
    execStub.withArgs('git diff --cached --stat', sinon.match.any).returns('foo.ts | 1 +');
    execStub.withArgs('git ls-files --others --exclude-standard', sinon.match.any).returns('');

    const result = await resolveSlashCommand('/commit');
    expect(result).to.include('diff --git a/foo.ts');
    expect(result).to.include('foo.ts | 1 +');
    expect(result).to.not.include('No uncommitted changes');
  });

  it('does not call git diff HEAD when staged changes exist', async () => {
    const execStub = sinon.stub(childProcess, 'execSync');
    execStub.withArgs('git diff --cached', sinon.match.any).returns('staged diff content');
    execStub.withArgs('git diff --cached --stat', sinon.match.any).returns('foo.ts | 1 +');
    execStub.withArgs('git ls-files --others --exclude-standard', sinon.match.any).returns('');

    await resolveSlashCommand('/commit');
    expect(execStub.calledWith('git diff HEAD', sinon.match.any)).to.be.false;
  });

  it('falls back to git diff HEAD when nothing is staged', async () => {
    const execStub = sinon.stub(childProcess, 'execSync');
    execStub.withArgs('git diff --cached', sinon.match.any).returns('');
    execStub.withArgs('git diff HEAD --stat', sinon.match.any).returns('bar.ts | 2 +-');
    execStub.withArgs('git diff HEAD', sinon.match.any).returns('diff --git a/bar.ts b/bar.ts\n-old\n+new');
    execStub.withArgs('git ls-files --others --exclude-standard', sinon.match.any).returns('');

    const result = await resolveSlashCommand('/commit');
    expect(result).to.include('diff --git a/bar.ts');
    expect(result).to.include('bar.ts | 2 +-');
  });

  it('includes untracked files when present', async () => {
    const execStub = sinon.stub(childProcess, 'execSync');
    execStub.withArgs('git diff --cached', sinon.match.any).returns('');
    execStub.withArgs('git diff HEAD --stat', sinon.match.any).returns('');
    execStub.withArgs('git diff HEAD', sinon.match.any).returns('some diff');
    execStub.withArgs('git ls-files --others --exclude-standard', sinon.match.any).returns('new-file.ts');

    const result = await resolveSlashCommand('/commit');
    expect(result).to.include('New untracked files');
    expect(result).to.include('new-file.ts');
  });

  it('returns no-changes sentinel when nothing staged, no diff, no untracked', async () => {
    const execStub = sinon.stub(childProcess, 'execSync');
    execStub.withArgs('git diff --cached', sinon.match.any).returns('');
    execStub.withArgs('git diff HEAD --stat', sinon.match.any).returns('');
    execStub.withArgs('git diff HEAD', sinon.match.any).returns('');
    execStub.withArgs('git ls-files --others --exclude-standard', sinon.match.any).returns('');

    const result = await resolveSlashCommand('/commit');
    expect(result).to.include('No uncommitted changes');
  });

  it('returns no-changes sentinel when git throws', async () => {
    sinon.stub(childProcess, 'execSync').throws(new Error('not a git repo'));

    const result = await resolveSlashCommand('/commit');
    expect(result).to.include('No uncommitted changes');
  });
});

describe('resolveSlashCommand other commands', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  it('/explain returns explanation instruction', async () => {
    const result = await resolveSlashCommand('/explain');
    expect(result).to.include('Explain');
  });

  it('/refactor returns refactor instruction', async () => {
    const result = await resolveSlashCommand('/refactor');
    expect(result).to.include('Refactor');
  });

  it('/fix returns fix instruction', async () => {
    const result = await resolveSlashCommand('/fix');
    expect(result).to.include('fix');
  });

  it('/tests returns test instruction', async () => {
    const result = await resolveSlashCommand('/tests');
    expect(result).to.include('unit tests');
  });

  it('/docs returns documentation instruction', async () => {
    const result = await resolveSlashCommand('/docs');
    expect(result).to.include('documentation');
  });

  it('/review returns review instruction', async () => {
    const result = await resolveSlashCommand('/review');
    expect(result).to.include('Review');
  });

  it('unknown command returns the raw text unchanged', async () => {
    const result = await resolveSlashCommand('hello world');
    expect(result).to.equal('hello world');
  });
});

describe('resolveMentions', () => {
  let fetchStub;

  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch');
    vscode.workspace.findFiles.reset();
    vscode.workspace.findFiles.resolves([]);
    vscode.workspace.fs.readFile.reset();
    vscode.workspace.fs.stat.reset();
  });

  afterEach(() => {
    fetchStub.restore();
    sinon.restore();
  });

  it('@url reports HTTP error status when fetch returns non-ok response', async () => {
    fetchStub.resolves({ ok: false, status: 404, statusText: 'Not Found' });
    const result = await resolveMentions('@url:https://example.com/missing', new Set());
    expect(result).to.include('HTTP 404');
    expect(result).to.include('Not Found');
  });

  it('@url reports HTTP 403 Forbidden correctly', async () => {
    fetchStub.resolves({ ok: false, status: 403, statusText: 'Forbidden' });
    const result = await resolveMentions('@url:https://example.com/private', new Set());
    expect(result).to.include('HTTP 403');
    expect(result).to.include('Forbidden');
  });

  it('@filename reports error when file is found but cannot be read', async () => {
    vscode.workspace.findFiles.resolves([{ fsPath: '/test/config.ts' }]);
    vscode.workspace.fs.stat.resolves({ size: 100 });
    vscode.workspace.fs.readFile.rejects(new Error('permission denied'));
    const result = await resolveMentions('@config.ts', new Set());
    expect(result).to.include('Error: could not read file');
    expect(result).to.include('config.ts');
  });

  it('@filename reports error when stat throws', async () => {
    vscode.workspace.findFiles.resolves([{ fsPath: '/test/missing.ts' }]);
    vscode.workspace.fs.stat.rejects(new Error('file not found'));
    const result = await resolveMentions('@missing.ts', new Set());
    expect(result).to.include('Error: could not read file');
  });
});

describe('resolveWebSearch', () => {
  let fetchStub: sinon.SinonStub;

  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch');
  });

  afterEach(() => {
    fetchStub.restore();
    sinon.restore();
  });

  it('returns null when text is not a /search command', async () => {
    const result = await resolveWebSearch('hello world');
    expect(result).to.be.null;
  });

  it('returns null for a partial match that is not /search', async () => {
    const result = await resolveWebSearch('/commit');
    expect(result).to.be.null;
  });

  it('returns formatted results for a successful /search query', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => ({
        AbstractText: 'TypeScript is a typed superset of JavaScript.',
        RelatedTopics: [
          { Text: 'TypeScript - Microsoft' },
          { Text: 'TypeScript handbook' },
        ],
      }),
    });

    const result = await resolveWebSearch('/search TypeScript');
    expect(result).to.not.be.null;
    expect(result).to.include('Web search results');
    expect(result).to.include('TypeScript');
    expect(result).to.include('Summary:');
  });

  it('returns fallback when fetch throws', async () => {
    fetchStub.rejects(new Error('network error'));

    const result = await resolveWebSearch('/search TypeScript');
    expect(result).to.not.be.null;
    expect(result).to.include('TypeScript');
    expect(result).to.include('training knowledge');
  });

  it('returns no-results message when API returns empty data', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => ({ AbstractText: '', RelatedTopics: [] }),
    });

    const result = await resolveWebSearch('/search unknownquery');
    expect(result).to.not.be.null;
    expect(result).to.include('No results found');
    expect(result).to.include('unknownquery');
  });

  it('is case-insensitive for the /search prefix', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => ({ AbstractText: 'Some result', RelatedTopics: [] }),
    });

    const result = await resolveWebSearch('/SEARCH TypeScript');
    expect(result).to.not.be.null;
    expect(result).to.include('TypeScript');
  });
});

describe('@terminal mention', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  it('includes terminal output when buffer has content', async () => {
    terminalBuffer.appendTerminalOutput('npm ERR! package not found\n');
    const result = await resolveMentions('@terminal', new Set());
    expect(result).to.include('[Terminal output]');
    expect(result).to.include('npm ERR!');
  });

  it('includes all sources of terminal content in the same block', async () => {
    terminalBuffer.appendTerminalOutput('first line\n');
    terminalBuffer.appendTerminalOutput('second line\n');
    const result = await resolveMentions('@terminal', new Set());
    expect(result).to.include('first line');
    expect(result).to.include('second line');
  });
});

describe('grom.presets defaults', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  const defaults = pkg.contributes.configuration.properties['grom.presets'].default;

  it('all default presets have label, text and description', () => {
    defaults.forEach((p: any) => {
      expect(p.label, `${p.label} missing label`).to.be.a('string').and.not.empty;
      expect(p.text, `${p.label} missing text`).to.be.a('string').and.not.empty;
      expect(p.description, `${p.label} missing description`).to.be.a('string').and.not.empty;
    });
  });

  it('all slash command presets have text starting with /', () => {
    const slashPresets = defaults.filter((p: any) => p.text.startsWith('/'));
    expect(slashPresets.length).to.be.greaterThan(0);
    slashPresets.forEach((p: any) => {
      expect(p.text).to.match(/^\/[a-z]/, `${p.label} text should be a valid slash command`);
    });
  });
});
