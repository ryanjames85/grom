import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'media', 'webview.html'), 'utf8');
const js  = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns the opening tag string for the element with the given id. */
function tagFor(id: string): string {
  const m = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
  if (!m) throw new Error(`Element #${id} not found in webview.html`);
  return m[0];
}

function hasTitle(tag: string): boolean {
  return /\btitle\s*=\s*["'][^"']+["']/.test(tag);
}

// ── Plan / Build mode toggle ──────────────────────────────────────────────────

describe('webview — Plan/Build mode toggle tooltips', () => {
  it('#plan-btn has a non-empty title attribute', () => {
    expect(hasTitle(tagFor('plan-btn'))).to.equal(true,
      '#plan-btn is missing a title= tooltip');
  });

  it('#build-btn has a non-empty title attribute', () => {
    expect(hasTitle(tagFor('build-btn'))).to.equal(true,
      '#build-btn is missing a title= tooltip');
  });

  it('#plan-btn title mentions "Plan"', () => {
    expect(tagFor('plan-btn').toLowerCase()).to.include('plan');
  });

  it('#build-btn title mentions "Build"', () => {
    expect(tagFor('build-btn').toLowerCase()).to.include('build');
  });
});

// ── grom-select provider dropdown ────────────────────────────────────────────

describe('webview — provider dropdown option tooltips', () => {
  it('grom-select-option template includes a title attribute', () => {
    // The template string inside setOptions uses o.tooltip || o.label
    expect(js).to.include('o.tooltip || o.label',
      'grom-select-option template is missing title="${_escHtml(o.tooltip || o.label)}"');
  });

  it('grom-select-option template writes title= into the DOM', () => {
    expect(js).to.match(/grom-select-option[^`]*title="\${_escHtml\(o\.tooltip \|\| o\.label\)}/,
      'grom-select-option HTML template does not set title attribute');
  });

  const expectedProviders: Array<[string, string]> = [
    ['ollama',    'Ollama'],
    ['lmstudio',  'LM Studio'],
    ['opencode',  'Open Code'],
    ['openai',    'OpenAI'],
    ['anthropic', 'Anthropic'],
    ['groq',      'Groq'],
    ['mistral',   'Mistral'],
    ['gemini',    'Gemini'],
  ];

  for (const [value, label] of expectedProviders) {
    it(`provider "${label}" has a tooltip entry`, () => {
      // Each provider entry must carry a tooltip field alongside its value
      const pattern = new RegExp(`value:\\s*['"]${value}['"](?:[^}]|\\n)*?tooltip:`);
      expect(pattern.test(js)).to.equal(true,
        `Provider "${label}" (value="${value}") is missing a tooltip field in providerOpts`);
    });
  }
});

// ── Slash command menu ────────────────────────────────────────────────────────

describe('webview — slash command menu tooltips', () => {
  it('preset items set item.title from description or text', () => {
    expect(js).to.include('item.title = p.description ||',
      'Slash menu preset items are missing item.title assignment');
  });

  it('/compact item has a title attribute set', () => {
    expect(js).to.include("compact.title = '",
      '/compact slash menu item is missing compact.title');
  });

  it('/compact title is non-trivial', () => {
    const m = js.match(/compact\.title\s*=\s*'([^']+)'/);
    expect(m).to.not.equal(null, '/compact title assignment not found');
    expect(m![1].length).to.be.greaterThan(10);
  });

  it('/clear-history item has a title attribute set', () => {
    expect(js).to.include("clearHist.title = '",
      '/clear-history slash menu item is missing clearHist.title');
  });

  it('/clear-history title is non-trivial', () => {
    const m = js.match(/clearHist\.title\s*=\s*'([^']+)'/);
    expect(m).to.not.equal(null, '/clear-history title assignment not found');
    expect(m![1].length).to.be.greaterThan(10);
  });

  it('typing /reindex is intercepted before being sent to the model', () => {
    expect(js).to.include("val.toLowerCase() === '/reindex'",
      '/reindex is not intercepted in sendBtn.onclick the same way /compact and /clear-history are');
  });

  it('typed /reindex posts reindexWorkspace to the extension host', () => {
    expect(js).to.match(/'\/reindex'[\s\S]{0,120}type:\s*'reindexWorkspace'/,
      'typing /reindex does not post {type: reindexWorkspace}');
  });

  // Selecting a slash-menu item via Tab/Enter (keyboard) or a mouse click both run that
  // item's own click handler directly, bypassing sendBtn.onclick's `prompt.value = ''`.
  // Each menu item's handler must clear the box itself, or the typed text lingers after
  // the command has already run (found via manual testing of /reindex, applies to all three).
  it('the Compact menu item clears the input box itself, not just via sendBtn.onclick', () => {
    const idx = js.indexOf("compact.addEventListener('click'");
    expect(idx).to.not.equal(-1);
    const line = js.slice(idx, js.indexOf('\n', idx));
    expect(line).to.include("prompt.value = ''",
      'Compact menu item must clear prompt.value itself: Tab/Enter selection calls its click handler directly, never going through sendBtn.onclick');
  });

  it('the Clear-history menu item clears the input box itself', () => {
    const idx = js.indexOf("clearHist.addEventListener('click'");
    expect(idx).to.not.equal(-1);
    const line = js.slice(idx, js.indexOf('\n', idx));
    expect(line).to.include("prompt.value = ''",
      'Clear-history menu item must clear prompt.value itself');
  });

  it('the Reindex menu item clears the input box itself', () => {
    const idx = js.indexOf("reindex.addEventListener('click'");
    expect(idx).to.not.equal(-1);
    const line = js.slice(idx, js.indexOf('\n', idx));
    expect(line).to.include("prompt.value = ''",
      'Reindex menu item must clear prompt.value itself');
  });

  it('/reindex item has a title attribute set', () => {
    expect(js).to.include("reindex.title = '",
      '/reindex slash menu item is missing reindex.title');
  });

  it('/reindex title is non-trivial', () => {
    const m = js.match(/reindex\.title\s*=\s*'([^']+)'/);
    expect(m).to.not.equal(null, '/reindex title assignment not found');
    expect(m![1].length).to.be.greaterThan(10);
  });

  it('/reindex menu item click posts reindexWorkspace', () => {
    expect(js).to.match(/reindex\.addEventListener\('click',[\s\S]{0,120}type:\s*'reindexWorkspace'/,
      '/reindex menu item click handler does not post {type: reindexWorkspace}');
  });
});

