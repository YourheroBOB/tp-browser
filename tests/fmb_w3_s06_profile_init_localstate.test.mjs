// tests/fmb_w3_s06_profile_init_localstate.test.mjs
// 回歸測試（w3 / s06）：tools/profile-init.js 同步 Cookies 時的金鑰一致性。
//
// 失敗模式（修正前）：
//   1. 目的端 profile-agent/Local State 是合法 JSON 但值為 null → `dstLs.os_crypt = ...`
//      丟 TypeError，被外層 catch 吞掉；Cookies 已被 copyFileSync 覆蓋，os_crypt 沒寫入。
//   2. 目的端值為 [] → os_crypt 掛在陣列上，JSON.stringify 時被丟棄，結果同上。
//   3. 來源端 Local State 為 null → 同樣是 Cookies 已覆蓋、os_crypt 沒寫入。
//   以上都會讓目的端 Cookies 用來源金鑰加密卻沒有對應金鑰（登入態永久損毀），
//   而且目的端 Cookies ≥ 64KB 之後就不再重試。
//
// 零依賴、零網路：HOME／USERPROFILE／LOCALAPPDATA／EGO_LINUX_DATA_DIR 全部指到
// mkdtempSync(tmpdir()) 底下的暫存目錄；金鑰只用明顯假值 'K'。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w3-s06-profile-init-'));
const scriptPath = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

const SOURCE_COOKIE_BYTES = 40960; // > 32768：來源 Cookies 的同步門檻
const OLD_DST_COOKIES = 'D'.repeat(1024); // < 65536：目的端「還沒同步過」的大小
const SOURCE_OS_CRYPT = JSON.stringify({ os_crypt: { encrypted_key: 'K' } });

after(() => rmSync(tempRoot, { recursive: true, force: true }));

// 與 tools/profile-init.js 的判斷保持一致（Windows 走 Default/Network/Cookies）。
const dstCookiesPath = (profileDef) =>
  join(process.platform === 'win32' ? join(profileDef, 'Network') : profileDef, 'Cookies');

// 三平台的瀏覽器根目錄都建立同一份來源 profile，測試結果不受執行平台影響。
function seedSourceProfile(home, localStateJson) {
  const roots = [
    join(home, '.config', 'google-chrome'),
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  ];
  for (const root of roots) {
    const profDir = join(root, 'Default');
    mkdirSync(join(profDir, 'Network'), { recursive: true });
    writeFileSync(join(profDir, 'Bookmarks'), JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [{ type: 'url', name: 'example', url: 'https://example.test/' }],
        },
      },
    }), 'utf8');
    writeFileSync(join(profDir, 'Network', 'Cookies'), 'c'.repeat(SOURCE_COOKIE_BYTES), 'utf8');
    writeFileSync(join(root, 'Local State'), localStateJson, 'utf8');
  }
  return roots;
}

function makeDestination(dataDir, dstLocalStateJson) {
  const profileRoot = join(dataDir, 'profile-agent');
  const profileDef = join(profileRoot, 'Default');
  mkdirSync(profileDef, { recursive: true });
  writeFileSync(join(profileRoot, 'Local State'), dstLocalStateJson, 'utf8');
  return { profileRoot, profileDef };
}

function runProfileInit(home, dataDir) {
  const res = spawnSync(process.execPath, [scriptPath], {
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
  assert.equal(res.status, 0, res.stderr || res.stdout || String(res.error?.message ?? ''));
  return res;
}

const DEST_STATES = [
  { slug: 'null', label: 'null', json: 'null' },
  { slug: 'array', label: '空陣列 []', json: '[]' },
  { slug: 'string', label: '字串', json: '"x"' },
];

for (const state of DEST_STATES) {
  test(`目的端 Local State 為 ${state.label} 時，仍寫入來源 os_crypt 並同步 Cookies`, () => {
    const home = join(tempRoot, `home-dst-${state.slug}`);
    const dataDir = join(tempRoot, `data-dst-${state.slug}`);
    mkdirSync(home, { recursive: true });
    seedSourceProfile(home, SOURCE_OS_CRYPT);
    const { profileRoot, profileDef } = makeDestination(dataDir, state.json);

    runProfileInit(home, dataDir);

    const raw = readFileSync(join(profileRoot, 'Local State'), 'utf8');
    const dstLs = JSON.parse(raw);
    assert.equal(Array.isArray(dstLs), false, raw);
    assert.equal(typeof dstLs, 'object', raw);
    assert.equal(dstLs.os_crypt?.encrypted_key, 'K', raw);

    // Cookies 必須真的換成來源檔，否則「金鑰與 Cookies 脫鉤」的情境無法重現/驗證。
    assert.equal(readFileSync(dstCookiesPath(profileDef), 'utf8').length, SOURCE_COOKIE_BYTES);
  });
}

const UNUSABLE_SOURCE_STATES = [
  { slug: 'null', label: 'null', json: 'null' },
  { slug: 'array', label: '空陣列 []', json: '[]' },
  { slug: 'os-crypt-null', label: '{"os_crypt":null}', json: '{"os_crypt":null}' },
  { slug: 'os-crypt-array', label: '{"os_crypt":[]}', json: '{"os_crypt":[]}' },
  { slug: 'no-key', label: '{"os_crypt":{}}', json: '{"os_crypt":{}}' },
];

for (const state of UNUSABLE_SOURCE_STATES) {
  test(`來源 Local State 為 ${state.label} 時，不得覆蓋目的端 Cookies 也不得寫 os_crypt`, () => {
    const home = join(tempRoot, `home-src-${state.slug}`);
    const dataDir = join(tempRoot, `data-src-${state.slug}`);
    mkdirSync(home, { recursive: true });
    seedSourceProfile(home, state.json);
    const existingDstLocalState = JSON.stringify({ variations: { x: 1 } });
    const { profileRoot, profileDef } = makeDestination(dataDir, existingDstLocalState);
    const dstCookies = dstCookiesPath(profileDef);
    mkdirSync(dirname(dstCookies), { recursive: true });
    writeFileSync(dstCookies, OLD_DST_COOKIES, 'utf8');

    runProfileInit(home, dataDir);

    // 來源沒有可用金鑰 → 目的端 Cookies 必須原封不動（避免只做一半）。
    assert.equal(readFileSync(dstCookies, 'utf8'), OLD_DST_COOKIES);

    // 目的端 Local State 也不該被塞入 os_crypt，其餘欄位保留。
    const dstLs = JSON.parse(readFileSync(join(profileRoot, 'Local State'), 'utf8'));
    assert.equal(dstLs.os_crypt, undefined);
    assert.deepEqual(dstLs.variations, { x: 1 });
  });
}
