// @ts-nocheck
const { parseToolCall, buildToolSystemPrompt, extractJsonObjects } = require('../mcp-parser');

let expect;

describe('parseToolCall', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  // Pattern 1 — clean JSON
  it('parses clean JSON with "tool" and "args" keys', () => {
    const r = parseToolCall('{"tool":"filesystem__read_file","args":{"path":"src/index.ts"}}');
    expect(r).to.not.be.null;
    expect(r.tool).to.equal('filesystem__read_file');
    expect(r.args).to.deep.equal({ path: 'src/index.ts' });
  });

  it('parses JSON with "name" alias instead of "tool"', () => {
    const r = parseToolCall('{"name":"search__query","args":{"q":"hello"}}');
    expect(r.tool).to.equal('search__query');
  });

  it('parses JSON with "arguments" alias instead of "args"', () => {
    const r = parseToolCall('{"tool":"fs__read","arguments":{"path":"foo.ts"}}');
    expect(r.args).to.deep.equal({ path: 'foo.ts' });
  });

  it('parses JSON embedded in prose', () => {
    const r = parseToolCall('Let me read the file for you.\n{"tool":"fs__read_file","args":{"path":"test.ts"}}\nDone.');
    expect(r.tool).to.equal('fs__read_file');
  });

  it('parses JSON with empty args', () => {
    const r = parseToolCall('{"tool":"server__list_files","args":{}}');
    expect(r.tool).to.equal('server__list_files');
    expect(r.args).to.deep.equal({});
  });

  it('parses JSON with "input" alias for args', () => {
    const r = parseToolCall('{"tool":"run__cmd","input":{"cmd":"ls"}}');
    expect(r.tool).to.equal('run__cmd');
    expect(r.args).to.deep.equal({ cmd: 'ls' });
  });

  it('does not false-positive on JSON without a tool key', () => {
    expect(parseToolCall('{"message":"hello","status":200}')).to.be.null;
  });

  it('does not false-positive on JSON with a tool key but non-object args', () => {
    // args must be an object — array or string should not match
    expect(parseToolCall('{"tool":"x","args":"notanobject"}')).to.be.null;
  });

  // Pattern 2 — markdown fence
  it('parses JSON inside a ```json fence', () => {
    const r = parseToolCall('Sure, here you go:\n```json\n{"tool":"db__query","args":{"sql":"SELECT 1"}}\n```');
    expect(r.tool).to.equal('db__query');
    expect(r.args.sql).to.equal('SELECT 1');
  });

  it('parses JSON inside a plain ``` fence', () => {
    const r = parseToolCall('```\n{"tool":"fs__write","args":{"path":"a.txt","content":"hi"}}\n```');
    expect(r.tool).to.equal('fs__write');
  });

  // Pattern 3 — loose key-value text
  it('parses loose text format "tool: name" at start of line', () => {
    const r = parseToolCall('tool: fs__read_file\nargs: {"path": "src/app.ts"}');
    expect(r.tool).to.equal('fs__read_file');
  });

  it('parses loose text format "tool = name"', () => {
    const r = parseToolCall('tool = search__web\nargs: {"query": "test"}');
    expect(r.tool).to.equal('search__web');
  });

  it('does NOT false-positive on prose mentioning a tool inline', () => {
    // "tool: write_file" embedded mid-sentence should not fire
    const r = parseToolCall("I'll use the tool: write_file to create the file for you.");
    expect(r).to.be.null;
  });

  it('does NOT false-positive on prose starting with "tool" as a word', () => {
    const r = parseToolCall('The tool call was successful. Here is the result.');
    expect(r).to.be.null;
  });

  // Pattern 4 — function-call style
  it('parses function-call style with JSON args', () => {
    const r = parseToolCall('server__read_file({"path":"main.ts"})');
    expect(r.tool).to.equal('server__read_file');
    expect(r.args.path).to.equal('main.ts');
  });

  it('parses function-call style with key=value args', () => {
    const r = parseToolCall('server__search(query="hello world", limit="10")');
    expect(r.tool).to.equal('server__search');
    expect(r.args.query).to.equal('hello world');
  });

  // Pattern 4b — gemma-4 / Qwen <|tool_call> style
  it('parses gemma-4 <|tool_call>call:name{args} with unquoted keys', () => {
    const r = parseToolCall('<|tool_call>call:write_file{content:"hello",path:"sad.md"}<tool_call|>');
    expect(r.tool).to.equal('write_file');
    expect(r.args.path).to.equal('sad.md');
    expect(r.args.content).to.equal('hello');
  });

  it('parses gemma-4 <|"|> string delimiters for values with special chars', () => {
    const r = parseToolCall('<|tool_call>call:write_file{content:<|"|># laugh\nfunny content<|"|>,path:"laugh.md"}<tool_call|>');
    expect(r.tool).to.equal('write_file');
    expect(r.args.path).to.equal('laugh.md');
    expect(r.args.content).to.include('laugh');
  });

  it('parses gemma-4 type-annotated value: content:markdown:"..."', () => {
    const r = parseToolCall('<|tool_call>call:write_file{content:markdown:"# Jokes\\nhaha",path:"joke.md"}<tool_call|>');
    expect(r.tool).to.equal('write_file');
    expect(r.args.path).to.equal('joke.md');
    expect(r.args.content).to.include('Jokes');
  });

  it('parses gemma-4 format with } inside quoted content value (greedy regex)', () => {
    const r = parseToolCall('<|tool_call>call:write_file{content:"has } brace inside",path:"f.md"}<tool_call|>');
    expect(r.tool).to.equal('write_file');
    expect(r.args.path).to.equal('f.md');
    expect(r.args.content).to.include('brace');
  });

  it('parses <tool_call>name{} style with no args', () => {
    const r = parseToolCall('<tool_call>list_directory{}<tool_call|>');
    expect(r.tool).to.equal('list_directory');
    expect(r.args).to.deep.equal({});
  });

  it('parses gemma-4 format without closing <tool_call|> tag', () => {
    const r = parseToolCall('<|tool_call>call:read_file{path:"foo.ts"}');
    expect(r.tool).to.equal('read_file');
    expect(r.args.path).to.equal('foo.ts');
  });

  // Pattern 4c — <tool_code> tags (gemma-4)
  it('parses <tool_code> wrapped function call with key=value args', () => {
    const r = parseToolCall('<tool_code>\nwrite_file(path="jokes.md", content="ha ha")\n</tool_code>');
    expect(r).to.not.be.null;
    expect(r.tool).to.equal('write_file');
    expect(r.args.path).to.equal('jokes.md');
    expect(r.args.content).to.equal('ha ha');
  });

  it('parses <tool_code> with JSON body', () => {
    const r = parseToolCall('<tool_code>read_file({"path":"foo.ts"})</tool_code>');
    expect(r.tool).to.equal('read_file');
    expect(r.args.path).to.equal('foo.ts');
  });

  it('parses <tool_code> with prose before the tag', () => {
    const r = parseToolCall('I will add more jokes.\n<tool_code>\nwrite_file(path="jokes.md", content="new")\n</tool_code>');
    expect(r.tool).to.equal('write_file');
    expect(r.args.path).to.equal('jokes.md');
  });

  it('does not match <tool_code> with no valid function inside', () => {
    const r = parseToolCall('<tool_code>just some text here</tool_code>');
    expect(r).to.be.null;
  });

  // Negative cases
  it('returns null for plain prose', () => {
    expect(parseToolCall('Here is the answer to your question.')).to.be.null;
  });

  it('returns null for unrelated JSON', () => {
    expect(parseToolCall('{"message":"hello","status":200}')).to.be.null;
  });

  it('returns null for empty string', () => {
    expect(parseToolCall('')).to.be.null;
  });

  it('extracts tool call from inside a JSON array wrapper', () => {
    const r = parseToolCall('[{"tool":"x","args":{"k":"v"}}]');
    expect(r).to.not.be.null;
    expect(r.tool).to.equal('x');
  });

  it('returns null for partial/malformed JSON', () => {
    expect(parseToolCall('{"tool":"x","args":{}')).to.be.null;
  });
});

