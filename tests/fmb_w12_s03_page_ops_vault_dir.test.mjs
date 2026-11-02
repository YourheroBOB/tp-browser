// tests/fmb_w12_s03_page_ops_vault_dir.test.mjs
// daemon/page-ops.js 的 vault 載入／持久化回歸測試（w12 / s03）。
// 全程只使用 mkdtempSync(tmpdir())，不連線任何服務；示例憑證一律 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR 於模組載入時計算，必須先設定覆寫再動態 import。
const dataDir = mkdtempSync(join(tmpdir(), 'fmb-w12-s03-page-ops-'));
process.env.EGO_LINUX_DATA_DIR = dataDir;

const { BrowserHub } = await import('../daemon/page-ops.js');

const STORAGE_VAULT = join(dataDir, 'storage-vault.json');
const COOKIES_VAULT = join(dataDir, 'cookies-vault.json');

after(() => {
  delete process.env.EGO_LINUX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function newHub() {
  // 只借用原型上的 vault 方法：不跑建構子（避免計時器、CDP 連線與 _wire()）。
  const hub = Object.create(BrowserHub.prototype);
  hub.storageVault = {};
  hub.cookieVault = new Map();
  return hub;
}

test('vault 檔讀寫綁定 EGO_LINUX_DATA_DIR，不會落到真實家目錄', () => {
  const vault = {
    'https://a.example': { updatedAt: '2026-01-01T00:00:00.000Z', ls: [['k', 'v']], ss: [] },
  };
  writeFileSync(STORAGE_VAULT, JSON.stringify(vault), 'utf8');

  const hub = newHub();
  hub._loadVaultsFromDisk();

  assert.deepEqual(hub.storageVault['https://a.example'].ls, [['k', 'v']]);
  assert.deepEqual(hub.storageVault['https://a.example'].ss, []);
});

test('storage-vault.json 為 JSON 陣列時，新同步的 origin 不得在持久化時消失', () => {
  writeFileSync(STORAGE_VAULT, '[]', 'utf8');

  const hub = newHub();
  hub._loadVaultsFromDisk();
  assert.equal(Array.isArray(hub.storageVault), false, 'storageVault 不得是陣列');

  hub._handleStorageSync({
    origin: 'https://b.example/login',
    ls: [['token', 'FAKE_VALUE_FOR_TEST']],
    ss: [],
  });

  const raw = JSON.parse(readFileSync(STORAGE_VAULT, 'utf8'));
  assert.equal(Array.isArray(raw), false, '磁碟 vault 不得是陣列');
  assert.deepEqual(raw['https://b.example'].ls, [['token', 'FAKE_VALUE_FOR_TEST']]);
  assert.deepEqual(raw['https://b.example'].ss, []);
});

test('損壞的 vault 條目在載入階段剔除，不會被注入 preload 腳本', () => {
  const junk = Object.create(null);
  junk['https://ok.example'] = {
    updatedAt: '2026-02-02T00:00:00.000Z',
    ls: [['k', 'v'], 'junk', ['bad', 1], ['long', 'x'.repeat(65537)], ['k2', 'v2']],
    ss: null,
  };
  junk['http://insecure.example'] = { ls: [['k', 'v']] };
  junk['https://arr.example'] = [];
  Object.defineProperty(junk, '__proto__', { value: { ls: [['k', 'v']] }, enumerable: true });
  writeFileSync(STORAGE_VAULT, JSON.stringify(junk), 'utf8');

  const hub = newHub();
  hub._loadVaultsFromDisk();

  assert.deepEqual(hub.storageVault['https://ok.example'].ls, [['k', 'v'], ['k2', 'v2']]);
  assert.deepEqual(hub.storageVault['https://ok.example'].ss, []);
  assert.equal('http://insecure.example' in hub.storageVault, false);
  assert.equal('https://arr.example' in hub.storageVault, false);
  assert.equal(Object.getPrototypeOf(hub.storageVault), Object.prototype);

  const script = hub._buildStoragePreloadScript();
  assert.match(script, /https:\/\/ok\.example/);
  assert.doesNotMatch(script, /insecure\.example/);
});

test('單一 origin 條目超額時，載入階段即裁切到上限並保留較新的鍵', () => {
  const ls = Array.from({ length: 600 }, (_, i) => [`k${i}`, 'v']);
  writeFileSync(STORAGE_VAULT, JSON.stringify({ 'https://cap.example': { ls, ss: [] } }), 'utf8');

  const hub = newHub();
  hub._loadVaultsFromDisk();

  const loaded = hub.storageVault['https://cap.example'].ls;
  assert.equal(loaded.length, 500);
  assert.deepEqual(loaded[0], ['k100', 'v']);
  assert.deepEqual(loaded[499], ['k599', 'v']);
});

test('cookies-vault.json 從 EGO_LINUX_DATA_DIR 載入，並剔除 value 非字串的條目', () => {
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(COOKIES_VAULT, JSON.stringify({
    cookies: [
      { name: 'sid', value: 'FAKE_VALUE_FOR_TEST', domain: '.example.com', path: '/', expires: now + 3600 },
      { name: 'broken', value: 42, domain: '.example.com', path: '/' },
      { name: 'sess', value: 'FAKE_VALUE_FOR_TEST', domain: 'example.com', path: '/', expires: -1, session: true },
    ],
  }), 'utf8');

  const hub = newHub();
  hub._loadVaultsFromDisk();

  const names = [...hub.cookieVault.values()].map((c) => c.name).sort();
  assert.deepEqual(names, ['sess', 'sid']);
  const nowAfter = Math.floor(Date.now() / 1000);
  for (const c of hub.cookieVault.values()) {
    assert.equal(typeof c.value, 'string');
    assert.ok(c.expires > nowAfter, `${c.name} 應被提升為非 session cookie`);
    assert.equal(Boolean(c.session), false);
  }
});

test('以裸物件（無任何原型方法）呼叫 _handleStorageSync 仍會落盤一次並套用 origin 上限', () => {
  // 回歸：vault 邏輯若改成 BrowserHub 上的私有方法（this._trimStorageOrigins(...)），
  // 以「裸物件 + 單一方法」呼叫時會 TypeError，被最外層空 catch 吞掉，
  // 於是整批 storage 同步靜默遺失（寫回 0 次）、origin 上限也失效（70 個 origin 全留）。
  const bare = { storageVault: {}, persistCalls: 0 };
  bare._persistStorageVault = () => { bare.persistCalls++; };

  BrowserHub.prototype._handleStorageSync.call(bare, {
    origin: 'https://c.example/path',
    ls: [['k', 'FAKE_VALUE_FOR_TEST']],
    ss: [],
  });

  assert.equal(bare.persistCalls, 1, '同步一次只應落盤一次');
  assert.deepEqual(bare.storageVault['https://c.example'].ls, [['k', 'FAKE_VALUE_FOR_TEST']]);

  for (let i = 0; i < 70; i++) {
    BrowserHub.prototype._handleStorageSync.call(bare, {
      origin: `https://o${i}.example`,
      ls: [['k', 'v']],
      ss: [],
    });
  }
  assert.equal(bare.persistCalls, 71);
  assert.equal(Object.keys(bare.storageVault).length, 64, 'origin 總數上限必須生效');
  assert.equal('https://c.example' in bare.storageVault, true, '剛寫入的 origin 不應被自己淘汰');
});

test('以裸物件呼叫 _loadVaultsFromDisk 仍能載入並淨化 storage vault', () => {
  writeFileSync(STORAGE_VAULT, JSON.stringify({
    'https://ok.example': { ls: [['k', 'v'], ['bad', 1]], ss: [] },
    'http://insecure.example': { ls: [['k', 'v']] },
  }), 'utf8');

  const bare = { storageVault: {}, cookieVault: new Map() };
  BrowserHub.prototype._loadVaultsFromDisk.call(bare);

  assert.deepEqual(bare.storageVault['https://ok.example'].ls, [['k', 'v']]);
  assert.equal('http://insecure.example' in bare.storageVault, false);
});
