import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('profile-init keeps keyed Login Data when the source Local State has no os_crypt', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'tp-pi-home-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-pi-data-'));
  try {
    const localApp = join(homeDir, 'AppData', 'Local');
    const chromeRoot = process.platform === 'darwin'
      ? join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
      : process.platform === 'win32'
        ? join(localApp, 'Google', 'Chrome', 'User Data')
        : join(homeDir, '.config', 'google-chrome');
    const srcProfile = join(chromeRoot, 'Default');
    mkdirSync(srcProfile, { recursive: true });
    writeFileSync(join(chromeRoot, 'Local State'), '{}\n');
    writeFileSync(join(srcProfile, 'Bookmarks'), JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [{ type: 'url', name: 'example', url: 'https://example.com/' }],
        },
        other: { children: [] },
      },
    }));
    writeFileSync(join(srcProfile, 'Login Data'), 'S'.repeat(100));

    const profileRoot = join(dataDir, 'profile-agent');
    const profileDef = join(profileRoot, 'Default');
    mkdirSync(profileDef, { recursive: true });
    const dstLoginText = 'DEST_LOGIN_KEEP';
    writeFileSync(join(profileDef, 'Login Data'), dstLoginText);
    writeFileSync(join(profileRoot, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: 'FAKE_VALUE_FOR_TEST_DST' },
    }));

    const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        LOCALAPPDATA: localApp,
        EGO_LINUX_DATA_DIR: dataDir,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(profileDef, 'Login Data'), 'utf8'), dstLoginText);
    const dstState = JSON.parse(readFileSync(join(profileRoot, 'Local State'), 'utf8'));
    assert.equal(dstState.os_crypt.encrypted_key, 'FAKE_VALUE_FOR_TEST_DST');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
