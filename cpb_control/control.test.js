import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';
import { buildControlSdk, waitForControl } from '../lib/cpb_control.js';

const row = (ownership = 'agent', state = 'active', id = 1) => ({ id, ownership, state });
const options = { timeout: 1000, polling: 5 };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('an active agent space returns the existing exact receipt shape', async () => {
  let calls = 0;
  assert.deepEqual(await waitForControl(1, async () => {
    calls++;
    return [row()];
  }, options), { control: true });
  assert.equal(calls, 1);
});

test('human ownership stays blocked even when space.use has set state to active', async () => {
  let ownership = 'user';
  const queried = deferred();
  let returned = false;
  const waiting = waitForControl({ spaceId: 1 }, async () => {
    queried.resolve();
    return [row(ownership)];
  }, options).then((receipt) => { returned = true; return receipt; });
  await queried.promise;
  await sleep(15);
  assert.equal(returned, false);
  ownership = 'agent';
  assert.deepEqual(await waiting, { control: true });
});

test('handOff stays blocked until both active state and agent ownership are observed', async () => {
  let calls = 0;
  const snapshots = [
    [row('agent', 'handed-off')],
    [row('user', 'handed-off')],
    [row('user', 'active')],
    [row()],
  ];
  const receipt = await waitForControl(1, async () => snapshots[calls++], options);
  assert.deepEqual(receipt, { control: true });
  assert.equal(calls, 4);
});

test('another task space cannot release the requested space', async () => {
  let calls = 0;
  await waitForControl(2, async () => {
    calls++;
    return [row(), row(calls === 1 ? 'user' : 'agent', 'active', 2)];
  }, options);
  assert.equal(calls, 2);
});

test('a deleted or absent task space fails immediately', async () => {
  let calls = 0;
  await assert.rejects(waitForControl(1, async () => {
    calls++;
    return calls === 1 ? [row('user')] : [];
  }, options), { name: 'UnknownSpace', message: 'no task space 1' });
  assert.equal(calls, 2);
});

test('invalid daemon responses fail closed instead of reporting control', async (t) => {
  for (const [name, value] of [
    ['non-array', {}],
    ['missing ownership', [{ id: 1, state: 'active' }]],
    ['unknown ownership', [row('unknown')]],
    ['unknown state', [row('agent', 'unknown')]],
    ['missing state', [{ id: 1, ownership: 'agent' }]],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(waitForControl(1, async () => value, options), { name: 'ProtocolError' });
    });
  }
});

test('daemon errors propagate unchanged without a retry', async () => {
  const failure = new EgoError('AuthError', 'daemon rejected the request');
  let calls = 0;
  await assert.rejects(waitForControl(1, async () => {
    calls++;
    throw failure;
  }, options), (error) => error === failure);
  assert.equal(calls, 1);
});

test('synchronous query failures propagate unchanged', async () => {
  const failure = new Error('query failed');
  await assert.rejects(waitForControl(1, () => { throw failure; }, options),
    (error) => error === failure);
});

test('a timeout does not wait for the polling interval and stops further queries', async () => {
  let calls = 0;
  const start = performance.now();
  await assert.rejects(waitForControl(1, async () => {
    calls++;
    return [row('user')];
  }, { timeout: 30, polling: 1000 }), { name: 'TimeoutError' });
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 20 && elapsed < 500, `elapsed ${elapsed}ms`);
  await sleep(20);
  assert.equal(calls, 1);
});

test('the deadline bounds a stalled request and ignores its late success', async () => {
  const request = deferred();
  let calls = 0;
  let returned = false;
  const start = performance.now();
  await assert.rejects(waitForControl(1, () => {
    calls++;
    return request.promise;
  }, { timeout: 30, polling: 5 }).then((receipt) => {
    returned = true;
    return receipt;
  }), { name: 'TimeoutError' });
  assert.ok(performance.now() - start < 500);
  request.resolve([row()]);
  await sleep(20);
  assert.equal(returned, false);
  assert.equal(calls, 1);
});

test('a response at the monotonic deadline cannot win before the timer callback', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  await assert.rejects(waitForControl(1, async () => {
    now = 30;
    return [row()];
  }, { timeout: 30, polling: 5 }), { name: 'TimeoutError' });
});

