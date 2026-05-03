// @ts-nocheck
const sinon = require('sinon');
const cp = require('child_process');

// self-contained mock
const vscodeMock = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test-workspace' } }],
    fs: {
      readFile: sinon.stub(),
      writeFile: sinon.stub(),
      createDirectory: sinon.stub(),
      readDirectory: sinon.stub(),
      delete: sinon.stub(),
    },
    asRelativePath: (uri) => (uri.fsPath || uri || '').replace('/test-workspace/', ''),
    findFiles: sinon.stub(),
    openTextDocument: sinon.stub().resolves({}),
  },
  window: {
    activeTerminal: { show: sinon.stub(), sendText: sinon.stub() },
    createTerminal: sinon.stub().returns({ show: sinon.stub(), sendText: sinon.stub() }),
    showTextDocument: sinon.stub(),
  },
  Uri: {
    joinPath: (...args) => ({ fsPath: args.map(a => a.fsPath || a).join('/') }),
    file: (path) => ({ fsPath: path }),
  },
  FileType: {
    File: 1,
    Directory: 2,
  }
};

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'vscode') return vscodeMock;
  return originalRequire.apply(this, arguments);
};

global.vscode = vscodeMock;

const { executeBuiltinTool } = require('../builtin-tools');
const vscode = vscodeMock;

let expect;

describe('Builtin Tools', () => {
  let fetchStub;
  let execStub;

  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch');
    execStub = sinon.stub(cp, 'exec');
    
    // Reset global vscode stubs
    vscode.workspace.fs.readFile.reset();
    vscode.workspace.fs.writeFile.reset();
    vscode.workspace.fs.createDirectory.reset();
    vscode.workspace.fs.readDirectory.reset();
    vscode.workspace.fs.delete.reset();
    vscode.workspace.findFiles.reset();
    vscode.workspace.openTextDocument.reset();
    vscode.window.createTerminal.reset();
    vscode.window.showTextDocument.reset();
  });

  afterEach(() => {
    fetchStub.restore();
    execStub.restore();
    sinon.restore();
  });

  describe('read_file', () => {
    it('reads a file successfully', async () => {
      const content = 'hello world';
      vscode.workspace.fs.readFile.resolves(Buffer.from(content));
      const result = await executeBuiltinTool('read_file', { path: 'test.ts' });
      expect(result).to.equal(content);
    });

    it('returns error for path traversal', async () => {
      const result = await executeBuiltinTool('read_file', { path: '../outside.ts' });
      expect(result).to.include('Path traversal or absolute paths not allowed');
    });

    it('returns error for absolute paths', async () => {
      const result = await executeBuiltinTool('read_file', { path: 'C:/windows/system32/cmd.exe' });
      expect(result).to.include('Path traversal or absolute paths not allowed');
    });

    it('truncates large files', async () => {
      const largeContent = 'a'.repeat(25000);
      vscode.workspace.fs.readFile.resolves(Buffer.from(largeContent));
      const result = await executeBuiltinTool('read_file', { path: 'large.ts' });
      expect(result.length).to.be.lessThan(largeContent.length);
      expect(result).to.include('(truncated');
    });
  });

  describe('write_file', () => {
    it('writes a file successfully and creates directory', async () => {
      vscode.workspace.fs.writeFile.resolves();
      vscode.workspace.fs.createDirectory.resolves();
      const result = await executeBuiltinTool('write_file', { path: 'src/new.ts', content: 'new content' });
      expect(result).to.include('Written src/new.ts');
      expect(vscode.workspace.fs.createDirectory.calledOnce).to.be.true;
    });
  });

  describe('list_directory', () => {
    it('lists directory contents and filters blocked dirs', async () => {
      vscode.workspace.fs.readDirectory.resolves([
        ['src', 2],
        ['node_modules', 2],
        ['README.md', 1],
      ]);
      const result = await executeBuiltinTool('list_directory', { path: '' });
      expect(result).to.include('[dir]  src');
      expect(result).to.include('[file] README.md');
      expect(result).to.not.include('node_modules');
    });
  });

  describe('delete_file', () => {
    it('deletes a file using trash', async () => {
      vscode.workspace.fs.delete.resolves();
      const result = await executeBuiltinTool('delete_file', { path: 'old.ts' });
      expect(result).to.include('Deleted old.ts');
      expect(vscode.workspace.fs.delete.calledWith(sinon.match.any, sinon.match({ useTrash: true }))).to.be.true;
    });
  });

  describe('search_files', () => {
    it('finds matches in files', async () => {
      vscode.workspace.findFiles.resolves([{ fsPath: '/test-workspace/src/test.ts' }]);
      vscode.workspace.fs.readFile.resolves(Buffer.from('line 1\nmatch me\nline 3'));
      const result = await executeBuiltinTool('search_files', { pattern: 'match' });
      expect(result).to.include('src/test.ts:2: match me');
    });
  });

  describe('run_terminal', () => {
    it('executes a command and returns output', async () => {
      execStub.yields(null, 'stdout output', '');
      const result = await executeBuiltinTool('run_terminal', { command: 'ls' });
      expect(result).to.equal('stdout output');
    });

    it('returns exit code on error', async () => {
      execStub.yields({ code: 1 }, '', 'error output');
      const result = await executeBuiltinTool('run_terminal', { command: 'false' });
      expect(result).to.equal('error output');
    });
  });

  describe('browse_web', () => {
    it('fetches a URL and strips HTML', async () => {
      fetchStub.resolves({
        ok: true,
        text: async () => '<html><body><h1>Title</h1><p>Content</p></body></html>'
      });
      const result = await executeBuiltinTool('browse_web', { url: 'https://example.com' });
      expect(result).to.include('Title Content');
    });

    it('returns error for non-http URLs', async () => {
      const result = await executeBuiltinTool('browse_web', { url: 'file:///etc/passwd' });
      expect(result).to.include('Error: url must start with http');
    });
  });
});
