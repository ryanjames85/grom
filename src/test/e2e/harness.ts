/**
 * harness.ts
 *
 * Drives a REAL VS Code Extension Development Host headlessly and inspects the REAL rendered
 * Grom webview - not a mock, not a source-text assertion. This is for behavior that can only be
 * proven by actually running the extension: real DOM updates from real postMessage traffic, real
 * CSS-driven visibility, real user-input round trips through the real extension host.
 *
 * Key technique: VS Code's webview renders as two nested iframes in its own Electron window.
 * - The OUTER host iframe (class="webview ready", no id) is cross-origin from the top-level
 *   workbench page (vscode-webview:// vs vscode-file://), but Playwright's page.frames() still
 *   enumerates it as a real navigated frame, so `page.frames().find(...)` reaches it.
 * - The INNER content iframe (#active-frame) is written dynamically (not navigated to a URL),
 *   so Playwright's Frame API cannot attach to it directly. It IS reachable as plain DOM
 *   (`iframe.contentWindow`/`contentDocument`) from the outer host frame's own evaluate() call,
 *   since from there it's same-origin-family - just not from the top-level page's evaluate().
 *
 * Every launched instance gets its own isolated --user-data-dir and --extensions-dir so this
 * never touches the developer's real VS Code profile or runs concurrently with one.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Frame, Page } from 'playwright-core';

const FIXTURE_WORKSPACE = path.join(__dirname, 'fixture-workspace');

const VSCODE_CLI = process.platform === 'win32' ? 'code.cmd' : 'code';

export interface GromHost {
  proc: cp.ChildProcess;
  browser: Browser;
  page: Page;
  /** Sends a keyboard shortcut/command to the real workbench, then waits for settle. */
  dispose(): Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`CDP endpoint on port ${port} never became ready: ${lastErr}`);
}

/** Locates the webview's outer host frame. Retries since the webview mounts asynchronously
 *  after the sidebar view is opened. */
