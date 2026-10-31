import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSdk, createClient } from '../lib/sdk.js';

const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';

test('SDK module exposes the documented public entry points', () => {
  assert.equal(typeof createClient, 'function');
  assert.equal(typeof buildSdk, 'function');
});

test('createClient returns callable rpc and waitPush functions', () => {
  const client = createClient({
    port: 9772,
    token: FAKE_TOKEN,
  });

  assert.equal(typeof client.rpc, 'function');
  assert.equal(typeof client.waitPush, 'function');
});

test('buildSdk exposes the documented TaskSpace and Page surfaces', () => {
  const sdk = buildSdk({
    rpc: async () => ({}),
    waitPush: async () => undefined,
  });

  assert.equal(typeof sdk.taskSpace, 'function');
  assert.equal(typeof sdk.TaskSpace, 'function');
  assert.equal(typeof sdk.Page, 'function');

  assert.equal(typeof sdk.TaskSpace.prototype.page, 'function');
  assert.equal(typeof sdk.TaskSpace.prototype.finish, 'function');
  assert.equal(typeof sdk.Page.prototype.goto, 'function');
  assert.equal(typeof sdk.Page.prototype.snapshot, 'function');
  assert.equal(typeof sdk.Page.prototype.evaluate, 'function');
  assert.equal(typeof sdk.Page.prototype.screenshot, 'function');
});

test('createClient.rpc preserves the local RPC request and response envelopes', async () => {
  const requests = [];
  const responses = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers ?? {});
    const rawBody = typeof init.body === 'string'
      ? init.body
      : Buffer.isBuffer(init.body)
        ? init.body.toString('utf8')
        : init.body == null
          ? ''
          : String(init.body);
    const body = JSON.parse(rawBody);

    requests.push({
      url,
      method,
      headers: Object.fromEntries(headers.entries()),
      body,
    });

    const payload = body.method === 'contract.error'
      ? {
          id: body.id,
          ok: false,
          error: {
            name: 'TypeError',
            message: 'invalid contract input',
          },
        }
      : {
          id: body.id,
          ok: true,
          result: { contract: 'accepted' },
        };

    responses.push(payload);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const client = createClient({
      port: 9772,
      token: FAKE_TOKEN,
    });

    assert.deepEqual(
      await client.rpc('contract.ok', { limit: 1 }),
      { contract: 'accepted' },
    );

    await assert.rejects(
      client.rpc('contract.error'),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid contract input/);
        return true;
      },
    );

    assert.equal(requests.length, 2);
    assert.equal(responses.length, 2);

    const requestUrl = new URL(requests[0].url);
    assert.ok(
      requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost',
    );
    assert.equal(requestUrl.pathname, '/rpc');
    assert.equal(requests[0].method, 'POST');
    assert.match(
      requests[0].headers['content-type'],
      /^application\/json\b/,
    );

    const suppliedTokens = [
      requests[0].headers['x-tp-token'],
      requests[0].headers['x-ego-token'],
    ].filter(Boolean);
    assert.ok(suppliedTokens.includes(FAKE_TOKEN));

    assert.equal(requests[0].body.method, 'contract.ok');
    assert.deepEqual(requests[0].body.params, { limit: 1 });
    assert.equal(typeof requests[0].body.id, 'number');
    assert.equal(responses[0].id, requests[0].body.id);

    assert.equal(requests[1].body.method, 'contract.error');
    assert.deepEqual(requests[1].body.params, {});
    assert.equal(typeof requests[1].body.id, 'number');
    assert.equal(responses[1].id, requests[1].body.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
