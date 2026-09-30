/**
 * webview.e2e.test.ts
 *
 * Real end-to-end tests against a live VS Code Extension Development Host with Grom's actual
 * webview rendered inside it (see harness.ts for how). These prove behavior that source-text
 * assertions and mocked-vscode unit tests structurally cannot: that the real DOM updates the way
 * the code says it should, and that a real postMessage round trip through the real extension
 * host actually works end to end.
 *
 * This is intentionally a small, high-value suite, not a replacement for the unit test suite -
 * each test here is something that was previously only verifiable by a human clicking through a
 * live F5 session. Slow (spins up a real VS Code window) and not part of `npm test`; run via
 * `npm run test:e2e`. Requires the `code` CLI on PATH.
 */

import { expect } from 'chai';
import { launchGromHost, evalInWebview, GromHost } from './harness';

describe('Grom webview (real Extension Development Host)', function () {
  this.timeout(120000);
  let host: GromHost;

  before(async function () {
    this.timeout(60000);
    host = await launchGromHost();
  });

  after(async () => { await host?.dispose(); });

  it('updateAiDisplay() wraps <think> content in a details.think block and renders the answer outside it', async () => {
    const result = await evalInWebview(host, (win, doc) => {
      // Mirrors the real message-bubble structure main.js builds (see the currentAiDiv setup
      // around .msg-body's innerHTML): updateAiDisplay's `container` argument is a .msg-body
      // element that already has an empty .ai-content child, not a bare div.
      const container = doc.createElement('div');
      container.className = 'msg-body';
      container.innerHTML = '<div class="ai-content"></div>';
      doc.getElementById('chat-container')!.appendChild(container);
      (win as any).updateAiDisplay(container, '<think>reasoning about it</think>The answer is 4.');
      const details = container.querySelector('details.think');
      const body = details?.querySelector('.think-body')?.textContent || '';
      const mainText = container.querySelector('.think-main')?.textContent || '';
      container.remove();
      return { hasThinkBlock: !!details, thinkBody: body, mainText };
    });
    expect(result.hasThinkBlock, 'a <think>...</think> reply must produce a details.think element').to.equal(true);
    expect(result.thinkBody).to.include('reasoning about it');
    expect(result.mainText).to.include('The answer is 4.');
    expect(result.mainText, 'the answer text must not still contain the thinking content').to.not.include('reasoning about it');
  });

  it('updateAiDisplay() does not wrap content in a think block when there is no <think> tag', async () => {
    const result = await evalInWebview(host, (win, doc) => {
      const container = doc.createElement('div');
      container.className = 'msg-body';
      container.innerHTML = '<div class="ai-content"></div>';
      doc.getElementById('chat-container')!.appendChild(container);
      (win as any).updateAiDisplay(container, 'Just a plain reply, no thinking.');
      const hasThinkBlock = !!container.querySelector('details.think');
      const text = container.textContent || '';
      container.remove();
      return { hasThinkBlock, text };
    });
    expect(result.hasThinkBlock).to.equal(false);
    expect(result.text).to.include('Just a plain reply, no thinking.');
  });

  it('the language-override badge shows and hides in response to a real languageOverrideActive message', async () => {
    // Dispatches a genuine `message` event at the webview's own window - the same delivery
    // mechanism the real extension host uses - so this exercises the REAL window.addEventListener
    // handler in main.js, not a mock of it.
    const shown = await evalInWebview(host, (win, doc, arg: { model: string; language: string }) => {
      win.postMessage({ type: 'languageOverrideActive', active: true, model: arg.model, language: arg.language }, '*');
      return new Promise<{ display: string; title: string }>(resolve => {
        setTimeout(() => {
          const badge = doc.getElementById('language-override-badge')!;
          resolve({ display: getComputedStyle(badge).display, title: badge.title });
        }, 100);
      });
    }, { model: 'qwen2.5-coder:1.5b', language: 'python' });
    expect(shown.display, 'badge must become visible on languageOverrideActive: active=true').to.not.equal('none');
    expect(shown.title).to.include('qwen2.5-coder:1.5b');
    expect(shown.title).to.include('python');

    const hidden = await evalInWebview(host, (win, doc) => {
      win.postMessage({ type: 'languageOverrideActive', active: false }, '*');
      return new Promise<string>(resolve => {
        setTimeout(() => resolve(getComputedStyle(doc.getElementById('language-override-badge')!).display), 100);
      });
    });
    expect(hidden, 'badge must hide again on languageOverrideActive: active=false').to.equal('none');
  });

  it('clicking the memory button opens the overlay via a real round trip through the real extension host', async () => {
    const opened = await evalInWebview(host, (win, doc) => {
      (doc.getElementById('memory-btn') as HTMLButtonElement).click();
      return new Promise<string>(resolve => {
        // Real getMemory() round trip (webview -> extension host -> globalState -> back), not a
        // stubbed response - genuinely waits for the actual reply to arrive.
        const deadline = Date.now() + 5000;
        const poll = () => {
          const overlay = doc.getElementById('memory-overlay')!;
          if (getComputedStyle(overlay).display !== 'none' || Date.now() > deadline) {
            resolve(getComputedStyle(overlay).display);
          } else {
            setTimeout(poll, 100);
          }
        };
        poll();
      });
    });
    expect(opened, 'memory overlay must open after a real extension-host round trip').to.equal('flex');

    const closed = await evalInWebview(host, (win, doc) => {
      (win as any).cancelMemory();
      return getComputedStyle(doc.getElementById('memory-overlay')!).display;
    });
    expect(closed).to.equal('none');
  });
});
