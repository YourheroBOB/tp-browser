// tests/test_fmb_cfg_env.test.mjs
// tp-browser：設定載入／環境變數／預設值／錯誤設定處理的測試。
//
// 隔離邊界（本檔所有副作用都落在 mkdtempSync(tmpdir()) 之內）：
//   1. 執行 tools/profile-init.js 時，一律把 HOME、USERPROFILE、LOCALAPPDATA、
//      EGO_LINUX_DATA_DIR 指向暫存目錄，模組「看到」的使用者家目錄因此完全隔離，
//      不會讀寫真實瀏覽器設定、Cookie 或任何個資。
//   2. 不建立任何含真實書籤／登入資料的 fixture；假值一律使用
//      "FAKE_VALUE_FOR_TEST" 這種明顯假字串。
//   3. 不連線任何服務（profile-init.js 本身沒有網路 I/O），也不啟動 daemon。
//   4. 若執行環境不允許以環境變數覆寫 os.homedir()，相關測試會 skip，
//      絕不退回真實家目錄。
//
// 與既有測試的區隔：
//   - tests/test_fmb_profile_init.test.mjs 已涵蓋書籤／Favicons 等 profile 資料搬移；
//     本檔不重複該部分，只驗證「Preferences 設定載入、預設值、env 覆寫與壞設定處理」。
//   - 亦不重複 tests/test_fmb_{cdp,keys,store}.test.mjs、tests/fmb_integration_cli.test.mjs
//     與 fmb_feature2/ 的測試。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROFILE_INIT = join(REPO_ROOT, 'tools', 'profile-init.js');
const PKG_PATH = join(REPO_ROOT, 'package.json');

const BRAND_PROFILE_NAME = '⚡ TooPower';
const FAKE = 'FAKE_VALUE_FOR_TEST';

// ---------------------------------------------------------------- helpers

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'tp-fmb-cfg-'));
  const home = join(root, 'home');
  const localAppData = join(root, 'localappdata');
  mkdirSync(home, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, localAppData };
}

function buildEnv({ home, localAppData, extra = {} }) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
  };
  for (const key of ['SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function defaultDataDir(home) {
  return join(home, '.local', 'share', 'ego-linux');
}

function profileDir(dataDir) {
  return join(dataDir, 'profile-agent', 'Default');
}

function prefsPath(dataDir) {
  return join(profileDir(dataDir), 'Preferences');
}

function seedPrefs(dataDir, content) {
  const file = prefsPath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return file;
}

function runProfileInit(env, args = []) {
  return spawnSync(process.execPath, [PROFILE_INIT, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// 依 process.platform 組出來源瀏覽器 profile 路徑（僅在沙盒內使用）。
function browserSourceProfileDir({ home, localAppData }) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
  }
  if (process.platform === 'win32') {
    return join(localAppData, 'Google', 'Chrome', 'User Data', 'Default');
  }
  return join(home, '.config', 'google-chrome', 'Default');
}

let homeOverrideVerdict = null;
function canOverrideHome(sandbox) {
  if (homeOverrideVerdict !== null) return homeOverrideVerdict;
  const probe = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(require("node:os").homedir())'],
    { env: buildEnv(sandbox), encoding: 'utf8', timeout: 30_000 },
  );
  homeOverrideVerdict = probe.status === 0 && String(probe.stdout ?? '').trim() === sandbox.home;
  return homeOverrideVerdict;
}

// 回傳 true 代表可以安全執行；false 代表已 skip（不可退回真實家目錄）。
function requireSandboxHome(t, sandbox) {
  if (canOverrideHome(sandbox)) return true;
  t.skip('此執行環境無法以環境變數覆寫 os.homedir()，為避免碰觸真實使用者設定而跳過');
  return false;
}

// ------------------------------------------------- 資料目錄與預設設定載入

test('profile-init：未設定 EGO_LINUX_DATA_DIR 時採用預設資料目錄並寫入預設設定', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const res = runProfileInit(buildEnv(sandbox));
  assert.equal(res.status, 0, `profile-init 應成功結束：${res.stderr}`);

  const dataDir = defaultDataDir(sandbox.home);
  const file = prefsPath(dataDir);
  assert.ok(existsSync(file), `應在預設路徑建立 ${file}`);

  const prefs = readJsonFile(file);
  assert.deepEqual(prefs.bookmark_bar, { show_on_all_tabs: true });
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.profile.name, BRAND_PROFILE_NAME);
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.credentials_enable_service, true);
  assert.equal(prefs.credentials_enable_autosignin, true);

  // 沙盒內沒有任何瀏覽器來源資料：不應宣稱同步、也不應生出書籤檔
  assert.doesNotMatch(res.stdout, /Synced/);
  assert.equal(existsSync(join(profileDir(dataDir), 'Bookmarks')), false);
  assert.equal(existsSync(join(profileDir(dataDir), 'AccountBookmarks')), false);
});

