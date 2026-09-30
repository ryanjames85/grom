// @ts-nocheck
/**
 * _vscode-mock.ts
 *
 * Single shared source of the 'vscode' mock used across test files, replacing the ad-hoc
 * per-file `Module.prototype.require` monkey-patches this suite used to carry. Each of those
 * patches mutated a process-wide global and was never restored, so whichever file mocha
 * happened to load first "won" and silently determined what every later file saw when it
 * required a real, vscode-dependent source module — including, in at least one proven case,
 * a completely different file's whole test suite silently never registering with mocha at all
 * (see project_test_harness_bug.md in the session memory for the full writeup).
 *
 * Usage: call installVscodeMock() once at the top of a test file, before requiring any real
 * source module that depends on 'vscode'. It returns the mock object (extend it with sinon
 * stubs particular to that file) and a restore() function. ALWAYS call restore() in an after()
 * hook so the patch never leaks into the next file mocha loads.
 *
 *   const { mock: vscode, restore } = installVscodeMock();
 *   after(restore);
 *   const { executeBuiltinTool } = require('../builtin-tools');
 *
 * A file that needs extra stubs beyond the base shape (e.g. workspace.fs.stat) should add
 * them to the returned mock object directly before requiring its source module, rather than
 * building a second competing mock.
 */

const sinon = require('sinon');
const Module = require('module');

/** Builds a fresh mock object covering every vscode API this test suite currently touches. */
function createVscodeMock() {
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test-workspace' } }],
      getConfiguration: sinon.stub().returns({ get: (key, def) => def }),
      fs: {
        readFile: sinon.stub(),
        writeFile: sinon.stub(),
        createDirectory: sinon.stub(),
        readDirectory: sinon.stub(),
        delete: sinon.stub(),
        stat: sinon.stub(),
      },
      asRelativePath: (uri) => (uri.fsPath || uri || '').replace('/test-workspace/', ''),
      findFiles: sinon.stub().resolves([]),
      openTextDocument: sinon.stub().resolves({}),
      createFileSystemWatcher: sinon.stub().returns({
        onDidCreate: sinon.stub(), onDidDelete: sinon.stub(), onDidChange: sinon.stub(), dispose: sinon.stub(),
      }),
      onDidChangeConfiguration: sinon.stub().returns({ dispose: sinon.stub() }),
    },
    window: {
      activeTextEditor: undefined,
      activeTerminal: { show: sinon.stub(), sendText: sinon.stub() },
      createTerminal: sinon.stub().returns({ show: sinon.stub(), sendText: sinon.stub() }),
      showTextDocument: sinon.stub(),
      showInformationMessage: sinon.stub().resolves(undefined),
      showWarningMessage: sinon.stub().resolves(undefined),
      showErrorMessage: sinon.stub().resolves(undefined),
      createOutputChannel: sinon.stub().returns({ appendLine: sinon.stub(), show: sinon.stub(), dispose: sinon.stub() }),
      createStatusBarItem: sinon.stub().returns({ show: sinon.stub(), hide: sinon.stub(), dispose: sinon.stub() }),
    },
    commands: {
      registerCommand: sinon.stub().returns({ dispose: sinon.stub() }),
      executeCommand: sinon.stub().resolves(undefined),
    },
    Uri: {
      joinPath: (...args) => ({ fsPath: args.map(a => a.fsPath || a).join('/') }),
      file: (path) => ({ fsPath: path }),
    },
    FileType: { File: 1, Directory: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
}

/**
 * Patches Module.prototype.require so require('vscode') resolves to `mock` for the
 * lifetime of this call, then returns a restore() that undoes exactly this patch.
 * Safe to nest: restore() always puts back whatever require() was immediately before
 * this call (not necessarily Node's true original), so files can compose correctly
 * regardless of what mocha loaded before them, as long as each one calls restore().
 */
function installVscodeMock(extra) {
  const mock = Object.assign(createVscodeMock(), extra || {});
  const previousRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'vscode') return mock;
    return previousRequire.apply(this, arguments);
  };
  global.vscode = mock;
  const restore = () => {
    Module.prototype.require = previousRequire;
    if (global.vscode === mock) delete global.vscode;
  };
  return { mock, restore };
}

/**
 * Requires a real source module fresh, bypassing Node's module cache. Necessary because a
 * source module's top-level `import * as vscode from 'vscode'` binds to whichever mock was
 * active the FIRST time anything in the process required it — if an earlier test file already
 * required the same module under its own mock, later files sharing the cached module would
 * silently be reading and writing that earlier file's mock, not their own, even after calling
 * installVscodeMock() themselves. Call this instead of a plain require() for any real source
 * module a test file is directly testing (not for one it only needs a stub of).
 */
function freshRequire(id) {
  const resolved = require.resolve(id);
  // require.cache itself is unreliable under ts-node's CJS/ESM interop here; Module._cache
  // is Node's actual internal module registry and is always present.
  delete Module._cache[resolved];
  return require(id);
}

module.exports = { createVscodeMock, installVscodeMock, freshRequire };