describe('extractJsonObjects', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  it('extracts a single top-level object', () => {
    const r = extractJsonObjects('{"a":1}');
    expect(r).to.deep.equal([{ a: 1 }]);
  });

  it('extracts multiple objects from prose', () => {
    const r = extractJsonObjects('Before {"a":1} middle {"b":2} after');
    expect(r).to.have.length(2);
  });

  it('extracts nested objects correctly', () => {
    const r = extractJsonObjects('{"tool":"x","args":{"path":"y"}}');
    expect(r[0].args.path).to.equal('y');
  });

  it('handles } inside a string value without breaking', () => {
    const r = extractJsonObjects('{"content":"has } inside","tool":"x"}');
    expect(r[0].content).to.equal('has } inside');
  });

  it('returns empty array for non-JSON text', () => {
    expect(extractJsonObjects('no json here')).to.deep.equal([]);
  });

  it('skips malformed objects and finds valid ones after them', () => {
    const r = extractJsonObjects('not valid json here {"good":true}');
    expect(r).to.deep.equal([{ good: true }]);
  });
});

describe('buildToolSystemPrompt sad path', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  it('does not throw when inputSchema has no properties', () => {
    expect(() => buildToolSystemPrompt([{ name: 'x', description: 'y', inputSchema: { type: 'object' } }])).to.not.throw();
  });

  it('does not throw when inputSchema is empty object', () => {
    expect(() => buildToolSystemPrompt([{ name: 'x', description: 'y', inputSchema: {} }])).to.not.throw();
  });

  it('does not throw when required array is missing', () => {
    expect(() => buildToolSystemPrompt([{
      name: 'x', description: 'y',
      inputSchema: { type: 'object', properties: { p: { type: 'string' } } }
    }])).to.not.throw();
  });
});

