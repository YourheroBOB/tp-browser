import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w9-s09-profile-init-'));
const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const DB_NAMES = ['Login Data', 'Login Data For Account', 'Web Data'];
const SRC_FILL = { 'Login Data': 0x11, 'Login Data For Account': 0x22, 'Web Data': 0x33 };
const DST_FILL = { 'Login Data': 0x91, 'Login Data For Account': 0x92, 'Web Data': 0x93 };

function chromeUserData(home) {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  return join(home, '.config', 'google-chrome');
}

function srcBody(name) {
  return Buffer.alloc(10 * 1024, SRC_FILL[name]);
}

function dstBody(name) {
  return Buffer.alloc(128, DST_FILL[name]);
}

function walBody(name) {
  return Buffer.from(`FAKE_WAL_FOR_TEST:${name}`);
}

function journalBody(name) {
  return Buffer.from(`FAKE_JOURNAL_FOR_TEST:${name}`);
}

function shmBody(name) {
  return Buffer.from(`FAKE_SHM_FOR_TEST:${name}`);
}

function localStateBytes(encryptedKey) {
  const body = encryptedKey == null
    ? {}
    : { os_crypt: { encrypted_key: encryptedKey } };
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function setup({ label, srcKey, dstKey }) {
  const home = join(tempRoot, `${label}-home`);
  const dataDir = join(tempRoot, `${label}-data`);
  const srcRoot = chromeUserData(home);
  const srcProf = join(srcRoot, 'Default');
  const dstRoot = join(dataDir, 'profile-agent');
  const dstProf = join(dstRoot, 'Default');
  mkdirSync(srcProf, { recursive: true });
  mkdirSync(dstProf, { recursive: true });

  writeFileSync(join(srcProf, 'Bookmarks'), JSON.stringify({
    roots: {
      bookmark_bar: {
        children: [{ type: 'url', name: 'example', url: 'http://example.test/' }],
      },
      other: { children: [] },
    },
  }), 'utf8');

  const srcState = localStateBytes(srcKey);
  const dstState = localStateBytes(dstKey);
  writeFileSync(join(srcRoot, 'Local State'), srcState);
  writeFileSync(join(dstRoot, 'Local State'), dstState);

  for (const name of DB_NAMES) {
    writeFileSync(join(srcProf, name), srcBody(name));
    writeFileSync(join(dstProf, name), dstBody(name));
    writeFileSync(join(dstProf, `${name}-wal`), walBody(name));
    writeFileSync(join(dstProf, `${name}-journal`), journalBody(name));
    writeFileSync(join(dstProf, `${name}-shm`), shmBody(name));
  }

  const cookiesDir = process.platform === 'win32' ? join(dstProf, 'Network') : dstProf;
  mkdirSync(cookiesDir, { recursive: true });
  const cookies = Buffer.alloc(64 * 1024 + 1, 0x43);
  const cookiesPath = join(cookiesDir, 'Cookies');
  writeFileSync(cookiesPath, cookies);

  return { home, dataDir, dstProf, dstRoot, dstState, cookies, cookiesPath };
}

function run(home, dataDir) {
  return spawnSync(process.execPath, [script], {
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
}

function assertSynced(dstProf) {
  for (const name of DB_NAMES) {
    assert.ok(readFileSync(join(dstProf, name)).equals(srcBody(name)), name);
    assert.equal(existsSync(join(dstProf, `${name}-wal`)), false, `${name}-wal`);
    assert.equal(existsSync(join(dstProf, `${name}-journal`)), false, `${name}-journal`);
    assert.equal(existsSync(join(dstProf, `${name}-shm`)), false, `${name}-shm`);
  }
}

function assertUntouched(dstProf) {
  for (const name of DB_NAMES) {
    assert.ok(readFileSync(join(dstProf, name)).equals(dstBody(name)), name);
    assert.ok(readFileSync(join(dstProf, `${name}-wal`)).equals(walBody(name)), `${name}-wal`);
    assert.ok(readFileSync(join(dstProf, `${name}-journal`)).equals(journalBody(name)), `${name}-journal`);
    assert.ok(readFileSync(join(dstProf, `${name}-shm`)).equals(shmBody(name)), `${name}-shm`);
  }
}

test('profile-init keeps destination login databases when os_crypt keys differ', () => {
  const ctx = setup({
    label: 'differ',
    srcKey: 'FAKE_VALUE_FOR_TEST_SRC',
    dstKey: 'FAKE_VALUE_FOR_TEST_DST',
  });
  const result = run(ctx.home, ctx.dataDir);
  assert.equal(result.status, 0, result.stderr);
  for (const name of DB_NAMES) {
    assert.ok(
      result.stdout.includes(`Skipped ${name} sync: source and destination os_crypt.encrypted_key differ`),
      result.stdout,
    );
  }
  assertUntouched(ctx.dstProf);
  assert.ok(readFileSync(join(ctx.dstRoot, 'Local State')).equals(ctx.dstState));
  assert.ok(readFileSync(ctx.cookiesPath).equals(ctx.cookies));
});

test('profile-init syncs login databases when os_crypt keys match', () => {
  const ctx = setup({
    label: 'same',
    srcKey: 'FAKE_VALUE_FOR_TEST',
    dstKey: 'FAKE_VALUE_FOR_TEST',
  });
  const result = run(ctx.home, ctx.dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Skipped Login Data/);
  assertSynced(ctx.dstProf);
  assert.ok(readFileSync(join(ctx.dstRoot, 'Local State')).equals(ctx.dstState));
});

test('profile-init syncs login databases when neither side has an encrypted_key', () => {
  const ctx = setup({
    label: 'nokey',
    srcKey: null,
    dstKey: null,
  });
  const result = run(ctx.home, ctx.dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Skipped Login Data/);
  assertSynced(ctx.dstProf);
  assert.ok(readFileSync(join(ctx.dstRoot, 'Local State')).equals(ctx.dstState));
});