// ── Toolbar + and / buttons ───────────────────────────────────────────────────

describe('webview — toolbar button tooltips', () => {
  it('#plus-btn has a non-empty title attribute', () => {
    expect(hasTitle(tagFor('plus-btn'))).to.equal(true,
      '#plus-btn is missing a title= tooltip');
  });

  it('#slash-btn has a non-empty title attribute', () => {
    expect(hasTitle(tagFor('slash-btn'))).to.equal(true,
      '#slash-btn is missing a title= tooltip');
  });

  it('#plus-btn title mentions attach or file', () => {
    const tag = tagFor('plus-btn').toLowerCase();
    expect(tag.includes('attach') || tag.includes('file') || tag.includes('image')).to.equal(true,
      '#plus-btn title should describe its attach/file purpose');
  });

  it('#slash-btn title mentions commands', () => {
    expect(tagFor('slash-btn').toLowerCase()).to.include('command',
      '#slash-btn title should describe slash commands');
  });
});

// ── Provider / model dropdown button ─────────────────────────────────────────

describe('webview — provider and model select tooltips', () => {
  it('#provider-select has a data-tooltip attribute', () => {
    const m = html.match(/id="provider-select"[^>]*/);
    expect(m).to.not.equal(null, '#provider-select element not found');
    expect(m![0]).to.match(/data-tooltip\s*=\s*["'][^"']+["']/,
      '#provider-select is missing data-tooltip attribute');
  });

  it('#model-select has a data-tooltip attribute', () => {
    const m = html.match(/id="model-select"[^>]*/);
    expect(m).to.not.equal(null, '#model-select element not found');
    expect(m![0]).to.match(/data-tooltip\s*=\s*["'][^"']+["']/,
      '#model-select is missing data-tooltip attribute');
  });

  it('_initGromSelect reads data-tooltip and applies it to the button', () => {
    expect(js).to.include('el.dataset.tooltip',
      '_initGromSelect does not read data-tooltip from the container element');
    expect(js).to.include('_btnTitle',
      '_initGromSelect does not pass the tooltip to the button title');
  });
});

