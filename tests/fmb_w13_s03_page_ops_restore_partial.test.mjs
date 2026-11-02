// tests/fmb_w13_s03_page_ops_restore_partial.test.mjs
//
// 回歸測試：daemon/page-ops.js → BrowserHub.restoreVaultToBrowser()
//
// 問題：CDP 的 Storage.setCookies 是「一次呼叫、整批驗證」。vault 裡只要有一筆 cookie
// 被 Chrome 判為不合法（分區鍵、值格式、前綴規則…），整個 CDP 指令就回錯誤；原實作把
// 所有 cookie 塞進同一個 await 再配一個空的 catch，等於「一筆壞 cookie 讓整座 cookie
// vault（實機 3,300+ 筆登入態）全部無聲還原失敗」。
//
// 測試隔離：用 Object.create(BrowserHub.prototype) 直接組出實例，只注入 cdp 與
// cookieVault；不建立 CDP 連線、不啟計時器、不讀寫任何檔案（包含
// ~/.local/share/ego-linux/cookies-vault.json）。cookie 值一律使用 FAKE_VALUE_FOR_TEST。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHub } from '../daemon/page-ops.js';

const BAD_COOKIE_NAME = '__tp_invalid_cookie';
const VALUE = 'FAKE_VALUE_FOR_TEST';
const nowSec = () => Math.floor(Date.now() / 1000);
const FUTURE = nowSec() + 7 * 86400;

// 未定義的成員一律當成 no-op 訂閱（onEvent / onClose / once …），
// 讓測試不依賴 page-ops 的私有 CDP wiring 細節。
function stub() { return stub; }

function makeFakeCdp({ alwaysFailSetCookies = false } = {}) {
  const storedCookies = new Map();
  const calls = [];
  const api = {
    storedCookies,
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Storage.getCookies') return { cookies: [] };
      if (method === 'Storage.setCookies') {
        if (alwaysFailSetCookies) throw new Error('WebSocket is not open');
        const list = Array.isArray(params?.cookies) ? params.cookies : [];
        // 模擬 Chromium：整批只要有一筆驗證失敗，整個 CDP 指令就失敗。
        if (list.some((c) => c?.name === BAD_COOKIE_NAME)) {
          throw new Error('Invalid cookie fields');
        }
        for (const c of list) storedCookies.set(c.name, c);
        return {};
      }
      return {};
    },
  };
  return new Proxy(api, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (prop in target) return target[prop];
      return stub;
    },
  });
}

function cookie(name, overrides = {}) {
  return {
    name,
    value: VALUE,
    domain: '.example.test',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    expires: FUTURE,
    ...overrides,
  };
}

function makeHub(options) {
  const cdp = makeFakeCdp(options);
  const hub = Object.create(BrowserHub.prototype);
  hub.cdp = cdp;
  hub.cookieVault = new Map();
  return { hub, cdp };
}

const setCookieCalls = (cdp) => cdp.calls.filter((c) => c.method === 'Storage.setCookies');

test('restoreVaultToBrowser：單一不合法 cookie 不得讓其他登入態一起還原失敗', async () => {
  const { hub, cdp } = makeHub();
  hub.cookieVault.set('a', cookie('sid_a'));
  hub.cookieVault.set('bad', cookie(BAD_COOKIE_NAME));
  hub.cookieVault.set('c', cookie('sid_c'));

  const restored = await hub.restoreVaultToBrowser();

  assert.equal(cdp.storedCookies.get('sid_a')?.value, VALUE, '合法 cookie 必須被還原');
  assert.equal(cdp.storedCookies.get('sid_c')?.value, VALUE, '合法 cookie 必須被還原');
  assert.equal(cdp.storedCookies.has(BAD_COOKIE_NAME), false, '壞 cookie 不應被寫入');
  assert.equal(restored, 2);
});

test('restoreVaultToBrowser：全部合法時仍以單一批次送出，不逐筆退化', async () => {
  const { hub, cdp } = makeHub();
  hub.cookieVault.set('a', cookie('sid_a'));
  hub.cookieVault.set('b', cookie('sid_b'));

  const restored = await hub.restoreVaultToBrowser();

  const calls = setCookieCalls(cdp);
  assert.equal(calls.length, 1, '正常情況應只發一次 Storage.setCookies');
  assert.deepEqual(calls[0].params.cookies.map((c) => c.name), ['sid_a', 'sid_b']);
  assert.equal(restored, 2);
});

test('restoreVaultToBrowser：過期 cookie 不會被送出（只還原仍有效的登入態）', async () => {
  const { hub, cdp } = makeHub();
  hub.cookieVault.set('old', cookie('sid_old', { expires: nowSec() - 60 }));
  hub.cookieVault.set('new', cookie('sid_new'));

  const restored = await hub.restoreVaultToBrowser();

  const calls = setCookieCalls(cdp);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.cookies.map((c) => c.name), ['sid_new']);
  assert.equal(restored, 1);
});

test('restoreVaultToBrowser：vault 無可還原項目時不打 CDP，回傳 0', async () => {
  const { hub, cdp } = makeHub();
  hub.cookieVault.set('broken', { name: '', domain: '', value: VALUE });

  const restored = await hub.restoreVaultToBrowser();

  assert.equal(setCookieCalls(cdp).length, 0);
  assert.equal(restored, 0);
});

test('restoreVaultToBrowser：整批與逐筆都被拒（例如 CDP 已斷線）時不會無限重試', async () => {
  const { hub, cdp } = makeHub({ alwaysFailSetCookies: true });
  for (let i = 0; i < 50; i++) hub.cookieVault.set(`k${i}`, cookie(`sid_${i}`));

  const restored = await hub.restoreVaultToBrowser();

  assert.equal(restored, 0);
  const attempts = setCookieCalls(cdp).length;
  assert.ok(attempts <= 11, `逐筆重試應有上限（1 次整批 + 最多 10 次逐筆），實際 ${attempts} 次`);
});
