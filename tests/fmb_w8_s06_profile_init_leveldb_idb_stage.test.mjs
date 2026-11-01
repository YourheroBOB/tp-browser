// tests/fmb_w8_s06_profile_init_leveldb_idb_stage.test.mjs
// Regression tests for profile-init directory sync bugs:
//   1. Local Storage leveldb must be replaced atomically, not merged into an existing leveldb.
//   2. IndexedDB https_* origins must be staged + renamed, so a failed copy cannot leave a
//      half-copied origin that `existsSync()` later treats as complete.
// Zero network, zero real credentials, all paths under mkdtempSync(tmpdir()).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w8-s06-profile-init-'));
const home = join(tempRoot, 'home');
const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
const linuxOnly = process.platform !== 'linux';

after(() => rmSync(tempRoot, { recursive: true, force: true }));

const runProfileInit = (dataDir) =>
  spawnSync(process.execPath, [script], {
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

const resetSourceProfile = () => {
  const prof = join(home, '.config', 'chromium', 'Default');
  rmSync(prof, { recursive: true, force: true });
  mkdirSync(prof, { recursive: true });
  writeFileSync(
    join(prof, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [{ name: 'FAKE_VALUE_FOR_TEST', url: 'https://example.invalid/' }],
        },
        other: { children: [] },
      },
    }),
    'utf8'
  );
  return prof;
};

const listDir = (p) => (existsSync(p) ? readdirSync(p).sort() : []);
const hasSyncResidue = (p) =>
  listDir(p).some((n) => n.includes('.fmb-sync-tmp-') || n.includes('.fmb-sync-old-'));

// Force a mid-copy failure deterministically without permissions, disk-full, or network:
// a deep nested payload whose destination path exceeds PATH_MAX after the staged temp prefix is
// added. The first shallow files are copied before the failure, so rollback is exercised.
function makeDeepFailureFile(baseDir) {
  let dir = baseDir;
  while (dir.length < 3800) {
    const remaining = 3800 - dir.length;
    dir = join(dir, 'n'.repeat(Math.min(200, Math.max(1, remaining))));
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'f'.repeat(250));
  writeFileSync(file, 'deep payload\n');
  return file;
}

const leveldbPayload = (label) => `${label}\n${'x'.repeat(200)}`;

test('profile-init replaces an inconsistent destination leveldb directory atomically', {
  skip: linuxOnly ? 'linux-only profile-init fixture' : false,
}, () => {
  const dataDir = join(tempRoot, 'data-leveldb-ok');
  const srcProf = resetSourceProfile();
  const srcLdb = join(srcProf, 'Local Storage', 'leveldb');
  mkdirSync(srcLdb, { recursive: true });
  writeFileSync(join(srcLdb, 'CURRENT'), leveldbPayload('MANIFEST-000009'));
  writeFileSync(join(srcLdb, 'MANIFEST-000009'), leveldbPayload('source manifest'));
  writeFileSync(join(srcLdb, '000010.ldb'), leveldbPayload('source table'));
  writeFileSync(join(srcLdb, 'LOCK'), leveldbPayload('source lock'));

  const dstLdb = join(dataDir, 'profile-agent', 'Default', 'Local Storage', 'leveldb');
  mkdirSync(dstLdb, { recursive: true });
  writeFileSync(join(dstLdb, 'MANIFEST-000001'), 'stale manifest\n');
  writeFileSync(join(dstLdb, '000003.log'), 'stale log\n');
  writeFileSync(join(dstLdb, 'LOCK'), 'stale lock\n');

  const res = runProfileInit(dataDir);
  assert.equal(res.status, 0, res.stderr);

  assert.deepEqual(listDir(dstLdb), ['000010.ldb', 'CURRENT', 'MANIFEST-000009']);
  assert.equal(readFileSync(join(dstLdb, 'CURRENT'), 'utf8'), leveldbPayload('MANIFEST-000009'));
  assert.equal(readFileSync(join(dstLdb, 'MANIFEST-000009'), 'utf8'), leveldbPayload('source manifest'));
  assert.equal(readFileSync(join(dstLdb, '000010.ldb'), 'utf8'), leveldbPayload('source table'));
  assert.equal(existsSync(join(dstLdb, 'LOCK')), false);

  const parent = join(dataDir, 'profile-agent', 'Default', 'Local Storage');
  assert.deepEqual(listDir(parent), ['leveldb']);
  assert.equal(hasSyncResidue(parent), false);
});

