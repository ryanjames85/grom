import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'media', 'webview.html'), 'utf8');
const js   = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');
const css  = fs.readFileSync(path.join(root, 'media', 'styles.css'), 'utf8');
const pkg  = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const MODELS = ['tiny', 'tiny.en', 'base', 'base.en', 'small.en', 'small'];

// ── package.json schema ───────────────────────────────────────────────────────

describe('voice — package.json schema', () => {
  const voiceModel = pkg.contributes?.configuration?.properties?.['grom.voiceModel'];
  const sensitivity = pkg.contributes?.configuration?.properties?.['grom.voiceSensitivity'];

  it('grom.voiceModel exists in contributes.configuration', () => {
    expect(voiceModel).to.not.equal(undefined, 'grom.voiceModel missing from package.json');
  });

  it('grom.voiceModel default is tiny.en', () => {
    expect(voiceModel?.default).to.equal('tiny.en');
  });

  for (const id of MODELS) {
    it(`grom.voiceModel enum includes "${id}"`, () => {
      expect(voiceModel?.enum).to.include(id, `"${id}" missing from grom.voiceModel enum`);
    });
  }

  it('grom.voiceModel enum has exactly 6 entries', () => {
    expect(voiceModel?.enum).to.have.lengthOf(6);
  });

  it('grom.voiceSensitivity exists in contributes.configuration', () => {
    expect(sensitivity).to.not.equal(undefined, 'grom.voiceSensitivity missing from package.json');
  });

  it('grom.voiceSensitivity default is 0.010', () => {
    expect(sensitivity?.default).to.equal(0.010);
  });

  it('grom.voiceSensitivity minimum is > 0', () => {
    expect(sensitivity?.minimum).to.be.greaterThan(0);
  });

  it('grom.voiceSensitivity maximum is <= 0.1', () => {
    expect(sensitivity?.maximum).to.be.at.most(0.1);
  });
});

// ── webview.html — model picker ───────────────────────────────────────────────

describe('voice — model picker HTML', () => {
  for (const id of MODELS) {
    it(`#voice-model-btn-${id} exists`, () => {
      expect(html).to.include(`id="voice-model-btn-${id}"`,
        `Model button for "${id}" missing from webview.html`);
    });

    it(`#voice-model-btn-${id} calls selectVoiceModel('${id}')`, () => {
      expect(html).to.include(`selectVoiceModel('${id}')`,
        `Model button for "${id}" does not call selectVoiceModel`);
    });
  }

  it('#voice-set-default-btn exists', () => {
    expect(html).to.include('id="voice-set-default-btn"',
      '"Set as default" button missing from webview.html');
  });

  it('#voice-set-default-btn calls applyVoiceModel', () => {
    expect(html).to.include('applyVoiceModel()',
      '"Set as default" button does not call applyVoiceModel');
  });

  it('#voice-model-download-btn exists', () => {
    expect(html).to.include('id="voice-model-download-btn"',
      'Download model button missing from webview.html');
  });
});

// ── webview.html — sensitivity slider ────────────────────────────────────────

describe('voice — sensitivity slider HTML', () => {
  it('#voice-sensitivity-slider exists', () => {
    expect(html).to.include('id="voice-sensitivity-slider"',
      'Sensitivity slider missing from webview.html');
  });

  it('#voice-sensitivity-slider is type range', () => {
    // The type attribute may appear before or after id= in the tag
    const m = html.match(/<input[^>]*id="voice-sensitivity-slider"[^>]*>/);
    expect(m).to.not.equal(null, '#voice-sensitivity-slider input not found');
    expect(m![0]).to.include('type="range"');
  });

  it('#voice-sensitivity-slider calls onVoiceSensitivityInput on input', () => {
    expect(html).to.include('onVoiceSensitivityInput',
      'Slider missing oninput handler');
  });

  it('#voice-sensitivity-slider calls onVoiceSensitivityChange on change', () => {
    expect(html).to.include('onVoiceSensitivityChange',
      'Slider missing onchange handler');
  });

  it('#voice-sensitivity-val exists for live display', () => {
    expect(html).to.include('id="voice-sensitivity-val"',
      'Sensitivity value label missing from webview.html');
  });
});

// ── webview.html — transcribing / warm-up row ─────────────────────────────────

