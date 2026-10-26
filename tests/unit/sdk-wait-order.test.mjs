import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSdk, createClient } from '../../lib/sdk.js';

test('waitForEvent registers waitPush before _refresh', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../lib/sdk.js'), 'utf8');
  const fn = src.slice(src.indexOf('async waitForEvent'), src.indexOf('async waitForFileChooser'));
  const waitAt = fn.indexOf('waitPush');
  const refreshAt = fn.indexOf('await this._refresh()');
  assert.ok(waitAt >= 0 && refreshAt > waitAt, 'waitPush must be armed before await _refresh');
  assert.equal(fn.includes('m.kind === \'download\' && m.kind === \'download\''), false);
  assert.ok(fn.includes('pending.catch'), 'must attach a rejection handler before refresh');
  assert.ok(fn.includes('pending.cancel'), 'must cancel the waiter if refresh fails');
});

test('waitForEvent refresh failure does not unhandledRejection', async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { waitPush } = createClient({
      port: 9772,
      token: 'test-token',
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ ok: true, result: {} }),
        body: { getReader() { return { read: async () => ({ done: true, value: undefined }) }; } },
      }),
    });
    const sdk = buildSdk({
      rpc: async (method) => {
        if (method === 'space.use') throw new Error('daemon unreachable');
        return {};
      },
      waitPush,
    });
    const task = {
      spaceId: 1,
      _pageCall: async () => ({}),
      page(label) { return new sdk.Page(this, label); },
    };
    const page = new sdk.Page(task, 'p1', 'TID');
    await assert.rejects(() => page.waitForEvent('download', { timeout: 80 }), /daemon unreachable/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('evaluate third argument timeout is forwarded and eval alias keeps opts', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../lib/sdk.js'), 'utf8');
  assert.match(src, /evaluate\(fnOrString, arg, opts = \{\}\)/);
  assert.match(src, /eval\(fnOrString, arg, opts = \{\}\) \{ return this\.evaluate\(fnOrString, arg, opts\); \}/);
});
