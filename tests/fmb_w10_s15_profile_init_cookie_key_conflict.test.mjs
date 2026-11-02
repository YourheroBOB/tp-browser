// tests/fmb_w10_s15_profile_init_cookie_key_conflict.test.mjs
// 回歸測試：tools/profile-init.js 在「來源與目的 os_crypt.encrypted_key 不同」時，
// 仍會把來源金鑰寫進 profile-agent/Local State 並覆蓋 Cookies，害已保留在
// profile-agent 的 Login Data / Web Data（用目的金鑰加密）永久無法解密。
// 只用 os.tmpdir() 內的暫存目錄，零網路、零真實憑證（一律 FAKE_*_FOR_TEST）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w10-s15-profile-init-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const SRC_KEY = 'FAKE_SOURCE_KEY_FOR_TEST';
const DST_KEY = 'FAKE_DEST_KEY_FOR_TEST';

// profile-init.js 只在三個平台的預設路徑下尋找本機瀏覽器 profile。
function chromeRoot(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

// 目的端 Cookies 落點：Windows 走 profile-agent/Default/Network/Cookies，其餘走 Default/Cookies。
function dstCookiesPath(profileDef) {
  return process.platform === 'win32'
    ? join(profileDef, 'Network', 'Cookies')
    : join(profileDef, 'Cookies');
}

function makeHome(name) {
  const home = join(tempRoot, name, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

// 造出一個「有書籤 + 大 Cookies + Local State 金鑰」的來源瀏覽器 profile。
function seedSource(home, cookieBytes) {
  const root = chromeRoot(home);
  const profDir = join(root, 'Default');
  mkdirSync(join(profDir, 'Network'), { recursive: true });
  writeFileSync(join(profDir, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: { children: [{ name: 'b1', url: 'https://example.test/' }] },
      other: { children: [] },
    },
  }), 'utf8');
  writeFileSync(join(profDir, 'Network', 'Cookies'), cookieBytes);
  writeFileSync(join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: SRC_KEY } }), 'utf8');
  return profDir;
}

function run(home, dataDir) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      EGO_LINUX_DATA_DIR: dataDir,
    },
  });
}

test('key 衝突時不得覆寫目的 os_crypt 金鑰與 Cookies', () => {
  const home = makeHome('conflict');
  const dataDir = join(tempRoot, 'conflict', 'data');
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(profileDef, { recursive: true });

  const srcCookieBytes = Buffer.alloc(40_000, 0x41);
  seedSource(home, srcCookieBytes);

  const dstCookiePath = dstCookiesPath(profileDef);
  mkdirSync(dirname(dstCookiePath), { recursive: true });
  const dstCookieBytes = Buffer.alloc(200, 0x42);
  writeFileSync(dstCookiePath, dstCookieBytes);

  const localStatePath = join(dataDir, 'profile-agent', 'Local State');
  writeFileSync(localStatePath, JSON.stringify({ os_crypt: { encrypted_key: DST_KEY }, keep_me: 1 }), 'utf8');

  const res = run(home, dataDir);
  assert.equal(res.status, 0, res.stderr);

  // 先確認來源 profile 真的被選中（書籤有同步），否則下面的斷言會空洞通過。
  assert.match(res.stdout, /Synced 1 bookmarks/);
  // 也確認走到「金鑰衝突」分支，而不是因為其他原因沒同步。
  assert.match(res.stdout, /Skipped Cookies sync/);

  const ls = JSON.parse(readFileSync(localStatePath, 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, DST_KEY, '目的金鑰不應被來源金鑰取代');
  assert.equal(ls.keep_me, 1, 'Local State 其他欄位不應遺失');
  assert.deepEqual(readFileSync(dstCookiePath), dstCookieBytes, '既有 Cookies 不應被來源 Cookies 覆蓋');
});

test('目的端完全沒有金鑰時仍會同步 Cookies 與來源 os_crypt', () => {
  const home = makeHome('nokey');
  const dataDir = join(tempRoot, 'nokey', 'data');
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(profileDef, { recursive: true });

  const srcCookieBytes = Buffer.alloc(40_000, 0x41);
  seedSource(home, srcCookieBytes);

  const res = run(home, dataDir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Synced Cookies/);

  assert.deepEqual(readFileSync(dstCookiesPath(profileDef)), srcCookieBytes);
  const ls = JSON.parse(readFileSync(join(dataDir, 'profile-agent', 'Local State'), 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, SRC_KEY);
});

test('兩邊金鑰相同時仍會同步（保護條件不可過度觸發）', () => {
  const home = makeHome('samekey');
  const dataDir = join(tempRoot, 'samekey', 'data');
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(profileDef, { recursive: true });

  const srcCookieBytes = Buffer.alloc(40_000, 0x41);
  seedSource(home, srcCookieBytes);

  const dstCookiePath = dstCookiesPath(profileDef);
  mkdirSync(dirname(dstCookiePath), { recursive: true });
  writeFileSync(dstCookiePath, Buffer.alloc(200, 0x42));
  writeFileSync(join(dataDir, 'profile-agent', 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: SRC_KEY } }), 'utf8');

  const res = run(home, dataDir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Synced Cookies/);

  assert.deepEqual(readFileSync(dstCookiePath), srcCookieBytes);
  const ls = JSON.parse(readFileSync(join(dataDir, 'profile-agent', 'Local State'), 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, SRC_KEY);
});
