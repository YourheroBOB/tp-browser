// tests/fmb_w10_s03_page_ops_vault_persist.test.mjs
// 回歸測試：daemon/page-ops.js 的 vault 落地與 cookie url 組裝。
//   1) 資料目錄不存在時，_persistStorageVault / _persistCookieVault 不得靜默 ENOENT 而整批遺失。
//   2) vault 內非絕對 path 不得組出「host 被串歪」的 cookie url。
//
// 特性：零依賴、零網路、不連線任何服務、不讀寫 repo 以外的真實使用者路徑。
// 資料根目錄以 HOME／USERPROFILE 導向 mkdtempSync(tmpdir())，只用到明顯假值 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w10-s03-page-ops-'));
const home = join(tempRoot, 'home');
mkdirSync(home, { recursive: true });

const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
// page-ops.js 在 import 當下就用 os.homedir() 算出 DATA_DIR，必須先導向暫存目錄。
process.env.HOME = home;
process.env.USERPROFILE = home;

const { BrowserHub } = await import('../daemon/page-ops.js');

const DATA_DIR = join(home, '.local', 'share', 'ego-linux');
const COOKIES_FILE = join(DATA_DIR, 'cookies-vault.json');
const STORAGE_FILE = join(DATA_DIR, 'storage-vault.json');

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(tempRoot, { recursive: true, force: true });
});

// 不跑 BrowserHub 建構子（會啟動 sweep timer 並註冊 CDP handler），
// 只取原型方法做「落地／載入」與 cookie 組裝的單元驗證。
function freshHub() {
  const hub = Object.create(BrowserHub.prototype);
  hub.cookieVault = new Map();
  hub.storageVault = {};
  return hub;
}

const futureExpires = () => Math.floor(Date.now() / 1000) + 3600;

test('storage vault：資料目錄不存在時仍應建立目錄並落地，重載後資料一致', () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  assert.equal(existsSync(STORAGE_FILE), false, '前置條件：storage vault 檔不存在');

  const hub = freshHub();
  hub.storageVault = {
    'https://example.test': {
      updatedAt: '2026-01-01T00:00:00.000Z',
      ls: [['token', 'FAKE_VALUE_FOR_TEST']],
      ss: [['draft', 'FAKE_VALUE_FOR_TEST']],
    },
  };
  hub._persistStorageVault();

  assert.equal(existsSync(STORAGE_FILE), true, '資料目錄不存在時也必須建立目錄並寫入 storage vault');

  const reloaded = freshHub();
  reloaded._loadVaultsFromDisk();
  assert.deepEqual(reloaded.storageVault['https://example.test'].ls, [['token', 'FAKE_VALUE_FOR_TEST']]);
  assert.deepEqual(reloaded.storageVault['https://example.test'].ss, [['draft', 'FAKE_VALUE_FOR_TEST']]);
});

test('cookie vault：資料目錄不存在時仍應建立目錄並落地，重載後登入態還在', () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  assert.equal(existsSync(COOKIES_FILE), false, '前置條件：cookie vault 檔不存在');

  const expires = futureExpires();
  const hub = freshHub();
  hub.cookieVault.set('sid|.example.test|/', {
    name: 'sid',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: '.example.test',
    path: '/',
    expires,
  });
  hub._persistCookieVault();

  assert.equal(existsSync(COOKIES_FILE), true, '資料目錄不存在時也必須建立目錄並寫入 cookie vault');
  const raw = JSON.parse(readFileSync(COOKIES_FILE, 'utf8'));
  assert.equal(Array.isArray(raw.cookies), true);
  assert.equal(raw.cookies.length, 1);

  const reloaded = freshHub();
  reloaded._loadVaultsFromDisk();
  assert.equal(reloaded.cookieVault.size, 1, '未過期的 cookie 必須能從磁碟還原');
});

test('restoreVaultToBrowser：非絕對 path 不得組出 host 被串歪的 url；合法 absolute path 不受影響', async () => {
  const expires = futureExpires();
  const sent = [];
  const hub = freshHub();
  hub.cdp = {
    send(method, params) {
      sent.push({ method, params });
      return Promise.resolve({});
    },
  };

  // 1) 被人工改寫／其他工具寫入的非法 path（沒有前導斜線）
  hub.cookieVault.set('bad', {
    name: 'sid',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: '.example.test',
    path: 'foo',
    expires,
  });
  // 2) 正常 cookie，確認修法不影響既有行為
  hub.cookieVault.set('good', {
    name: 'sid2',
    value: 'FAKE_VALUE_FOR_TEST',
    domain: 'example.test',
    path: '/app',
    secure: true,
    expires,
  });

  await hub.restoreVaultToBrowser();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'Storage.setCookies');
  const cookies = sent[0].params.cookies;
  assert.equal(cookies.length, 2);

  const bad = cookies.find((c) => c.name === 'sid');
  assert.equal(bad.url, 'http://example.test/', 'path 不合法時必須退回根路徑，不得把 host 串成 example.testfoo');
  assert.equal(bad.path, '/');
  assert.equal(bad.domain, '.example.test');

  const good = cookies.find((c) => c.name === 'sid2');
  assert.equal(good.url, 'https://example.test/app');
  assert.equal(good.path, '/app');
  assert.equal(good.secure, true);
});
