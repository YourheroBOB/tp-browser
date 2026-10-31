// 針對 tools/profile-init.js 的行為測試。
// 重要：整支程式都靠 HOME / USERPROFILE / LOCALAPPDATA / EGO_LINUX_DATA_DIR 決定路徑，
// 因此這裡把上述環境變數全部導到 os.tmpdir()，確保不會讀寫使用者真實 profile。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'tools', 'profile-init.js');

const FAKE_BOOKMARK_A = { name: 'FAKE_BOOKMARK_A', url: 'http://127.0.0.1:8890/a' };
const FAKE_BOOKMARK_B = { name: 'FAKE_BOOKMARK_B', url: 'http://127.0.0.1:8890/b' };

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  return { home, dataDir };
}

function runProfileInit(home, dataDir) {
  const env = { ...process.env };
  delete env.XDG_CONFIG_HOME;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    EGO_LINUX_DATA_DIR: dataDir,
  });
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, env,
  });
  assert.equal(r.status, 0, `profile-init.js 執行失敗：${r.stderr || r.error?.message}`);
  return r;
}

// 依平台回傳「本機 Chrome 使用者資料根目錄」（profile-init.js 會去掃這些路徑）
function chromeBase(home) {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  return join(home, '.config', 'google-chrome');
}

function seedLocalBrowserProfile(home) {
  const profDir = join(chromeBase(home), 'Default');
  mkdirSync(profDir, { recursive: true });
  writeFileSync(join(profDir, 'Bookmarks'), JSON.stringify({
    roots: { bookmark_bar: { children: [FAKE_BOOKMARK_A, FAKE_BOOKMARK_B] }, other: { children: [] } },
  }), 'utf8');
  writeFileSync(join(profDir, 'Login Data'), 'FAKE_VALUE_FOR_TEST'.repeat(256), 'utf8');
  writeFileSync(join(profDir, 'Favicons'), Buffer.alloc(120000, 0x41));
  return profDir;
}

function prefsPathOf(dataDir) {
  return join(dataDir, 'profile-agent', 'Default', 'Preferences');
}

test('全新環境會寫出含書籤列、工作階段還原與 ⚡ TooPower 名稱的 Preferences（可重複執行）', (t) => {
  const { home, dataDir } = sandbox(t);

  runProfileInit(home, dataDir);
  const first = JSON.parse(readFileSync(prefsPathOf(dataDir), 'utf8'));
  assert.equal(first.bookmark_bar.show_on_all_tabs, true);
  assert.equal(first.session.restore_on_startup, 1);
  assert.equal(first.profile.name, '⚡ TooPower');
  assert.equal(first.profile.exit_type, 'Normal');
  assert.equal(first.profile.exited_cleanly, true);
  assert.equal(first.credentials_enable_service, true);

  // 第二次執行必須是 idempotent：名稱不會被改回預設值
  runProfileInit(home, dataDir);
  const second = JSON.parse(readFileSync(prefsPathOf(dataDir), 'utf8'));
  assert.equal(second.profile.name, '⚡ TooPower');
  assert.equal(second.bookmark_bar.show_on_all_tabs, true);
  assert.ok(existsSync(join(dataDir, 'profile-agent', 'Default')), 'Default profile 目錄應存在');
});

test('既有 Preferences 的其他設定會被保留（非破壞性 merge）', (t) => {
  const { home, dataDir } = sandbox(t);
  const prefsPath = prefsPathOf(dataDir);
  mkdirSync(join(dataDir, 'profile-agent', 'Default'), { recursive: true });
  writeFileSync(prefsPath, JSON.stringify({
    bookmark_bar: { show_on_all_tabs: false },
    custom_key: 'FAKE_VALUE_FOR_TEST',
    profile: { name: 'Person 1' },
  }), 'utf8');

  runProfileInit(home, dataDir);
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
  assert.equal(prefs.custom_key, 'FAKE_VALUE_FOR_TEST', '未知的自訂設定不應被丟棄');
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true, '書籤列應被強制打開');
  assert.equal(prefs.profile.name, '⚡ TooPower', '"Person 1" 是預設名稱，應被改寫');
});

test('會從既有本機瀏覽器 profile 匯入書籤、Favicons 與 Login Data', (t) => {
  const { home, dataDir } = sandbox(t);
  const profDir = seedLocalBrowserProfile(home);

  runProfileInit(home, dataDir);

  const dstDefault = join(dataDir, 'profile-agent', 'Default');
  const dstBookmarks = join(dstDefault, 'Bookmarks');
  assert.ok(existsSync(dstBookmarks), '書籤應被匯入');
  assert.equal(readFileSync(dstBookmarks, 'utf8'), readFileSync(join(profDir, 'Bookmarks'), 'utf8'));

  assert.ok(existsSync(join(dstDefault, 'AccountBookmarks')), '現代 Chrome 的 AccountBookmarks 也應一併寫出');

  const dstFavicons = join(dstDefault, 'Favicons');
  assert.ok(existsSync(dstFavicons), 'Favicons DB 應被匯入');
  assert.equal(statSync(dstFavicons).size, statSync(join(profDir, 'Favicons')).size);

  const dstLogin = join(dstDefault, 'Login Data');
  assert.ok(existsSync(dstLogin), 'Login Data 應被匯入');
  assert.equal(statSync(dstLogin).size, statSync(join(profDir, 'Login Data')).size);
});

test('profile-agent 已有較完整資料時不會被覆蓋', (t) => {
  const { home, dataDir } = sandbox(t);
  seedLocalBrowserProfile(home);

  const dstDefault = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(dstDefault, { recursive: true });
  const existingBookmarks = JSON.stringify({
    roots: { bookmark_bar: { children: [{ name: 'FAKE_KEEP_ME' }] }, other: { children: [] } },
  });
  writeFileSync(join(dstDefault, 'Bookmarks'), existingBookmarks, 'utf8');
  writeFileSync(join(dstDefault, 'Favicons'), Buffer.alloc(300000, 0x42));
  const existingLogin = 'FAKE_VALUE_FOR_TEST-KEEP-LOGIN'.repeat(100);
  writeFileSync(join(dstDefault, 'Login Data'), existingLogin, 'utf8');

  runProfileInit(home, dataDir);

  assert.equal(readFileSync(join(dstDefault, 'Bookmarks'), 'utf8'), existingBookmarks, '既有書籤不應被覆蓋');
  assert.equal(statSync(join(dstDefault, 'Favicons')).size, 300000, '既有較大的 Favicons 不應被覆蓋');
  assert.equal(readFileSync(join(dstDefault, 'Login Data'), 'utf8'), existingLogin, '既有 Login Data 不應被覆蓋');
});
