import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isForbiddenHostOrigin, rpcTooLargePayload, RPC_MAX_BODY } from '../../daemon/http-guard.js';

test('isForbiddenHostOrigin rejects evil Host and any Origin', () => {
  assert.equal(isForbiddenHostOrigin({ host: 'evil.example' }), true);
  assert.equal(isForbiddenHostOrigin({ host: '127.0.0.1', origin: 'http://127.0.0.1' }), true);
  assert.equal(isForbiddenHostOrigin({ host: '127.0.0.1:18880' }), false);
  assert.equal(isForbiddenHostOrigin({ host: '127.0.0.1' }), false);
});

test('rpcTooLargePayload is JSON BadRequest', () => {
  const j = JSON.parse(rpcTooLargePayload());
  assert.equal(j.ok, false);
  assert.equal(j.error.name, 'BadRequest');
  assert.match(j.error.message, /1048576/);
});

test('daemon calls host/origin guard before /newtab routes', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../daemon/ego-browserd.js'), 'utf8');
  const handler = src.slice(src.indexOf('createServer'));
  const guardAt = handler.indexOf('isForbiddenHostOrigin');
  const newtabAt = handler.indexOf("pathname === '/newtab'");
  const docsAt = handler.indexOf("pathname === '/showcase'");
  assert.ok(guardAt >= 0 && newtabAt > guardAt, 'Host/Origin check must precede /newtab');
  assert.ok(docsAt > guardAt, 'Host/Origin check must precede /docs');
});
