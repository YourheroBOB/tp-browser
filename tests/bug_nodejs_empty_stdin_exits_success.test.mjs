import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeJsArgsError } from '../bin/tp-browser.js';

test('empty stdin is a usage error before any daemon or browser launch', () => {
  const empty = nodeJsArgsError([], '');
  assert.ok(Array.isArray(empty), 'empty stdin must be rejected');
  assert.match(empty.join('\n'), /empty/);
  assert.match(empty.join('\n'), /nothing was executed/);

  const blank = nodeJsArgsError([], '\uFEFF \t\r\n');
  assert.ok(Array.isArray(blank), 'BOM/whitespace stdin must be rejected');
  assert.match(blank.join('\n'), /nothing was executed/);
});

test('a non-flag placeholder still rejects empty stdin but keeps a real script', () => {
  assert.equal(nodeJsArgsError(['notes.js'], 'console.log(1)'), null);
  const lines = nodeJsArgsError(['notes.js'], '\n\t');
  assert.ok(Array.isArray(lines), 'empty stdin behind a placeholder filename must be rejected');
  assert.match(lines.join('\n'), /nothing was executed/);
});
