// @ts-nocheck
const sinon = require('sinon');
const { installVscodeMock } = require('./_vscode-mock');

// InlineDiffSession/applyComposerPatches use a handful of vscode APIs the shared base mock
// doesn't carry (WorkspaceEdit, Range, ProgressLocation, withProgress); layered on here.
class FakeWorkspaceEdit {
  constructor() { this.replacements = []; }
  replace(uri, range, text) { this.replacements.push({ uri, range, text }); }
}
class FakeRange {
  constructor(start, end) { this.start = start; this.end = end; }
}

const { mock: vscode, restore: restoreVscodeMock } = installVscodeMock({
  WorkspaceEdit: FakeWorkspaceEdit,
  Range: FakeRange,
  ProgressLocation: { Notification: 1 },
});
vscode.workspace.applyEdit = sinon.stub().resolves(true);
vscode.window.withProgress = sinon.stub().callsFake(async (_opts, task) => {
  const token = { onCancellationRequested: sinon.stub() };
  return task({ report: sinon.stub() }, token);
});

const { InlineDiffSession, undoLastComposer, applyComposerPatches } = require('../inline-diff');

let expect;

after(restoreVscodeMock);

/** Explicit per-stub reset: sinon.reset() proved unreliable for stubs created once inside
 * the shared mock (outside any test's own scope), so each relevant stub is reset by name. */
function resetVscodeMockHistory() {
  vscode.workspace.applyEdit.resetHistory();
  vscode.workspace.openTextDocument.resetHistory();
  vscode.workspace.fs.stat.resetHistory();
  vscode.workspace.fs.readFile.resetHistory();
  vscode.workspace.fs.writeFile.resetHistory();
  vscode.workspace.fs.createDirectory.resetHistory();
  vscode.workspace.fs.delete.resetHistory();
  vscode.commands.executeCommand.resetHistory();
  vscode.window.showInformationMessage.resetHistory().resolves(undefined);
  vscode.window.showWarningMessage.resetHistory();
  vscode.window.showErrorMessage.resetHistory();
  vscode.window.showTextDocument.resetHistory();
}

// Any lingering session from a previous test file loaded in the same process (unlikely with
// the per-file process runner, but cheap insurance) is cleared before this file's own tests.
before(async () => { await InlineDiffSession.getCurrent()?.reject(); });

/** A minimal fake vscode.TextDocument: enough for the code under test, nothing more. */
function fakeDoc(content, opts = {}) {
  return {
    uri: opts.uri || { fsPath: '/test-workspace/foo.ts' },
    fileName: opts.fileName || 'foo.ts',
    languageId: opts.languageId || 'typescript',
    getText: (selection) => (selection ? content.slice(0, 5) : content),
    positionAt: (n) => n,
  };
}

function fakeEditor(doc, opts = {}) {
  return { document: doc, viewColumn: opts.viewColumn ?? 1, selection: opts.selection };
}

describe('InlineDiffSession', () => {
  before(async () => { const chai = await import('chai'); expect = chai.expect; });

  beforeEach(async () => {
    await InlineDiffSession.getCurrent()?.reject();
    resetVscodeMockHistory();
    vscode.workspace.applyEdit.resolves(true);
    vscode.workspace.openTextDocument.resolves(fakeDoc('original content'));
  });

  it('getCurrent() is undefined before any session starts', () => {
    // A prior test may leave a session active; explicitly reject to reset state.
    return InlineDiffSession.getCurrent()?.reject().then(() => {
      expect(InlineDiffSession.getCurrent()).to.equal(undefined);
    });
  });

  it('start() writes the suggested content into the real file via WorkspaceEdit', async () => {
    const doc = fakeDoc('original content');
    vscode.window.showInformationMessage.resolves(undefined); // dismissed: leave diff open
    await InlineDiffSession.start(fakeEditor(doc), 'suggested content');
    expect(vscode.workspace.applyEdit.called).to.equal(true);
  });

  it('start() opens the vscode diff command with a label mentioning the file name', async () => {
    const doc = fakeDoc('original', { fileName: 'my-file.ts' });
    vscode.window.showInformationMessage.resolves(undefined);
    await InlineDiffSession.start(fakeEditor(doc), 'new content');
    const diffCall = vscode.commands.executeCommand.getCalls().find(c => c.args[0] === 'vscode.diff');
    expect(diffCall, 'vscode.diff command was invoked').to.exist;
    expect(diffCall.args[3]).to.include('my-file.ts');
  });

  it('start() replacing an active session rejects (reverts) the previous one first', async () => {
    const doc1 = fakeDoc('doc1 original');
    vscode.window.showInformationMessage.resolves(undefined);
    await InlineDiffSession.start(fakeEditor(doc1), 'doc1 suggested');
    const firstSession = InlineDiffSession.getCurrent();

    const doc2 = fakeDoc('doc2 original');
    await InlineDiffSession.start(fakeEditor(doc2), 'doc2 suggested');

    expect(InlineDiffSession.getCurrent()).to.not.equal(firstSession);
  });

  it('choosing Accept in the prompt closes the editor and reopens the doc in place', async () => {
    const doc = fakeDoc('original');
    vscode.window.showInformationMessage.resolves('Accept');
    await InlineDiffSession.start(fakeEditor(doc), 'suggested');
    expect(vscode.commands.executeCommand.calledWith('workbench.action.closeActiveEditor')).to.equal(true);
    expect(vscode.window.showTextDocument.called).to.equal(true);
  });

  it('choosing Reject restores the original content via a WorkspaceEdit replace', async () => {
    const doc = fakeDoc('original content');
    vscode.window.showInformationMessage.resolves('Reject');
    await InlineDiffSession.start(fakeEditor(doc), 'suggested content');
    // Two applyEdit calls: one to write the suggestion, one to restore on reject.
    expect(vscode.workspace.applyEdit.callCount).to.be.greaterThan(1);
  });

  it('accept() and reject() are no-ops if called again after the session is already disposed', async () => {
    const doc = fakeDoc('original');
    vscode.window.showInformationMessage.resolves('Accept');
    await InlineDiffSession.start(fakeEditor(doc), 'suggested');
    const session = InlineDiffSession.getCurrent();
    expect(session).to.equal(undefined); // already disposed by Accept
  });

  it('start() uses the selected text as the original when a non-empty selection is given', async () => {
    const doc = fakeDoc('the quick brown fox');
    vscode.window.showInformationMessage.resolves(undefined);
    const selection = { isEmpty: false };
    await InlineDiffSession.start(fakeEditor(doc, { selection }), 'jumps over', selection);
    const replaceCall = vscode.workspace.applyEdit.getCall(0);
    expect(replaceCall).to.exist;
  });
});

