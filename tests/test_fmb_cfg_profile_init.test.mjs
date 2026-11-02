// tests/test_fmb_cfg_profile_init.test.mjs
//
// 目的：鎖定 tp-browser 的「設定載入」面——環境變數解析、預設值、以及壞掉的設定檔如何處理。
// 測試對象：tools/profile-init.js（在本次可取得的內容中，唯一能安全驅動的設定初始化程式）。
//
// 邊界（刻意設計，勿放寬）：
//   1. 只在 mkdtempSync(tmpdir()) 內建立假的 HOME／資料根目錄；不讀真實使用者設定或瀏覽器資料。
//   2. 不連線任何網路服務；子程序只執行 repo 內的 node 腳本。
//   3. 不測 bookmark／favicon／cookie 等「資料同步」行為（既有 tests/test_fmb_profile_init.test.mjs 已涵蓋），
//      本檔只測設定層：EGO_LINUX_DATA_DIR、預設資料根目錄、Preferences 預設鍵、損壞的設定檔。
//   4. 所有測試資料都是明顯假值，不含任何真實憑證、金鑰或個資；如需假憑證一律用 FAKE_VALUE_FOR_TEST。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE_INIT = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

// profile-init.js 在資料根目錄下固定使用 <dataDir>/profile-agent/Default/Preferences
const PREFS_SEGMENTS = ['profile-agent', 'Default', 'Preferences'];

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失敗 */ }
  }
});

function newSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'fmb-cfg-profile-init-'));
  sandboxes.push(root);
  return {
    root,
    home: join(root, 'home'),
    data: join(root, 'data'),
  };
}

function prefsPathIn(dataDir) {
  return join(dataDir, ...PREFS_SEGMENTS);
}

function seedPreferences(dataDir, value) {
  const file = prefsPathIn(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

function readPreferences(dataDir) {
  return JSON.parse(readFileSync(prefsPathIn(dataDir), 'utf8'));
}

// 以「沙箱化的 HOME」執行 profile-init.js。
// 重點：把 HOME／USERPROFILE／LOCALAPPDATA／APPDATA 全部導向暫存目錄，
// 讓腳本探索本機瀏覽器 profile 時不會碰到 repo 以外的真實路徑。
// dataDir 傳 undefined = 不設定 EGO_LINUX_DATA_DIR；傳字串（含空字串）= 設定該值。
function runProfileInit(box, { dataDir } = {}) {
  const env = {
    ...process.env,
    HOME: box.home,
    USERPROFILE: box.home,
    LOCALAPPDATA: join(box.home, 'AppData', 'Local'),
    APPDATA: join(box.home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(box.home, '.config'),
  };
  delete env.EGO_LINUX_DATA_DIR;
  if (typeof dataDir === 'string') env.EGO_LINUX_DATA_DIR = dataDir;
  return spawnSync(process.execPath, [PROFILE_INIT], {
    cwd: box.root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('環境變數：未設定 EGO_LINUX_DATA_DIR 時，資料根目錄預設為 $HOME/.local/share/ego-linux', () => {
  const box = newSandbox();
  const res = runProfileInit(box);
  assert.equal(res.status, 0, `profile-init 應成功結束，stderr=${res.stderr}`);

  const defaultRoot = join(box.home, '.local', 'share', 'ego-linux');
  assert.ok(existsSync(prefsPathIn(defaultRoot)), `應在預設路徑建立 Preferences：${prefsPathIn(defaultRoot)}`);
  assert.ok(!existsSync(join(box.data, 'profile-agent')), '不應寫入未被指定的資料根目錄');
});

test('環境變數：EGO_LINUX_DATA_DIR 為空字串時視同未設定（沿用預設值）', () => {
  const box = newSandbox();
  const res = runProfileInit(box, { dataDir: '' });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);

  const defaultRoot = join(box.home, '.local', 'share', 'ego-linux');
  assert.ok(existsSync(prefsPathIn(defaultRoot)), '空字串應 fallback 回預設資料根目錄');
});

test('環境變數：EGO_LINUX_DATA_DIR 會覆寫預設資料根目錄', () => {
  const box = newSandbox();
  const res = runProfileInit(box, { dataDir: box.data });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);

  assert.ok(existsSync(prefsPathIn(box.data)), '應在指定的資料根目錄建立 Preferences');
  assert.ok(
    !existsSync(join(box.home, '.local', 'share', 'ego-linux', 'profile-agent')),
    '覆寫生效時不應同時寫入預設資料根目錄',
  );
});

test('預設值：Preferences 會寫入 bookmark bar／session restore／profile 狀態標記', () => {
  const box = newSandbox();
  const res = runProfileInit(box, { dataDir: box.data });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);

  const prefs = readPreferences(box.data);
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true, '書籤列應強制在所有分頁顯示');
  assert.equal(prefs.session.restore_on_startup, 1, '應啟用工作階段還原');
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.credentials_enable_service, true);
  assert.equal(prefs.credentials_enable_autosignin, true);
  assert.ok(
    typeof prefs.profile.name === 'string' && prefs.profile.name.length > 0,
    'profile.name 應被填入非空值',
  );
});

test('既有設定：未知鍵保留、bookmark_bar 被強制開啟、自訂 profile.name 不被覆蓋', () => {
  const box = newSandbox();
  seedPreferences(box.data, {
    FAKE_UNKNOWN_SETTING: { keep: 'FAKE_VALUE_FOR_TEST' },
    bookmark_bar: { show_on_all_tabs: false },
    profile: { name: '我的測試設定檔' },
  });

  const res = runProfileInit(box, { dataDir: box.data });
  assert.equal(res.status, 0, `stderr=${res.stderr}`);

  const prefs = readPreferences(box.data);
  assert.deepEqual(prefs.FAKE_UNKNOWN_SETTING, { keep: 'FAKE_VALUE_FOR_TEST' }, '不應清掉不認得的設定鍵');
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true, '應覆寫成 true');
  assert.equal(prefs.profile.name, '我的測試設定檔', '使用者自訂的 profile 名稱不應被改寫');
  assert.equal(prefs.session.restore_on_startup, 1, '缺少的預設鍵應被補上');
});