test('profile-init rolls back a failed leveldb staged copy and preserves the old directory', {
  skip: linuxOnly ? 'linux-only profile-init fixture' : false,
}, () => {
  const dataDir = join(tempRoot, 'data-leveldb-fail');
  const srcProf = resetSourceProfile();
  const srcLdb = join(srcProf, 'Local Storage', 'leveldb');
  mkdirSync(srcLdb, { recursive: true });
  writeFileSync(join(srcLdb, 'CURRENT'), leveldbPayload('MANIFEST-000009'));
  writeFileSync(join(srcLdb, 'MANIFEST-000009'), leveldbPayload('source manifest'));
  writeFileSync(join(srcLdb, '000010.ldb'), leveldbPayload('source table'));
  makeDeepFailureFile(srcLdb);

  const dstLdb = join(dataDir, 'profile-agent', 'Default', 'Local Storage', 'leveldb');
  mkdirSync(dstLdb, { recursive: true });
  writeFileSync(join(dstLdb, 'MANIFEST-000001'), 'stale manifest\n');
  writeFileSync(join(dstLdb, '000003.log'), 'stale log\n');
  writeFileSync(join(dstLdb, 'LOCK'), 'stale lock\n');

  const before = listDir(dstLdb).map((name) => [name, readFileSync(join(dstLdb, name), 'utf8')]);
  const res = runProfileInit(dataDir);
  assert.equal(res.status, 0, res.stderr);

  assert.deepEqual(listDir(dstLdb), before.map(([name]) => name));
  for (const [name, content] of before) {
    assert.equal(readFileSync(join(dstLdb, name), 'utf8'), content);
  }
  assert.equal(existsSync(join(dstLdb, 'CURRENT')), false);
  assert.equal(existsSync(join(dstLdb, 'MANIFEST-000009')), false);

  const parent = join(dataDir, 'profile-agent', 'Default', 'Local Storage');
  assert.deepEqual(listDir(parent), ['leveldb']);
  assert.equal(hasSyncResidue(parent), false);
});

test('profile-init stages https_* IndexedDB origins and does not copy LOCK', {
  skip: linuxOnly ? 'linux-only profile-init fixture' : false,
}, () => {
  const dataDir = join(tempRoot, 'data-idb-ok');
  const srcProf = resetSourceProfile();
  const srcIdb = join(srcProf, 'IndexedDB');
  const srcOrigin = join(srcIdb, 'https_example.invalid');
  mkdirSync(srcOrigin, { recursive: true });
  writeFileSync(join(srcOrigin, '000001.ldb'), 'idb table\n');
  writeFileSync(join(srcOrigin, 'LOCK'), 'origin lock\n');
  mkdirSync(join(srcIdb, 'http_not_copied'), { recursive: true });

  const dstIdb = join(dataDir, 'profile-agent', 'Default', 'IndexedDB');
  const dstOrigin = join(dstIdb, 'https_example.invalid');

  const res = runProfileInit(dataDir);
  assert.equal(res.status, 0, res.stderr);

  assert.deepEqual(listDir(dstOrigin), ['000001.ldb']);
  assert.equal(readFileSync(join(dstOrigin, '000001.ldb'), 'utf8'), 'idb table\n');
  assert.equal(existsSync(join(dstIdb, 'http_not_copied')), false);
  assert.equal(hasSyncResidue(dstIdb), false);
});

test('profile-init cleans a failed IndexedDB staged copy so the origin can retry', {
  skip: linuxOnly ? 'linux-only profile-init fixture' : false,
}, () => {
  const dataDir = join(tempRoot, 'data-idb-fail');
  const srcProf = resetSourceProfile();
  const srcIdb = join(srcProf, 'IndexedDB');
  const srcFailOrigin = join(srcIdb, 'https_failing.invalid');
  mkdirSync(srcFailOrigin, { recursive: true });
  writeFileSync(join(srcFailOrigin, '000001.ldb'), 'partial\n');
  makeDeepFailureFile(srcFailOrigin);

  const dstIdb = join(dataDir, 'profile-agent', 'Default', 'IndexedDB');
  const dstFailOrigin = join(dstIdb, 'https_failing.invalid');

  const first = runProfileInit(dataDir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(dstFailOrigin), false);
  assert.equal(hasSyncResidue(dstIdb), false);

  rmSync(srcFailOrigin, { recursive: true, force: true });
  mkdirSync(srcFailOrigin, { recursive: true });
  writeFileSync(join(srcFailOrigin, '000001.ldb'), 'complete\n');

  const second = runProfileInit(dataDir);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(listDir(dstFailOrigin), ['000001.ldb']);
  assert.equal(readFileSync(join(dstFailOrigin, '000001.ldb'), 'utf8'), 'complete\n');
  assert.equal(hasSyncResidue(dstIdb), false);
});
