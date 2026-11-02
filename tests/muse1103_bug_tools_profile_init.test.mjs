import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

function chromeRoot(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

function runProfileInit(home, dataDir) {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      EGO_LINUX_DATA_DIR: dataDir,
    },
    encoding: 'utf8',
  });
}

function withFakeHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'tp-pi-strbm-home-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-pi-strbm-data-'));
  try {
    fn(home, dataDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function realBookmarks(url) {
  return JSON.stringify({
    version: 1,
    roots: {
      bookmark_bar: { children: [{ type: 'url', name: 'real', url }] },
      other: { children: [{ type: 'url', name: 'real2', url }] },
    },
  });
}

test('profile-init prefers 2 real bookmarks over corrupt string children', () => {
  withFakeHome((home, dataDir) => {
    const root = chromeRoot(home);
    const corrupt = join(root, 'Default');
    mkdirSync(corrupt, { recursive: true });
    // Corrupt file: children is a 16-char string, not an array.
    writeFileSync(join(corrupt, 'Bookmarks'), JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: { children: 'xxxxxxxxxxxxxxxx' },
        other: { children: [] },
      },
    }));
    const marker = 'https://example.com/real-bookmarks';
    const good = join(root, 'Profile 1');
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, 'Bookmarks'), realBookmarks(marker));

    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    const dst = join(dataDir, 'profile-agent', 'Default', 'Bookmarks');
    assert.equal(existsSync(dst), true, 'expected destination Bookmarks to be imported');
    assert.equal(readFileSync(dst, 'utf8').includes(marker), true);
  });
});

test('profile-init imports nothing when every source has non-array children', () => {
  withFakeHome((home, dataDir) => {
    const root = chromeRoot(home);
    const corrupt = join(root, 'Default');
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, 'Bookmarks'), JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: { children: 'xxxxxxxxxxxxxxxx' },
        other: { children: [] },
      },
    }));

    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    const dst = join(dataDir, 'profile-agent', 'Default', 'Bookmarks');
    assert.equal(existsSync(dst), false, 'corrupt string-children source must not be imported');
  });
});
