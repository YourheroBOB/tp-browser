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

function runProfileInit(home, dataDir, extraArgs = []) {
  return spawnSync(process.execPath, [script, ...extraArgs], {
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

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'tp-pi-edge-home-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-pi-edge-data-'));
  return { home, dataDir };
}

function teardown(home, dataDir) {
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}

function readPrefs(dataDir) {
  const p = join(dataDir, 'profile-agent', 'Default', 'Preferences');
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeSourceBookmarks(home, children = [{ type: 'url', name: 'a', url: 'https://example.com/' }]) {
  const root = chromeRoot(home);
  const prof = join(root, 'Default');
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, 'Bookmarks'), JSON.stringify({
    version: 1,
    roots: { bookmark_bar: { children }, other: { children: [] } },
  }));
  return { root, prof };
}

test('profile-init repairs a corrupt Preferences file with required defaults', () => {
  const { home, dataDir } = setup();
  try {
    const def = join(dataDir, 'profile-agent', 'Default');
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, 'Preferences'), 'not-json{{{');
    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    const prefs = readPrefs(dataDir);
    assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
    assert.equal(prefs.session.restore_on_startup, 1);
    assert.equal(prefs.profile.name, '⚡ TooPower');
    assert.equal(prefs.profile.exit_type, 'Normal');
    assert.equal(prefs.profile.exited_cleanly, true);
    assert.equal(prefs.credentials_enable_service, true);
    assert.equal(prefs.credentials_enable_autosignin, true);
  } finally {
    teardown(home, dataDir);
  }
});

test('profile-init normalizes array/scalar bookmark_bar/session/profile subtrees', () => {
  const { home, dataDir } = setup();
  try {
    const def = join(dataDir, 'profile-agent', 'Default');
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, 'Preferences'), JSON.stringify({
      bookmark_bar: [],
      session: 'corrupt',
      profile: 42,
    }));
    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    const prefs = readPrefs(dataDir);
    assert.equal(prefs.bookmark_bar.show_on_all_tabs, true);
    assert.equal(prefs.session.restore_on_startup, 1);
    assert.equal(prefs.profile.exit_type, 'Normal');
  } finally {
    teardown(home, dataDir);
  }
});

test('profile-init preserves an existing custom profile name but renames Person 1', () => {
  const { home, dataDir } = setup();
  try {
    const def = join(dataDir, 'profile-agent', 'Default');
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, 'Preferences'), JSON.stringify({ profile: { name: 'My Work' } }));
    let res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPrefs(dataDir).profile.name, 'My Work');

    writeFileSync(join(def, 'Preferences'), JSON.stringify({ profile: { name: 'Person 1' } }));
    res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readPrefs(dataDir).profile.name, '⚡ TooPower');
  } finally {
    teardown(home, dataDir);
  }
});

test('profile-init ignores a source Bookmarks file with invalid JSON', () => {
  const { home, dataDir } = setup();
  try {
    const root = chromeRoot(home);
    const prof = join(root, 'Default');
    mkdirSync(prof, { recursive: true });
    writeFileSync(join(prof, 'Bookmarks'), 'garbage{{{');
    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout || '', /^(?!.*Synced \d+ bookmarks)/);
    assert.equal(existsSync(join(dataDir, 'profile-agent', 'Default', 'Bookmarks')), false);
  } finally {
    teardown(home, dataDir);
  }
});

test('profile-init skips Cookies sync when source Local State has no usable os_crypt', () => {
  const { home, dataDir } = setup();
  try {
    const { root, prof } = writeSourceBookmarks(home);
    writeFileSync(join(root, 'Local State'), '{}\n');
    // Source Cookies large enough to qualify (> 32KB).
    writeFileSync(join(prof, 'Cookies'), 'C'.repeat(40000));
    const dstCookies = join(dataDir, 'profile-agent', 'Default', 'Cookies');
    mkdirSync(join(dataDir, 'profile-agent', 'Default'), { recursive: true });
    writeFileSync(dstCookies, 'DEST_COOKIES_KEEP');
    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout || '', /Skipped Cookies sync/);
    assert.equal(readFileSync(dstCookies, 'utf8'), 'DEST_COOKIES_KEEP');
  } finally {
    teardown(home, dataDir);
  }
});

test('profile-init syncs only missing https_ IndexedDB origins and skips LOCK files', () => {
  const { home, dataDir } = setup();
  try {
    const { prof } = writeSourceBookmarks(home);
    const srcIdb = join(prof, 'IndexedDB');
    mkdirSync(join(srcIdb, 'https_example.com_0.indexeddb.leveldb'), { recursive: true });
    writeFileSync(join(srcIdb, 'https_example.com_0.indexeddb.leveldb', 'CURRENT'), 'manifest');
    writeFileSync(join(srcIdb, 'https_example.com_0.indexeddb.leveldb', 'LOCK'), 'lock');
    mkdirSync(join(srcIdb, 'http_example.com_0.indexeddb.leveldb'), { recursive: true });
    writeFileSync(join(srcIdb, 'http_example.com_0.indexeddb.leveldb', 'CURRENT'), 'manifest');
    // Pre-existing destination origin must be left alone.
    const dstExisting = join(dataDir, 'profile-agent', 'Default', 'IndexedDB', 'https_keep.com_0.indexeddb.leveldb');
    mkdirSync(dstExisting, { recursive: true });
    writeFileSync(join(dstExisting, 'CURRENT'), 'original');

    const res = runProfileInit(home, dataDir);
    assert.equal(res.status, 0, res.stderr);
    const dstIdb = join(dataDir, 'profile-agent', 'Default', 'IndexedDB');
    assert.equal(
      readFileSync(join(dstIdb, 'https_example.com_0.indexeddb.leveldb', 'CURRENT'), 'utf8'),
      'manifest',
    );
    assert.equal(
      existsSync(join(dstIdb, 'https_example.com_0.indexeddb.leveldb', 'LOCK')),
      false,
    );
    assert.equal(existsSync(join(dstIdb, 'http_example.com_0.indexeddb.leveldb')), false);
    assert.equal(readFileSync(join(dstExisting, 'CURRENT'), 'utf8'), 'original');
  } finally {
    teardown(home, dataDir);
  }
});
