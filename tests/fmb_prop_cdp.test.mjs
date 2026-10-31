// Property / invariant tests for daemon/cdp.js (framing, pending map, event fan-out, once()).
// No socket is ever dialed: only the pure framing layers are driven directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cdp, CdpError, once } from '../daemon/cdp.js';

// Syntactically valid but never-dialed endpoint — Cdp only opens a socket inside connect().
const NEVER_DIALED = 'ws://127.0.0.1:9/never-dialed-cdp';
const offline = (label = 'prop') => new Cdp(NEVER_DIALED, label);

// Minimal stand-in for the Cdp event surface that once() relies on.
function fakeBus() {
  const handlers = new Set();
  return {
    handlers,
    onEvent(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    emit(ev) { for (const fn of [...handlers]) fn(ev); },
  };
}

function quietConsoleError(t) {
  const orig = console.error;
  console.error = () => {};
  t.after(() => { console.error = orig; });
}

test('constructor: an offline client starts with empty state and is not closed', () => {
  const cdp = offline();
  assert.equal(cdp.id, 0);
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.sessions.size, 0);
  assert.equal(cdp.closed, false);
  assert.equal(cdp.wsUrl, NEVER_DIALED);
  assert.equal(cdp.label, 'prop');
});

test('close: idempotent and marks the client closed', () => {
  const cdp = offline();
  assert.equal(cdp.closed, false);
  cdp.close();
  cdp.close();
  assert.equal(cdp.closed, true);
});

test('onEvent: unsubscribe is idempotent and removes exactly one handler', () => {
  const cdp = offline();
  const off = cdp.onEvent(() => {});
  assert.equal(cdp.handlers.size, 1);
  assert.equal(off(), true);
  assert.equal(off(), false);
  assert.equal(off(), false);
  assert.equal(cdp.handlers.size, 0);
});

test('onEvent: the same function registered twice is stored once (Set semantics)', () => {
  const cdp = offline();
  const fn = () => {};
  cdp.onEvent(fn);
  cdp.onEvent(fn);
  assert.equal(cdp.handlers.size, 1);
  cdp.onEvent(fn)();
  assert.equal(cdp.handlers.size, 0);
});

test('_recv: unparseable payloads are ignored without throwing or dispatching', () => {
  const cdp = offline();
  let calls = 0;
  cdp.onEvent(() => { calls += 1; });
  for (const bad of ['', '   ', 'not json', '{{{', '{"id":', Buffer.from('garbage')]) {
    assert.doesNotThrow(() => cdp._recv(bad));
  }
  assert.equal(calls, 0);
  assert.equal(cdp.sessions.size, 0);
});

test('_recv: a response for an unknown id is dropped silently', () => {
  const cdp = offline();
  let calls = 0;
  cdp.onEvent(() => { calls += 1; });
  cdp._recv(JSON.stringify({ id: 4242, result: { ok: true } }));
  assert.equal(calls, 0);
  assert.equal(cdp.pending.size, 0);
});

test('_recv: fan-out delivers every event to every live handler in registration order', () => {
  const cdp = offline();
  const seen = [];
  const offA = cdp.onEvent((ev) => seen.push(['a', ev]));
  cdp.onEvent((ev) => seen.push(['b', ev]));

  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' }));
  assert.deepEqual(seen.map(([k]) => k), ['a', 'b']);
  for (const [, ev] of seen) {
    assert.deepEqual(ev, { sessionId: 'S1', method: 'Page.loadEventFired', params: { timestamp: 1 } });
  }

  seen.length = 0;
  cdp._recv(Buffer.from(JSON.stringify({ method: 'Runtime.consoleAPICalled' })));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0][1], { sessionId: null, method: 'Runtime.consoleAPICalled', params: {} });

  offA();
  seen.length = 0;
  cdp._recv(JSON.stringify({ method: 'Page.frameNavigated', params: {}, sessionId: 'S2' }));
  assert.deepEqual(seen.map(([k]) => k), ['b']);
});

test('_recv: a throwing handler does not stop dispatch to later handlers', (t) => {
  quietConsoleError(t);
  const cdp = offline();
  const after = [];
  cdp.onEvent(() => { throw new Error('boom'); });
  const off = cdp.onEvent((ev) => after.push(ev.method));
  assert.doesNotThrow(() => cdp._recv(JSON.stringify({ method: 'X.y' })));
  assert.deepEqual(after, ['X.y']);
  off();
});

test('monotonic: the known-session-id set only grows and never loses an id', () => {
  const cdp = offline();
  const sizes = [];
  for (const id of ['A', 'B', 'A', 'C', 'B']) {
    cdp._recv(JSON.stringify({ sessionId: id, method: 'Runtime.executionContextCreated' }));
    sizes.push(cdp.sessions.size);
  }
  assert.deepEqual(sizes, [1, 2, 2, 3, 3]);
  assert.deepEqual([...cdp.sessions].sort(), ['A', 'B', 'C']);
  cdp._recv(JSON.stringify({ sessionId: 'A', method: 'Page.frameDetached' }));
  assert.equal(cdp.sessions.size, 3);
});