test('pre-aborted waits never query the daemon', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(waitForControl(1, async () => {
    calls++;
    return [row()];
  }, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('abort cancels a polling sleep without another query', async () => {
  const controller = new AbortController();
  const queried = deferred();
  let calls = 0;
  const waiting = waitForControl(1, async () => {
    calls++;
    queried.resolve();
    return [row('user')];
  }, { ...options, polling: 1000, signal: controller.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await queried.promise;
  await sleep(5);
  controller.abort();
  await rejected;
  await sleep(20);
  assert.equal(calls, 1);
});

test('abort bounds a stalled request and ignores a late handback', async () => {
  const controller = new AbortController();
  const request = deferred();
  let calls = 0;
  const waiting = waitForControl(1, () => {
    calls++;
    return request.promise;
  }, { ...options, signal: controller.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await rejected;
  request.resolve([row()]);
  await sleep(20);
  assert.equal(calls, 1);
});

test('completed waits remove their external abort listener', async () => {
  const controller = new AbortController();
  const { getEventListeners } = await import('node:events');
  const before = getEventListeners(controller.signal, 'abort').length;
  await waitForControl(1, async () => [row()], { ...options, signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
  controller.abort();
});

test('timed-out waits remove their external abort listener', async () => {
  const controller = new AbortController();
  const { getEventListeners } = await import('node:events');
  const before = getEventListeners(controller.signal, 'abort').length;
  await assert.rejects(waitForControl(1, async () => [row('user')], {
    timeout: 10, polling: 1000, signal: controller.signal,
  }), { name: 'TimeoutError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});

test('concurrent waits have independent cancellation and task space state', async () => {
  const controller = new AbortController();
  const snapshots = [row('user'), row('user', 'handed-off', 2)];
  const query = async () => snapshots;
  const cancelled = assert.rejects(waitForControl(1, query, {
    ...options, signal: controller.signal,
  }), { name: 'AbortError' });
  const other = waitForControl(2, query, options);
  controller.abort();
  await cancelled;
  snapshots[1] = row('agent', 'active', 2);
  assert.deepEqual(await other, { control: true });
});

test('invalid inputs are rejected before any query', async (t) => {
  let calls = 0;
  const query = async () => { calls++; return [row()]; };
  for (const task of [0, -1, 1.5, '1', null, {}, { spaceId: '1' }, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(`task ${JSON.stringify(task)}`, async () => {
      await assert.rejects(waitForControl(task, query, options), TypeError);
    });
  }
  for (const name of ['timeout', 'polling']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '30', 2 ** 31]) {
      await t.test(`${name} ${value}`, async () => {
        await assert.rejects(waitForControl(1, query, { ...options, [name]: value }), TypeError);
      });
    }
  }
  await assert.rejects(waitForControl(1, undefined, options), TypeError);
  await assert.rejects(waitForControl(1, query, { ...options, signal: {} }), TypeError);
  assert.equal(calls, 0);
});

test('opt-in SDK uses only space.list, preserves other methods, and refreshes task metadata', async () => {
  const calls = [];
  let ownership = 'user';
  let state = 'handed-off';
  const client = {
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'space.list') return [{ ...row(ownership, state), name: 'control-test' }];
      if (method === 'space.use') return { ...row(ownership, state), name: 'control-test', pages: [] };
      if (method === 'page.call') return 'test title';
      throw new Error(`unexpected RPC ${method}`);
    },
  };
  const sdk = buildControlSdk(client);
  const task = await sdk.taskSpace('control-test');
  assert.ok(task instanceof sdk.TaskSpace);
  assert.equal(task.ownership, 'user');
  calls.length = 0;
  const waiting = task.waitForControl(options);
  await sleep(15);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ method }) => method === 'space.list'));
  ownership = 'agent';
  state = 'active';
  assert.deepEqual(await waiting, { control: true });
  assert.equal(task.ownership, 'agent');
  assert.equal(task._state, 'active');
  assert.equal(await task.page('p1').title(), 'test title');
  assert.deepEqual(calls.at(-1), {
    method: 'page.call', params: { spaceId: 1, label: 'p1', method: 'title', args: [] },
  });
});

test('all SDK TaskSpace construction paths use the opt-in waiter', async () => {
  const calls = [];
  const sdk = buildControlSdk({
    rpc: async (method) => {
      calls.push(method);
      if (method === 'space.list') return [row()];
      return { ...row(), name: 'control-test', pages: [] };
    },
  });
  const tasks = [
    await sdk.taskSpace(1),
    await sdk.taskSpace('new-control-test'),
    await sdk.useOrCreateTaskSpace(1),
    await sdk.claimTaskSpace(1),
    await sdk.takeOverTaskSpace(1),
    new sdk.TaskSpace({ ...row(), pages: [] }),
  ];
  calls.length = 0;
  for (const task of tasks) assert.deepEqual(await task.waitForControl(options), { control: true });
  assert.deepEqual(calls, Array(tasks.length).fill('space.list'));
});

test('the original SDK behavior remains unchanged and isolated', async () => {
  const calls = [];
  const client = {
    rpc: async (method) => {
      calls.push(method);
      return { control: true };
    },
  };
  const original = buildSdk(client);
  const optedIn = buildControlSdk(client);
  const subsequent = buildSdk(client);
  assert.notEqual(original.TaskSpace, optedIn.TaskSpace);
  assert.notEqual(subsequent.TaskSpace, optedIn.TaskSpace);
  for (const sdk of [original, subsequent]) {
    assert.deepEqual(await new sdk.TaskSpace(row()).waitForControl(), { control: true });
  }
  assert.deepEqual(calls, ['space.waitForControl', 'space.waitForControl']);
});

test('existing HTTP client and opt-in SDK interoperate without real network or credential files', async () => {
  const requests = [];
  // Ephemeral authentication input stays in memory and is never logged or written.
  const client = createClient({
    port: 9774,
    token: randomBytes(24).toString('hex'),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, method: body.method, params: body.params });
      assert.equal(body.method, 'space.list');
      return Response.json({ ok: true, result: [row()] });
    },
  });
  const sdk = buildControlSdk(client);
  assert.deepEqual(await new sdk.TaskSpace(row()).waitForControl(options), { control: true });
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:9774/rpc', method: 'space.list', params: {},
  }]);
});