test('預設值：profile.name 為 Person 1 或 第一位使用者 時會被改名為內建品牌名稱', () => {
  for (const original of ['Person 1', '第一位使用者']) {
    const box = newSandbox();
    seedPreferences(box.data, { profile: { name: original } });

    const res = runProfileInit(box, { dataDir: box.data });
    assert.equal(res.status, 0, `stderr=${res.stderr}`);

    const name = readPreferences(box.data).profile.name;
    assert.notEqual(name, original, `預設名稱「${original}」應被視為未設定而改寫`);
    assert.match(String(name), /TooPower$/, '改寫後應為內建品牌名稱');
  }
});

test('錯誤設定：Preferences 為非法 JSON 時會被重建為合法預設值，且程式不失敗', () => {
  const box = newSandbox();
  seedPreferences(box.data, '{ 這不是合法 JSON ,,,');

  const res = runProfileInit(box, { dataDir: box.data });
  assert.equal(res.status, 0, `壞掉的設定檔不應讓程式失敗，stderr=${res.stderr}`);

  const prefs = readPreferences(box.data);
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(prefs.profile.exited_cleanly, true);
});

test('冪等性：重複執行不改變既有自訂值，也不失敗', () => {
  const box = newSandbox();
  seedPreferences(box.data, { profile: { name: '重複執行測試' }, FAKE_COUNTER: 1 });

  const first = runProfileInit(box, { dataDir: box.data });
  assert.equal(first.status, 0, `第一次執行失敗，stderr=${first.stderr}`);
  const firstPrefs = readPreferences(box.data);

  const second = runProfileInit(box, { dataDir: box.data });
  assert.equal(second.status, 0, `第二次執行失敗，stderr=${second.stderr}`);
  const secondPrefs = readPreferences(box.data);

  assert.deepEqual(secondPrefs, firstPrefs, '重複初始化後的設定內容應完全相同');
  assert.equal(secondPrefs.profile.name, '重複執行測試');
});

test('錯誤設定：Preferences 為合法 JSON 的 null 時，視同空物件並重建為合法預設值', () => {
  // JSON.parse('null') === null。空值應視同空物件，走預設重建路徑，不得非零退出。
  const box = newSandbox();
  seedPreferences(box.data, 'null');

  const res = runProfileInit(box, { dataDir: box.data });
  assert.equal(res.status, 0, `null 應視同空物件，stderr=${res.stderr}`);

  const prefs = readPreferences(box.data);
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(prefs.profile.exited_cleanly, true);
});
