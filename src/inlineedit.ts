/**
 * inlineedit.ts
 *
 * "Edit selection" command: prompts the user for an instruction, sends the selected code + instruction
 * to the LLM, and opens a VS Code diff view so the user can Accept or Reject the rewrite.
 *
 * NOTE: This is intentionally a single-shot call (not streaming) — inline edits are small enough
 * that waiting for the full result before showing the diff is the cleaner UX.
 */

import * as vscode from 'vscode';
import { LocalLLMClient } from './client';

/** Entry point for the grom.inlineEdit command — prompts for an instruction and rewrites the selection. */
export async function inlineEdit(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (!selectedText.trim()) {
    vscode.window.showInformationMessage('Select some code first, then use Grom: Edit.');
    return;
  }

  const instruction = await vscode.window.showInputBox({
    prompt: 'What should Grom do with this code?',
    placeHolder: 'e.g. Add error handling, convert to async/await, add TypeScript types…',
    ignoreFocusOut: true
  });
  if (!instruction) return;

  const lang = editor.document.languageId;
  const config = vscode.workspace.getConfiguration('grom');
  const apiUrl = config.get<string>('apiUrl') || 'http://127.0.0.1:11434';
  const model = config.get<string>('model') || 'qwen2.5-coder';
  const useOllama = config.get<boolean>('useOllamaFormat') ?? true;
  const apiKey = config.get<string>('apiKey', '');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Grom: editing…',
    cancellable: true
  }, async (_, cancelToken) => {
    const controller = new AbortController();
    cancelToken.onCancellationRequested(() => controller.abort());

    try {
      const client = new LocalLLMClient(apiUrl, model, useOllama, apiKey || undefined);
      const messages = [
        {
          role: 'system' as const,
          content: `You are an expert ${lang} developer. The user will give you code and an instruction. Rewrite the code following the instruction exactly. Return ONLY the rewritten code — no explanation, no markdown fences, no commentary. Preserve indentation and style.`
        },
        {
          role: 'user' as const,
          content: `Instruction: ${instruction}\n\nCode:\n${selectedText}`
        }
      ];

      const result = await client.chat(messages, controller.signal);
      if (cancelToken.isCancellationRequested) return;

      // Strip thinking blocks from reasoning models, then markdown fences
      const cleaned = result.trim()
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim()
        .replace(/^```[\w]*\n?/, '')
        .replace(/\n?```$/, '');

      // Show diff and ask to accept
      await showInlineEditDiff(editor, selection, selectedText, cleaned, instruction, context);
    } catch (e: any) {
      if (e.name !== 'AbortError') vscode.window.showErrorMessage(`Grom edit failed: ${e.message}`);
    }
  });
}

/** Opens a VS Code diff of original vs suggested code, then applies the edit if the user clicks Accept. */
async function showInlineEditDiff(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  original: string,
  suggested: string,
  instruction: string,
  context: vscode.ExtensionContext
) {
  // Write original and suggested to temp virtual docs for diff view
  const originalDoc = await vscode.workspace.openTextDocument({
    content: original,
    language: editor.document.languageId
  });
  const suggestedDoc = await vscode.workspace.openTextDocument({
    content: suggested,
    language: editor.document.languageId
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalDoc.uri,
    suggestedDoc.uri,
    `Grom Edit: ${instruction}`
  );

  const choice = await vscode.window.showInformationMessage(
    'Apply Grom\'s edit?',
    { modal: false },
    'Accept', 'Reject'
  );

  // Close the diff tab
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  if (choice === 'Accept') {
    await editor.edit(e => e.replace(selection, suggested));
    // Bring the editor back into focus
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }
}
