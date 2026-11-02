import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

function chromeDefaultDir(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
  }
  return join(home, '.config', 'google-chrome', 'Default');
}

function emptyFolder(name) {
  return { type: 'folder', name, children: [] };
}

function importThirdRoot(rootKey, marker) {
  const home = mkdtempSync(join(tmpdir(), 'tp-profile-bm-'));
  const dataDir = join(home, 'ego-data');
  try {
    const prof = chromeDefaultDir(home);
    mkdirSync(prof, { recursive: true });
    const roots = {
      bookmark_bar: emptyFolder('Bookmarks bar'),
      other: emptyFolder('Other bookmarks'),
      [rootKey]: {
        type: 'folder',
        name: 'Mobile bookmarks',
        children: [{ type: 'url', name: 'Only here', url: marker }],
      },
    };
    writeFileSync(join(prof, 'Bookmarks'), JSON.stringify({ version: 1, roots }));
    const res = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        EGO_LINUX_DATA_DIR: dataDir,
      },
      encoding: 'utf8',
    });
    const dst = join(dataDir, 'profile-agent', 'Default', 'Bookmarks');
    let body = '';
    try { body = readFileSync(dst, 'utf8'); } catch { body = ''; }
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', body };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('profile-init imports a Chrome profile whose bookmarks are only in roots.synced', () => {
  const marker = 'https://example.com/synced-only';
  const { status, stdout, stderr, body } = importThirdRoot('synced', marker);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Synced 1 bookmarks/);
  assert.equal(body.includes(marker), true);
});

test('profile-init imports a legacy Chrome profile whose bookmarks are only in roots.mobile', () => {
  const marker = 'https://example.com/mobile-only';
  const { status, stdout, stderr, body } = importThirdRoot('mobile', marker);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Synced 1 bookmarks/);
  assert.equal(body.includes(marker), true);
});