// ── Hide mic button in settings ───────────────────────────────────────────────

describe('webview — hide/show mic toggle in voice settings', () => {
  it('#mic-toggle-btn exists in the voice settings section', () => {
    expect(hasTitle(tagFor('mic-toggle-btn'))).to.equal(true,
      '#mic-toggle-btn is missing a title= tooltip');
  });

  it('#mic-toggle-btn calls window.toggleMicVisibility', () => {
    expect(tagFor('mic-toggle-btn')).to.include('toggleMicVisibility',
      '#mic-toggle-btn does not call window.toggleMicVisibility');
  });

  it('toggleMicVisibility posts disableVoiceInput when enabled', () => {
    expect(js).to.include('disableVoiceInput',
      'toggleMicVisibility does not post disableVoiceInput');
  });

  it('toggleMicVisibility posts enableVoiceInput when disabled', () => {
    expect(js).to.include('enableVoiceInput',
      'toggleMicVisibility does not post enableVoiceInput');
  });

  it('_updateMicToggleBtn applies voice-mic-on class when enabled', () => {
    expect(js).to.include('voice-mic-on',
      '_updateMicToggleBtn missing voice-mic-on class toggle');
  });

  it('_updateMicToggleBtn applies voice-mic-off class when disabled', () => {
    expect(js).to.include('voice-mic-off',
      '_updateMicToggleBtn missing voice-mic-off class toggle');
  });

  it('_updateMicToggleBtn shows on/off state in button text', () => {
    expect(js).to.include('Mic on', '_updateMicToggleBtn missing "Mic on" text');
    expect(js).to.include('Mic off', '_updateMicToggleBtn missing "Mic off" text');
  });
});

// ── Info badges ───────────────────────────────────────────────────────────────

const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');

describe('webview — info badge style', () => {
  it('.info-badge class exists in styles.css', () => {
    expect(css).to.include('.info-badge',
      '.info-badge CSS class is missing from styles.css');
  });

  it('.info-badge has border-radius for circular shape', () => {
    const m = css.match(/\.info-badge\s*\{[^}]+\}/s);
    expect(m).to.not.equal(null, '.info-badge rule not found');
    expect(m![0]).to.include('border-radius',
      '.info-badge is missing border-radius (should be circular)');
  });

  it('.info-badge has opacity (not an empty or stub rule)', () => {
    const m = css.match(/\.info-badge\s*\{[^}]+\}/s);
    expect(m).to.not.equal(null, '.info-badge rule not found');
    expect(m![0]).to.include('opacity',
      '.info-badge rule exists but has no opacity — may be a stub');
  });
});

describe('webview — Voice Input settings privacy badge', () => {
  it('Voice Input settings title contains an info-badge element', () => {
    expect(html).to.match(/settings-section-title[^<]*Voice Input[^<]*<span[^>]*class="info-badge"/,
      'Voice Input settings title is missing the info-badge span');
  });

  it('Voice Input privacy badge has a non-empty title attribute', () => {
    const m = html.match(/settings-section-title[^<]*Voice Input.*?<span([^>]*)>/s);
    expect(m).to.not.equal(null, 'Voice Input info-badge span not found');
    expect(m![1]).to.match(/title\s*=\s*["'][^"']{10,}["']/,
      'Voice Input info-badge title is missing or too short');
  });

  it('Voice Input privacy badge title mentions local processing', () => {
    const m = html.match(/<span[^>]*class="info-badge"[^>]*title="([^"]+)"[^>]*>[^<]*<\/span>/g);
    expect(m).to.not.equal(null, 'No info-badge spans found');
    const privacyBadge = m!.find(s => s.toLowerCase().includes('local') || s.toLowerCase().includes('device'));
    expect(privacyBadge).to.not.equal(undefined,
      'No info-badge title mentions local/device processing');
  });

  it('Voice Input privacy badge title mentions server (nothing sent to server)', () => {
    const m = html.match(/<span[^>]*class="info-badge"[^>]*title="([^"]+)"/g);
    expect(m).to.not.equal(null, 'No info-badge spans found');
    const privacyBadge = m!.find(s => s.toLowerCase().includes('server'));
    expect(privacyBadge).to.not.equal(undefined,
      'Voice Input privacy badge should mention server (e.g. "nothing sent to a server")');
  });

  it('Voice Input privacy badge uses text "i"', () => {
    const m = html.match(/<span[^>]*class="info-badge"[^>]*>([^<]+)<\/span>/g);
    expect(m).to.not.equal(null, 'No info-badge spans found');
    const hasSingleI = m!.some(s => /<span[^>]*>i<\/span>/.test(s));
    expect(hasSingleI).to.equal(true,
      'info-badge should use the letter "i" as its content');
  });

  it('Voice Input privacy badge title is substantive (> 30 chars)', () => {
    const m = html.match(/settings-section-title.*?<span[^>]*class="info-badge"[^>]*title="([^"]+)"/s);
    expect(m).to.not.equal(null, 'Voice Input settings info-badge title not found');
    expect(m![1].length).to.be.greaterThan(30,
      'Voice Input privacy badge title is too short to be meaningful');
  });
});