describe('buildToolSystemPrompt', () => {
  before(async () => {
    const chai = await import('chai');
    expect = chai.expect;
  });

  it('returns empty string when no tools', () => {
    expect(buildToolSystemPrompt([])).to.equal('');
  });

  it('includes tool name and description', () => {
    const prompt = buildToolSystemPrompt([{
      name: 'fs__read_file',
      description: 'Read a file from disk',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] }
    }]);
    expect(prompt).to.include('fs__read_file');
    expect(prompt).to.include('Read a file from disk');
    expect(prompt).to.include('path');
    expect(prompt).to.include('required');
  });

  it('includes the JSON format instruction', () => {
    const prompt = buildToolSystemPrompt([{ name: 'a__b', description: 'desc', inputSchema: {} }]);
    expect(prompt).to.include('"tool"');
    expect(prompt).to.include('"args"');
  });

  it('marks optional params correctly', () => {
    const prompt = buildToolSystemPrompt([{
      name: 'search',
      description: 'Search',
      inputSchema: {
        properties: { q: { type: 'string' }, limit: { type: 'number' } },
        required: ['q']
      }
    }]);
    expect(prompt).to.include('(required)');
    expect(prompt).to.include('(optional)');
  });

  it('handles tool with no parameters', () => {
    const prompt = buildToolSystemPrompt([{ name: 'list_dir', description: 'List', inputSchema: {} }]);
    expect(prompt).to.include('list_dir');
    expect(prompt).to.include('List');
  });

  it('includes all tools when multiple provided', () => {
    const prompt = buildToolSystemPrompt([
      { name: 'tool_a', description: 'A', inputSchema: {} },
      { name: 'tool_b', description: 'B', inputSchema: {} }
    ]);
    expect(prompt).to.include('tool_a');
    expect(prompt).to.include('tool_b');
  });
});
