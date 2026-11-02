import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tp-bug-reset-suffix-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { BrowserHub } = await import('../daemon/page-ops.js');

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function hubWith(cookies) {
  const calls = [];
  const cdp = {
    calls,
    onEvent() { return () => {}; },
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Storage.getCookies') return Promise.resolve({ cookies });
      if (method === 'Browser.getVersion') {
        return Promise.resolve({ userAgent: 'Mozilla/5.0 Chrome/120.0.0.0', product: 'Chrome/120.0.0.0' });
      }
      return Promise.resolve({});
    },
  };
  const hub = new BrowserHub(cdp, { downloadsDir: home, onPush() {}, daemonPort: 9772 });
  clearInterval(hub._sweepTimer);
  hub.sessions.set('T1', {
    sessionId: 'S1',
    url: 'https://shop.example.com.tw/cart',
    net: new Set(),
    dialogs: [],
    frames: new Set(),
    isPopup: false,
  });
  return { hub, calls };
}

test('resetSiteAuth on .com.tw does not wipe unrelated registrable domains', async () => {
  const unrelated = {
    name: 'SID',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: '.bank.com.tw',
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 3600,
  };
  const { hub, calls } = hubWith([unrelated]);
  hub.cookieVault.set('SID|.bank.com.tw|/', { ...unrelated });
  hub.storageVault['https://bank.com.tw'] = {
    ls: [['k', 'FAKE_VALUE_FOR_TEST']],
    ss: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = await hub.resetSiteAuth('T1');
  assert.equal(result.clearedDomains.includes('com.tw'), false);
  assert.ok(result.clearedDomains.includes('example.com.tw'));
  const deletes = calls.filter((c) => c.method === 'Network.deleteCookies');
  assert.equal(deletes.length, 0);
  assert.equal(hub.cookieVault.has('SID|.bank.com.tw|/'), true);
  assert.ok(hub.storageVault['https://bank.com.tw']);
});

test('resetSiteAuth on .com.tw still clears that registrable domain', async () => {
  const own = {
    name: 'SID',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: '.example.com.tw',
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 3600,
  };
  const { hub, calls } = hubWith([own]);
  hub.cookieVault.set('SID|.example.com.tw|/', { ...own });
  const result = await hub.resetSiteAuth('T1');
  assert.ok(result.clearedDomains.includes('example.com.tw'));
  assert.equal(result.clearedDomains.includes('com.tw'), false);
  const deletes = calls.filter((c) => c.method === 'Network.deleteCookies');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].params.name, 'SID');
  assert.equal(deletes[0].params.domain, '.example.com.tw');
  assert.equal(hub.cookieVault.has('SID|.example.com.tw|/'), false);
});
