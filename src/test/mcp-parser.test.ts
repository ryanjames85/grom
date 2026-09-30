import { expect } from 'chai';
import { parseToolCall, extractJsonObjects, buildToolSystemPrompt } from '../mcp-parser';
import type { McpTool } from '../mcp-parser';

// ── extractJsonObjects ────────────────────────────────────────────────────────

describe('extractJsonObjects', () => {
  it('returns empty array for empty string', () => {
    expect(extractJsonObjects('')).to.deep.equal([]);
  });

  it('returns empty array for plain prose with no braces', () => {
    expect(extractJsonObjects('just some text')).to.deep.equal([]);
  });

  it('parses a single top-level JSON object', () => {
    const result = extractJsonObjects('{"tool":"read_file","args":{"path":"foo.ts"}}');
    expect(result).to.have.length(1);
    expect(result[0].tool).to.equal('read_file');
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const result = extractJsonObjects('Sure! Here is my call: {"tool":"read_file","args":{}} and done.');
    expect(result).to.have.length(1);
    expect(result[0].tool).to.equal('read_file');
  });

  it('extracts multiple JSON objects', () => {
    const result = extractJsonObjects('{"a":1} some text {"b":2}');
    expect(result).to.have.length(2);
    expect(result[0].a).to.equal(1);
    expect(result[1].b).to.equal(2);
  });

  it('handles nested objects correctly', () => {
    const result = extractJsonObjects('{"outer":{"inner":{"deep":true}}}');
    expect(result).to.have.length(1);
    expect(result[0].outer.inner.deep).to.be.true;
  });

  it('handles escaped quotes inside strings', () => {
    const result = extractJsonObjects('{"tool":"read","args":{"content":"say \\"hello\\""}}');
    expect(result).to.have.length(1);
    expect(result[0].args.content).to.equal('say "hello"');
  });

  it('recovers from unescaped backslashes (Windows paths)', () => {
    // .\\setup.ps1 has an invalid escape \s; sanitise-and-retry should fix it
    const result = extractJsonObjects('{"tool":"run","args":{"path":".\\\\setup.ps1"}}');
    expect(result).to.have.length(1);
    expect(result[0].tool).to.equal('run');
  });

  it('ignores unclosed braces', () => {
    expect(extractJsonObjects('{"tool":"x"')).to.deep.equal([]);
  });

  it('does not count braces inside strings as depth', () => {
    const result = extractJsonObjects('{"key":"value with { brace }"}');
    expect(result).to.have.length(1);
    expect(result[0].key).to.equal('value with { brace }');
  });
});

// ── parseToolCall: Pattern 1 (JSON anywhere) ─────────────────────────────────

describe('parseToolCall — Pattern 1 (JSON object)', () => {
  it('parses clean JSON with tool + args', () => {
    const result = parseToolCall('{"tool":"read_file","args":{"path":"src/index.ts"}}');
    expect(result).to.not.be.null;
    expect(result!.tool).to.equal('read_file');
    expect(result!.args.path).to.equal('src/index.ts');
  });

  const keyAliases: Array<[string, string, string, (r: any) => void]> = [
    ['name',       '{"name":"write_file","args":{}}',                  '"name" as tool key',       r => expect(r.tool).to.equal('write_file')],
    ['function',   '{"function":"list_dir","args":{}}',                '"function" as tool key',   r => expect(r.tool).to.equal('list_dir')],
    ['arguments',  '{"tool":"read_file","arguments":{"path":"foo"}}',  '"arguments" alias',        r => expect(r.args.path).to.equal('foo')],
    ['parameters', '{"tool":"search","parameters":{"query":"hi"}}',    '"parameters" alias',       r => expect(r.args.query).to.equal('hi')],
    ['input',      '{"tool":"run","input":{"cmd":"ls"}}',              '"input" alias',            r => expect(r.args.cmd).to.equal('ls')],
  ];
  for (const [, json, label, assert] of keyAliases) {
    it(`accepts ${label}`, () => { assert(parseToolCall(json)); });
  }

  it('returns null when the JSON object has no tool/name/function key', () => {
    // A plain JSON object with no recognisable tool key should fall through all patterns.
    const result = parseToolCall('{"random":"object","value":42}');
    expect(result).to.be.null;
  });

  it('does not misread an ordinary JSON example with a bare "name" field as a tool call (v0.5.7 bug fix)', () => {
    // Regression test: obj.name used to be trusted unconditionally, so any JSON object anywhere
    // in prose with a "name" key (an ordinary English word, not a tool-call signal on its own)
    // was misparsed as a tool call with empty args - e.g. a model quoting an example API
    // response. Pattern 3 also requires "tool:" at line start for the same reason; Pattern 1
    // was missing the equivalent guard for its "name"/"function" leniency fallbacks.
    const result = parseToolCall('Here is an example response: {"name":"Alice","role":"admin"}');
    expect(result).to.be.null;
  });

  it('still accepts "name" as the tool key when paired with a real args-shaped field', () => {
    const result = parseToolCall('{"name":"write_file","arguments":{"path":"x"}}');
    expect(result).to.not.be.null;
    expect(result!.tool).to.equal('write_file');
  });

  it('extracts JSON embedded in prose', () => {
    const result = parseToolCall('I will call: {"tool":"read_file","args":{"path":"foo.ts"}} now.');
    expect(result!.tool).to.equal('read_file');
  });
});

