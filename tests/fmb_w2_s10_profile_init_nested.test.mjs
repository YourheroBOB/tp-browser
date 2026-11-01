// tests/fmb_w2_s10_profile_init_nested.test.mjs
// 重現並鎖定 tools/profile-init.js 的巢狀設定 bug：
//   1) bookmark_bar / session / profile 是陣列時，typeof [] === 'object'，程式於陣列上設屬性，
//      JSON.stringify 會把這些屬性丟掉 → show_on_all_tabs / restore_on_startup / exit_type 全部消失。
//   2) profile.name 是數字（例如 123）時被原樣保留，Chromium 不認得非字串名稱。
// 以子程序執行（env 全部指向暫存目錄），讀回 Preferences 後斷言。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w2-s10-profile-init-'));
const home = join(tempRoot, 'empty-home');
const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const DEFAULT_NAME = '⚡ TooPower';

mkdirSync(home);
after(() => rmSync(tempRoot, { recursive: true, force: true }));

// HOME／資料目錄全部落在暫存目錄，因此本機瀏覽器 profile 探索找不到任何候選項目。
function runInit(dataDir) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, '.config'),
      EGO_LINUX_DATA_DIR: dataDir,
    },
  });
}

function writePreferences(dataDir, value) {
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(profileDef, { recursive: true });
  const file = join(profileDef, 'Preferences');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}

function runAndRead(dataDir, initial) {
  const file = writePreferences(dataDir, initial);
  const res = runInit(dataDir);
  assert.equal(res.status, 0, `${JSON.stringify(initial)} → ${res.stderr}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('profile-init：陣列形式的巢狀欄位會重建為 plain object，設定不再被 JSON 吞掉', () => {
  const prefs = runAndRead(join(tempRoot, 'data-arrays'), {
    bookmark_bar: [],
    session: [1],
    profile: [],
  });

  for (const key of ['bookmark_bar', 'session', 'profile']) {
    assert.ok(prefs[key] !== null && typeof prefs[key] === 'object', `${key} 應為物件`);
    assert.equal(Array.isArray(prefs[key]), false, `${key} 不應是陣列`);
  }
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.profile.name, DEFAULT_NAME);
});

test('profile-init：null／字串／數字／布林形式的巢狀欄位同樣會重建', () => {
  const prefs = runAndRead(join(tempRoot, 'data-scalars'), {
    bookmark_bar: null,
    session: 'restore',
    profile: 0,
  });

  assert.equal(Array.isArray(prefs.bookmark_bar), false);
  assert.equal(Array.isArray(prefs.session), false);
  assert.equal(Array.isArray(prefs.profile), false);
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.name, DEFAULT_NAME);
});

test('profile-init：profile.name 不是非空字串時改成預設名稱', () => {
  const cases = [
    ['number', 123],
    ['empty-string', ''],
    ['whitespace-string', '   '],
    ['placeholder', 'Person 1'],
    ['object', { first: 'A' }],
    ['null', null],
    ['boolean', true],
  ];
  for (const [tag, name] of cases) {
    const prefs = runAndRead(join(tempRoot, `data-name-${tag}`), { profile: { name, avatar_index: 3 } });
    assert.equal(prefs.profile.name, DEFAULT_NAME, `profile.name=${tag}`);
    assert.equal(prefs.profile.avatar_index, 3, `profile.name=${tag} 應保留其他鍵`);
  }
});

test('profile-init：合法巢狀物件與其他既有鍵都會被保留', () => {
  const original = {
    bookmark_bar: { show_on_all_tabs: false, custom_bookmark_metric: 12 },
    session: { restore_on_startup: 5, startup_urls: ['https://example.test/'] },
    profile: { name: 'Alice', avatar_index: 7 },
    some_other_section: { nested: { deep: true }, list: [1, 2, 3] },
    credentials_enable_service: false,
  };
  const prefs = runAndRead(join(tempRoot, 'data-valid'), original);

  // 強制套用的值
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.credentials_enable_service, true);

  // 既有的其他鍵必須原封不動
  assert.equal(prefs.bookmark_bar.custom_bookmark_metric, 12);
  assert.deepEqual(prefs.session.startup_urls, ['https://example.test/']);
  assert.equal(prefs.profile.name, 'Alice');
  assert.equal(prefs.profile.avatar_index, 7);
  assert.deepEqual(prefs.some_other_section, original.some_other_section);
});
