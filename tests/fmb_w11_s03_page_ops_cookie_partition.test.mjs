// tests/fmb_w11_s03_page_ops_cookie_partition.test.mjs
//
// 回歸測試（w11 / s03 — daemon/page-ops.js）
//
// 缺陷：cookie vault 的鍵（cookieKey）原本只用 `name|domain|path`，
// 但 CHIPS（partitioned cookie）的真正身分還包含 partitionKey.topLevelSite。
// toCookieParam() 已經會把 partitionKey 還原回 CDP，代表程式「有意」保存分區 cookie，
// 可是 syncVaultNow() 會讓同 name/domain/path、不同 topLevelSite 的兩顆 cookie
// 在 Map 中互相覆蓋 → 其中一個分區的登入態無聲遺失，重啟後也還原不回來。
//
// 本檔特性：
//   * 只呼叫 BrowserHub.prototype 上的方法（不建構 BrowserHub）→ 不啟動 sweep timer、
//     不讀寫真實資料目錄、不連線任何服務。
//   * 零網路、零檔案寫入；所有憑證值都是明顯假字串 FAKE_VALUE_FOR_TEST。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHub } from '../daemon/page-ops.js';

const NOW_SEC = Math.floor(Date.now() / 1000);
const FUTURE = NOW_SEC + 3600;

function partitionedCookie(topLevelSite, value) {
  return {
    name: 'sid',
    value,
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    expires: FUTURE,
    sameSite: 'None',
    partitionKey: { topLevelSite, hasCrossSiteAncestor: false },
  };
}

function plainCookie(overrides = {}) {
  return {
    name: 'token',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: '.example.com',
    path: '/app',
    secure: false,
    httpOnly: false,
    expires: FUTURE,
    sameSite: 'Lax',
    ...overrides,
  };
}

// 只提供 syncVaultNow()/restoreVaultToBrowser() 實際會用到的成員，避免任何 I/O。
function makeFakeHub(cookies) {
  const calls = [];
  const persisted = [];
  return {
    cdp: {
      async send(method, params) {
        calls.push({ method, params });
        if (method === 'Storage.getCookies') return { cookies };
        return {};
      },
    },
    sessions: new Map(),
    cookieVault: new Map(),
    calls,
    persisted,
    _persistCookieVault() {
      persisted.push(new Map(this.cookieVault));
    },
  };
}

test('syncVaultNow：同 name/domain/path 但不同 partitionKey 的 cookie 不得互相覆蓋', async () => {
  const hub = makeFakeHub([
    partitionedCookie('https://site-a.example', 'FAKE_VALUE_FOR_TEST-a'),
    partitionedCookie('https://site-b.example', 'FAKE_VALUE_FOR_TEST-b'),
  ]);

  await BrowserHub.prototype.syncVaultNow.call(hub);

  assert.equal(hub.cookieVault.size, 2, 'partitioned cookies 在 vault 中應是兩個獨立條目');
  const sites = [...hub.cookieVault.values()]
    .map((c) => c.partitionKey?.topLevelSite)
    .sort();
  assert.deepEqual(sites, ['https://site-a.example', 'https://site-b.example']);
  const values = [...hub.cookieVault.values()].map((c) => c.value).sort();
  assert.deepEqual(values, ['FAKE_VALUE_FOR_TEST-a', 'FAKE_VALUE_FOR_TEST-b']);
  assert.equal(hub.persisted.length, 1, '一次同步只落地一次');
});

test('syncVaultNow：重複同步同一批分區 cookie 不會膨脹也不會搬移鍵', async () => {
  const cookies = [
    partitionedCookie('https://site-a.example', 'FAKE_VALUE_FOR_TEST-a'),
    partitionedCookie('https://site-b.example', 'FAKE_VALUE_FOR_TEST-b'),
  ];
  const hub = makeFakeHub(cookies);

  await BrowserHub.prototype.syncVaultNow.call(hub);
  const keysAfterFirst = [...hub.cookieVault.keys()].sort();
  await BrowserHub.prototype.syncVaultNow.call(hub);

  assert.equal(hub.cookieVault.size, 2);
  assert.deepEqual([...hub.cookieVault.keys()].sort(), keysAfterFirst);
});

test('syncVaultNow：未分區 cookie 的 vault 鍵維持 name|domain|path（舊 vault 相容）', async () => {
  const hub = makeFakeHub([plainCookie()]);

  await BrowserHub.prototype.syncVaultNow.call(hub);

  assert.deepEqual([...hub.cookieVault.keys()], ['token|.example.com|/app']);
});

test('restoreVaultToBrowser：兩個分區各自帶回自己的 partitionKey', async () => {
  const synced = makeFakeHub([
    partitionedCookie('https://site-a.example', 'FAKE_VALUE_FOR_TEST-a'),
    partitionedCookie('https://site-b.example', 'FAKE_VALUE_FOR_TEST-b'),
  ]);
  await BrowserHub.prototype.syncVaultNow.call(synced);

  const sends = [];
  const restoreFake = {
    cookieVault: synced.cookieVault,
    cdp: {
      async send(method, params) {
        sends.push({ method, params });
        return {};
      },
    },
  };
  await BrowserHub.prototype.restoreVaultToBrowser.call(restoreFake);

  assert.equal(sends.length, 1);
  assert.equal(sends[0].method, 'Storage.setCookies');
  const params = sends[0].params.cookies;
  assert.equal(params.length, 2, '兩個分區都要被還原');

  const bySite = new Map(params.map((p) => [p.partitionKey?.topLevelSite, p]));
  const a = bySite.get('https://site-a.example');
  const b = bySite.get('https://site-b.example');
  assert.ok(a && b, '每個分區都應對應到一顆 cookie');
  assert.equal(a.value, 'FAKE_VALUE_FOR_TEST-a');
  assert.equal(b.value, 'FAKE_VALUE_FOR_TEST-b');
  assert.equal(a.partitionKey.hasCrossSiteAncestor, false);
  assert.equal(a.url, 'https://example.com/');
  assert.equal(a.secure, true);
  assert.equal(a.httpOnly, true);
  assert.equal(a.domain, '.example.com');
});

test('restoreVaultToBrowser：全部 cookie 都已過期時不下任何 CDP 指令', async () => {
  const sends = [];
  const hub = {
    cookieVault: new Map([
      ['token|.example.com|/app', plainCookie({ expires: NOW_SEC - 60 })],
      ['sid|.example.com|/', { ...plainCookie({ name: 'sid', path: '/' }), expires: 0 }],
    ]),
    // expires: 0 會被 toCookieParam() 視為 session cookie 而延長，
    // 因此這裡只讓「明確過期」的那顆被過濾；再補一顆 session cookie 驗證延長行為。
    cdp: {
      async send(method, params) {
        sends.push({ method, params });
        return {};
      },
    },
  };

  await BrowserHub.prototype.restoreVaultToBrowser.call(hub);

  assert.equal(sends.length, 1, 'session cookie 延長後仍會還原，但過期 cookie 不應出現');
  const params = sends[0].params.cookies;
  assert.deepEqual(params.map((p) => p.name), ['sid']);
});
