import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w13-s15-profile-init-'));
const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

after(() => rmSync(tempRoot, { recursive: true, force: true }));

function browserProfilePaths(home) {
  if (process.platform === 'darwin') {
    const baseDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    return { baseDir, profileDir: join(baseDir, 'Default') };
  }
  if (process.platform === 'win32') {
    const baseDir = join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    return { baseDir, profileDir: join(baseDir, 'Default') };
  }
  const baseDir = join(home, '.config', 'google-chrome');
  return { baseDir, profileDir: join(baseDir, 'Default') };
}

const cases = [
  { name: 'neither profile has a key', sourceKey: null, destinationKey: null, shouldCopy: true },
  { name: 'only the source has a key', sourceKey: 'FAKE_VALUE_FOR_TEST_SOURCE_KEY', destinationKey: null, shouldCopy: false },
  { name: 'only the destination has a key', sourceKey: null, destinationKey: 'FAKE_VALUE_FOR_TEST_DESTINATION_KEY', shouldCopy: false },
  {
    name: 'profiles have different keys',
    sourceKey: 'FAKE_VALUE_FOR_TEST_SOURCE_KEY',
    destinationKey: 'FAKE_VALUE_FOR_TEST_DESTINATION_KEY',
    shouldCopy: false,
  },
  {
    name: 'profiles have the same key',
    sourceKey: 'FAKE_VALUE_FOR_TEST_SHARED_KEY',
    destinationKey: 'FAKE_VALUE_FOR_TEST_SHARED_KEY',
    shouldCopy: true,
  },
];

for (const scenario of cases) {
  test(`profile-init syncs Login Data only when os_crypt keys are compatible: ${scenario.name}`, () => {
    const caseRoot = join(tempRoot, scenario.name.replaceAll(/[^a-z0-9]+/gi, '-'));
    const home = join(caseRoot, 'home');
    const dataDir = join(caseRoot, 'data');
    const { baseDir, profileDir } = browserProfilePaths(home);
    const destinationProfile = join(dataDir, 'profile-agent', 'Default');

    mkdirSync(profileDir, { recursive: true });
    mkdirSync(destinationProfile, { recursive: true });

    writeFileSync(
      join(profileDir, 'Bookmarks'),
      JSON.stringify({ roots: { bookmark_bar: { children: [{ name: 'test' }] } } }),
      'utf8',
    );
    writeFileSync(join(baseDir, 'Local State'), JSON.stringify({
      os_crypt: scenario.sourceKey === null ? {} : { encrypted_key: scenario.sourceKey },
    }), 'utf8');

    const sourceLoginData = 'source-login-data';
    const destinationLoginData = 'destination-login-data';
    writeFileSync(join(profileDir, 'Login Data'), sourceLoginData, 'utf8');
    writeFileSync(join(destinationProfile, 'Login Data'), destinationLoginData, 'utf8');
    writeFileSync(
      join(dataDir, 'profile-agent', 'Local State'),
      JSON.stringify({
        os_crypt: scenario.destinationKey === null ? {} : { encrypted_key: scenario.destinationKey },
      }),
      'utf8',
    );

    const result = spawnSync(process.execPath, [script, '--force'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        EGO_LINUX_DATA_DIR: dataDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(destinationProfile, 'Login Data'), 'utf8'),
      scenario.shouldCopy ? sourceLoginData : destinationLoginData,
    );
  });
}
