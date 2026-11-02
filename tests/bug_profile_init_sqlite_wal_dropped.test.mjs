// profile-init 同步 Favicons／Login Data 時必須連同 SQLite -wal 一起搬。
// 只複製主檔會丟掉尚未 checkpoint 的提交。不連網、不碰暫存目錄以外的路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceProfileDir(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
  }
  return join(home, '.config', 'google-chrome', 'Default');
}

test('profile-init copies Favicons-wal with the database', () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-init-wal-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const prof = sourceProfileDir(home);
  try {
    mkdirSync(prof, { recursive: true });
    writeFileSync(join(prof, 'Bookmarks'), JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'url', name: 'example', url: 'http://example.com/' }] },
        other: { children: [] },
      },
    }));
    const mainBytes = Buffer.from('FAKE_VALUE_FOR_TEST-main');
    const walBytes = Buffer.from('FAKE_VALUE_FOR_TEST-wal');
    writeFileSync(join(prof, 'Favicons'), mainBytes);
    writeFileSync(join(prof, 'Favicons-wal'), walBytes);

    const result = spawnSync(process.execPath, [join(repoRoot, 'tools', 'profile-init.js')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        EGO_LINUX_DATA_DIR: data,
      },
    });
    assert.equal(result.status, 0);

    const dst = join(data, 'profile-agent', 'Default', 'Favicons');
    assert.deepEqual(readFileSync(dst), mainBytes);
    assert.deepEqual(readFileSync(`${dst}-wal`), walBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