// ── parseToolCall: Pattern 2 (markdown fence) ────────────────────────────────

describe('parseToolCall — Pattern 2 (markdown code fence)', () => {
  it('extracts tool call from a json-tagged fence', () => {
    const text = '```json\n{"tool":"read_file","args":{"path":"foo.ts"}}\n```';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('read_file');
    expect(result!.args.path).to.equal('foo.ts');
  });

  it('extracts tool call from an untagged fence', () => {
    const text = '```\n{"tool":"write_file","args":{"path":"out.ts","content":"x"}}\n```';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('write_file');
  });

  it('handles Windows-style backslash path inside a fence', () => {
    const text = '```json\n{"tool":"run","args":{"path":".\\\\setup.ps1"}}\n```';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('run');
  });
});

// ── parseToolCall: Pattern 3 (key-value text) ───────────────────────────────

describe('parseToolCall — Pattern 3 (loose key-value)', () => {
  it('parses tool: name\\nargs: {...} at line start', () => {
    const text = 'tool: read_file\nargs: {"path":"foo.ts"}';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('read_file');
    expect(result!.args.path).to.equal('foo.ts');
  });

  it('parses tool: with no args', () => {
    const text = 'tool: list_dir\n';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('list_dir');
    expect(result!.args).to.deep.equal({});
  });

  it('does NOT match "tool:" in the middle of a prose line', () => {
    // Pattern 3 requires (?:^|\n) before "tool", mid-sentence should not match.
    // Note: Pattern 1 also won't match because there is no JSON object.
    const text = "I'll use the tool: write_file to help you write code today.";
    const result = parseToolCall(text);
    // Pattern 3 should not match; no other pattern matches this format either.
    expect(result).to.be.null;
  });

  it('parses args containing a nested JSON object instead of silently dropping every argument (v0.5.7 bug fix)', () => {
    // Regression test: the old non-greedy \{[\s\S]*?\} capture stopped at the FIRST `}`, which
    // is wrong when args contain a nested object. That truncated the capture into invalid JSON,
    // JSON.parse threw, and the catch silently fell back to args={} - the tool call fired anyway
    // with every argument lost, no error surfaced anywhere.
    const text = 'tool: search\nargs: {"query": {"nested": 1}, "limit": 5}';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('search');
    expect(result!.args.query, 'the nested object must survive, not get truncated away').to.deep.equal({ nested: 1 });
    expect(result!.args.limit).to.equal(5);
  });
});

// ── parseToolCall: Pattern 4b (Gemma/Qwen tag format) ───────────────────────

