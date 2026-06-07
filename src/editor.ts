/**
 * editor.ts
 *
 * Simple VS Code editor helpers used by the chat panel and agent loop.
 * Each function is a thin wrapper around a VS Code API call.
 *
 * For the more complex diff/apply flows see:
 *   - inline-diff.ts  — InlineDiffSession (accept/reject inline changes) + applyComposerPatches
 *   - inlineedit.ts   — the select-and-instruct edit command
 */

import * as vscode from 'vscode';
import { languageFromPath } from './composer';
export { FilePatch, parseComposerResponse } from './composer';
export { InlineDiffSession, applyComposerPatches, undoLastComposer } from './inline-diff';

/** Inserts code at the current cursor position in the active editor. */
export function insertCode(code: string): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) editor.edit(e => e.insert(editor.selection.active, code));
}

/** Replaces the current selection with code, or inserts at cursor if nothing is selected. */
export async function applyCode(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  if (editor.document.getText(selection).trim().length > 0) {
    await editor.edit(e => e.replace(selection, code));
  } else {
    await editor.edit(e => e.insert(selection.active, code));
  }
}

/** Opens a read-only diff view showing an agent's proposed write — old content left, proposed right.
 *  Used by the per-action approval flow so the user can review before the file is actually written. */
export async function diffAgentWrite(targetPath: string, newContent: string): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return;
  const normalised = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const targetUri = vscode.Uri.joinPath(folders[0].uri, normalised);

  let existingContent = '';
  let lang = languageFromPath(normalised);
  try {
    const existingDoc = await vscode.workspace.openTextDocument(targetUri);
    existingContent = existingDoc.getText();
    lang = existingDoc.languageId;
  } catch {
    // New file — try VS Code's own detection via untitled URI (not shown to user)
    try {
      const filename = normalised.split('/').pop() ?? 'file';
      const tempDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.from({ scheme: 'untitled', path: filename })
      );
      if (tempDoc.languageId !== 'plaintext') { lang = tempDoc.languageId; }
    } catch {}
  }

  const origDoc = await vscode.workspace.openTextDocument({ content: existingContent, language: lang });
  const proposedDoc = await vscode.workspace.openTextDocument({ content: newContent, language: lang });
  const label = `Grom agent: ${normalised.split('/').pop()} — proposed changes`;
  await vscode.commands.executeCommand('vscode.diff', origDoc.uri, proposedDoc.uri, label);
}

/** Shows a diff of the current selection (or whole file) against suggested code — used by the chat panel's Diff button. */
export async function diffCode(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const original = editor.document.getText(editor.selection) || editor.document.getText();
  const origDoc = await vscode.workspace.openTextDocument({ content: original, language: editor.document.languageId });
  const suggestedDoc = await vscode.workspace.openTextDocument({ content: code, language: editor.document.languageId });
  vscode.commands.executeCommand('vscode.diff', origDoc.uri, suggestedDoc.uri, 'Compare');
}

/** Starts an InlineDiffSession for the given code against the active editor — entry point for the chat panel's Apply button. */
export async function acceptDiff(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const { InlineDiffSession } = await import('./inline-diff');
  await InlineDiffSession.start(editor, code);
}