describe('voice — transcribing row HTML', () => {
  it('#voice-transcribing-row exists', () => {
    expect(html).to.include('id="voice-transcribing-row"',
      'Transcribing row missing from webview.html');
  });

  it('#voice-transcribing-text exists', () => {
    expect(html).to.include('id="voice-transcribing-text"',
      'Transcribing text span missing from webview.html');
  });
});

// ── main.js — worker construction ────────────────────────────────────────────

describe('voice — inline blob worker', () => {
  it('worker is created from a Blob (inline, not a file URL)', () => {
    expect(js).to.include('new Blob(',
      'Worker source must be inlined as a Blob to bypass VS Code CSP');
  });

  it('worker uses URL.createObjectURL', () => {
    expect(js).to.include('URL.createObjectURL(',
      'Worker URL must be created via createObjectURL');
  });

  it('worker is constructed as classic (no type:module)', () => {
    // classic worker = new Worker(url) with no second arg containing type:'module'
    expect(js).to.not.match(/new Worker\([^)]*type\s*:\s*['"]module['"]/,
      'Worker must be classic (no type:module) for Electron/VS Code compatibility');
  });

  it('worker source includes all six model HF repo IDs', () => {
    expect(js).to.include('Xenova/whisper-tiny',      'tiny model missing from inline worker');
    expect(js).to.include('Xenova/whisper-tiny.en',   'tiny.en model missing from inline worker');
    expect(js).to.include('Xenova/whisper-base',      'base model missing from inline worker');
    expect(js).to.include('Xenova/whisper-base.en',   'base.en model missing from inline worker');
    expect(js).to.include('Xenova/whisper-small.en',  'small.en model missing from inline worker');
    expect(js).to.include('Xenova/whisper-small',     'small model missing from inline worker');
  });

  it('worker uses dynamic import() from CDN (not require or static import)', () => {
    expect(js).to.include('import(CDN)',
      'Worker must use dynamic import() to load transformers from CDN');
  });
});

// ── main.js — energy gate ────────────────────────────────────────────────────

describe('voice — energy gate', () => {
  it('_vpEnergyGate variable is declared', () => {
    expect(js).to.include('_vpEnergyGate',
      '_vpEnergyGate variable missing — energy gate is hardcoded');
  });

  it('energy gate is compared against _vpEnergyGate (not a literal)', () => {
    expect(js).to.match(/rms\s*<\s*_vpEnergyGate/,
      'Energy gate comparison must use _vpEnergyGate variable, not a hardcoded literal');
  });

  it('_vpEnergyGate default value is 0.010', () => {
    expect(js).to.match(/_vpEnergyGate\s*=\s*0\.010/,
      '_vpEnergyGate default must be 0.010');
  });

  it('setVoiceSensitivity message is posted to extension on slider change', () => {
    expect(js).to.include('setVoiceSensitivity',
      'Sensitivity change must post setVoiceSensitivity message to extension host');
  });

  it('_vpSetSensitivity updates _vpEnergyGate', () => {
    expect(js).to.include('_vpSetSensitivity',
      '_vpSetSensitivity function missing');
  });
});

// ── main.js — PCM accumulation ───────────────────────────────────────────────

describe('voice — PCM accumulation', () => {
  it('PCM chunks are merged into a single buffer before transcription', () => {
    // The merge pattern: new Float32Array(existing + chunk), set both
    expect(js).to.match(/new Float32Array\(_vpAllPcm\.length \+ chunk\.length\)/,
      'PCM chunks must be accumulated (merged), not overwritten');
  });

  it('transcription only fires on isFinal, not on every chunk', () => {
    expect(js).to.match(/if\s*\(isFinal\)\s*_vpTranscribe\(true\)/,
      'Transcription should only fire when isFinal is true');
  });

  it('_vpAllPcm accumulation uses a merged Float32Array', () => {
    // Must merge via new Float32Array(existing.length + chunk.length)
    expect(js).to.match(/new Float32Array\(_vpAllPcm\.length \+ chunk\.length\)/,
      '_vpAllPcm must be merged via Float32Array, not overwritten');
  });
});

// ── main.js — silence pad ────────────────────────────────────────────────────

describe('voice — silence pad', () => {
  it('a silence pad is prepended before sending to Whisper', () => {
    expect(js).to.include('_VP_PAD',
      'Silence pad (_VP_PAD) missing — Whisper may drop first word');
  });

  it('silence pad is set at 0.3 seconds (4800 samples at 16kHz)', () => {
    expect(js).to.match(/16000\s*\*\s*0\.3/,
      'Silence pad should be 0.3s (16000 * 0.3)');
  });

  it('audio is offset by _VP_PAD when copied into padded buffer', () => {
    expect(js).to.match(/audio\.set\(raw,\s*_VP_PAD\)/,
      'Raw audio must be placed at offset _VP_PAD in the padded buffer');
  });
});

// ── main.js — model state ────────────────────────────────────────────────────

describe('voice — model state management', () => {
  it('_vpModelId variable is declared', () => {
    expect(js).to.include('_vpModelId',
      '_vpModelId (active model) variable missing');
  });

  it('_vpSelectedId variable is declared (separate from active)', () => {
    expect(js).to.include('_vpSelectedId',
      '_vpSelectedId (highlighted in picker) variable missing');
  });

  it('selectVoiceModel function is exposed on window', () => {
    expect(js).to.match(/window\.selectVoiceModel\s*=/,
      'window.selectVoiceModel must be exposed for HTML onclick handlers');
  });

  it('applyVoiceModel function is exposed on window', () => {
    expect(js).to.match(/window\.applyVoiceModel\s*=/,
      'window.applyVoiceModel must be exposed for "Set as default" button');
  });

  it('applyVoiceModel posts setVoiceModel to the extension host', () => {
    expect(js).to.include('setVoiceModel',
      'applyVoiceModel must post setVoiceModel to persist the choice');
  });

  it('downloaded models are persisted to localStorage', () => {
    expect(js).to.include('grom_downloaded_models',
      'Downloaded model list must be persisted to localStorage');
  });
});

// ── main.js — warm-up ────────────────────────────────────────────────────────

describe('voice — model pre-warming', () => {
  it('_vpWarming flag is declared', () => {
    expect(js).to.include('_vpWarming',
      '_vpWarming flag missing — warm-up suppression not implemented');
  });

  it('warm-up triggers on voiceFfmpegStatus', () => {
    expect(js).to.include('voiceFfmpegStatus',
      'Warm-up must trigger on voiceFfmpegStatus message');
  });

  it('warm-up only fires when voice input is enabled', () => {
    // Both _voiceInputEnabled and _vpWarming = true must appear in the voiceFfmpegStatus handler
    const ffmpegIdx = js.indexOf('voiceFfmpegStatus');
    expect(ffmpegIdx).to.be.greaterThan(-1, 'voiceFfmpegStatus handler not found');
    const handlerSlice = js.slice(ffmpegIdx, ffmpegIdx + 500);
    expect(handlerSlice).to.include('_voiceInputEnabled',
      '_voiceInputEnabled guard missing in voiceFfmpegStatus handler');
    expect(handlerSlice).to.include('_vpWarming',
      '_vpWarming not set in voiceFfmpegStatus handler');
  });

  it('warm-up posts load message to worker', () => {
    expect(js).to.match(/type:\s*['"]load['"]/,
      'Warm-up must post { type: "load" } to the worker');
  });

  it('"Warming up" text is shown in the transcribing row during warm-up', () => {
    expect(js).to.include('Warming up',
      '"Warming up…" text missing — user has no feedback during pre-warm');
  });
});

// ── styles.css — voice classes ───────────────────────────────────────────────

describe('voice — CSS', () => {
  it('.voice-model-picker exists in styles.css', () => {
    expect(css).to.include('.voice-model-picker',
      '.voice-model-picker CSS missing');
  });

  it('.voice-sensitivity-row exists in styles.css', () => {
    expect(css).to.include('.voice-sensitivity-row',
      '.voice-sensitivity-row CSS missing');
  });

  it('#voice-sensitivity-slider exists in styles.css', () => {
    expect(css).to.include('#voice-sensitivity-slider',
      '#voice-sensitivity-slider CSS missing');
  });

  it('.voice-download-row exists in styles.css', () => {
    expect(css).to.include('.voice-download-row',
      '.voice-download-row CSS missing');
  });
});