describe('parseToolCall — Pattern 4b (tool_call tag)', () => {
  // Pattern 4b requires no space between the colon and value; the key regex `\s*:` does not
  // consume trailing whitespace, so a space causes the value to fall into the unquoted branch.

  it('parses <|tool_call|>call:tool{key:"val"}<tool_call|>', () => {
    const text = '<|tool_call|>call:read_file{path:"src/index.ts"}<tool_call|>';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('read_file');
    expect(result!.args.path).to.equal('src/index.ts');
  });

  it('parses <|"|> delimited values containing special characters', () => {
    const text = '<|tool_call|>call:write_file{content:<|"|>line1\nline2<|"|>}<tool_call|>';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('write_file');
    expect(result!.args.content).to.equal('line1\nline2');
  });

  it('parses <tool_call|> opening (no leading pipe) with <tool_call|> closing', () => {
    // Both \|? groups in the regex are optional, so <tool_call|> and <|tool_call|> both match.
    const text = '<tool_call|>call:list_dir{path:"."}<tool_call|>';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('list_dir');
    expect(result!.args.path).to.equal('.');
  });

  it('handles multiple key-value pairs', () => {
    const text = '<|tool_call|>call:write_file{path:"out.ts",content:"hello"}<tool_call|>';
    const result = parseToolCall(text);
    expect(result!.args.path).to.equal('out.ts');
    expect(result!.args.content).to.equal('hello');
  });

  it('does not swallow a second tool_call block into the first call\'s "raw" text when two appear in one response (v0.5.7 bug fix)', () => {
    // Regression test: the old regex's body capture (\{[\s\S]*\}) was greedy and unanchored, so
    // with two tool_call blocks in one text, .raw (the text stripped from the visible chunk via
    // agent-loop.ts's clearToolCallChunk) spanned from the first block through to the LAST `}`
    // in the whole text - silently deleting the second block (and anything between them) from
    // what the user sees, even though only the first call is ever actually executed.
    const text = '<|tool_call|>call:read_file{path:"a.ts"}<tool_call|> then <|tool_call|>call:read_file{path:"b.ts"}<tool_call|>';
    const result = parseToolCall(text);
    expect(result).to.not.be.null;
    expect(result!.tool).to.equal('read_file');
    expect(result!.args.path).to.equal('a.ts');
    expect(result!.raw, 'raw must not extend past the first call\'s own closing tag into the second block').to.not.include('b.ts');
  });
});

// ── parseToolCall: Pattern 4c (tool_code tags) ───────────────────────────────

describe('parseToolCall — Pattern 4c (tool_code tags)', () => {
  it('parses <tool_code>fn(key="val")</tool_code>', () => {
    const text = '<tool_code>read_file(path="src/index.ts")</tool_code>';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('read_file');
    expect(result!.args.path).to.equal('src/index.ts');
  });

  it('parses multiple kwarg pairs', () => {
    const text = "<tool_code>write_file(path='out.ts', content='hello')</tool_code>";
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('write_file');
    expect(result!.args.path).to.equal('out.ts');
    expect(result!.args.content).to.equal('hello');
  });

  it('parses JSON body args inside tool_code', () => {
    const text = '<tool_code>search({"query":"useState","limit":5})</tool_code>';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('search');
    expect(result!.args.query).to.equal('useState');
  });

  it('parses correctly when a string arg value contains a literal close-paren (v0.5.7 bug fix)', () => {
    const text = '<tool_code>write_file(path="notes (draft).txt", content="ok")</tool_code>';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('write_file');
    expect(result!.args.path).to.equal('notes (draft).txt');
    expect(result!.args.content).to.equal('ok');
  });
});

// ── parseToolCall: Pattern 4 (double-underscore function call) ───────────────

