import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationReached } from '../../daemon/nav-wait.js';

test('navigationReached requires origin match and does not treat prefix hosts as done', () => {
  assert.equal(navigationReached('http://127.0.0.1:8899/', 'http://127.0.0.1:8899/?z'), false);
  assert.equal(navigationReached('http://127.0.0.1:8899/?z', 'http://127.0.0.1:8899/?z'), true);
  assert.equal(navigationReached('http://127.0.0.1:88990/', 'http://127.0.0.1:8899'), false);
  assert.equal(navigationReached('http://127.0.0.1:8899.evil/', 'http://127.0.0.1:8899'), false);
  assert.equal(navigationReached('http://127.0.0.1:8899/ab', 'http://127.0.0.1:8899/a'), false);
  assert.equal(navigationReached('http://127.0.0.1:8899/a/b', 'http://127.0.0.1:8899/a'), false);
  assert.equal(navigationReached('http://127.0.0.1:8899/', 'http://127.0.0.1:8899/'), true);
});

test('navigationReached allows trailing slash and http upgrade, not prefix paths', () => {
  assert.equal(navigationReached('http://127.0.0.1:8899/x/', 'http://127.0.0.1:8899/x'), true);
  assert.equal(navigationReached('https://example.com/docs', 'http://example.com/docs'), true);
  assert.equal(navigationReached('http://example.com/q', 'http://example.com/q?z=1'), false);
  assert.equal(navigationReached('http://example.com/q?other=1', 'http://example.com/q?z=1'), false);
  assert.equal(navigationReached('http://example.com/docs/intro', 'http://example.com/docs'), false);
});
