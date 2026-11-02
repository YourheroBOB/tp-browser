import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserHub } from '../daemon/page-ops.js';

test('resetSiteAuth clears origin storage without the invalid session_storage type', async () => {
  const downloadsDir = mkdtempSync(join(tmpdir(), 'tp-bug-clear-storage-'));
  const origLoad = BrowserHub.prototype._loadVaultsFromDisk;
  const origPersistCookies = BrowserHub.prototype._persistCookieVault;
  const origPersistStorage = BrowserHub.prototype._persistStorageVault;
  BrowserHub.prototype._loadVaultsFromDisk = function () {};
  BrowserHub.prototype._persistCookieVault = function () {};
  BrowserHub.prototype._persistStorageVault = function () {};
  const calls = [];
  const cdp = {
    onEvent() { return () => {}; },
    send(method, params = {}, opts = {}) {
      calls.push({ method, params, sessionId: opts.sessionId });
      if (method === 'Storage.getCookies') return Promise.resolve({ cookies: [] });
      if (method === 'Browser.getVersion') {
        return Promise.resolve({ userAgent: 'Chrome/120.0.0.0', product: 'Chrome/120.0.0.0' });
      }
      return Promise.resolve({});
    },
  };
  try {
    const hub = new BrowserHub(cdp, { downloadsDir, onPush() {}, daemonPort: 9772 });
    clearInterval(hub._sweepTimer);
    hub.sessions.set('T1', {
      sessionId: 'S1',
      url: 'https://app.example.com/account',
      net: new Set(),
      frames: new Set(),
      dialogs: [],
      isPopup: false,
    });
    await hub.resetSiteAuth('T1');

    const clear = calls.find((c) => c.method === 'Storage.clearDataForOrigin');
    assert.ok(clear, 'expected Storage.clearDataForOrigin');
    assert.equal(clear.params.origin, 'https://app.example.com');
    assert.equal(clear.sessionId, 'S1');
    const types = clear.params.storageTypes.split(',').map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(types, ['indexeddb', 'local_storage']);

    const clearedSession = calls.find((c) => c.method === 'Runtime.evaluate'
      && String(c.params.expression || '').includes('sessionStorage.clear'));
    assert.ok(clearedSession, 'session storage must be cleared in the page');
    assert.equal(clearedSession.sessionId, 'S1');
  } finally {
    BrowserHub.prototype._loadVaultsFromDisk = origLoad;
    BrowserHub.prototype._persistCookieVault = origPersistCookies;
    BrowserHub.prototype._persistStorageVault = origPersistStorage;
    rmSync(downloadsDir, { recursive: true, force: true });
  }
});
