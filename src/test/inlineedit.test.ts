// @ts-nocheck
const sinon = require('sinon');
const { installVscodeMock } = require('./_vscode-mock');

const { mock: vscode, restore: restoreVscodeMock } = installVscodeMock({
  ProgressLocation: { Notification: 1 },
});
vscode.window.showInputBox = sinon.stub();
vscode.window.withProgress = sinon.stub().callsFake(async (_opts, task) => {
  const token = { isCancellationRequested: false, onCancellationRequested: sinon.stub() };
  return task({ report: sinon.stub() }, token);
});

const clientModule = require('../client');
const { inlineEdit } = require('../inlineedit');

let expect;

after(restoreVscodeMock);

function fakeEditor(opts = {}) {
  const doc = {
    languageId: opts.languageId || 'typescript',
    getText: () => opts.selectedText ?? 'const x = 1;',
  };
  return {
    document: doc,
    selection: opts.selection || {},
    viewColumn: 1,
    edit: sinon.stub().callsFake(async (cb) => {
      const replacements = [];
      cb({ replace: (sel, text) => replacements.push({ sel, text }) });
      editorInstance._lastEditReplacements = replacements;
      return true;
    }),
  };
}
let editorInstance;

describe('inlineEdit', () => {
  let clientStub;

  before(async () => { const chai = await import('chai'); expect = chai.expect; });

  beforeEach(() => {
    vscode.window.activeTextEditor = undefined;
    vscode.window.showInputBox.reset();
    vscode.window.showInputBox.resolves('add error handling');
    vscode.window.showInformationMessage.reset();
    vscode.window.showInformationMessage.resolves(undefined);
    vscode.window.showErrorMessage.reset();
    vscode.window.showTextDocument.reset();
    vscode.commands.executeCommand.reset();
    vscode.commands.executeCommand.resolves(undefined);
    vscode.workspace.openTextDocument.reset();
    vscode.workspace.openTextDocument.resolves({ uri: { fsPath: '/tmp/doc' } });
    vscode.workspace.getConfiguration.returns({ get: (key, def) => def });

    clientStub = sinon.createStubInstance(clientModule.LocalLLMClient);
    clientStub.chat.resolves('rewritten code');
    sinon.stub(clientModule, 'LocalLLMClient').returns(clientStub);
  });

  afterEach(() => sinon.restore());

  it('does nothing when there is no active editor', async () => {
    vscode.window.activeTextEditor = undefined;
    await inlineEdit({});
    expect(vscode.window.showInputBox.called).to.equal(false);
  });

  it('shows a hint and does nothing when the selection is empty/whitespace', async () => {
    editorInstance = fakeEditor({ selectedText: '   ' });
    vscode.window.activeTextEditor = editorInstance;
    await inlineEdit({});
    expect(vscode.window.showInformationMessage.calledWithMatch(/select some code/i)).to.equal(true);
    expect(vscode.window.showInputBox.called).to.equal(false);
  });

  it('does nothing further when the instruction prompt is dismissed', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    vscode.window.showInputBox.resolves(undefined);
    await inlineEdit({});
    expect(clientStub.chat.called).to.equal(false);
  });

  it('sends the instruction and selected code to the model', async () => {
    editorInstance = fakeEditor({ selectedText: 'const x = 1;' });
    vscode.window.activeTextEditor = editorInstance;
    vscode.window.showInputBox.resolves('add types');
    await inlineEdit({});
    expect(clientStub.chat.calledOnce).to.equal(true);
    const messages = clientStub.chat.firstCall.args[0];
    expect(messages[1].content).to.include('add types');
    expect(messages[1].content).to.include('const x = 1;');
  });

  it('strips <think> blocks and markdown fences from the model result before diffing', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    clientStub.chat.resolves('<think>reasoning here</think>```typescript\nconst y = 2;\n```');
    vscode.window.showInformationMessage.resolves('Accept');
    await inlineEdit({});
    const replacements = editorInstance._lastEditReplacements;
    expect(replacements[0].text).to.equal('const y = 2;');
  });

  it('opens the diff view comparing original and suggested code', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    clientStub.chat.resolves('const rewritten = true;');
    await inlineEdit({});
    const diffCall = vscode.commands.executeCommand.getCalls().find(c => c.args[0] === 'vscode.diff');
    expect(diffCall, 'vscode.diff was invoked').to.exist;
  });

  it('choosing Accept applies the edit and refocuses the editor', async () => {
    editorInstance = fakeEditor({ selectedText: 'old code' });
    vscode.window.activeTextEditor = editorInstance;
    clientStub.chat.resolves('new code');
    vscode.window.showInformationMessage.resolves('Accept');
    await inlineEdit({});
    expect(editorInstance.edit.calledOnce).to.equal(true);
    expect(editorInstance._lastEditReplacements[0].text).to.equal('new code');
    expect(vscode.window.showTextDocument.called).to.equal(true);
  });

  it('choosing Reject does not apply any edit', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    clientStub.chat.resolves('new code');
    vscode.window.showInformationMessage.resolves('Reject');
    await inlineEdit({});
    expect(editorInstance.edit.called).to.equal(false);
  });

  it('dismissing the diff prompt (no choice) does not apply any edit', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    clientStub.chat.resolves('new code');
    vscode.window.showInformationMessage.resolves(undefined);
    await inlineEdit({});
    expect(editorInstance.edit.called).to.equal(false);
  });

  it('shows an error message when the model call fails for a reason other than abort', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    clientStub.chat.rejects(new Error('connection refused'));
    await inlineEdit({});
    expect(vscode.window.showErrorMessage.calledWithMatch(/connection refused/)).to.equal(true);
  });

  it('does not show an error message when the request was aborted (user cancelled)', async () => {
    editorInstance = fakeEditor();
    vscode.window.activeTextEditor = editorInstance;
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    clientStub.chat.rejects(abortError);
    await inlineEdit({});
    expect(vscode.window.showErrorMessage.called).to.equal(false);
  });
});