describe('webview — nudge hide-mic info badge', () => {
  it('main.js creates an info-badge element in the nudge', () => {
    expect(js).to.include("'info-badge'",
      'main.js does not set className to info-badge for the nudge');
  });

  it('nudge info badge title mentions Settings or Voice Input', () => {
    const m = js.match(/hideInfo\.title\s*=\s*'([^']+)'/);
    expect(m).to.not.equal(null, 'hideInfo.title assignment not found in main.js');
    const title = m![1].toLowerCase();
    expect(title.includes('setting') || title.includes('voice')).to.equal(true,
      'nudge info badge title should mention Settings or Voice Input');
  });

  it('nudge info badge title is non-trivial', () => {
    const m = js.match(/hideInfo\.title\s*=\s*'([^']+)'/);
    expect(m).to.not.equal(null, 'hideInfo.title assignment not found in main.js');
    expect(m![1].length).to.be.greaterThan(20);
  });

  it('nudge info badge uses text "i"', () => {
    expect(js).to.match(/hideInfo\.textContent\s*=\s*['"]i['"]/,
      'nudge info badge textContent should be "i"');
  });

  it('nudge info badge title is not empty or whitespace', () => {
    const m = js.match(/hideInfo\.title\s*=\s*'([^']+)'/);
    expect(m).to.not.equal(null, 'hideInfo.title assignment not found');
    expect(m![1].trim().length).to.be.greaterThan(0,
      'nudge info badge title is empty or whitespace');
  });

  it('nudge info badge is appended after the hide-mic label (correct DOM order)', () => {
    // hideInfo must be appended to a row/container that already contains the hide-mic label text
    const appendIdx = js.indexOf('hideInfo');
    const labelIdx  = js.indexOf('Hide mic button');
    expect(appendIdx).to.be.greaterThan(-1, 'hideInfo not found in main.js');
    expect(labelIdx).to.be.greaterThan(-1,  '"Hide mic button" label not found in main.js');
    expect(appendIdx).to.be.greaterThan(labelIdx,
      'info badge code appears before the hide-mic label — DOM order may be wrong');
  });
});

// ── loadSessions: session reset guard ───────────────────────────────────────