test('profile-init：EGO_LINUX_DATA_DIR 會覆寫資料目錄，且不再建立預設家目錄路徑', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const customDataDir = join(sandbox.root, 'custom-data-dir'); // 故意不存在：驗證 recursive 建立
  const res = runProfileInit(
    buildEnv({ ...sandbox, extra: { EGO_LINUX_DATA_DIR: customDataDir } }),
  );
  assert.equal(res.status, 0, res.stderr);

  const file = prefsPath(customDataDir);
  assert.ok(existsSync(file), `應在 EGO_LINUX_DATA_DIR 之下建立 ${file}`);
  assert.equal(readJsonFile(file).bookmark_bar.show_on_all_tabs, true);
  assert.equal(
    existsSync(defaultDataDir(sandbox.home)),
    false,
    '一旦覆寫資料目錄，就不應再碰預設家目錄路徑',
  );
});

test('profile-init：既有設定與預設值合併，自訂值保留、強制值覆寫', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const dataDir = defaultDataDir(sandbox.home);
  const file = seedPrefs(dataDir, {
    bookmark_bar: { show_on_all_tabs: false, custom_bar_flag: FAKE },
    session: { restore_on_startup: 5 },
    profile: { name: '我的研究設定檔' },
    custom_top_level: FAKE,
  });

  const res = runProfileInit(buildEnv(sandbox));
  assert.equal(res.status, 0, res.stderr);

  const prefs = readJsonFile(file);
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true, '書籤列應被強制開啟');
  assert.equal(prefs.bookmark_bar.custom_bar_flag, FAKE, '既有子欄位應被保留');
  assert.equal(prefs.session.restore_on_startup, 1, 'session 預設值應被強制覆寫為 1');
  assert.equal(prefs.profile.name, '我的研究設定檔', '自訂 profile 名稱不應被覆蓋');
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.custom_top_level, FAKE, '未知的自訂欄位應原樣保留');
});

test('profile-init：預設 profile 名稱會被換成品牌名稱，自訂名稱則保留', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const cases = [
    { input: 'Person 1', expected: BRAND_PROFILE_NAME },
    { input: '第一位使用者', expected: BRAND_PROFILE_NAME },
    { input: '', expected: BRAND_PROFILE_NAME },
    { input: '我的工作設定檔', expected: '我的工作設定檔' },
  ];

  cases.forEach((testCase, index) => {
    const dataDir = join(sandbox.root, `name-case-${index}`);
    const file = seedPrefs(dataDir, { profile: { name: testCase.input } });
    const res = runProfileInit(
      buildEnv({ ...sandbox, extra: { EGO_LINUX_DATA_DIR: dataDir } }),
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readJsonFile(file).profile.name,
      testCase.expected,
      `profile.name 輸入為 ${JSON.stringify(testCase.input)} 時的預設值`,
    );
  });
});

test('profile-init：重複執行為冪等，設定內容不變', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const dataDir = defaultDataDir(sandbox.home);
  const env = buildEnv(sandbox);

  assert.equal(runProfileInit(env).status, 0);
  const first = readJsonFile(prefsPath(dataDir));
  assert.equal(runProfileInit(env).status, 0);
  const second = readJsonFile(prefsPath(dataDir));

  assert.deepEqual(second, first);
});

// ------------------------------------------------------- 錯誤設定處理

test('profile-init：Preferences 是無效 JSON 時不失敗，並回復為預設值', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const dataDir = defaultDataDir(sandbox.home);
  const file = seedPrefs(
    dataDir,
    `{ "bookmark_bar": { "show_on_all_tabs": true },,, "${FAKE}" }`,
  );

  const res = runProfileInit(buildEnv(sandbox));
  assert.equal(res.status, 0, `無效 JSON 不應讓程式失敗：${res.stderr}`);

  const prefs = readJsonFile(file);
  assert.deepEqual(prefs.bookmark_bar, { show_on_all_tabs: true });
  assert.equal(prefs.profile.name, BRAND_PROFILE_NAME);
  assert.doesNotMatch(
    readFileSync(file, 'utf8'),
    /FAKE_VALUE_FOR_TEST/,
    '損壞的設定內容不應被原樣保留下來',
  );
});

test('profile-init：Preferences 頂層是 JSON 陣列時不拋錯，並回復為預設值', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const dataDir = defaultDataDir(sandbox.home);
  const file = seedPrefs(dataDir, '[]');

  const res = runProfileInit(buildEnv(sandbox));
  assert.equal(res.status, 0, `頂層陣列不應讓程式失敗：${res.stderr}`);

  const prefs = readJsonFile(file);
  assert.equal(Array.isArray(prefs), false, '頂層陣列應被轉成物件後再套用預設值');
  assert.deepEqual(prefs.bookmark_bar, { show_on_all_tabs: true });
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.profile.name, BRAND_PROFILE_NAME);
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.credentials_enable_service, true);
  assert.equal(prefs.credentials_enable_autosignin, true);
});

