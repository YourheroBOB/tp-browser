import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tp-hostonly-cookie-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { BrowserHub } = await import('../daemon/page-ops.js');

const hubs = [];

after(() => {
  for (const hub of hubs) clearInterval(hub._sweepTimer);
  rmSync(home, { recursive: true, force: true });
});

function fakeCdp(responses = {}) {
  const calls = [];
  return {
    calls,
    onEvent() { return () => {}; },
    send(method, params) {
      calls.push({ method, params });
      if (Object.prototype.hasOwnProperty.call(responses, method)) {
        return Promise.resolve(responses[method]());
      }
      if (method === 'Browser.getVersion') {
        return Promise.resolve({ userAgent: 'Chrome/120.0.0.0', product: 'Chrome/120.0.0.0' });
      }
      return Promise.resolve({});
    },
  };
}

function makeHub(cdp) {
  const hub = new BrowserHub(cdp, {
    downloadsDir: join(home, 'downloads'),
    onPush() {},
    daemonPort: 9772,
  });
  clearInterval(hub._sweepTimer);
  hubs.push(hub);
  return hub;
}

function onWire(cookie) {
  return JSON.parse(JSON.stringify(cookie));
}

test('syncVaultNow promotes a host-only session cookie without Domain', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cdp = fakeCdp({
    'Storage.getCookies': () => ({
      cookies: [
        {
          name: 'sid_host',
          value: 'FAKE_VALUE_FOR_TEST',
          domain: 'example.com',
          path: '/',
          hostOnly: true,
          secure: true,
          httpOnly: true,
          session: true,
          expires: -1,
        },
        {
          name: 'sid_domain',
          value: 'FAKE_VALUE_FOR_TEST',
          domain: '.example.com',
          path: '/',
          hostOnly: false,
          secure: true,
          httpOnly: true,
          session: true,
          expires: -1,
        },
      ],
    }),
  });
  const hub = makeHub(cdp);
  await hub.syncVaultNow();
  const setCalls = cdp.calls.filter((c) => c.method === 'Storage.setCookies');
  assert.equal(setCalls.length, 1);
  const byName = Object.fromEntries(setCalls[0].params.cookies.map((c) => [c.name, onWire(c)]));
  assert.equal(Object.hasOwn(byName.sid_host, 'domain'), false);
  assert.equal(byName.sid_host.url, 'https://example.com/');
  assert.equal(byName.sid_host.value, 'FAKE_VALUE_FOR_TEST');
  assert.ok(byName.sid_host.expires > now);
  assert.equal(byName.sid_domain.domain, '.example.com');
});

test('restoreVaultToBrowser replays host-only cookies without Domain', async () => {
  const cdp = fakeCdp();
  const hub = makeHub(cdp);
  const expires = Math.floor(Date.now() / 1000) + 3600;
  hub.cookieVault.set('sid_host|example.com|/', {
    name: 'sid_host',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: 'example.com',
    path: '/',
    hostOnly: true,
    secure: true,
    httpOnly: true,
    session: false,
    expires,
  });
  hub.cookieVault.set('sid_domain|.example.com|/', {
    name: 'sid_domain',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: '.example.com',
    path: '/',
    hostOnly: false,
    secure: true,
    httpOnly: true,
    session: false,
    expires,
  });
  await hub.restoreVaultToBrowser();
  const setCalls = cdp.calls.filter((c) => c.method === 'Storage.setCookies');
  assert.equal(setCalls.length, 1);
  const byName = Object.fromEntries(setCalls[0].params.cookies.map((c) => [c.name, onWire(c)]));
  assert.equal(Object.hasOwn(byName.sid_host, 'domain'), false);
  assert.equal(byName.sid_host.url, 'https://example.com/');
  assert.equal(byName.sid_domain.domain, '.example.com');
});
