/**
 * inline-diff.ts
 *
 * InlineDiffSession — applies a code suggestion to the real file and opens VS Code's
 * native diff editor (original left, suggested right) so the user can Accept or Reject.
 *
 * Also owns applyComposerPatches, which drives the /compose multi-file apply flow.
 * It lives here rather than in editor.ts because it relies heavily on InlineDiffSession
 * for the per-file review step.
 *
 * NOTE: Strategy for InlineDiffSession — write the suggested content to the real file first,
 * then diff against a temp doc of the original. Accept = leave the file as-is + close diff.
 * Reject = restore original content + close diff. This gives ghost-deletion rendering for free
 * via VS Code's built-in diff renderer without any custom decorations.
 */

import * as vscode from 'vscode';
import { languageFromPath, FilePatch } from './composer';

// Backup store for undo — holds original content before the last Composer run
let _composerBackups: Array<{ uri: vscode.Uri; original: string | null }> = [];

/** Reverts all files changed by the last Composer run, deleting any newly created files. */
export async function undoLastComposer(): Promise<void> {
  if (!_composerBackups.length) {
    vscode.window.showInformationMessage('Grom: nothing to undo.');
    return;
  }
  const backups = [..._composerBackups];
  _composerBackups = [];
  let count = 0;
  for (const { uri, original } of backups) {
    try {
      if (original === null) {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(original, 'utf8'));
      }
      count++;
    } catch { /* skip if file moved/deleted externally */ }
  }
  vscode.window.showInformationMessage(`Grom: reverted ${count} file${count !== 1 ? 's' : ''}.`);
}

export class InlineDiffSession implements vscode.Disposable {
  private static _current?: InlineDiffSession;

  private _original: string;
  private _suggested: string;
  private _doc: vscode.TextDocument;
  private _viewColumn?: vscode.ViewColumn;
  private _disposed = false;

  private constructor(doc: vscode.TextDocument, original: string, suggested: string, viewColumn?: vscode.ViewColumn) {
    this._doc = doc;
    this._original = original;
    this._suggested = suggested;
    this._viewColumn = viewColumn;
  }

  /** Creates a new session, replacing any existing one, and opens the diff view. */
  static async start(editor: vscode.TextEditor, suggested: string, selection?: vscode.Selection): Promise<void> {
    await InlineDiffSession._current?.reject();

    const doc = editor.document;
    const original = selection && !selection.isEmpty
      ? doc.getText(selection)
      : doc.getText();

    const session = new InlineDiffSession(doc, original, suggested, editor.viewColumn);
    InlineDiffSession._current = session;
    await session._applyAndShowDiff(selection);
  }

  /** Returns the currently active session, if any. */
  static getCurrent(): InlineDiffSession | undefined { return InlineDiffSession._current; }

  /** Closes the diff tab and leaves the suggested content in place. */
  async accept(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    InlineDiffSession._current = undefined;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(this._doc, this._viewColumn);
  }

  /** Restores the original content and closes the diff tab. */
  async reject(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    InlineDiffSession._current = undefined;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(this._doc.positionAt(0), this._doc.positionAt(this._doc.getText().length));
    edit.replace(this._doc.uri, fullRange, this._original);
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(this._doc, this._viewColumn);
  }

  dispose() { this.reject(); }

  private async _applyAndShowDiff(selection?: vscode.Selection): Promise<void> {
    const doc = this._doc;

    // Write suggested content to the real file so VS Code's diff renderer shows deletions correctly
    const edit = new vscode.WorkspaceEdit();
    if (selection && !selection.isEmpty) {
      edit.replace(doc.uri, selection, this._suggested);
    } else {
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(doc.uri, fullRange, this._suggested);
    }
    await vscode.workspace.applyEdit(edit);

    const origDoc = await vscode.workspace.openTextDocument({ content: this._original, language: doc.languageId });
    const label = `Grom: ${doc.fileName.split(/[/\\]/).pop()} — review changes`;
    await vscode.commands.executeCommand('vscode.diff', origDoc.uri, doc.uri, label);

    const choice = await vscode.window.showInformationMessage(
      'Apply Grom\'s changes?',
      { modal: false },
      'Accept', 'Reject'
    );

    if (choice === 'Accept') {
      await this.accept();
    } else if (choice === 'Reject') {
      await this.reject();
    }
    // If dismissed, leave the diff open so the user can still decide via Accept/Reject commands
  }
}

