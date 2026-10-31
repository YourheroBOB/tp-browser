import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNodeJsExitCode } from '../../lib/nodejs-exit.js';

test('script exitCode 1 without throw becomes 1', () => {
  assert.equal(resolveNodeJsExitCode({ scriptExitCode: 1, threw: false }), 1);
});

test('no exitCode and no throw becomes 0', () => {
  assert.equal(resolveNodeJsExitCode({ scriptExitCode: undefined, threw: false }), 0);
});

test('throw becomes 1', () => {
  assert.equal(resolveNodeJsExitCode({ scriptExitCode: undefined, threw: true }), 1);
});