test('_recv: resolves a pending request once and forgets it (at-most-once)', async () => {
  const cdp = offline();
  const value = await new Promise((resolve, reject) => {
    cdp.pending.set(1, { resolve, reject, method: 'Browser.getVersion' });
    cdp._recv(JSON.stringify({ id: 1, result: { product: 'Fake/1.0' } }));
    assert.equal(cdp.pending.size, 0);
    cdp._recv(JSON.stringify({ id: 1, result: { product: 'Duplicate/9' } })); // ignored
  });
  assert.deepEqual(value, { product: 'Fake/1.0' });
  assert.equal(cdp.pending.size, 0);
});

test('_recv: error payloads reject with CdpError describing the method', async () => {
  const cases = [
    [{ code: -32000, message: 'Cannot navigate' }, /^Page\.navigate: Cannot navigate$/],
    [{ code: -32601, message: '' }, /^Page\.navigate: $/],
    [{ code: -1 }, /^Page\.navigate: \{"code":-1\}$/],
  ];
  for (const [error, pattern] of cases) {
    const cdp = offline();
    const err = await new Promise((resolve) => {
      cdp.pending.set(7, { resolve: () => resolve(null), reject: resolve, method: 'Page.navigate' });
      cdp._recv(JSON.stringify({ id: 7, error }));
    });
    assert.ok(err instanceof CdpError, JSON.stringify(error));
    assert.equal(err.name, 'CdpError');
    assert.match(err.message, pattern);
    assert.deepEqual(err.cdpError, error);
    assert.equal(cdp.pending.size, 0);
  }
});

test('send: rejects while offline, never dials, and leaves id/pending untouched', async () => {
  const cdp = offline();
  await assert.rejects(() => cdp.send('Browser.getVersion'), /CDP connection closed/);
  assert.equal(cdp.id, 0);
  assert.equal(cdp.pending.size, 0);

  cdp.close();
  await assert.rejects(() => cdp.send('Target.getTargets', {}, { sessionId: 'S1' }), /CDP connection closed/);
  assert.equal(cdp.pending.size, 0);
});

test('once: resolves on the first matching event, ignores others, and removes its handler', async () => {
  const bus = fakeBus();
  const waiting = once(bus, 'Page.loadEventFired', { timeout: 5000 });
  assert.equal(bus.handlers.size, 1);

  bus.emit({ method: 'Page.frameNavigated', params: {}, sessionId: null });
  assert.equal(bus.handlers.size, 1);
  bus.emit({ method: 'Page.loadEventFired', params: { timestamp: 42 }, sessionId: null });

  assert.deepEqual(await waiting, { timestamp: 42 });
  assert.equal(bus.handlers.size, 0);

  bus.emit({ method: 'Page.loadEventFired', params: { timestamp: 43 }, sessionId: null });
  assert.equal(bus.handlers.size, 0);
});

test('once: filters by sessionId and keeps waiting for other sessions', async () => {
  const bus = fakeBus();
  const waiting = once(bus, 'Page.javascriptDialogOpening', { sessionId: 'S2', timeout: 5000 });

  bus.emit({ method: 'Page.javascriptDialogOpening', params: { n: 1 }, sessionId: 'S1' });
  assert.equal(bus.handlers.size, 1);

  bus.emit({ method: 'Page.javascriptDialogOpening', params: { n: 2 }, sessionId: 'S2' });
  assert.deepEqual(await waiting, { n: 2 });
  assert.equal(bus.handlers.size, 0);
});

test('once: times out with a descriptive error and leaves no handler behind', async () => {
  const bus = fakeBus();
  await assert.rejects(
    () => once(bus, 'Page.domContentEventFired', { timeout: 20 }),
    /Page\.domContentEventFired event timed out after 20ms/,
  );
  assert.equal(bus.handlers.size, 0);
});

test('once: concurrent waiters for different methods resolve independently', async () => {
  const bus = fakeBus();
  const a = once(bus, 'A.evt', { timeout: 5000 });
  const b = once(bus, 'B.evt', { timeout: 5000 });
  assert.equal(bus.handlers.size, 2);

  bus.emit({ method: 'B.evt', params: { b: true }, sessionId: null });
  assert.deepEqual(await b, { b: true });
  assert.equal(bus.handlers.size, 1);

  bus.emit({ method: 'A.evt', params: { a: true }, sessionId: null });
  assert.deepEqual(await a, { a: true });
  assert.equal(bus.handlers.size, 0);
});

test('property: sequential once() waits never leak handlers and each gets its own payload', async () => {
  const bus = fakeBus();
  let peak = 0;
  for (let i = 0; i < 30; i += 1) {
    const waiting = once(bus, 'Prop.evt', { timeout: 5000 });
    peak = Math.max(peak, bus.handlers.size);
    bus.emit({ method: 'Prop.evt', params: { i }, sessionId: null });
    assert.deepEqual(await waiting, { i });
    assert.equal(bus.handlers.size, 0);
  }
  assert.equal(peak, 1);
});