describe('webview — loadSessions session reset guard', () => {
  it('loadSessions guard checks m.userInitiated before skipping reset', () => {
    expect(js).to.include('m.userInitiated',
      'loadSessions guard must check m.userInitiated to allow user-initiated resets through');
  });

  it('guard only skips reset when currentAiDiv is set AND userInitiated is false', () => {
    expect(js).to.include('currentAiDiv && !m.userInitiated',
      'guard must require both in-flight request AND non-user-initiated to skip reset');
  });

  it('guard resets currentAiDiv and currentAiText when userInitiated overrides', () => {
    expect(js).to.include('currentAiDiv = null; currentAiText =',
      'loadSessions must clear currentAiDiv and currentAiText when userInitiated forces a reset');
  });

  it('provider passes userInitiated in loadSessions message', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    expect(provider).to.include('userInitiated,',
      'provider must pass userInitiated flag in loadSessions message payload');
  });

  it('provider _loadAllSessions accepts userInitiated parameter', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    expect(provider).to.include('_loadAllSessions(userInitiated = false)',
      '_loadAllSessions must have userInitiated parameter defaulting to false');
  });

  it('_createNewSession calls _loadAllSessions with userInitiated true', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    const idx = provider.indexOf('private _createNewSession()');
    expect(idx).to.not.equal(-1, '_createNewSession method definition not found');
    const slice = provider.slice(idx, idx + 500);
    expect(slice).to.include('_loadAllSessions(true)',
      '_createNewSession must call _loadAllSessions(true) so New Chat always resets the UI');
  });

  it('_switchSession calls _loadAllSessions with userInitiated true', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    const idx = provider.indexOf('private async _switchSession(');
    expect(idx).to.not.equal(-1, '_switchSession method definition not found');
    const slice = provider.slice(idx, idx + 700);
    expect(slice).to.include('_loadAllSessions(true)',
      '_switchSession must call _loadAllSessions(true) so switching sessions always resets the UI');
  });

  it('deleteSession calls _loadAllSessions with userInitiated true', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    const idx = provider.indexOf('this._sessionManager.deleteSession(');
    expect(idx).to.not.equal(-1, 'deleteSession call not found');
    const slice = provider.slice(idx, idx + 200);
    expect(slice).to.include('_loadAllSessions(true)',
      'deleteSession must call _loadAllSessions(true)');
  });

  it('refreshPresets stays background (userInitiated false)', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    const idx = provider.indexOf('refreshPresets');
    expect(idx).to.not.equal(-1, 'refreshPresets not found');
    const slice = provider.slice(idx, idx + 100);
    expect(slice).to.not.include('_loadAllSessions(true)',
      'refreshPresets must NOT pass userInitiated=true — it is a background reload');
  });
});

