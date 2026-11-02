// tests/fmb_w12_s15_profile_init_key_conflict_cookies.test.mjs
// 回歸測試：tools/profile-init.js 在 source 與 profile-agent 的 os_crypt.encrypted_key 不同時，
// 會刻意保留 profile-agent 自己的 Login Data / Web Data（那些資料列是用「目的端」金鑰加密的，
// 換金鑰就解不開）。但舊版仍會在匯入 Cookies 時把 Local State 的 os_crypt 換成來源金鑰，
// 於是剛剛被保留的登入資料全部變成無法解密——等於為了匯入 Cookies 而丟掉既有密碼。
//
// 測試全程使用假的 HOME / 資料目錄與明顯假金鑰（FAKE_..._KEY），不連線、不讀寫 repo 外的路徑。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w12-s15-profile-init-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

// > 32768 bytes：這是腳本願意匯入 Cookies 的最小門檻。
const COOKIE_BYTES = Buffer.from('A'.repeat(40000), 'utf8');
const SOURCE_LOGIN_BYTES = Buffer.from('S'.repeat(4000), 'utf8');
// 目的端既有登入資料（內容是什麼不重要，重點是它必須被原封不動保留）。
const KEPT_LOGIN_BYTES = Buffer.from('D'.repeat(100), 'utf8');
const BOOKMARKS = JSON.stringify({
  roots: {
    bookmark_bar: { children: [{ name: 'example', url: 'https://example.com/' }] },
    other: { children: [] },
  },
});

function chromeRoot(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

function prepare(name, { srcKey, dstKey }) {
  const root = join(tempRoot, name);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const profileDef = join(dataDir, 'profile-agent', 'Default');
  const srcProfile = join(chromeRoot(home), 'Default');

  // 來源瀏覽器：有書籤（才會有 candidate）、大 Cookies DB、以及一份登入資料。
  mkdirSync(join(srcProfile, 'Network'), { recursive: true });
  writeFileSync(join(srcProfile, 'Bookmarks'), BOOKMARKS, 'utf8');
  writeFileSync(join(srcProfile, 'Network', 'Cookies'), COOKIE_BYTES);
  writeFileSync(join(srcProfile, 'Login Data'), SOURCE_LOGIN_BYTES);
  writeFileSync(
    join(chromeRoot(home), 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: srcKey } }),
    'utf8',
  );

  // 目的端 profile-agent：已有自己的金鑰與一份登入資料。
  mkdirSync(profileDef, { recursive: true });
  writeFileSync(
    join(dataDir, 'profile-agent', 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: dstKey } }),
    'utf8',
  );
  writeFileSync(join(profileDef, 'Login Data'), KEPT_LOGIN_BYTES);

  return { home, dataDir, profileDef };
}

function runInit(home, dataDir) {
  const result = spawnSync(process.execPath, [script], {
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
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function readDestinationKey(dataDir) {
  const localState = JSON.parse(
    readFileSync(join(dataDir, 'profile-agent', 'Local State'), 'utf8'),
  );
  return localState.os_crypt.encrypted_key;
}

function cookiesFile(profileDef) {
  const modern = join(profileDef, 'Network', 'Cookies');
  if (existsSync(modern)) return modern;
  const legacy = join(profileDef, 'Cookies');
  if (existsSync(legacy)) return legacy;
  return null;
}

test('profile-init：來源與 profile-agent 金鑰不同時，不覆寫 Local State 金鑰（保留的登入資料仍可解密）', () => {
  const { home, dataDir, profileDef } = prepare('conflict', {
    srcKey: 'FAKE_SRC_KEY',
    dstKey: 'FAKE_DST_KEY',
  });

  const result = runInit(home, dataDir);

  assert.match(
    result.stdout,
    /Skipped Cookies sync: profile-agent keeps Login Data/,
    `預期留下跳過訊息，實際 stdout：${result.stdout}`,
  );
  // 關鍵不變條件：目的端金鑰不能被換掉，否則被保留的 Login Data 就永遠解不開。
  assert.equal(readDestinationKey(dataDir), 'FAKE_DST_KEY');
  assert.equal(cookiesFile(profileDef), null, '金鑰衝突時不應寫入任何 Cookies DB');
  // 被保留的登入資料必須逐位元不變（沒有覆寫、也沒有被半途寫壞）。
  assert.equal(readFileSync(join(profileDef, 'Login Data')).equals(KEPT_LOGIN_BYTES), true);
  // 書籤匯入與金鑰守門無關，仍應照常發生。
  const bookmarks = JSON.parse(readFileSync(join(profileDef, 'Bookmarks'), 'utf8'));
  assert.equal(bookmarks.roots.bookmark_bar.children.length, 1);
});

test('profile-init：兩邊金鑰相同時，Cookies 與目的端登入資料仍照常匯入', () => {
  const key = 'FAKE_SHARED_KEY';
  const { home, dataDir, profileDef } = prepare('same-key', { srcKey: key, dstKey: key });

  const result = runInit(home, dataDir);

  assert.doesNotMatch(result.stdout, /Skipped Cookies sync/);
  const importedCookies = cookiesFile(profileDef);
  assert.ok(importedCookies, '同一把金鑰時 Cookies 應被匯入');
  assert.equal(readFileSync(importedCookies).equals(COOKIE_BYTES), true);
  assert.equal(readDestinationKey(dataDir), key);
  assert.equal(readFileSync(join(profileDef, 'Login Data')).equals(SOURCE_LOGIN_BYTES), true);
});
