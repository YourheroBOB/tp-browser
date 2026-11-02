// tests/fmb_w14_s15_profile_init_sqlite_sidecars.test.mjs
// 回歸測試：tools/profile-init.js 匯入 SQLite 資料庫（Cookies / Login Data）時，必須把來源端
// 尚未 checkpoint 的 `-wal` 与熱 `-journal` 一起帶過去；同時仍要清掉目的地那些屬於「舊 DB」的
// sidecar，且不得複製 `-shm`（執行期共用記憶體索引）。
// 全程只用假資料（FAKE_VALUE_FOR_TEST 等明顯假字串）與 mkdtempSync(tmpdir())，不連線、不讀寫
// repo 以外的路徑（除了自己的暫存目錄）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w14-s15-profile-init-'));
const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

after(() => rmSync(tempRoot, { recursive: true, force: true }));

// profile-init.js 依 process.platform 決定來源瀏覽器根目錄，測試照同一份對照表建立假 profile。
function sourceRoot(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

const BOOKMARKS = JSON.stringify({
  roots: {
    bookmark_bar: { children: [{ name: 'fake', url: 'https://example.invalid/' }] },
    other: { children: [] },
  },
});

function setupCase(name) {
  const root = join(tempRoot, name);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  const srcRoot = sourceRoot(home);
  const srcDef = join(srcRoot, 'Default');
  mkdirSync(srcDef, { recursive: true });
  mkdirSync(profileDef, { recursive: true });
  // 沒有書籤的 profile 不會被選為來源，所以一定要先放一份有效 Bookmarks。
  writeFileSync(join(srcDef, 'Bookmarks'), BOOKMARKS, 'utf8');
  writeFileSync(
    join(srcRoot, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: 'FAKE_VALUE_FOR_TEST' } }),
    'utf8',
  );
  return { home, dataDir, profileDef, srcRoot, srcDef };
}

function runScript({ home, dataDir }) {
  const res = spawnSync(process.execPath, [script], {
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
  assert.equal(res.status, 0, res.stderr);
  return res;
}

test('profile-init 把來源 Cookie / Login Data 的 -wal 與熱 -journal 一起匯入目的地', () => {
  const c = setupCase('sidecars-copied');

  const srcNetwork = join(c.srcDef, 'Network');
  mkdirSync(srcNetwork, { recursive: true });
  const srcCookies = join(srcNetwork, 'Cookies');
  const bigCookiesDb = Buffer.from(`FAKE_SQLITE_COOKIES\n${'x'.repeat(40000)}`);
  const walPayload = Buffer.from(`FAKE_WAL_FRAMES\n${'w'.repeat(2048)}`);
  writeFileSync(srcCookies, bigCookiesDb);
  writeFileSync(`${srcCookies}-wal`, walPayload);
  writeFileSync(`${srcCookies}-shm`, Buffer.from('FAKE_SHM_INDEX'));

  const srcLogin = join(c.srcDef, 'Login Data');
  const loginDb = Buffer.from(`FAKE_SQLITE_LOGIN_DATA\n${'l'.repeat(4000)}`);
  const journalPayload = Buffer.from(`FAKE_HOT_JOURNAL\n${'j'.repeat(512)}`);
  writeFileSync(srcLogin, loginDb);
  writeFileSync(`${srcLogin}-journal`, journalPayload);

  // 目的地已經有（很小的）Cookies 與屬於「舊 DB」的殘留 -wal，必須被來源端內容取代。
  const dstNetwork = join(c.profileDef, 'Network');
  mkdirSync(dstNetwork, { recursive: true });
  const dstCookies = join(dstNetwork, 'Cookies');
  writeFileSync(dstCookies, Buffer.from('STALE_DESTINATION_DB'));
  writeFileSync(`${dstCookies}-wal`, Buffer.from('STALE_DESTINATION_WAL'));

  runScript(c);

  assert.deepEqual(readFileSync(dstCookies), bigCookiesDb);
  assert.equal(existsSync(`${dstCookies}-wal`), true, '來源端未 checkpoint 的 WAL 必須一起匯入');
  assert.deepEqual(readFileSync(`${dstCookies}-wal`), walPayload);
  assert.equal(existsSync(`${dstCookies}-shm`), false, '-shm 是執行期索引，不應被複製');

  const dstLogin = join(c.profileDef, 'Login Data');
  assert.deepEqual(readFileSync(dstLogin), loginDb);
  assert.equal(existsSync(`${dstLogin}-journal`), true, '熱 journal 必須一起匯入');
  assert.deepEqual(readFileSync(`${dstLogin}-journal`), journalPayload);

  const localState = JSON.parse(
    readFileSync(join(c.dataDir, 'profile-agent', 'Local State'), 'utf8'),
  );
  assert.equal(localState.os_crypt.encrypted_key, 'FAKE_VALUE_FOR_TEST');

  // 來源端檔案不可被本工具改動。
  assert.deepEqual(readFileSync(srcCookies), bigCookiesDb);
  assert.deepEqual(readFileSync(`${srcCookies}-wal`), walPayload);
});

test('來源沒有 sidecar 時，目的地殘留的舊 -wal / -shm 會被清掉', () => {
  const c = setupCase('sidecars-stale-dropped');

  const srcNetwork = join(c.srcDef, 'Network');
  mkdirSync(srcNetwork, { recursive: true });
  const srcCookies = join(srcNetwork, 'Cookies');
  const bigCookiesDb = Buffer.from(`FAKE_SQLITE_COOKIES\n${'x'.repeat(40000)}`);
  writeFileSync(srcCookies, bigCookiesDb);

  const dstNetwork = join(c.profileDef, 'Network');
  mkdirSync(dstNetwork, { recursive: true });
  const dstCookies = join(dstNetwork, 'Cookies');
  writeFileSync(dstCookies, Buffer.from('STALE_DESTINATION_DB'));
  writeFileSync(`${dstCookies}-wal`, Buffer.from('STALE_DESTINATION_WAL'));
  writeFileSync(`${dstCookies}-shm`, Buffer.from('STALE_DESTINATION_SHM'));

  runScript(c);

  assert.deepEqual(readFileSync(dstCookies), bigCookiesDb);
  assert.equal(existsSync(`${dstCookies}-wal`), false, '舊 WAL 不能留在新 DB 旁邊');
  assert.equal(existsSync(`${dstCookies}-shm`), false, '舊 SHM 不能留在新 DB 旁邊');
});
