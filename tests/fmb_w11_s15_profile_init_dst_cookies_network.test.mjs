// tests/fmb_w11_s15_profile_init_dst_cookies_network.test.mjs
//
// 回歸測試：`tools/profile-init.js` 必須更新「目的 profile 實際使用」的 Cookies 資料庫。
//
// Chromium >= 96 在 Windows／macOS／Linux 三個桌面平台都把 Cookies 放在
// `Default/Network/Cookies`。若目的 profile 已經有那個檔案，舊版仍會把來源 Cookies
// 寫到 `Default/Cookies`：
//   1. 瀏覽器真正讀取的 `Network/Cookies` 永遠不會被更新（登入態匯入形同無效），
//   2. 卻多留一份瀏覽器忽略的舊式副本，而程式還印出「Synced Cookies」。
// 修正後必須改寫 `Network/Cookies`（含清掉屬於舊 DB 的 sidecar），且不憑空產生舊式路徑。
//
// 特性：零外部依賴、零網路、只用 mkdtempSync(tmpdir())，憑證一律用 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w11-s15-profile-init-'));
const FAKE_KEY = 'FAKE_VALUE_FOR_TEST';

after(() => rmSync(tempRoot, { recursive: true, force: true }));

// 與 profile-init.js 相同的來源瀏覽器探測根目錄，讓測試在三平台都能找到假來源 profile。
function sourceChromeRoot(home) {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  return join(home, '.config', 'google-chrome');
}

function makeSourceProfile(home, cookieBytes) {
  const root = sourceChromeRoot(home);
  const def = join(root, 'Default');
  mkdirSync(join(def, 'Network'), { recursive: true });
  writeFileSync(join(def, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: { children: [{ name: 'one', url: 'https://example.test/1' }, { name: 'two', url: 'https://example.test/2' }] },
      other: { children: [] },
    },
  }), 'utf8');
  writeFileSync(join(root, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: FAKE_KEY } }), 'utf8');
  writeFileSync(join(def, 'Network', 'Cookies'), cookieBytes);
  return { root, def };
}

function runScript(home, dataDir) {
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

test('目的 profile 已使用 Default/Network/Cookies：必須更新該檔案並清掉舊 sidecar', () => {
  const home = join(tempRoot, 'home-network');
  const dataDir = join(tempRoot, 'data-network');
  mkdirSync(home);

  const cookieBytes = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'binary'), Buffer.alloc(40_000, 0x41)]);
  assert.ok(cookieBytes.length > 32768);
  makeSourceProfile(home, cookieBytes);

  const profileDef = join(dataDir, 'profile-agent', 'Default');
  const dstNetworkCookies = join(profileDef, 'Network', 'Cookies');
  const dstLegacyCookies = join(profileDef, 'Cookies');
  mkdirSync(join(profileDef, 'Network'), { recursive: true });
  // 目的端真正被 Chromium 讀取的 DB 很小（< 64KB），因此必須被來源覆蓋。
  writeFileSync(dstNetworkCookies, Buffer.alloc(64, 0x42));
  writeFileSync(`${dstNetworkCookies}-wal`, 'stale-sidecar', 'utf8');
  writeFileSync(`${dstNetworkCookies}-journal`, 'stale-sidecar', 'utf8');

  const dstLocalStatePath = join(dataDir, 'profile-agent', 'Local State');
  writeFileSync(dstLocalStatePath, JSON.stringify({ os_crypt: { encrypted_key: FAKE_KEY }, keep_me: 1 }), 'utf8');

  const res = runScript(home, dataDir);
  assert.equal(res.status, 0, res.stderr);

  assert.equal(statSync(dstNetworkCookies).size, cookieBytes.length, 'Network/Cookies 必須被來源覆蓋');
  assert.deepEqual(readFileSync(dstNetworkCookies), cookieBytes);
  // 成功替換後，舊 DB 的 sidecar 已不屬於任何現存資料庫，必須清除。
  assert.equal(existsSync(`${dstNetworkCookies}-wal`), false);
  assert.equal(existsSync(`${dstNetworkCookies}-journal`), false);
  // 不應另外留下瀏覽器忽略的舊式副本。
  assert.equal(existsSync(dstLegacyCookies), false, '不應建立 Default/Cookies 舊式副本');

  // 目的 Local State 取得來源金鑰，且原有其他欄位不得被丟掉。
  const ls = JSON.parse(readFileSync(dstLocalStatePath, 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, FAKE_KEY);
  assert.equal(ls.keep_me, 1);
});

test('目的 profile 只有舊式 Default/Cookies：仍更新舊路徑，且不憑空建立 Network 目錄', () => {
  const home = join(tempRoot, 'home-legacy');
  const dataDir = join(tempRoot, 'data-legacy');
  mkdirSync(home);

  const cookieBytes = Buffer.alloc(33_000, 0x43);
  assert.ok(cookieBytes.length > 32768);
  makeSourceProfile(home, cookieBytes);

  const profileDef = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(profileDef, { recursive: true });
  const legacyCookies = join(profileDef, 'Cookies');
  writeFileSync(legacyCookies, Buffer.alloc(100, 0x44));

  const res = runScript(home, dataDir);
  assert.equal(res.status, 0, res.stderr);

  assert.deepEqual(readFileSync(legacyCookies), cookieBytes);
  assert.equal(existsSync(join(profileDef, 'Network')), false, '舊式 profile 不應被硬塞 Network 目錄');
});
