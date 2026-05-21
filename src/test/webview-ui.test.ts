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
