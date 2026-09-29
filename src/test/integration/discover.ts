/**
 * discover.ts
 *
 * Read-only discovery of local model servers for the integration tests. It only ever asks a
 * server what is already loaded. It never requests a load, because that can evict the model the
 * user is working with.
 *
 *   Ollama     GET /api/ps
 *   LM Studio  GET /api/v0/models (state === 'loaded')
 */

export interface ServerDef {
  name: 'Ollama' | 'LM Studio';
  url: string;
  /** True when Grom should talk to it using Ollama's /api/chat format. */
  useOllamaFormat: boolean;
  /** Preferred model from the environment. Only used if the server reports it as loaded. */
  modelEnv?: string;
}

const ALL_SERVERS: ServerDef[] = [
  {
    name: 'Ollama',
    url: process.env.GROM_IT_OLLAMA_URL || 'http://127.0.0.1:11434',
    useOllamaFormat: true,
    modelEnv: process.env.GROM_IT_OLLAMA_MODEL
  },
  {
    name: 'LM Studio',
    url: process.env.GROM_IT_LMSTUDIO_URL || 'http://127.0.0.1:1234',
    useOllamaFormat: false,
    modelEnv: process.env.GROM_IT_LMSTUDIO_MODEL
  }
];

/**
 * GROM_IT_ONLY=ollama or lmstudio limits the run to one server, even if both are up. Useful on a
 * machine that can only hold one model at a time.
 */
const only = (process.env.GROM_IT_ONLY || '').toLowerCase().replace(/[\s_-]/g, '');
export const SERVERS: ServerDef[] = only
  ? ALL_SERVERS.filter(s => s.name.toLowerCase().replace(/\s/g, '') === only)
  : ALL_SERVERS;

const isChat = (name: string) => !/embed/i.test(name);

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/** Returns the chat models currently loaded in memory, or throws if the server is unreachable. */
export async function loadedModels(def: ServerDef): Promise<string[]> {
  if (def.name === 'Ollama') {
    const data = await getJson(`${def.url}/api/ps`);
    return (data.models ?? []).map((m: any) => m.name || m.model).filter(isChat);
  }
  const data = await getJson(`${def.url}/api/v0/models`);
  return (data.data ?? [])
    .filter((m: any) => m.state === 'loaded' && m.type !== 'embeddings')
    .map((m: any) => m.id);
}

/** Picks the model to test: the env choice if it is loaded, otherwise the first loaded model. */
export async function pickLoadedModel(def: ServerDef): Promise<{ model: string } | { skip: string }> {
  let loaded: string[];
  try {
    loaded = await loadedModels(def);
  } catch {
    return { skip: `not reachable at ${def.url}` };
  }
  if (loaded.length === 0) return { skip: 'is up but has no chat model loaded (these tests never load one)' };
  return { model: def.modelEnv && loaded.includes(def.modelEnv) ? def.modelEnv : loaded[0] };
}

/** Returns an embedding model that is already loaded, or null. Read-only, like loadedModels. */
export async function loadedEmbeddingModel(def: ServerDef): Promise<string | null> {
  try {
    if (def.name === 'Ollama') {
      const data = await getJson(`${def.url}/api/ps`);
      const names: string[] = (data.models ?? []).map((m: any) => m.name || m.model);
      return names.find(n => /embed/i.test(n)) ?? null;
    }
    const data = await getJson(`${def.url}/api/v0/models`);
    const hit = (data.data ?? []).find((m: any) => m.state === 'loaded' && m.type === 'embeddings');
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}
