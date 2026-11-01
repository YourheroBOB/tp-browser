// tests/fmb_w6_s08_profile_init_sidecar_rollback.test.mjs
// tools/profile-init.js 在換 Cookies／Favicons／Login Data 時，SQLite sidecar
// （-journal／-wal／-shm）必須在換檔「成功之後」才刪除。
// 換檔失敗時：舊 DB、其 sidecar 與 Local State 都必須原封不動（Local State 逐位元組還原）。
// 換檔成功時：sidecar 才被移除。
// 零依賴、零網路：HOME／EGO_LINUX_DATA_DIR 全部指到 mkdtempSync(tmpdir()) 之下，
// 憑證一律使用 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
// win32 的 Cookies 目的端在 Default/Network 底下，且 rename 語意不同，本測試不涵蓋。
const skip = process.platform === 'win32' ? 'profile-init uses Default/Network/Cookies on win32' : false;

const SOURCE_COOKIES = Buffer.alloc(40000, 0x43); // 需要 > 32 KB 才會觸發 Cookies 同步
const SOURCE_FAVICONS = Buffer.alloc(4096, 0x46);
const SOURCE_LOGIN_DATA = Buffer.alloc(20000, 0x4c);
const OLD_LOCAL_STATE = Buffer.from('{"old":"ORIGINAL_LOCAL_STATE"}', 'utf8');

const created = [];

function sourceBrowserRoot(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return join(home, '.config', 'google-chrome');
}

// 建立一份「來源瀏覽器」與一份「目的 profile」，全部落在暫存目錄內。
function makeFixture(label) {
  const root = mkdtempSync(join(tmpdir(), `fmb-w6-s08-${label}-`));
  created.push(root);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const profileRoot = join(dataDir, 'profile-agent');
  const profileDef = join(profileRoot, 'Default');
  mkdirSync(profileDef, { recursive: true });
  mkdirSync(home, { recursive: true });

  const base = sourceBrowserRoot(home);
  const srcProf = join(base, 'Default');
  mkdirSync(srcProf, { recursive: true });
  writeFileSync(join(srcProf, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: { children: [{ name: 'one' }, { name: 'two' }] },
      other: { children: [] },
    },
  }), 'utf8');
  writeFileSync(join(srcProf, 'Cookies'), SOURCE_COOKIES);
  writeFileSync(join(srcProf, 'Favicons'), SOURCE_FAVICONS);
  writeFileSync(join(srcProf, 'Login Data'), SOURCE_LOGIN_DATA);
  writeFileSync(join(base, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: 'FAKE_VALUE_FOR_TEST' },
  }), 'utf8');

  // 目的端：舊的 Local State 與舊 Cookies DB 的三個 sidecar。
  writeFileSync(join(profileRoot, 'Local State'), OLD_LOCAL_STATE);
  for (const ext of ['-wal', '-journal', '-shm']) {
    writeFileSync(join(profileDef, `Cookies${ext}`), 'OLD', 'utf8');
  }

  return { root, home, dataDir, profileRoot, profileDef };
}

function run(home, dataDir) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      EGO_LINUX_DATA_DIR: dataDir,
    },
  });
}

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

test('換 Cookies 失敗時：-wal／-journal／-shm 內容仍是 OLD，Local State 逐位元組相同', { skip }, () => {
  const fx = makeFixture('fail');

  // 目的端 Cookies／Favicons／Login Data 都是「非空目錄」→ renameSync(tmp, dst) 必定失敗。
  for (const name of ['Cookies', 'Favicons', 'Login Data']) {
    mkdirSync(join(fx.profileDef, name));
    writeFileSync(join(fx.profileDef, name, 'blocker'), 'x', 'utf8');
  }
  writeFileSync(join(fx.profileDef, 'Favicons-wal'), 'OLD', 'utf8');
  writeFileSync(join(fx.profileDef, 'Login Data-journal'), 'OLD', 'utf8');

  const res = run(fx.home, fx.dataDir);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  for (const ext of ['-wal', '-journal', '-shm']) {
    assert.equal(readFileSync(join(fx.profileDef, `Cookies${ext}`), 'utf8'), 'OLD', `Cookies${ext}`);
  }
  assert.equal(readFileSync(join(fx.profileDef, 'Favicons-wal'), 'utf8'), 'OLD');
  assert.equal(readFileSync(join(fx.profileDef, 'Login Data-journal'), 'utf8'), 'OLD');

  // 回滾必須是逐位元組相同（不是重新序列化）。
  assert.deepEqual(readFileSync(join(fx.profileRoot, 'Local State')), OLD_LOCAL_STATE);

  // 暫存檔不得殘留。
  assert.equal(existsSync(join(fx.profileDef, 'Cookies.fmb-sync-tmp')), false);
  assert.equal(existsSync(join(fx.profileDef, 'Favicons.fmb-sync-tmp')), false);
  assert.equal(existsSync(join(fx.profileDef, 'Login Data.fmb-sync-tmp')), false);
  assert.equal(existsSync(join(fx.profileRoot, 'Local State.fmb-sync-tmp')), false);
});

test('換 Cookies 成功時：sidecar 才被移除，Local State 併入 os_crypt 並保留原有欄位', { skip }, () => {
  const fx = makeFixture('ok');
  writeFileSync(join(fx.profileDef, 'Cookies'), Buffer.alloc(128, 0x44), );

  const res = run(fx.home, fx.dataDir);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  assert.deepEqual(readFileSync(join(fx.profileDef, 'Cookies')), SOURCE_COOKIES);
  for (const ext of ['-wal', '-journal', '-shm']) {
    assert.equal(existsSync(join(fx.profileDef, `Cookies${ext}`)), false, `Cookies${ext} should be gone`);
  }
  assert.equal(existsSync(join(fx.profileDef, 'Cookies.fmb-sync-tmp')), false);

  const ls = JSON.parse(readFileSync(join(fx.profileRoot, 'Local State'), 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, 'FAKE_VALUE_FOR_TEST');
  assert.equal(ls.old, 'ORIGINAL_LOCAL_STATE');
});
