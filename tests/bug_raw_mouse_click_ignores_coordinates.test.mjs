import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserHub } from '../daemon/page-ops.js';

function fakeCdp() {
  const calls = [];
  return {
    calls,
    onEvent() { return () => {}; },
    send(method, params = {}, opts = {}) {
      calls.push({ method, params, sessionId: opts.sessionId ?? null });
      if (method === 'Browser.getVersion') {
        return Promise.resolve({ userAgent: 'Chrome/120.0.0.0', product: 'Chrome/120.0.0.0' });
      }
      return Promise.resolve({});
    },
  };
}

test('rawMouse click dispatches press and release at the given coordinates', async () => {
  const downloadsDir = join(tmpdir(), 'tp-bug-rawmouse-click');
  const cdp = fakeCdp();
  const hub = new BrowserHub(cdp, { downloadsDir, onPush() {}, daemonPort: 9772 });
  try {
    hub.sessions.set('t1', {
      sessionId: 'sid-1',
      url: 'about:blank',
      isPopup: false,
      net: new Set(),
      dialogs: [],
      frames: new Set(),
      domReady: false,
    });
    let err = null;
    try {
      await hub.rawMouse('t1', 'click', [12, 34], { button: 'right', timeout: 200 });
    } catch (e) {
      err = e;
    }
    const mouse = cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    const pressed = mouse.find((c) => c.params?.type === 'mousePressed');
    const released = mouse.find((c) => c.params?.type === 'mouseReleased');
    assert.ok(pressed, err ? `coordinate click failed: ${err.message}` : 'expected mousePressed');
    assert.equal(pressed.params.x, 12);
    assert.equal(pressed.params.y, 34);
    assert.equal(pressed.params.button, 'right');
    assert.equal(pressed.sessionId, 'sid-1');
    assert.ok(released, 'expected mouseReleased');
    assert.equal(released.params.x, 12);
    assert.equal(released.params.y, 34);
    assert.equal(released.params.button, 'right');
    assert.equal(released.sessionId, 'sid-1');
  } finally {
    clearInterval(hub._sweepTimer);
  }
});
