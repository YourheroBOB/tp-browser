// tests/fmb_w4_s15_profile_init_cookies_pair.test.mjs
// tools/profile-init.js 的回歸測試：
//  1. Cookies 與 Local State(os_crypt) 必須永遠成對；Cookies 交換失敗時不得先把金鑰換掉。
//  2. Preferences 的 bookmark_bar / session / profile 是陣列（部分寫入／損壞）時，
//     必要設定仍必須真的寫進檔案，而不是被 JSON.stringify 吃掉。
// 全程只使用 os.tmpdir() 下的暫存目錄、假值（FAKE_VALUE_FOR_TEST），不連任何服務。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w4-s15-profile-init-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

let seq = 0;

// 對齊 tools/profile-init.js 的平台判斷：來源 roots 與目的地 Cookies 位置。
function srcRootFor(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

function dstCookiesFor(profileDef) {
  return process.platform === 'win32' ? join(profileDef, 'Network', 'Cookies') : join(profileDef, 'Cookies');
}

function runScript(c) {
  const res = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: c.home,
      USERPROFILE: c.home,
      LOCALAPPDATA: join(c.home, 'AppData', 'Local'),
      EGO_LINUX_DATA_DIR: c.dataDir,
    },
  });
  assert.equal(res.status, 0, res.stderr || res.error?.message || 'profile-init failed');
  return res;
}

function makeCase({ destCookiesAsDir = false, destLocalState = null } = {}) {
  seq += 1;
  const home = join(tempRoot, `home-${seq}`);
  const dataDir = join(tempRoot, `data-${seq}`);
  const srcRoot = srcRootFor(home);
  const srcProfile = join(srcRoot, 'Default');
  mkdirSync(join(srcProfile, 'Network'), { recursive: true });
  writeFileSync(
    join(srcProfile, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ name: 'example', url: 'https://example.test/' }] },
        other: { children: [] },
      },
    }),
    'utf8',
  );
  writeFileSync(join(srcProfile, 'Network', 'Cookies'), Buffer.alloc(40_000, 7));
  writeFileSync(
    join(srcRoot, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: 'FAKE_VALUE_FOR_TEST_SRC_KEY' } }),
    'utf8',
  );

  const profileRoot = join(dataDir, 'profile-agent');
  const profileDef = join(profileRoot, 'Default');
  mkdirSync(profileDef, { recursive: true });
  const dstCookies = dstCookiesFor(profileDef);
  if (destCookiesAsDir) mkdirSync(dstCookies, { recursive: true });
  if (destLocalState !== null) writeFileSync(join(profileRoot, 'Local State'), destLocalState, 'utf8');

  return { home, dataDir, profileRoot, profileDef, dstCookies };
}

test('Cookies 交換失敗時不得覆寫 Local State 的 os_crypt（金鑰與 DB 必須成對）', () => {
  const oldState = JSON.stringify({
    os_crypt: { encrypted_key: 'FAKE_VALUE_FOR_TEST_OLD_KEY' },
    keep: 1,
  });
  const c = makeCase({ destCookiesAsDir: true, destLocalState: oldState });

  runScript(c);

  const ls = JSON.parse(readFileSync(join(c.profileRoot, 'Local State'), 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, 'FAKE_VALUE_FOR_TEST_OLD_KEY');
  assert.equal(ls.keep, 1);

  // 失敗路徑不得留下半套暫存檔。
  assert.equal(existsSync(join(c.profileRoot, 'Local State.fmb-sync-tmp')), false);
  assert.equal(existsSync(`${c.dstCookies}.fmb-sync-tmp`), false);
  // 目的地 Cookies（此處刻意讓 rename 失敗）沒有被半套寫入。
  assert.equal(statSync(c.dstCookies).isDirectory(), true);
});

test('交換成功時 Cookies 與 os_crypt 一起更新，且不留下暫存檔', () => {
  const c = makeCase({
    destLocalState: JSON.stringify({
      os_crypt: { encrypted_key: 'FAKE_VALUE_FOR_TEST_OLD_KEY' },
      other: 'keep',
    }),
  });

  runScript(c);

  const ls = JSON.parse(readFileSync(join(c.profileRoot, 'Local State'), 'utf8'));
  assert.equal(ls.os_crypt.encrypted_key, 'FAKE_VALUE_FOR_TEST_SRC_KEY');
  assert.equal(ls.other, 'keep', 'Local State 其他欄位必須保留');

  assert.equal(statSync(c.dstCookies).size, 40_000);
  assert.deepEqual(readdirSync(c.profileRoot).filter((f) => f.includes('fmb-sync-tmp')), []);
  assert.deepEqual(readdirSync(c.profileDef).filter((f) => f.includes('fmb-sync-tmp')), []);
});

test('Preferences 的 bookmark_bar／session／profile 是陣列時仍寫入必要設定', () => {
  seq += 1;
  const home = join(tempRoot, `home-${seq}`);
  const dataDir = join(tempRoot, `data-${seq}`);
  mkdirSync(home, { recursive: true });
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  mkdirSync(profileDef, { recursive: true });
  writeFileSync(
    join(profileDef, 'Preferences'),
    JSON.stringify({
      bookmark_bar: [],
      session: [],
      profile: [],
      credentials_enable_service: false,
    }),
    'utf8',
  );

  runScript({ home, dataDir });

  const prefs = JSON.parse(readFileSync(join(profileDef, 'Preferences'), 'utf8'));
  assert.equal(Array.isArray(prefs.bookmark_bar), false, 'bookmark_bar 必須被正規化成物件');
  assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
  assert.equal(Array.isArray(prefs.session), false, 'session 必須被正規化成物件');
  assert.equal(prefs.session.restore_on_startup, 1);
  assert.equal(Array.isArray(prefs.profile), false, 'profile 必須被正規化成物件');
  assert.equal(prefs.profile.name, '⚡ TooPower');
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.credentials_enable_service, true);
});
