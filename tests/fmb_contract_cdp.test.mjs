import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cdp, CdpError, once } from '../daemon/cdp.js';

test('CdpError preserves its error type, message, and original payload', () => {
  const payload = {
    code: -32000,
    message: 'Contract failure',
    data: { field: 'contract' },
  };
  const error = new CdpError('Page.navigate', payload);

  assert.ok(error instanceof Error);
  assert.equal(error.name, 'CdpError');
  assert.equal(error.message, 'Page.navigate: Contract failure');
  assert.equal(error.cdpError, payload);
  assert.deepEqual(error.cdpError, payload);
});

test('Cdp event subscriptions expose removable listener contracts', () => {
  assert.equal(typeof Cdp, 'function');
  assert.equal(Cdp.length, 1);
  assert.equal(Cdp.prototype.onEvent.length, 1);
  assert.equal(Cdp.prototype.onClose.length, 1);
  assert.equal(Cdp.prototype.send.length, 1);
  assert.equal(once.length, 2);

  const cdp = new Cdp('ws://127.0.0.1:1/never-connected', 'contract');
  const removeEvent = cdp.onEvent(() => {});
  const removeClose = cdp.onClose(() => {});

  assert.equal(typeof removeEvent, 'function');
  assert.equal(typeof removeClose, 'function');
  assert.equal(removeEvent(), true);
  assert.equal(removeClose(), true);
});

test('Cdp.send before connecting rejects with the existing Error contract', async () => {
  const cdp = new Cdp('ws://127.0.0.1:1/never-connected', 'contract');

  await assert.rejects(
    cdp.send('Browser.getVersion'),
    { name: 'Error', message: 'CDP connection closed' },
  );
});

test('once resolves matching events and removes its listener', async () => {
  const listeners = new Set();
  const fakeCdp = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const pending = once(fakeCdp, 'Target.targetCreated', {
    sessionId: 'contract-session',
    timeout: 1000,
  });

  assert.equal(listeners.size, 1);
  for (const listener of listeners) {
    listener({
      method: 'Target.targetCreated',
      sessionId: 'contract-session',
      params: { targetId: 'contract-target' },
    });
  }

  assert.deepEqual(await pending, { targetId: 'contract-target' });
  assert.equal(listeners.size, 0);
});

test('once rejects with the existing event timeout Error contract', async () => {
  const fakeCdp = {
    onEvent() {
      return () => {};
    },
  };

  await assert.rejects(
    once(fakeCdp, 'Never', { timeout: 10 }),
    {
      name: 'Error',
      message: 'Never event timed out after 10ms',
    },
  );
});
