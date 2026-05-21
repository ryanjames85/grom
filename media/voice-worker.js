// voice-worker.js — Whisper inference off the main thread
// Receives PCM slices via postMessage, returns transcribed text.
// Classic worker (no type:module) — dynamic import() is sufficient and works in Electron.

const MODEL_INFO = {
  'tiny':     'Xenova/whisper-tiny',
  'tiny.en':  'Xenova/whisper-tiny.en',
  'base':     'Xenova/whisper-base',
  'base.en':  'Xenova/whisper-base.en',
  'small.en': 'Xenova/whisper-small.en',
  'small':    'Xenova/whisper-small',
};

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';

let _pipe = null;
let _loadedModel = null;

// Surface unhandled rejections back to the main thread
self.onunhandledrejection = (e) => {
  self.postMessage({ type: 'error', message: 'Unhandled: ' + (e.reason?.message || String(e.reason)) });
};

async function _load(modelId) {
  if (_loadedModel === modelId && _pipe) return _pipe;
  _pipe = null;
  _loadedModel = null;
  const hf = MODEL_INFO[modelId] || MODEL_INFO['tiny.en'];
  self.postMessage({ type: 'progress', text: 'Loading pipeline…' });
  const { pipeline } = await import(CDN);
  _pipe = await pipeline('automatic-speech-recognition', hf, {
    dtype: 'q8',
    progress_callback: p => {
      if (p.status === 'downloading')
        self.postMessage({ type: 'progress', text: p.total
          ? 'Downloading model… ' + Math.round(p.loaded / p.total * 100) + '%'
          : 'Downloading model…' });
      else if (p.status === 'loading')
        self.postMessage({ type: 'progress', text: 'Loading model…' });
    }
  });
  _loadedModel = modelId;
  self.postMessage({ type: 'ready', modelId });
  return _pipe;
}

self.onmessage = async (e) => {
  const { type, modelId, pcm, isFinal, isMultilingual } = e.data;

  if (type === 'load') {
    try {
      await _load(modelId);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message, isFinal });
    }
    return;
  }

  if (type === 'transcribe') {
    try {
      const pipe = await _load(modelId);
      self.postMessage({ type: 'progress', text: null }); // clear download indicator
      const audio = new Float32Array(pcm); // pcm transferred as ArrayBuffer
      const opts = { sampling_rate: 16000, ...(isMultilingual ? { language: 'english' } : {}) };
      const result = await pipe(audio, opts);
      const text = (Array.isArray(result) ? result[0]?.text : result?.text) || '';
      self.postMessage({ type: 'result', text, isFinal });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message, isFinal });
    }
  }
};
