import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForControl, buildControlSdk } from '../lib/cpb_control.js';
import { EgoError } from '../lib/sdk.js';

const agentActive = (id = 1) => ({ id, ownership: 'agent', state: 'active' });
const userActive = (id = 1) => ({ id, ownership: 'user', state: 'active' });
const agentHandedOff = (id = 1) => ({ id, ownership: 'agent', state: 'handed-off' });

// ---- input validation ----

test('resolves immediately when already agent-owned and active', async () => {
  const r = await waitForControl(1, async () => [agentActive(1)], { timeout: 500, polling: 5 });
  assert.deepEqual(r, { control: true });
});

test('accepts TaskSpace-like object with spaceId', async () => {
  const r = await waitForControl({ spaceId: 7 }, async () => [agentActive(7)], { timeout: 500, polling: 5 });
  assert.deepEqual(r, { control: true });
});

test('rejects invalid task shapes', async () => {
  for (const bad of [0, -1, 1.5, NaN, null, undefined, {}, { spaceId: 0 }, '1']) {
    await assert.rejects(waitForControl(bad, async () => []), /positive integer space ID/);
  }
});

test('rejects non-function listTaskSpaces', async () => {
  await assert.rejects(waitForControl(1, null), /listTaskSpaces must be a function/);
});

test('rejects bad timeout/polling values', async () => {
  for (const v of [0, -5, 1.5, NaN, 2 ** 31]) {
    await assert.rejects(waitForControl(1, async () => [], { timeout: v }), /timeout must be an integer/);
    await assert.rejects(waitForControl(1, async () => [], { polling: v }), /polling must be an integer/);
  }
});

test('rejects non-AbortSignal and already-aborted signal', async () => {
  await assert.rejects(waitForControl(1, async () => [], { signal: {} }), /signal must be an AbortSignal/);
  const c = new AbortController();
  c.abort(new Error('x'));
  await assert.rejects(waitForControl(1, async () => [agentActive(1)], { signal: c.signal }), (e) => e instanceof EgoError && e.name === 'AbortError');
});

// ---- polling behaviour ----

test('polls until ownership flips to agent', async () => {
  let calls = 0;
  const list = async () => (++calls < 3 ? [userActive(1)] : [agentActive(1)]);
  const r = await waitForControl(1, list, { timeout: 1000, polling: 5 });
  assert.deepEqual(r, { control: true });
  assert.equal(calls, 3);
});

test('waits while handed-off, resolves when active', async () => {
  let calls = 0;
  const list = async () => (++calls < 2 ? [agentHandedOff(4)] : [agentActive(4)]);
  const r = await waitForControl(4, list, { timeout: 1000, polling: 5 });
  assert.deepEqual(r, { control: true });
  assert.equal(calls, 2);
});

test('throws UnknownSpace when id missing', async () => {
  await assert.rejects(
    waitForControl(9, async () => [agentActive(1)], { timeout: 500, polling: 5 }),
    (e) => e instanceof EgoError && e.name === 'UnknownSpace' && /9/.test(e.message),
  );
});

test('throws ProtocolError for non-array, bad ownership, bad state', async () => {
  await assert.rejects(waitForControl(1, async () => ({}), { timeout: 500, polling: 5 }),
    (e) => e instanceof EgoError && e.name === 'ProtocolError');
  await assert.rejects(waitForControl(1, async () => [{ id: 1, ownership: 'nobody', state: 'active' }], { timeout: 500, polling: 5 }),
    (e) => e instanceof EgoError && e.name === 'ProtocolError');
  await assert.rejects(waitForControl(1, async () => [{ id: 1, ownership: 'agent', state: 'closed' }], { timeout: 500, polling: 5 }),
    (e) => e instanceof EgoError && e.name === 'ProtocolError');
});

test('propagates listTaskSpaces rejection', async () => {
  const boom = new Error('daemon down');
  await assert.rejects(waitForControl(1, async () => { throw boom; }, { timeout: 500, polling: 5 }), (e) => e === boom);
});

// ---- timeout / abort ----

test('times out while control never arrives', async () => {
  await assert.rejects(
    waitForControl(1, async () => [userActive(1)], { timeout: 60, polling: 5 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError' && /60ms/.test(e.message) && /1/.test(e.message),
  );
});

test('timeout still fires when listTaskSpaces never settles', async () => {
  await assert.rejects(
    waitForControl(1, () => new Promise(() => {}), { timeout: 60, polling: 5 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
});

test('external abort rejects with AbortError', async () => {
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assert.rejects(
    waitForControl(1, async () => [userActive(1)], { timeout: 1000, polling: 5, signal: c.signal }),
    (e) => e instanceof EgoError && e.name === 'AbortError',
  );
});

// ---- buildControlSdk ----

test('buildControlSdk TaskSpace.waitForControl uses local poll and refreshes state', async () => {
  const sdk = buildControlSdk({ rpc: async () => { throw new Error('rpc should not be called'); }, waitPush: async () => { throw new Error('no push'); } });
  const ts = new sdk.TaskSpace({ id: 3, name: 't', ownership: 'user', state: 'active', pages: [] });
  assert.equal(typeof ts.waitForControl, 'function');
  // Seed the sdk list path: replace sdk.listTaskSpaces with a stub that flips to agent.
  let calls = 0;
  sdk.listTaskSpaces = async () => (++calls < 2 ? [userActive(3)] : [agentActive(3)]);
  // waitForControl on the prototype closes over the original sdk.listTaskSpaces,
  // so instead verify via prototype patch point: call with fresh sdk whose rpc serves space.list.
  const sdk2 = buildControlSdk({
    rpc: async (method) => {
      assert.equal(method, 'space.list');
      return (++calls < 4 ? [userActive(3)] : [agentActive(3)]);
    },
    waitPush: async () => { throw new Error('no push'); },
  });
  const ts2 = new sdk2.TaskSpace({ id: 3, name: 't', ownership: 'user', state: 'active', pages: [] });
  const receipt = await ts2.waitForControl({ timeout: 1000, polling: 5 });
  assert.deepEqual(receipt, { control: true });
  assert.equal(ts2.ownership, 'agent');
  assert.equal(ts2._state, 'active');
  void ts;
});