async function waitForWebviewHostFrame(page: Page, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const hostFrame = page.frames().find(f => f.url().includes('vscode-webview://'));
    if (hostFrame) {
      // The frame object exists once VS Code creates the iframe element, but #active-frame
      // (written by the webview content script) can still be a beat behind - wait for it too.
      try {
        const ready = await hostFrame.evaluate(() => {
          const af = document.getElementById('active-frame') as HTMLIFrameElement | null;
          return !!af?.contentDocument?.getElementById('chat-container');
        });
        if (ready) return hostFrame;
      } catch { /* frame navigated away mid-check; retry */ }
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      log(`still waiting for webview - ${page.frames().length} frame(s) so far: ${page.frames().map(f => f.url() || '(about:blank)').join(', ')}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Grom webview host frame (#active-frame with #chat-container) never became ready');
}

function log(msg: string) { console.error(`[e2e ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

/** Kills the VS Code process tree. Windows spawns Code.exe with its own child processes
 *  (renderer, GPU, extension host); a plain proc.kill() only signals the top process. */
async function rmDirWithRetry(dir: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
}

function killVscode(proc: cp.ChildProcess, userDataDir: string) {
  try { proc.kill(); } catch { /* already gone */ }
  if (process.platform !== 'win32') return;
  // On Windows, `code.cmd` doesn't exec into a GUI process directly - it runs Code.exe as a
  // plain Node process (cli.js) which itself launches or messages the real GUI window (main,
  // renderer, GPU, crashpad-handler, network utility - Electron spawns several), so `proc` (our
  // direct child) is not reliably even one of them; killing only it leaves the rest running
  // indefinitely. Every process belonging to THIS run carries the unique --user-data-dir folder
  // name we generated for it somewhere in its command line (sometimes quoted, sometimes not, so
  // matching on the full "--user-data-dir=<path>" substring is fragile) - the random folder-name
  // suffix mkdtempSync appended is quote-agnostic and unique enough to match safely on its own.
  try {
    const marker = path.basename(userDataDir);
    const query = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    cp.execSync(`powershell -NoProfile -Command "${query}"`, { stdio: 'ignore' });
  } catch { /* best effort - a leaked process here is a nuisance, not a test-correctness issue */ }
}

/** Opens Grom's sidebar the way a user actually would: clicking its activity-bar icon. Far more
 *  reliable under CDP automation than a global keybinding, which depends on VS Code's keybinding
 *  service receiving focus-dispatched key events correctly - a real click on real page content
 *  (the activity bar itself, not the webview) has no such dependency. Falls back to the
 *  keybinding if the icon can't be found, in case the accessible label ever changes. */
async function openGromSidebar(page: Page): Promise<void> {
  try {
    const icon = page.getByRole('tab', { name: /Grom/i });
    await icon.waitFor({ state: 'visible', timeout: 10000 });
    await icon.click();
    log('opened Grom sidebar via activity-bar click');
  } catch (e) {
    log(`activity-bar click failed (${e}), falling back to Ctrl+Shift+G keybinding`);
    await page.keyboard.press('Control+Shift+G');
  }
}

/** Launches a real, isolated Extension Development Host with Grom loaded and its sidebar open. */
export async function launchGromHost(opts: { timeoutMs?: number } = {}): Promise<GromHost> {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const { chromium } = require('playwright-core') as typeof import('playwright-core');

  const port = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grom-e2e-userdata-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grom-e2e-extdir-'));
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  log(`spawning ${VSCODE_CLI} on debug port ${port}, user-data-dir=${userDataDir}`);

  const proc = cp.spawn(VSCODE_CLI, [
    `--extensionDevelopmentPath=${repoRoot}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    `--remote-debugging-port=${port}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--skip-welcome',
    '--new-window',
    FIXTURE_WORKSPACE
  ], { stdio: 'ignore', shell: process.platform === 'win32' });

  let browser: Browser;
  let page: Page;
  try {
    await waitForCdp(port, timeoutMs);
    log('CDP endpoint ready, connecting');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
    const context = browser.contexts()[0];
    // The workbench window is the page whose URL is the real vscode-file:// workbench document,
    // not devtools or an about:blank placeholder some Electron builds also expose over CDP.
    const deadline = Date.now() + timeoutMs;
    let workbenchPage: Page | undefined;
    while (Date.now() < deadline && !workbenchPage) {
      workbenchPage = context.pages().find(p => p.url().includes('workbench.html'));
      if (!workbenchPage) await new Promise(r => setTimeout(r, 300));
    }
    if (!workbenchPage) throw new Error('workbench page never appeared over CDP');
    page = workbenchPage;
    log('workbench page found, waiting for load');
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });

    await openGromSidebar(page);
    await waitForWebviewHostFrame(page, timeoutMs);
    log('webview ready');
  } catch (e) {
    if (page! && browser!) {
      try {
        const shotPath = path.join(os.tmpdir(), `grom-e2e-failure-${Date.now()}.png`);
        await page.screenshot({ path: shotPath });
        log(`launch failed - screenshot saved to ${shotPath}`);
        log(`frames at failure: ${page.frames().map(f => f.url()).join(', ')}`);
      } catch { /* best-effort diagnostics only */ }
    }
    // Closing the CDP connection matters even on failure: an open WebSocket handle from a
    // connected `browser` keeps the whole test process's event loop alive, so a failed launch
    // would otherwise leave mocha hanging indefinitely after already having reported the failure.
    if (browser!) { try { await browser.close(); } catch { /* already gone */ } }
    killVscode(proc, userDataDir);
    throw e;
  }

  return {
    proc, browser, page,
    async dispose() {
      try { await browser.close(); } catch { /* already gone */ }
      killVscode(proc, userDataDir);
      // Stop-Process returns as soon as termination is signalled, but Windows can take a moment
      // to actually release file handles the killed processes held open in these directories -
      // an immediate rmSync can lose the race and silently leave the temp dir behind. A short
      // retry absorbs that without ever blocking a real failure (rmSync's own error is swallowed
      // either way, same as before).
      await rmDirWithRetry(userDataDir);
      await rmDirWithRetry(extensionsDir);
    }
  };
}

/** Returns the webview's outer host frame, assuming launchGromHost already confirmed it's ready. */
export function hostFrame(host: GromHost): Frame {
  const f = host.page.frames().find(fr => fr.url().includes('vscode-webview://'));
  if (!f) throw new Error('webview host frame not found - did the webview close?');
  return f;
}

/**
 * Runs `fn` inside the webview's real content document (#active-frame), with `window`/`document`
 * bound to ITS window/document, not the outer host frame's. `fn` is serialised and re-parsed in
 * the host frame's context, so it must be a plain function with no closures over this file's
 * scope - pass any external values via `arg`.
 */
export async function evalInWebview<T, A = undefined>(
  host: GromHost,
  fn: (win: Window, doc: Document, arg: A) => T,
  arg?: A
): Promise<T> {
  const frame = hostFrame(host);
  const evaluateAny = frame.evaluate.bind(frame) as (fn: any, arg: any) => Promise<T>;
  return evaluateAny(
    ({ fnSrc, arg }: { fnSrc: string; arg: A }) => {
      const af = document.getElementById('active-frame') as HTMLIFrameElement | null;
      if (!af?.contentWindow || !af?.contentDocument) throw new Error('#active-frame not ready');
      // eslint-disable-next-line no-new-func
      const inner = new Function(`return (${fnSrc});`)();
      return inner(af.contentWindow, af.contentDocument, arg);
    },
    { fnSrc: fn.toString(), arg: arg as A }
  );
}

/**
 * Computes the on-screen (top-page) bounding rect of an element inside the webview content,
 * by summing three offsets: the outer host iframe's position in the top page, #active-frame's
 * position within the host frame, and the element's own position within #active-frame's content.
 * Needed for any real (CDP-synthesized) mouse action against webview content.
 */
export async function webviewElementScreenRect(host: GromHost, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const frame = hostFrame(host);

  // Offset 1: host iframe's position within the top-level page. Read from the top page itself,
  // since the host frame cannot see its own position in its parent's coordinate space.
  const hostBox = await host.page.evaluate(() => {
    const el = document.querySelector('iframe.webview.ready') as HTMLIFrameElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  if (!hostBox) return null;

  // Offsets 2 and 3: #active-frame's position within the host frame, and the target element's
  // position within active-frame's own content - both computable from inside the host frame.
  const inner = await frame.evaluate((sel: string) => {
    const af = document.getElementById('active-frame') as HTMLIFrameElement | null;
    if (!af?.contentDocument) return null;
    const afRect = af.getBoundingClientRect();
    const el = af.contentDocument.querySelector(sel);
    if (!el) return null;
    const elRect = (el as HTMLElement).getBoundingClientRect();
    return { afX: afRect.x, afY: afRect.y, elX: elRect.x, elY: elRect.y, w: elRect.width, h: elRect.height };
  }, selector);
  if (!inner) return null;

  return {
    x: hostBox.x + inner.afX + inner.elX,
    y: hostBox.y + inner.afY + inner.elY,
    width: inner.w,
    height: inner.h
  };
}

/** Real CDP mouse move to the center of a webview element, for :hover-driven CSS. */
export async function hoverWebviewElement(host: GromHost, selector: string): Promise<void> {
  const rect = await webviewElementScreenRect(host, selector);
  if (!rect) throw new Error(`element not found in webview: ${selector}`);
  await host.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
}
