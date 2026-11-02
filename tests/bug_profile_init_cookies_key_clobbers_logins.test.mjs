import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_KEY = 'FAKE_VALUE_FOR_TEST';
const DST_KEY = 'FAKE_VALUE_FOR_TEST_DST';

function chromeUserData(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

test('cookies sync keeps dest os_crypt when keyed Login Data is left in place', () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-profile-init-home-'));
  const dataDir = join(home, 'ego-data');
  try {
    const userData = chromeUserData(home);
    const srcProfile = join(userData, 'Default');
    mkdirSync(join(srcProfile, 'Network'), { recursive: true });
    writeFileSync(join(userData, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: SRC_KEY },
    }));
    writeFileSync(join(srcProfile, 'Bookmarks'), JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'url', name: 'local', url: 'http://127.0.0.1/' }] },
        other: { children: [] },
      },
    }));
    writeFileSync(join(srcProfile, 'Network', 'Cookies'), Buffer.alloc(32769, 7));
    writeFileSync(join(srcProfile, 'Login Data'), Buffer.alloc(4096, 3));

    const profileRoot = join(dataDir, 'profile-agent');
    const profileDef = join(profileRoot, 'Default');
    mkdirSync(profileDef, { recursive: true });
    const dstLogin = Buffer.from('DEST_LOGIN_SENTINEL');
    const dstCookies = Buffer.from('DEST_COOKIES_SENTINEL');
    writeFileSync(join(profileDef, 'Login Data'), dstLogin);
    writeFileSync(join(profileDef, 'Cookies'), dstCookies);
    writeFileSync(join(profileRoot, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: DST_KEY },
      marker: 'keep',
    }));

    const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
    const res = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        EGO_LINUX_DATA_DIR: dataDir,
      },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(
      res.stdout,
      /Skipped Cookies sync: destination login data is encrypted with a different os_crypt\.encrypted_key/,
    );
    const dstState = JSON.parse(readFileSync(join(profileRoot, 'Local State'), 'utf8'));
    assert.equal(dstState.os_crypt.encrypted_key, DST_KEY);
    assert.equal(dstState.marker, 'keep');
    assert.equal(readFileSync(join(profileDef, 'Login Data')).equals(dstLogin), true);
    assert.equal(readFileSync(join(profileDef, 'Cookies')).equals(dstCookies), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