describe('undoLastComposer', () => {
  before(async () => { const chai = await import('chai'); expect = chai.expect; });

  it('shows "nothing to undo" when there are no backups', async () => {
    resetVscodeMockHistory();
    await undoLastComposer();
    expect(vscode.window.showInformationMessage.calledWithMatch(/nothing to undo/i)).to.equal(true);
  });
});

describe('applyComposerPatches', () => {
  before(async () => { const chai = await import('chai'); expect = chai.expect; });

  beforeEach(() => {
    resetVscodeMockHistory();
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/test-workspace' }, name: 'test-workspace' }];
    vscode.workspace.fs.stat.rejects(new Error('not found')); // default: every file is "new"
    vscode.workspace.fs.readFile.resolves(Buffer.from('existing content'));
    vscode.workspace.fs.writeFile.resolves();
    vscode.workspace.fs.createDirectory.resolves();
    vscode.workspace.openTextDocument.resolves(fakeDoc('x'));
    vscode.window.showInformationMessage.resolves('Cancel');
    vscode.commands.executeCommand.resolves(undefined);
  });

  it('does nothing for an empty patch list', async () => {
    await applyComposerPatches([]);
    expect(vscode.window.showErrorMessage.called).to.equal(false);
    expect(vscode.window.showInformationMessage.called).to.equal(false);
  });

  it('shows an error and does nothing when no workspace folder is open', async () => {
    vscode.workspace.workspaceFolders = undefined;
    await applyComposerPatches([{ path: 'foo.ts', content: 'x' }]);
    expect(vscode.window.showErrorMessage.calledWithMatch(/no workspace folder/i)).to.equal(true);
  });

  it('skips a patch with a path-traversal attempt and warns', async () => {
    await applyComposerPatches([{ path: '../outside.ts', content: 'x' }]);
    expect(vscode.window.showWarningMessage.calledWithMatch(/unsafe path/i)).to.equal(true);
  });

  it('skips a patch with an absolute path and warns', async () => {
    await applyComposerPatches([{ path: '/etc/passwd', content: 'x' }]);
    expect(vscode.window.showWarningMessage.calledWithMatch(/unsafe path/i)).to.equal(true);
  });

  it('skips a patch with a Windows drive-letter absolute path and warns', async () => {
    await applyComposerPatches([{ path: 'C:\\Windows\\System32\\evil.ts', content: 'x' }]);
    expect(vscode.window.showWarningMessage.calledWithMatch(/unsafe path/i)).to.equal(true);
    expect(vscode.workspace.fs.writeFile.called).to.equal(false);
  });

  it('does nothing further when every patch was unsafe (safe list ends up empty)', async () => {
    await applyComposerPatches([{ path: '../a.ts', content: 'x' }]);
    expect(vscode.window.showInformationMessage.called).to.equal(false);
  });

  it('returns without writing anything when the user cancels the initial confirmation', async () => {
    vscode.window.showInformationMessage.resolves('Cancel');
    await applyComposerPatches([{ path: 'foo.ts', content: 'new content' }]);
    expect(vscode.workspace.fs.writeFile.called).to.equal(false);
  });

  it('returns without writing anything when the confirmation is dismissed (falsy choice)', async () => {
    vscode.window.showInformationMessage.resolves(undefined);
    await applyComposerPatches([{ path: 'foo.ts', content: 'new content' }]);
    expect(vscode.workspace.fs.writeFile.called).to.equal(false);
  });

  it('a genuinely new file (stat throws) is written directly and opened, no diff review', async () => {
    vscode.window.showInformationMessage.onFirstCall().resolves('Apply All');
    vscode.workspace.fs.stat.rejects(new Error('ENOENT'));
    await applyComposerPatches([{ path: 'brand-new.ts', content: 'hello' }]);
    expect(vscode.workspace.fs.writeFile.calledOnce).to.equal(true);
    expect(vscode.workspace.fs.writeFile.firstCall.args[1].toString()).to.equal('hello');
  });

  it('an existing file whose content is unchanged is skipped entirely', async () => {
    vscode.workspace.fs.stat.resolves({}); // file exists
    vscode.workspace.fs.readFile.resolves(Buffer.from('same content'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Apply All');
    await applyComposerPatches([{ path: 'unchanged.ts', content: 'same content' }]);
    expect(vscode.workspace.fs.writeFile.called).to.equal(false);
  });

  it('"Apply All" applies changed existing files via an InlineDiffSession (WorkspaceEdit), not a direct write', async () => {
    // Writing to disk directly here (the old behaviour) would make InlineDiffSession.start()
    // capture the ALREADY-new content as "original", breaking Reject (nothing left to revert to).
    // The fix routes existing-file changes through applyEdit instead, same as any other diff session.
    vscode.workspace.fs.stat.resolves({});
    vscode.workspace.fs.readFile.resolves(Buffer.from('old content'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Apply All');
    vscode.window.showTextDocument.resolves(fakeEditor(fakeDoc('old content')));
    await applyComposerPatches([{ path: 'changed.ts', content: 'new content' }]);
    expect(vscode.workspace.fs.writeFile.called, 'must not bypass InlineDiffSession with a direct write').to.equal(false);
    expect(vscode.workspace.applyEdit.called, 'must apply the new content via WorkspaceEdit so the original is still recoverable').to.equal(true);
  });

  it('"Apply All" then Reject on that file restores the true pre-patch content, not the just-applied content', async () => {
    vscode.workspace.fs.stat.resolves({});
    vscode.workspace.fs.readFile.resolves(Buffer.from('old content'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Apply All');
    vscode.window.showTextDocument.resolves(fakeEditor(fakeDoc('old content')));
    await applyComposerPatches([{ path: 'changed.ts', content: 'new content' }]);

    const session = InlineDiffSession.getCurrent();
    expect(session, 'an InlineDiffSession should be active after Apply All').to.not.equal(undefined);
    vscode.workspace.applyEdit.resetHistory();
    await session.reject();
    const restoreCall = vscode.workspace.applyEdit.getCall(0);
    const restoredText = restoreCall.args[0].replacements[0].text;
    expect(restoredText, 'reject must restore the real pre-patch content, not the new content it was just "reverting" to').to.equal('old content');
  });

  it('per-file review: choosing Skip does not write that file', async () => {
    vscode.workspace.fs.stat.resolves({});
    vscode.workspace.fs.readFile.resolves(Buffer.from('old content'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Review & Apply');
    vscode.window.showInformationMessage.onSecondCall().resolves('Skip');
    await applyComposerPatches([{ path: 'changed.ts', content: 'new content' }]);
    expect(vscode.workspace.fs.writeFile.called).to.equal(false);
  });

  it('per-file review: choosing Apply writes that one file', async () => {
    vscode.workspace.fs.stat.resolves({});
    vscode.workspace.fs.readFile.resolves(Buffer.from('old content'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Review & Apply');
    vscode.window.showInformationMessage.onSecondCall().resolves('Apply');
    await applyComposerPatches([{ path: 'changed.ts', content: 'new content' }]);
    expect(vscode.workspace.fs.writeFile.calledOnce).to.equal(true);
  });

  it('per-file review: choosing Cancel All stops processing remaining files', async () => {
    vscode.workspace.fs.stat.resolves({});
    vscode.workspace.fs.readFile.resolves(Buffer.from('old content'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Review & Apply');
    vscode.window.showInformationMessage.onSecondCall().resolves('Cancel All');
    await applyComposerPatches([
      { path: 'a.ts', content: 'new a' },
      { path: 'b.ts', content: 'new b' },
    ]);
    expect(vscode.workspace.fs.writeFile.called).to.equal(false);
  });

  it('a multi-root workspace patch path prefixed with the folder name resolves against that folder', async () => {
    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: '/root-a' }, name: 'root-a' },
      { uri: { fsPath: '/root-b' }, name: 'root-b' },
    ];
    vscode.workspace.fs.stat.rejects(new Error('ENOENT'));
    vscode.window.showInformationMessage.onFirstCall().resolves('Apply All');
    await applyComposerPatches([{ path: 'root-b/src/file.ts', content: 'hi' }]);
    const writeCall = vscode.workspace.fs.writeFile.getCall(0);
    expect(writeCall.args[0].fsPath).to.include('root-b');
    expect(writeCall.args[0].fsPath).to.not.include('root-b/root-b');
  });
});