describe('parseToolCall — Pattern 4 (server__tool function call)', () => {
  it('parses server__tool({"key":"val"})', () => {
    const text = 'server__read_file({"path":"foo.ts"})';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('server__read_file');
    expect(result!.args.path).to.equal('foo.ts');
  });

  it('parses server__tool(key="val", other="x")', () => {
    const text = 'mcp__write_file(path="out.ts", content="hello")';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('mcp__write_file');
    expect(result!.args.path).to.equal('out.ts');
  });

  it('does NOT match a single-word function call without double-underscore', () => {
    // Pattern 4 requires __ in name. A bare function call in prose should not match
    // (Pattern 4c handles named tool_code tags; Pattern 4 is for server-namespaced calls).
    const text = 'list_dir(path=".")';
    // Pattern 4c won't match (no tool_code tags), Pattern 4 won't match (no __).
    // Pattern 1–3 also won't match this format.
    const result = parseToolCall(text);
    expect(result).to.be.null;
  });

  it('parses correctly when a string arg value contains a literal close-paren (v0.5.7 bug fix)', () => {
    // Regression test: the old \(([^)]*)\) capture stopped at the FIRST ')' anywhere, including
    // one inside a quoted string value. "notes (draft).txt" truncated the whole args capture,
    // silently dropping every argument instead of parsing the real path.
    const text = 'mcp__write_file(path="notes (draft).txt", content="ok")';
    const result = parseToolCall(text);
    expect(result!.tool).to.equal('mcp__write_file');
    expect(result!.args.path, 'must capture the full path including the parenthesised part').to.equal('notes (draft).txt');
    expect(result!.args.content).to.equal('ok');
  });
});

// ── parseToolCall: null cases ────────────────────────────────────────────────

describe('parseToolCall — returns null', () => {
  it('returns null for empty string', () => {
    expect(parseToolCall('')).to.be.null;
  });

  it('returns null for plain prose with no tool indicators', () => {
    expect(parseToolCall('Here is my explanation of the code...')).to.be.null;
  });
});

// ── buildToolSystemPrompt ─────────────────────────────────────────────────────

describe('buildToolSystemPrompt', () => {
  it('returns empty string for empty tools array', () => {
    expect(buildToolSystemPrompt([])).to.equal('');
  });

  it('includes the tool name in the output', () => {
    const tools: McpTool[] = [{ name: 'read_file', description: 'Read a file', inputSchema: {} }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.include('read_file');
  });

  it('includes the tool description', () => {
    const tools: McpTool[] = [{ name: 'search', description: 'Search the docs', inputSchema: {} }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.include('Search the docs');
  });

  it('marks required params as (required)', () => {
    const tools: McpTool[] = [{
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path']
      }
    }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.include('(required)');
  });

  it('marks optional params as (optional)', () => {
    const tools: McpTool[] = [{
      name: 'search',
      description: 'Search',
      inputSchema: {
        properties: { limit: { type: 'number', description: 'Max results' } },
        required: []
      }
    }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.include('(optional)');
  });

  it('includes the JSON format instruction', () => {
    const tools: McpTool[] = [{ name: 'x', description: 'y', inputSchema: {} }];
    expect(buildToolSystemPrompt(tools)).to.include('"tool":"<tool_name>"');
  });

  it('strips newlines from description (injection protection)', () => {
    const tools: McpTool[] = [{ name: 'x', description: 'line1\nline2\nline3', inputSchema: {} }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.not.include('\nline2');
    expect(result).to.include('line1 line2 line3');
  });

  it('strips backtick/quote chars from description (injection protection)', () => {
    const tools: McpTool[] = [{ name: 'x', description: 'desc `rm -rf`', inputSchema: {} }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.not.include('`');
  });

  it('truncates description longer than 200 chars', () => {
    const tools: McpTool[] = [{ name: 'x', description: 'a'.repeat(300), inputSchema: {} }];
    const result = buildToolSystemPrompt(tools);
    // The description segment in the output should not exceed 200 chars of 'a'
    expect(result).to.not.include('a'.repeat(201));
  });

  it('handles tool with no properties in schema', () => {
    const tools: McpTool[] = [{ name: 'ping', description: 'Ping', inputSchema: { properties: {}, required: [] } }];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.include('ping');
    expect(result).to.not.include('Parameters');
  });

  it('handles multiple tools', () => {
    const tools: McpTool[] = [
      { name: 'read_file', description: 'Read', inputSchema: {} },
      { name: 'write_file', description: 'Write', inputSchema: {} },
    ];
    const result = buildToolSystemPrompt(tools);
    expect(result).to.include('read_file');
    expect(result).to.include('write_file');
  });

  it('handles missing inputSchema gracefully', () => {
    const tools: McpTool[] = [{ name: 'x', description: 'y', inputSchema: undefined as any }];
    expect(() => buildToolSystemPrompt(tools)).to.not.throw();
  });
});
