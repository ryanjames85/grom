/**
 * logger.ts
 *
 * Writes timestamped lines to the "Grom" VS Code Output channel when
 * grom.debugLogging is enabled. All calls are no-ops when the setting is off.
 * The channel is created lazily on first use and reused thereafter.
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function _enabled(): boolean {
  return vscode.workspace.getConfiguration('grom').get<boolean>('debugLogging', false);
}

function _ch(): vscode.OutputChannel {
  if (!_channel) _channel = vscode.window.createOutputChannel('Grom');
  return _channel;
}

export function log(message: string): void {
  if (!_enabled()) return;
  _ch().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  if (!_enabled()) return;
  const detail = err instanceof Error ? err.message : String(err ?? '');
  _ch().appendLine(`[${new Date().toISOString()}] ERROR ${message}${detail ? ': ' + detail : ''}`);
}

export function dispose(): void {
  _channel?.dispose();
  _channel = undefined;
}
