#!/usr/bin/env node
/**
 * run-tests.mjs
 *
 * Runs every src/test/**\/*.test.ts file as its own child process, rather than mocha's
 * usual single process loading every spec file's glob into one shared Node module cache.
 *
 * Why: several test files patch process-wide global state (Module.prototype.require, to mock
 * 'vscode') to make real source modules loadable in a test environment. A real source module
 * is a singleton within one process: whichever file requires it FIRST permanently binds its
 * internal `import vscode from 'vscode'` to that file's own mock for the rest of the process,
 * no matter what any later file does with its own mock. When two test files need the SAME
 * real source module (e.g. both agent-loop.test.ts and builtin-tools.test.ts import
 * ../builtin-tools) bound to their own, different mocks, running them in one shared process
 * is fundamentally unsafe: one file's tests can silently exercise a DIFFERENT file's stubs.
 * This previously caused an entire file's test suite to vanish from `npm test` with zero
 * error for about five months (see the project_test_harness_bug memory / CHANGELOG for the
 * full writeup) before mocha's `--parallel` (worker threads) was tried and hit its own,
 * separate chai/ESM loading bug in this project's ts-node setup.
 *
 * A real OS process boundary per file sidesteps the whole class of bug at its root: each
 * file gets a completely fresh Node module cache, so no file's require('vscode') mock or
 * cached real-module binding can ever reach another file, regardless of load order.
 *
 * Usage: node scripts/run-tests.mjs  (this is what `npm test` now runs)
 * Exits non-zero if any file has a failing test, or if any file itself errors out.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDir = join(process.cwd(), 'src', 'test');
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.ts'))
  .sort()
  .map(f => join('src', 'test', f));

let totalPassing = 0;
let totalFailing = 0;
const failedFiles = [];

for (const file of files) {
  // shell:true with an args array is deprecated (args aren't escaped); build one command
  // string instead. Every piece here is a fixed literal or a path from our own readdirSync
  // call, never user input, so this is safe.
  const result = spawnSync(
    `npx mocha -r ts-node/register -r chai "${file}"`,
    { encoding: 'utf8', shell: true }
  );
  const output = (result.stdout || '') + (result.stderr || '');
  const passMatch = output.match(/(\d+)\s+passing/);
  const failMatch = output.match(/(\d+)\s+failing/);
  const passing = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failing = failMatch ? parseInt(failMatch[1], 10) : 0;
  const crashed = result.status !== 0 && failing === 0 && passing === 0;

  totalPassing += passing;
  totalFailing += failing;

  if (failing > 0 || crashed) {
    failedFiles.push(file);
    console.log(`\n--- ${file} ---`);
    console.log(output);
  } else {
    console.log(`  ${file}: ${passing} passing`);
  }
}

console.log(`\n${totalPassing} passing, ${totalFailing} failing across ${files.length} files`);
if (failedFiles.length > 0) {
  console.log(`\nFailed files:\n${failedFiles.map(f => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
