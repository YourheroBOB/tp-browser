import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, CdpError, once } from '../daemon/cdp.js';

function makeOpenCdp() {
  const cdp = new Cdp('ws://127.0.0.1/fake');
  cdp.ws = {
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(payload);
    },
    close() {
      this.readyState = 3;
    },
  };
  return cdp;
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  fail() {
    this.onerror?.({});
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

async function withFakeWebSocket(run) {
  const hadOriginal = Object.hasOwn(globalThis, 'WebSocket');
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    await run();
  } finally {
    if (hadOriginal) globalThis.WebSocket = original;
    else delete globalThis.WebSocket;
  }
}

test('Cdp resolves successful responses and rejects protocol errors with CdpError', async () => {
  const cdp = makeOpenCdp();

  const success = cdp.send('Browser.getVersion', { fixture: true }, { timeout: 100 });
  const request = JSON.parse(cdp.ws.sent[0]);
  assert.equal(request.id, 1);
  assert.equal(request.method, 'Browser.getVersion');
  assert.deepEqual(request.params, { fixture: true });

  cdp._recv(JSON.stringify({ id: request.id, result: { value: 1 } }));
  assert.deepEqual(await success, { value: 1 });

  const failure = cdp.send('Bad.method', {}, { timeout: 100 });
  const failedRequest = JSON.parse(cdp.ws.sent[1]);
  cdp._recv(JSON.stringify({
    id: failedRequest.id,
    error: { code: -32000, message: 'fixture protocol error' },
  }));

  await assert.rejects(failure, (error) => {
    assert.ok(error instanceof CdpError);
    assert.equal(error.name, 'CdpError');
    assert.equal(error.cdpError.code, -32000);
    assert.match(error.message, /Bad\.method: fixture protocol error/);
    return true;
  });
});

test('Cdp ignores malformed and unknown messages and isolates event-handler exceptions', () => {
  const cdp = makeOpenCdp();
  const seen = [];

  cdp._recv('{not-json');
  cdp._recv(Buffer.from('also-not-json'));
  cdp._recv(JSON.stringify({ id: 999, result: { ignored: true } }));
  assert.equal(cdp.pending.size, 0);

  cdp.onEvent((event) => seen.push(event));
  cdp._recv(JSON.stringify({
    sessionId: 'fixture-session',
    method: 'Target.targetCreated',
    params: { targetId: 'fake-target' },
  }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'Target.targetCreated');
  assert.equal(seen[0].params.targetId, 'fake-target');
  assert.ok(cdp.sessions.has('fixture-session'));

  const originalError = console.error;
  let laterHandlerCalls = 0;
  try {
    console.error = () => {};
    cdp.onEvent(() => {
      throw new Error('fixture handler failure');
    });
    cdp.onEvent(() => { laterHandlerCalls += 1; });
    cdp._recv(JSON.stringify({ method: 'Fixture.event', params: {} }));
  } finally {
    console.error = originalError;
  }
  assert.equal(laterHandlerCalls, 1);
});

test('Cdp rejects closed, not-open, timed-out and synchronously failed sends', async () => {
  const closed = makeOpenCdp();
  closed.closed = true;
  await assert.rejects(
    closed.send('Closed.method'),
    /CDP connection closed/,
  );

  const notOpen = makeOpenCdp();
  notOpen.ws.readyState = 0;
  await assert.rejects(
    notOpen.send('NotOpen.method'),
    /CDP connection closed/,
  );

  const brokenWrite = makeOpenCdp();
  brokenWrite.ws.send = () => {
    throw new Error('fixture write failure');
  };
  await assert.rejects(
    brokenWrite.send('Write.method', {}, { timeout: 1 }),
    /fixture write failure/,
  );

  const slow = makeOpenCdp();
  await assert.rejects(
    slow.send('Slow.method', {}, { timeout: 5 }),
    /Slow\.method timed out after 5ms/,
  );
});

test('once resolves only the requested method and session, then cleans up after timeout', async () => {
  const cdp = makeOpenCdp();
  const event = once(cdp, 'Target.targetCreated', {
    sessionId: 'fixture-session',
    timeout: 100,
  });

  cdp._recv(JSON.stringify({
    sessionId: 'fixture-session',
    method: 'Other.event',
    params: {},
  }));
  cdp._recv(JSON.stringify({
    sessionId: 'other-session',
    method: 'Target.targetCreated',
    params: { targetId: 'ignored' },
  }));
  cdp._recv(JSON.stringify({
    sessionId: 'fixture-session',
    method: 'Target.targetCreated',
    params: { targetId: 'fake-target' },
  }));

  assert.deepEqual(await event, { targetId: 'fake-target' });
  assert.equal(cdp.handlers.size, 0);

  await assert.rejects(
    once(cdp, 'Missing.event', { timeout: 5 }),
    /Missing\.event event timed out after 5ms/,
  );
  assert.equal(cdp.handlers.size, 0);
});

test('Cdp.connect completes with a fake socket and close rejects pending requests', async () => {
  await withFakeWebSocket(async () => {
    FakeWebSocket.instances.length = 0;
    const cdp = new Cdp('ws://127.0.0.1/fake');
    const connecting = cdp.connect(100);
    const socket = FakeWebSocket.instances.at(-1);

    socket.open();
    assert.equal(await connecting, cdp);

    let closeObserved = false;
    cdp.onClose(() => { closeObserved = true; });
    const pending = cdp.send('Long.method', {}, { timeout: 1000 });
    const rejection = assert.rejects(pending, /CDP connection closed/);

    cdp.close();
    await rejection;
    assert.equal(closeObserved, true);
  });
});

test('Cdp.connect reports connection failure and timeout without using a real network', async () => {
  await withFakeWebSocket(async () => {
    FakeWebSocket.instances.length = 0;
    const failedCdp = new Cdp('ws://127.0.0.1/fake');
    const failedConnect = failedCdp.connect(100);
    FakeWebSocket.instances.at(-1).fail();
    await assert.rejects(failedConnect, /CDP connect failed/);
  });

  await withFakeWebSocket(async () => {
    FakeWebSocket.instances.length = 0;
    const timedOutCdp = new Cdp('ws://127.0.0.1/fake');
    await assert.rejects(
      timedOutCdp.connect(5),
      /CDP connect timeout/,
    );
  });
});