test('profile-init：Preferences 內容是 JSON null 時不失敗，並回復為預設值', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const dataDir = defaultDataDir(sandbox.home);
  const file = seedPrefs(dataDir, 'null');

  const res = runProfileInit(buildEnv(sandbox));
  assert.equal(res.status, 0, `頂層 JSON null 不應讓程式失敗：${res.stderr}`);

  const prefs = readJsonFile(file);
  assert.deepEqual(prefs.bookmark_bar, { show_on_all_tabs: true });
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.profile.name, BRAND_PROFILE_NAME);
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.credentials_enable_service, true);
  assert.equal(prefs.credentials_enable_autosignin, true);
  assert.doesNotMatch(
    readFileSync(file, 'utf8').trim(),
    /^null$/,
    '損壞的 null 設定不應被原樣保留下來',
  );
});

test('profile-init：來源 Bookmarks 是無效 JSON 時被安全忽略，不會同步任何書籤', (t) => {
  const sandbox = makeSandbox(t);
  if (!requireSandboxHome(t, sandbox)) return;

  const srcProfile = browserSourceProfileDir(sandbox);
  mkdirSync(srcProfile, { recursive: true });
  writeFileSync(join(srcProfile, 'Bookmarks'), `{ "roots": ${FAKE} }`, 'utf8');

  const res = runProfileInit(buildEnv(sandbox));
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /Synced/);
  assert.equal(
    existsSync(join(profileDir(defaultDataDir(sandbox.home)), 'Bookmarks')),
    false,
    '來源書籤檔壞掉時不應產生半套結果',
  );
});

// --------------------------------------------------- 其他設定檔契約檢查

test('package.json：設定可載入，關鍵預設值（ESM、Node 版本、零依賴、bin 目標）正確', () => {
  const pkg = readJsonFile(PKG_PATH);

  assert.equal(pkg.name, 'tp-browser');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=22');
  assert.equal(pkg.license, 'Apache-2.0');

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[field], undefined, `${field} 不應存在：本專案標榜 0 npm 依賴`);
  }

  assert.ok(pkg.bin && typeof pkg.bin === 'object');
  assert.ok(Object.keys(pkg.bin).length >= 2, '應同時提供 tp-browser 與 ego-browser 相容別名');
  for (const [name, relPath] of Object.entries(pkg.bin)) {
    assert.ok(
      existsSync(join(REPO_ROOT, relPath)),
      `bin "${name}" 指向的檔案必須存在：${relPath}`,
    );
  }

  const license = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8');
  assert.ok(license.includes('Apache License'));
  assert.ok(license.includes('Version 2.0'));
});

test('systemd 設定：瀏覽器服務預設只綁 loopback、使用 9773 與共用 profile-agent', () => {
  const chromeUnit = readFileSync(join(REPO_ROOT, 'scripts', 'ego-linux-chrome.service'), 'utf8');
  assert.ok(chromeUnit.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(chromeUnit.includes('--remote-debugging-port=9773'));
  assert.ok(chromeUnit.includes('--user-data-dir=%h/.local/share/ego-linux/profile-agent'));
  assert.ok(chromeUnit.includes('--headless=new'));
  assert.ok(chromeUnit.includes('Restart=on-failure'));

  const daemonUnit = readFileSync(join(REPO_ROOT, 'scripts', 'ego-linux-browserd.service'), 'utf8');
  assert.ok(daemonUnit.includes('After=ego-linux-chrome.service'));
  assert.ok(daemonUnit.includes('daemon/ego-browserd.js'));
  assert.ok(daemonUnit.includes('Restart=on-failure'));
});

test('tp-start.sh：預設埠 9772/9773、--alt-port 為 9774/9775，且支援 TP_BROWSER_BIN 覆寫', () => {
  const sh = readFileSync(join(REPO_ROOT, 'scripts', 'tp-start.sh'), 'utf8');

  assert.ok(sh.includes('DAEMON_PORT=9772'));
  assert.ok(sh.includes('CHROME_PORT=9773'));
  assert.ok(sh.includes('DAEMON_PORT=9774'));
  assert.ok(sh.includes('CHROME_PORT=9775'));
  assert.ok(sh.includes('BROWSER_BIN="${TP_BROWSER_BIN:-}"'), '應支援以 TP_BROWSER_BIN 覆寫瀏覽器執行檔');
  assert.ok(sh.includes('chmod 700 "$DATA_DIR"'), '資料根目錄預設權限應為 0700');
  assert.ok(sh.includes('--remote-debugging-address=127.0.0.1'));
});
