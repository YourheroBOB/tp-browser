import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserHub } from '../daemon/page-ops.js';

test('goto load does not succeed while location is only a prefix of the target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-bug-goto-'));
  const cdp = {
    onEvent() { return () => {}; },
    async send(method, params) {
      if (method === 'Browser.getVersion') {
        return { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0', product: 'Chrome/120.0.0.0' };
      }
      if (method === 'Page.navigate') return { frameId: 'frame-1' };
      if (method === 'Runtime.evaluate') {
        if (params?.expression === 'document.readyState') return { result: { value: 'complete' } };
        if (params?.expression === 'location.href') return { result: { value: 'https://example.com/app' } };
        return { result: { value: null } };
      }
      return {};
    },
  };
  const hub = new BrowserHub(cdp, { downloadsDir: dir, onPush() {}, daemonPort: 9772 });
  clearInterval(hub._sweepTimer);
  hub.sessions.set('T1', {
    sessionId: 'S1',
    url: 'https://example.com/app',
    net: new Set(),
    frames: new Set(),
    dialogs: [],
    choosers: [],
    events: [],
    uaCleaned: true,
    domReady: true,
    isPopup: false,
    attachedAt: Date.now(),
  });
  try {
    let caught = null;
    try {
      await hub.goto('T1', 'https://example.com/app/settings', { waitUntil: 'load', timeout: 450 });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'goto resolved while location was still a prefix of the target');
    assert.equal(caught.name, 'NavigationError');
    assert.match(caught.message, /timeout 450ms exceeded waiting for load/);
  } finally {
    clearInterval(hub._sweepTimer);
    rmSync(dir, { recursive: true, force: true });
  }
});