describe('webview — thinking display (grom.showThinking)', () => {
  it('package.json declares grom.showThinking, default true', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const setting = pkg.contributes?.configuration?.properties?.['grom.showThinking'];
    expect(setting, 'grom.showThinking missing from package.json').to.not.equal(undefined);
    expect(setting.type).to.equal('boolean');
    expect(setting.default).to.equal(true);
  });

  it('provider.ts reads grom.showThinking and includes it in the loadSessions post', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    expect(provider).to.include("get<boolean>('showThinking', true)");
    const idx = provider.indexOf("showReasoningToggle: vscode.workspace.getConfiguration('grom').get<boolean>('showReasoningToggle'");
    const slice = provider.slice(idx, idx + 300);
    expect(slice, 'showThinking should be posted alongside showReasoningToggle').to.include('showThinking');
  });

  it('main.js reads m.showThinking in the loadSessions handler', () => {
    expect(js).to.include('_showThinking = m.showThinking !== false');
  });

  it('main.js defaults _showThinking to true before any message arrives', () => {
    const idx = js.indexOf('let _showThinking');
    expect(idx).to.be.greaterThan(-1);
    expect(js.slice(idx, idx + 40)).to.include('= true');
  });

  it('updateAiDisplay renders a collapsible <details class="think"> with a live preview and a toggle/disable control', () => {
    expect(js).to.include('details class="think"');
    expect(js).to.include('think-preview');
    expect(js).to.include('think-toggle-label');
    expect(js).to.include('think-disable-btn');
  });

  it('updateAiDisplay suppresses the think block entirely when _showThinking is false', () => {
    const idx = js.indexOf('function updateAiDisplay');
    const body = js.slice(idx, idx + 1800);
    expect(body).to.include('if (!_showThinking)');
    expect(body).to.not.include('hideThisOne');
  });

  it('the Hide/Show block label is plain text riding on the native summary toggle, not its own click handler', () => {
    const idx = js.indexOf('function _renderThinkBlock');
    expect(idx, '_renderThinkBlock not found').to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 2000);
    expect(body).to.include("details.open ? 'Hide block' : 'Show block'");
    expect(js).to.not.include('window.hideThinking');
  });

  it('disableThinking is a global, persisted setting change, confirmed first, not a per-message flag', () => {
    expect(js).to.include('window.disableThinking = ');
    const idx = js.indexOf('window.disableThinking = ');
    const body = js.slice(idx, idx + 800);
    // VS Code webviews silently block window.confirm()/alert()/prompt() — there is no option to
    // allow them — so confirmation has to be inline (click-to-arm, click-again-to-commit), not a
    // native dialog which would just do nothing when clicked.
    expect(body, 'native confirm() would silently no-op in a VS Code webview').to.not.include('confirm(');
    expect(body, 'first click arms it rather than acting immediately').to.include("btn.dataset.confirming !== '1'");
    expect(body, 'posts setShowThinking to persist it').to.include("type: 'setShowThinking', value: false");
    expect(body, 'takes effect immediately client-side too').to.include('_showThinking = false');
    expect(js).to.not.include('dataset.thinkHidden');
  });

  it('provider.ts persists setShowThinking as a global VS Code setting', () => {
    const provider = fs.readFileSync(path.join(root, 'src', 'provider.ts'), 'utf8');
    const idx = provider.indexOf("case 'setShowThinking'");
    expect(idx, "case 'setShowThinking' not found in provider.ts").to.be.greaterThan(-1);
    const body = provider.slice(idx, idx + 500);
    expect(body).to.include("update('showThinking'");
    expect(body).to.include('ConfigurationTarget.Global');
  });

  it('onThinkToggle remembers a manually expanded thinking block across re-renders', () => {
    expect(js).to.include('window.onThinkToggle');
    expect(js).to.include("dataset.thinkOpen = details.open");
    expect(js).to.include("dataset.thinkOpen === '1'");
  });

  it('the toggle label reads "Hide block" when open and "Show block" when closed', () => {
    const idx = js.indexOf('function _renderThinkBlock');
    const body = js.slice(idx, idx + 2000);
    expect(body).to.include("details.open ? 'Hide block' : 'Show block'");
  });

  it('the disable button reads "Disable", a clearly separate action from the toggle label', () => {
    const idx = js.indexOf('function _renderThinkBlock');
    const body = js.slice(idx, idx + 2000);
    expect(body).to.include('>Disable<');
  });

  it('the collapsed preview shows a live tail of the actual thinking text, not a generic label', () => {
    const idx = js.indexOf('function _renderThinkBlock');
    const body = js.slice(idx, idx + 2000);
    expect(body, 'shows real content, not a placeholder like "Thinking…"').to.include('think.slice(-240)');
    expect(body).to.not.include("'Thinking…'");
    expect(body).to.not.include("'Thought for '");
  });

  it('the collapsed preview is hidden once expanded, so it does not duplicate the full text', () => {
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    expect(css).to.include('details.think[open] .think-preview');
  });

  it('the preview box is bottom-aligned and fixed height with a fade mask, not real scrolling', () => {
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    expect(css).to.include('.think-preview {');
    expect(css).to.include('mask-image');
    expect(css).to.include('align-items: flex-end');
  });

  it('the fade goes top-to-bottom (top line stays readable, the newest bottom line fades toward nothing)', () => {
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    const idx = css.indexOf('.think-preview {');
    const rule = css.slice(idx, idx + 400);
    const m = rule.match(/mask-image: linear-gradient\(to bottom, ([^)]+)\)/);
    expect(m, 'mask-image gradient not found on .think-preview').to.not.equal(null);
    const stops = m![1];
    // "black" (opaque) must come before "transparent" in the stop list, i.e. top is opaque/dim
    // and the fade toward transparent happens further down, not the other way around.
    expect(stops.indexOf('black')).to.be.lessThan(stops.indexOf('transparent'));
  });

  it('an expand/collapse arrow sits beside Hide block and rotates when the block is open', () => {
    expect(js).to.include('think-expand-arrow');
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    expect(css).to.include('.think-expand-arrow');
    expect(css, 'the arrow should visibly change state when expanded').to.include('details.think[open] .think-expand-arrow');
  });

  it('the expanded thought box has a capped height and scrolls internally instead of growing the page', () => {
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    const idx = css.indexOf('.think-body {');
    const rule = css.slice(idx, idx + 200);
    expect(rule).to.include('max-height');
    expect(rule).to.include('overflow-y: auto');
  });

  it('an expanded thinking box stays scrolled to the newest text as it streams, unless the user scrolled away', () => {
    const idx = js.indexOf('function _renderThinkBlock');
    const body = js.slice(idx, idx + 2600);
    expect(body).to.include("querySelector('.think-body')");
    expect(body).to.include('box.scrollTop = box.scrollHeight');
    expect(body, 'must not force-scroll when the user has manually scrolled up').to.include('!box._userScrolledUp');
  });

  it('a mini jump-to-latest control tracks scroll position per box, mirroring the main chat pattern', () => {
    expect(js).to.include('window.jumpThinkToBottom');
    const idx = js.indexOf('function _renderThinkBlock');
    const body = js.slice(idx, idx + 2000);
    expect(body).to.include("box._userScrolledUp = false");
    expect(body).to.include("box.addEventListener('scroll'");
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    expect(css).to.include('think-scroll-btn');
  });

  it('the thinking block DOM is built once and updated in place, not torn down on every chunk', () => {
    const idx = js.indexOf('function _renderThinkBlock');
    expect(idx, '_renderThinkBlock not found').to.be.greaterThan(-1);
    const body = js.slice(idx, idx + 400);
    expect(body, 'reuses the existing details element when present').to.include("content.querySelector(':scope > details.think')");
    expect(body).to.include('if (!details)');
  });

  it('an abort mid-thought renders plainly as "*Cancelled.*", not swallowed into the think block', () => {
    // A cut-off <think> block never gets a closing tag, so without this guard the Cancelled
    // marker parses as more thinking content instead of the answer -- checked ahead of the
    // <think> branch entirely, not merely as a special case inside it.
    const idx = js.indexOf('function updateAiDisplay');
    const guardIdx = js.indexOf('*Cancelled.*', idx);
    const thinkIdx = js.indexOf("text.includes('<think>')", idx);
    expect(guardIdx, 'no Cancelled guard found in updateAiDisplay').to.be.greaterThan(-1);
    expect(guardIdx, 'the Cancelled guard must run before the <think> branch').to.be.lessThan(thinkIdx);
    const body = js.slice(idx, thinkIdx);
    expect(body).to.include("marked.parse('*Cancelled.*')");
    expect(body).to.include('return;');
  });

  it('the loading dots are a sibling outside .ai-content, never torn down by a content re-render', () => {
    expect(js).to.include("innerHTML = '<div class=\"thinking-dots\"><span></span><span></span><span></span><span class=\"elapsed-time\"></span></div><div class=\"ai-content\"></div>'");
    const idx = js.indexOf('function updateAiDisplay');
    const body = js.slice(idx, idx + 700);
    expect(body).to.include("querySelector(':scope > .ai-content')");
    expect(body).to.include("querySelector(':scope > .thinking-dots')");
  });

  it('updateAiDisplay itself toggles the dots on/off based on whether a real answer has arrived', () => {
    const idx = js.indexOf('function updateAiDisplay');
    const body = js.slice(idx, idx + 3200);
    expect(body).to.include('const stillWorking = !stripThinkTags(text)');
    expect(body).to.include('dots.style.display = stillWorking');
    expect(body).to.include('if (!stillWorking) _stopElapsedTimer()');
  });

  it('the chunk handler no longer special-cases suppression — updateAiDisplay owns dots visibility', () => {
    const idx = js.indexOf("case 'chunk':");
    const body = js.slice(idx, idx + 500);
    expect(body).to.include('updateAiDisplay(currentAiDiv');
    expect(body).to.not.include('suppressingThink');
  });

  it('stripThinkTags removes both closed and still-open <think> content', () => {
    const idx = js.indexOf('function stripThinkTags');
    expect(idx).to.be.greaterThan(-1);
    expect(js.slice(idx, idx + 150)).to.include('<\\/think>|$');
  });

  it('styles.css styles details.think with a toggle label and a disable button hidden until hover', () => {
    const css = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
    expect(css).to.include('details.think');
    expect(css).to.include('think-toggle-label');
    expect(css).to.include('think-disable-btn');
    expect(css, 'the disable control should not be visible by default').to.include('details.think .think-disable-btn { flex-shrink: 0; opacity: 0;');
    expect(css, 'only revealed on hovering the summary row').to.include('details.think summary:hover .think-disable-btn');
  });
});
