// tests/muse1103_bug_lib_cpb_control.test.mjs
//
// Review of lib/cpb_control.js: no reproducible real bug was found.
// All validation, success, UnknownSpace/ProtocolError, timeout/abort, listener
// cleanup, and SDK-isolation paths behave as cpb_control/README.md specifies
// (existing suite: cpb_control/control.test.js, 49/49 passing), and abort/
// timeout storms (80 iterations) never leak a foreign error.
//
// Riskiest remaining edge pinned here: when the deadline fires or the caller
// aborts while poll() is parked inside timers/promises sleep(), that sleep
// rejects with a generic DOMException AbortError ("The operation was aborted"),
// NOT with stop.signal.reason. The caller must still observe the documented
// EgoError('TimeoutError'/'AbortError'). That currently holds only because the
// internal `stopped` abort listener is registered before any sleep starts, so
// it always wins the Promise.race. The pre-existing tests assert just
// `{ name: 'TimeoutError' }`, which would not catch a regression that lets the
// DOMException surface on the abort path (it also carries name 'AbortError').
// These tests pin the error identity (instanceof EgoError + name + message)
// across repeated mid-sleep timeout/abort landings, with no wall-clock bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { EgoError } from '../lib/sdk.js';
import { waitForControl } from '../lib/cpb_control.js';

const blocked = async () => [{ id: 1, ownership: 'user', state: 'active' }];

test('mid-sleep timeout always surfaces EgoError TimeoutError (x20)', async () => {
  for (let i = 0; i < 20; i++) {
    const err = await waitForControl(1, blocked, { timeout: 25, polling: 5 })
      .then(() => null, (e) => e);
    assert.ok(err instanceof EgoError, `iteration ${i}: ${err?.constructor?.name} ${err?.name}`);
    assert.equal(err.name, 'TimeoutError');
    assert.match(err.message, /timed out after 25ms for task space 1/);
  }
});

test('mid-sleep external abort always surfaces EgoError AbortError (x20)', async () => {
  for (let i = 0; i < 20; i++) {
    const controller = new AbortController();
    let calls = 0;
    const waiting = waitForControl(1, async () => {
      calls++;
      return blocked();
    }, { timeout: 5000, polling: 5000, signal: controller.signal });
    await sleep(12);
    controller.abort();
    const err = await waiting.then(() => null, (e) => e);
    assert.ok(err instanceof EgoError, `iteration ${i}: ${err?.constructor?.name} ${err?.name}`);
    assert.equal(err.name, 'AbortError');
    assert.equal(err.message, 'waitForControl was aborted');
    assert.equal(calls, 1);
  }
});

test('stalled query + timeout: EgoError TimeoutError wins and late success is ignored', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let returned = false;
  const err = await waitForControl(1, () => {
    calls++;
    return gate;
  }, { timeout: 25, polling: 5 }).then(
    (receipt) => { returned = true; return receipt; },
    (e) => e,
  );
  assert.ok(err instanceof EgoError, `${err?.constructor?.name} ${err?.name}`);
  assert.equal(err.name, 'TimeoutError');
  release([{ id: 1, ownership: 'agent', state: 'active' }]);
  await sleep(20);
  assert.equal(returned, false);
  assert.equal(calls, 1);
});

test('TaskSpace-object input resolves with the exact receipt shape', async () => {
  let calls = 0;
  const receipt = await waitForControl({ spaceId: 7 }, async () => {
    calls++;
    return [{ id: 7, ownership: 'agent', state: 'active' }];
  }, { timeout: 1000, polling: 5 });
  assert.deepEqual(receipt, { control: true });
  assert.equal(calls, 1);
});
