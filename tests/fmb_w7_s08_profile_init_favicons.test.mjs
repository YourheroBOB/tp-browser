import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const profileInitScript = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w7-s08-favicons-'));

after(() => rmSync(tempRoot, { recursive: true, force: true }));

function sourceProfileDir(home) {
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
  }
  return join(home, '.config', 'google-chrome', 'Default');
}

function runProfileInitCase(name, { destFavicons, force = false }) {
  const caseRoot = join(tempRoot, name);
  const home = join(caseRoot, 'home');
  const dataDir = join(caseRoot, 'data');
  const srcProfile = sourceProfileDir(home);
  const dstProfile = join(dataDir, 'profile-agent', 'Default');

  mkdirSync(srcProfile, { recursive: true });
  mkdirSync(dstProfile, { recursive: true });

  const sourceBookmarks = JSON.stringify({
    roots: {
      bookmark_bar: {
        children: [{ name: 'fmb-w7-s08', type: 'url', url: 'https://example.invalid/' }],
      },
      other: { children: [] },
    },
  });
  writeFileSync(join(srcProfile, 'Bookmarks'), sourceBookmarks, 'utf8');

  const sourceFavicons = Buffer.alloc(40 * 1024, 0x41);
  writeFileSync(join(srcProfile, 'Favicons'), sourceFavicons);

  const dstFaviconsPath = join(dstProfile, 'Favicons');
  if (destFavicons !== null) {
    writeFileSync(dstFaviconsPath, destFavicons);
  }

  const result = spawnSync(
    process.execPath,
    force ? [profileInitScript, '--force'] : [profileInitScript],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        EGO_LINUX_DATA_DIR: dataDir,
      },
    }
  );

  assert.equal(result.status, 0, result.stderr || String(result.error));
  return { dstFaviconsPath, sourceFavicons };
}

test('profile-init Favicons：目的端較大時不被來源覆蓋', () => {
  const largerDest = Buffer.alloc(60 * 1024, 0x42);
  const { dstFaviconsPath, sourceFavicons } = runProfileInitCase('dest-larger', {
    destFavicons: largerDest,
  });

  const actual = readFileSync(dstFaviconsPath);
  assert.ok(actual.equals(largerDest), '目的端 Favicons 在位元組層級被改動');
  assert.ok(!actual.equals(sourceFavicons), '目的端較大時不應被來源覆蓋');
});

test('profile-init Favicons：目的端不存在時要同步', () => {
  const { dstFaviconsPath, sourceFavicons } = runProfileInitCase('dest-missing', {
    destFavicons: null,
  });

  assert.ok(existsSync(dstFaviconsPath), '目的端 Favicons 應被建立');
  assert.ok(readFileSync(dstFaviconsPath).equals(sourceFavicons), '目的端不存在時應同步來源位元組');
});

test('profile-init Favicons：目的端小於來源一半時要同步', () => {
  const smallerDest = Buffer.alloc(10 * 1024, 0x43);
  const { dstFaviconsPath, sourceFavicons } = runProfileInitCase('dest-smaller', {
    destFavicons: smallerDest,
  });

  assert.ok(readFileSync(dstFaviconsPath).equals(sourceFavicons), '目的端明顯小於來源時應同步來源位元組');
});

test('profile-init Favicons：--force 時一定同步', () => {
  const largerDest = Buffer.alloc(60 * 1024, 0x42);
  const { dstFaviconsPath, sourceFavicons } = runProfileInitCase('force', {
    destFavicons: largerDest,
    force: true,
  });

  assert.ok(readFileSync(dstFaviconsPath).equals(sourceFavicons), '--force 時應同步來源位元組');
});
