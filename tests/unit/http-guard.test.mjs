import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isForbiddenHostOrigin,
  rpcTooLargePayload,
  RPC_MAX_BODY,
  rejectIfForbiddenHostOrigin,
  writeRpcTooLarge,
} from '../../daemon/http-guard.js';

const here = dirname(fileURLToPath(import.meta.url));

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

function assertGuardBeforeRoutes(src, fileLabel) {
  const start = src.indexOf('const server = createServer');
  assert.ok(start >= 0, `${fileLabel} must contain const server = createServer`);
  const handler = src.slice(start);
  const guardAt = handler.indexOf('rejectIfForbiddenHostOrigin');
  const newtabAt = handler.indexOf("pathname === '/newtab'");
  const docsAt = handler.indexOf("pathname === '/showcase'");
  assert.ok(guardAt >= 0 && newtabAt > guardAt, `${fileLabel}: Host/Origin check must precede /newtab`);
  assert.ok(docsAt > guardAt, `${fileLabel}: Host/Origin check must precede /docs`);
}

test('both daemons call host/origin guard before /newtab routes', () => {
  assertGuardBeforeRoutes(readFileSync(join(here, '../../daemon/ego-browserd.js'), 'utf8'), 'ego-browserd.js');
  assertGuardBeforeRoutes(readFileSync(join(here, '../../daemon/tp-browserd.js'), 'utf8'), 'tp-browserd.js');
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}

function rawRequest({ port, path, host, method = 'GET', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { host, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(null, {
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (e) => done(e));
    if (body) req.write(body);
    req.end();
  });
}

test('loopback /newtab with Host evil is 403 not 200', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (rejectIfForbiddenHostOrigin(req, res)) return;
    if (url.pathname === '/newtab' && req.method === 'GET') {
      res.writeHead(200).end('newtab-ok');
      return;
    }
    res.writeHead(200).end('ok');
  });
  const port = await listen(server);
  try {
    const evil = await rawRequest({ port, path: '/newtab', host: 'evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.includes('newtab-ok'), false);
    const ok = await rawRequest({ port, path: '/newtab', host: '127.0.0.1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'newtab-ok');
  } finally {
    server.close();
  }
});

test('oversized POST receives HTTP 413 rather than ECONNRESET', async () => {
  const server = createServer(async (req, res) => {
    if (rejectIfForbiddenHostOrigin(req, res)) return;
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > RPC_MAX_BODY) {
        await writeRpcTooLarge(req, res);
        return;
      }
      chunks.push(c);
    }
    res.writeHead(200).end('ok');
  });
  const port = await listen(server);
  try {
    const payload = Buffer.alloc(RPC_MAX_BODY + 64, 0x61);
    const res = await rawRequest({
      port,
      path: '/rpc',
      host: '127.0.0.1',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      body: payload,
    });
    assert.equal(res.status, 413);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, false);
    assert.equal(j.error.name, 'BadRequest');
  } finally {
    server.close();
  }
});