/** Applies a set of multi-file patches from /compose with path-traversal guards, per-file diff review, and undo support. */
export async function applyComposerPatches(patches: FilePatch[]): Promise<void> {
  if (!patches.length) return;

  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('Grom: no workspace folder open.');
    return;
  }

  // Validate all paths and reject any traversal attempts before touching the filesystem
  const safe: Array<{ path: string; content: string; uri: vscode.Uri; isNew: boolean }> = [];
  for (const patch of patches) {
    const normalised = patch.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalised.includes('..') || normalised.startsWith('/')) {
      vscode.window.showWarningMessage(`Grom: skipping unsafe path "${patch.path}"`);
      continue;
    }
    // In multi-root workspaces the model may prefix paths with the folder name — find the right root
    const matchedFolder = folders.find(f => normalised.startsWith(f.name + '/'));
    const root = matchedFolder?.uri ?? folders[0].uri;
    const filePath = matchedFolder ? normalised.slice(matchedFolder.name.length + 1) : normalised;
    const uri = vscode.Uri.joinPath(root, filePath);
    let isNew = false;
    try { await vscode.workspace.fs.stat(uri); } catch { isNew = true; }
    safe.push({ path: normalised, content: patch.content, uri, isNew });
  }
  if (!safe.length) return;

  // Snapshot originals before writing anything, so Undo All can restore them
  _composerBackups = [];
  for (const p of safe) {
    if (p.isNew) {
      _composerBackups.push({ uri: p.uri, original: null });
    } else {
      try {
        const bytes = await vscode.workspace.fs.readFile(p.uri);
        _composerBackups.push({ uri: p.uri, original: Buffer.from(bytes).toString('utf8') });
      } catch { /* can't snapshot — skip */ }
    }
  }

  const lines = safe.map(p => `${p.isNew ? '＋ new' : '  mod'} ${p.path}`).join('\n');
  const choice = await vscode.window.showInformationMessage(
    `Grom Composer — ${safe.length} file${safe.length > 1 ? 's' : ''}:\n${lines}`,
    { modal: true },
    'Review & Apply', 'Apply All', 'Cancel'
  );
  if (choice === 'Cancel' || !choice) return;

  const applyAll = choice === 'Apply All';
  let cancelled = false;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Grom: applying changes',
    cancellable: true
  }, async (progress, token) => {
    token.onCancellationRequested(() => { cancelled = true; });

    for (let i = 0; i < safe.length; i++) {
      if (cancelled) break;
      const patch = safe[i];
      const uri = patch.uri;
      progress.report({ message: `${patch.path} (${i + 1}/${safe.length})`, increment: 100 / safe.length });

      if (patch.isNew) {
        const parentUri = vscode.Uri.joinPath(uri, '..');
        try { await vscode.workspace.fs.createDirectory(parentUri); } catch {}
        await vscode.workspace.fs.writeFile(uri, Buffer.from(patch.content, 'utf8'));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
        continue;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const original = Buffer.from(bytes).toString('utf8');
      if (original === patch.content) continue;

      if (applyAll) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(patch.content, 'utf8'));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        await InlineDiffSession.start(editor, patch.content);
        continue;
      }

      // Per-file review: show diff, ask Apply / Skip / Cancel All
      const origDoc = await vscode.workspace.openTextDocument({ content: original, language: languageFromPath(patch.path) });
      const sugDoc = await vscode.workspace.openTextDocument({ content: patch.content, language: languageFromPath(patch.path) });
      await vscode.commands.executeCommand('vscode.diff', origDoc.uri, sugDoc.uri, `Grom Composer: ${patch.path}`);

      const action = await vscode.window.showInformationMessage(
        `Apply changes to ${patch.path}? (${i + 1} of ${safe.length})`,
        { modal: false },
        'Apply', 'Skip', 'Cancel All'
      );
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      if (action === 'Cancel All') { cancelled = true; break; }
      if (action !== 'Apply') continue;

      await vscode.workspace.fs.writeFile(uri, Buffer.from(patch.content, 'utf8'));
    }
  });

  if (!cancelled) {
    const action = await vscode.window.showInformationMessage(
      `Grom Composer applied ${safe.length} file${safe.length !== 1 ? 's' : ''}.`,
      'Undo All'
    );
    if (action === 'Undo All') await undoLastComposer();
  }
}
