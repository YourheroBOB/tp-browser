// tests/fmb_w14_s03_page_ops_vault_resilience.test.mjs
// daemon/page-ops.js 兩個「靜默資料遺失」錯誤處理缺口的回歸測試：
//   1. restoreVaultToBrowser()：CDP 的 Storage.setCookies 是「全或無」，vault 裡只要有一個
//      壞掉的 cookie，整批登入態都會還原失敗（外層空 catch 讓它完全無聲）。
//   2. _loadVaultsFromDisk()：storage-vault.json 形狀不合法（例如陣列）時，之後寫入的 origin
//      會在序列化時被丟掉，等於頁面 storage 同步永久靜默失效。
// 零依賴、零網路、不連線任何服務；所有檔案都在 mkdtempSync(tmpdir()) 內。
// 需要假值時一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// page-ops.js 在 import 時就用 os.homedir() 算出資料目錄，因此必須先改 HOME / USERPROFILE
// 再動態載入，確保整個測試只碰得到暫存目錄，不會讀寫真實使用者的 ~/.local/share/ego-linux。
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w14-s03-pageops-'));
const dataDir = join(tempRoot, '.local', 'share', 'ego-linux');
mkdirSync(dataDir, { recursive: true });
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;

const { BrowserHub } = await import('../daemon/page-ops.js');

const STORAGE_VAULT = join(dataDir, 'storage-vault.json');

after(() => rmSync(tempRoot, { recursive: true, force: true }));

// 不呼叫 constructor：避免註冊 2 秒掃描計時器與 CDP 事件，只測目標方法本身。
function bareHub() {
  const hub = Object.create(BrowserHub.prototype);
  hub.sessions = new Map();
  hub.cookieVault = new Map();
  hub.storageVault = {};
  return hub;
}

function fakeCookie(name, value, overrides = {}) {
  return {
    name,
    value,
    domain: 'app.example.test',
    path: '/',
    secure: true,
    expires: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// 模擬 Chrome：批次裡只要有一個壞 cookie，整批失敗且不設定任何 cookie。
function fakeSetCookies(accepted, attempts) {
  return {
    async send(method, params) {
      assert.equal(method, 'Storage.setCookies');
      const list = Array.isArray(params?.cookies) ? params.cookies : [];
      attempts.push(list.length);
      if (list.some((c) => String(c?.name || '').includes('BAD'))) {
        throw new Error('Invalid cookie fields');
      }
      for (const c of list) accepted.push(c.name);
    },
  };
}

test('storage-vault.json 形狀不合法時會被丟棄重建，且後續同步真的寫得回磁碟', () => {
  const origin = 'https://app.example.test';
  for (const bad of ['[]', '["https://stale.example"]', '"FAKE_VALUE_FOR_TEST"', '42']) {
    writeFileSync(STORAGE_VAULT, bad, 'utf8');
    const hub = bareHub();
    hub._loadVaultsFromDisk();
    assert.equal(typeof hub.storageVault, 'object', `bad=${bad}`);
    assert.notEqual(hub.storageVault, null, `bad=${bad}`);
    assert.equal(Array.isArray(hub.storageVault), false, `bad=${bad} 必須重建為純物件`);
    hub._handleStorageSync({ origin, ls: [['token', 'FAKE_VALUE_FOR_TEST']], ss: [] });
    assert.deepEqual(hub.storageVault[origin].ls, [['token', 'FAKE_VALUE_FOR_TEST']], `bad=${bad}`);
    const onDisk = JSON.parse(readFileSync(STORAGE_VAULT, 'utf8'));
    assert.deepEqual(onDisk[origin].ls, [['token', 'FAKE_VALUE_FOR_TEST']], `bad=${bad} 寫回磁碟不可遺失 origin`);
  }
});

test('restoreVaultToBrowser：單一壞 cookie 不得讓整批登入態全滅', async () => {
  const hub = bareHub();
  hub.cookieVault.set('a', fakeCookie('sid', 'FAKE_VALUE_FOR_TEST'));
  hub.cookieVault.set('b', fakeCookie('__BAD__sid', 'FAKE_VALUE_FOR_TEST'));
  hub.cookieVault.set('c', fakeCookie('uid', 'FAKE_VALUE_FOR_TEST'));
  const accepted = [];
  const attempts = [];
  hub.cdp = fakeSetCookies(accepted, attempts);

  const result = await hub.restoreVaultToBrowser();

  assert.deepEqual(attempts, [3, 1, 1, 1], '先試整批，失敗後逐筆重試');
  assert.deepEqual(accepted.sort(), ['sid', 'uid'], '合法 cookie 必須全部還原');
  assert.deepEqual(result, { restored: 2, failed: 1 });
});

test('restoreVaultToBrowser：正常批次只發一次 Storage.setCookies', async () => {
  const hub = bareHub();
  hub.cookieVault.set('a', fakeCookie('sid', 'FAKE_VALUE_FOR_TEST'));
  hub.cookieVault.set('b', fakeCookie('uid', 'FAKE_VALUE_FOR_TEST'));
  const accepted = [];
  const attempts = [];
  hub.cdp = fakeSetCookies(accepted, attempts);

  const result = await hub.restoreVaultToBrowser();

  assert.deepEqual(attempts, [2]);
  assert.deepEqual(accepted.sort(), ['sid', 'uid']);
  assert.deepEqual(result, { restored: 2, failed: 0 });
});

test('restoreVaultToBrowser：只送合法 cookie，過期與缺欄位的條目不算數', async () => {
  const hub = bareHub();
  const past = Math.floor(Date.now() / 1000) - 60;
  hub.cookieVault.set('a', fakeCookie('sid', 'FAKE_VALUE_FOR_TEST'));
  hub.cookieVault.set('b', fakeCookie('expired', 'FAKE_VALUE_FOR_TEST', { expires: past }));
  hub.cookieVault.set('c', { name: 'novalue', domain: 'app.example.test' });
  const accepted = [];
  const attempts = [];
  hub.cdp = fakeSetCookies(accepted, attempts);

  const result = await hub.restoreVaultToBrowser();

  assert.deepEqual(attempts, [1]);
  assert.deepEqual(accepted, ['sid']);
  assert.deepEqual(result, { restored: 1, failed: 0 });
});

test('restoreVaultToBrowser：vault 為空時完全不打 CDP', async () => {
  const hub = bareHub();
  const attempts = [];
  hub.cdp = { async send() { attempts.push('called'); } };

  const result = await hub.restoreVaultToBrowser();

  assert.deepEqual(attempts, []);
  assert.deepEqual(result, { restored: 0, failed: 0 });
});
