/**
 * timeouts.ts
 *
 * Per-test time limits for the integration tests. One flat limit is wrong for every model at once:
 * a metadata call needs seconds, a tool round trip on a 4B model needs minutes, and a thinking
 * model that cannot be told to stop thinking needs longer still.
 *
 * limit = base seconds for the kind of test  x  factor for how the model behaves  x  global scale
 *
 * Environment variables (all optional):
 *   GROM_IT_TIMEOUT_SCALE  multiplier for every limit, e.g. 2 on a slower machine, 0.5 on a fast one
 *   GROM_IT_TIMEOUT_MS     force this exact limit for every test (wins over everything else)
 */

export type ReasoningControl = 'api' | 'token' | 'hint' | 'none';

/** What a test does, which decides its base limit in seconds. */
type Kind = 'fast' | 'generate' | 'think' | 'long' | 'rag';

const BASE_SECONDS: Record<Kind, number> = {
  fast: 15,       // metadata calls only, no generation
  generate: 120,  // one short generation
  think: 240,     // generation where the model may think at length
  long: 480,      // several generations or several tool rounds in one test
  rag: 60,        // embedding calls
};

/** First match wins. Titles are the `it(...)` names in the integration test files. */
const RULES: Array<[RegExp, Kind]> = [
  [/lists at least one chat model|returns boolean capability|detects a context window/, 'fast'],
  [/builds a semantic|progress that never|finds code by meaning|re-embeds only|forced rebuild/, 'rag'],
  [/\/no_think and \/think|destructive tool|tool round trip/, 'long'],
  [/streams a reply|stops promptly|abort|silentAbort|next message works|thinking blocks|plain chat|plan mode/, 'think'],
  [/.*/, 'generate'],
];

/**
 * How the model behaves, as a multiplier:
 *  - hint    : a reasoning model with no off switch, so it thinks at length every time
 *  - none    : not a reasoning model, so replies are short
 *  - token/api: thinking can be turned off, and these tests do turn it off where the test allows
 */
function modelFactor(control: ReasoningControl): number {
  switch (control) {
    case 'hint': return 2;
    case 'none': return 0.75;
    default: return 1;
  }
}

export function timeoutFor(title: string, control: ReasoningControl): number {
  const forced = Number(process.env.GROM_IT_TIMEOUT_MS);
  if (Number.isFinite(forced) && forced > 0) return forced;

  const scale = Number(process.env.GROM_IT_TIMEOUT_SCALE);
  const globalScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const kind = RULES.find(([re]) => re.test(title))![1];
  return Math.round(BASE_SECONDS[kind] * modelFactor(control) * globalScale * 1000);
}
