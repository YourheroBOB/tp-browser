#!/usr/bin/env node
// Automatically initializes `profile-agent/Default/Preferences` to always show the
// native Bookmarks Bar (`bookmark_bar.show_on_all_tabs = true`), enable session persistence,
// and import the user's existing local browser Bookmarks, Favicons, Saved Logins, Local Storage & IndexedDB.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const home = homedir();
const dataDir = process.env.EGO_LINUX_DATA_DIR || join(home, '.local', 'share', 'ego-linux');
const profileRoot = join(dataDir, 'profile-agent');
const profileDef = join(profileRoot, 'Default');
mkdirSync(profileDef, { recursive: true });

// 1. Force native Bookmarks Bar (`show_on_all_tabs: true`) + Session Restore in Default/Preferences
const prefsPath = join(profileDef, 'Preferences');
let prefs = {};
if (existsSync(prefsPath)) {
  try { prefs = JSON.parse(readFileSync(prefsPath, 'utf8')); } catch { prefs = {}; }
}
if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs) ||
    Object.getPrototypeOf(prefs) !== Object.prototype) {
  prefs = {};
}
// `bookmark_bar` / `session` / `profile` can be an array or a scalar after a partial or corrupt
// write. A property hung on an array is dropped by JSON.stringify, which would silently lose
// every setting assigned below, so normalize each subtree to a plain object first.
prefs.bookmark_bar = isPlainObject(prefs.bookmark_bar) ? prefs.bookmark_bar : {};
prefs.bookmark_bar.show_on_all_tabs = true;
prefs.session = isPlainObject(prefs.session) ? prefs.session : {};
prefs.session.restore_on_startup = 1;
prefs.profile = isPlainObject(prefs.profile) ? prefs.profile : {};
if (!prefs.profile.name || prefs.profile.name === 'Person 1' || prefs.profile.name === '第一位使用者') {
  prefs.profile.name = '⚡ TooPower';
}
prefs.profile.exit_type = 'Normal';
prefs.profile.exited_cleanly = true;
prefs.credentials_enable_service = true;
prefs.credentials_enable_autosignin = true;
try {
  writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
} catch {}

// 2. Discover local browser profiles (supporting both `Bookmarks` and modern Chrome `AccountBookmarks`)
function countBookmarks(file) {
  if (!existsSync(file)) return 0;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const b1 = (j.roots?.bookmark_bar?.children || []).length;
    const b2 = (j.roots?.other?.children || []).length;
    return b1 + b2;
  } catch { return 0; }
}

function fileSize(file) {
  try { return existsSync(file) ? statSync(file).size : 0; } catch { return 0; }
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f));
        if (st.isFile()) total += st.size;
      } catch {}
    }
  } catch {}
  return total;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// SQLite sidecars (`-journal`, `-wal`, `-shm`) hold writes that have not been checkpointed into
// the main database file yet, so they still belong to the *current* DB and must survive every
// failed replacement. Deleting them before the copy means a copy that fails afterwards (locked
// file, EACCES, ENOSPC, destination is a directory) silently throws away those writes — for
// Cookies that is exactly the un-checkpointed login state. Stage the copy next to the
// destination, rename it into place, and only drop the sidecars once the rename really succeeded.
function replaceSqliteFile(srcPath, dstPath) {
  const tmp = `${dstPath}.fmb-sync-tmp`;
  try {
    copyFileSync(srcPath, tmp);
    renameSync(tmp, dstPath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw err;
  }
  for (const ext of ['-journal', '-wal', '-shm']) {
    try { if (existsSync(dstPath + ext)) unlinkSync(dstPath + ext); } catch {}
  }
}

// Directory-sized browser state must never be copied file-by-file into a live destination.
// A leveldb destination that keeps stale .ldb/.log/MANIFEST-* files next to the source
// CURRENT/MANIFEST pair is corrupt, and an IndexedDB copy that fails halfway leaves a partial
// directory that `existsSync()` later treats as complete. Stage the whole tree in a sibling
// temp directory, swap it in only after the copy succeeded, and roll back on any failure so the
// previous contents survive.
function removePathQuietly(target) {
  try { rmSync(target, { recursive: true, force: true }); } catch {}
}

function copyTreeFiltered(srcDir, dstDir, filter) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeFiltered(src, dst, filter);
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
    }
    // Symlinks and special files are intentionally skipped: browser profile payloads are regular
    // files/directories, and skipping prevents a hostile source entry from escaping the stage.
  }
}

function syncTreeStaged(srcDir, dstDir, filter = () => true) {
  const parent = dirname(dstDir);
  mkdirSync(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = `${dstDir}.fmb-sync-tmp-${stamp}`;
  removePathQuietly(tmp);
  try {
    copyTreeFiltered(srcDir, tmp, filter);
    if (!existsSync(dstDir)) {
      renameSync(tmp, dstDir);
      return true;
    }
    const backup = `${dstDir}.fmb-sync-old-${stamp}`;
    removePathQuietly(backup);
    renameSync(dstDir, backup);
    try {
      renameSync(tmp, dstDir);
    } catch (err) {
      try {
        renameSync(backup, dstDir);
        removePathQuietly(backup);
      } catch {}
      throw err;
    }
    removePathQuietly(backup);
    return true;
  } catch (err) {
    removePathQuietly(tmp);
    throw err;
  }
}

// Return the source browser's `os_crypt` only when the destination can actually decrypt
// cookies with it. Missing file, invalid JSON, `null`, an array or an empty
// `encrypted_key` all mean "not usable" — in that case Cookies must not be replaced.
function readSourceOsCrypt(localStatePath) {
  if (!existsSync(localStatePath)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(localStatePath, 'utf8')); } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  const osCrypt = parsed.os_crypt;
  if (!isPlainObject(osCrypt)) return null;
  if (typeof osCrypt.encrypted_key !== 'string' || osCrypt.encrypted_key === '') return null;
  return osCrypt;
}

// The destination Local State can be `null`, an array or a scalar after a partial/corrupt
// write. Start from a fresh object in those cases so `os_crypt` is never silently dropped
// (assigning onto `null` throws, and a property hung on an array is lost by JSON.stringify).
function readDestinationLocalState(localStatePath) {
  if (!existsSync(localStatePath)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(localStatePath, 'utf8')); } catch { return {}; }
  return isPlainObject(parsed) ? parsed : {};
}

const dstBookmarks = join(profileDef, 'Bookmarks');
const dstAccountBookmarks = join(profileDef, 'AccountBookmarks');
const dstFavicons = join(profileDef, 'Favicons');
const forceSync = process.argv.includes('--force') || process.argv.includes('--sync-auth');

const candidates = [];
const addRoot = (baseDir) => {
  if (!baseDir || !existsSync(baseDir)) return;
  const subs = new Set(['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4', 'Profile 5']);
  try {
    for (const entry of readdirSync(baseDir)) subs.add(entry);
  } catch {}
  for (const sub of subs) {
    const profDir = join(baseDir, sub);
    for (const bmName of ['Bookmarks', 'AccountBookmarks']) {
      const f = join(profDir, bmName);
      if (existsSync(f)) {
        candidates.push({ bmFile: f, profDir, baseDir, favFile: join(profDir, 'Favicons') });
      }
    }
  }
};

if (process.platform === 'darwin') {
  const appSup = join(home, 'Library', 'Application Support');
  addRoot(join(appSup, 'Google', 'Chrome'));
  addRoot(join(appSup, 'Citro Labs', 'ego lite'));
  addRoot(join(appSup, 'Microsoft Edge'));
  addRoot(join(appSup, 'BraveSoftware', 'Brave-Browser'));
  addRoot(join(appSup, 'Comet'));
  addRoot(join(appSup, 'Chromium'));
} else if (process.platform === 'win32') {
  const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  addRoot(join(localApp, 'Google', 'Chrome', 'User Data'));
  addRoot(join(localApp, 'Microsoft', 'Edge', 'User Data'));
  addRoot(join(localApp, 'BraveSoftware', 'Brave-Browser', 'User Data'));
  addRoot(join(localApp, 'Chromium', 'User Data'));
} else {
  const cfg = join(home, '.config');
  addRoot(join(cfg, 'google-chrome'));
  addRoot(join(cfg, 'microsoft-edge'));
  addRoot(join(cfg, 'BraveSoftware', 'Brave-Browser'));
  addRoot(join(cfg, 'chromium'));
}

let bestCandidate = null;
let bestScore = 0;
for (const c of candidates) {
  const n = countBookmarks(c.bmFile);
  if (n <= 0) continue;
  const favSz = fileSize(c.favFile);
  const lsSz = dirSize(join(c.profDir, 'Local Storage', 'leveldb'));
  const score = n * 1000 + (favSz > 100000 ? 500 : 0) + (lsSz > 500000 ? 300 : 0);
  if (score > bestScore) {
    bestScore = score;
    bestCandidate = { ...c, count: n, favSz, lsSz };
  }
}

if (bestCandidate) {
  const needBookmarks = forceSync || countBookmarks(dstBookmarks) === 0;
  if (needBookmarks) {
    try {
      copyFileSync(bestCandidate.bmFile, dstBookmarks);
      try { copyFileSync(bestCandidate.bmFile, dstAccountBookmarks); } catch {}
      console.log(`Synced ${bestCandidate.count} bookmarks from: ${bestCandidate.bmFile}`);
    } catch {}
  }

  // Always ensure Favicons SQLite DB is synced 1:1 if missing, smaller than source, or --force
  const curFavSz = fileSize(dstFavicons);
  if (bestCandidate.favSz > 0 && (forceSync || curFavSz < 100000 || curFavSz < bestCandidate.favSz * 0.5)) {
    try {
      replaceSqliteFile(bestCandidate.favFile, dstFavicons);
      console.log(`Synced Favicons DB (${Math.round(bestCandidate.favSz / 1024)} KB) from: ${bestCandidate.favFile}`);
    } catch {}
  }

  // Login Data, Login Data For Account, and Web Data are encrypted under
  // os_crypt.encrypted_key. Sync them when both profiles lack a key (typical
  // Linux/macOS) or both keys are equal. When both keys exist and differ, keep
  // the destination files and their -wal/-journal/-shm sidecars: Local State
  // still holds the destination key, so copied rows would be undecryptable.
  // Cookies that are already >= 64KB never refresh that key.
  const loginSrcOsCrypt = readSourceOsCrypt(join(bestCandidate.baseDir, 'Local State'));
  const loginDstOsCrypt = readSourceOsCrypt(join(profileRoot, 'Local State'));
  const loginSrcKey = loginSrcOsCrypt ? loginSrcOsCrypt.encrypted_key : null;
  const loginDstKey = loginDstOsCrypt ? loginDstOsCrypt.encrypted_key : null;
  const loginKeysConflict = loginSrcKey !== null && loginDstKey !== null && loginSrcKey !== loginDstKey;

  // Sync Login Data, Login Data For Account, and Web Data if missing or smaller in profile-agent
  for (const dbName of ['Login Data', 'Login Data For Account', 'Web Data']) {
    const srcDb = join(bestCandidate.profDir, dbName);
    const dstDb = join(profileDef, dbName);
    const srcSz = fileSize(srcDb);
    const dstSz = fileSize(dstDb);
    if (srcSz > 0 && (forceSync || dstSz < srcSz * 0.5)) {
      if (loginKeysConflict) {
        console.log(`Skipped ${dbName} sync: source and destination os_crypt.encrypted_key differ`);
        continue;
      }
      try {
        replaceSqliteFile(srcDb, dstDb);
      } catch {}
    }
  }

  // Sync Local State os_crypt & initial Cookies DB when profile-agent Cookies is empty/tiny.
  // The source key is read and validated *before* any file is replaced: copying Cookies first
  // and failing to write os_crypt leaves cookies encrypted with a key the destination does not
  // have, and once the destination Cookies reach 64 KB the sync never retries (permanent loss).
  const srcCookies = existsSync(join(bestCandidate.profDir, 'Network', 'Cookies'))
    ? join(bestCandidate.profDir, 'Network', 'Cookies')
    : join(bestCandidate.profDir, 'Cookies');
  const dstCookiesDir = process.platform === 'win32' ? join(profileDef, 'Network') : profileDef;
  const dstCookies = join(dstCookiesDir, 'Cookies');
  if (fileSize(srcCookies) > 32768 && (forceSync || fileSize(dstCookies) < 65536)) {
    const srcLocalStatePath = join(bestCandidate.baseDir, 'Local State');
    const dstLocalStatePath = join(profileRoot, 'Local State');
    const srcOsCrypt = readSourceOsCrypt(srcLocalStatePath);
    if (!srcOsCrypt) {
      console.log('Skipped Cookies sync: source Local State has no usable os_crypt');
    } else if (loginKeysConflict) {
      // Replacing the destination `os_crypt.encrypted_key` with the source one strands every
      // key-dependent row that stays in profile-agent (the Login Data / Web Data files kept by the
      // block above, which this branch does not replace): they were encrypted under the
      // destination key, and the swap deletes exactly that key. The result is a destination whose
      // logins can never be decrypted again — the very loss the Login Data block refuses to cause.
      // A key conflict must therefore leave the whole destination pair (Local State + Cookies)
      // untouched, keeping key and payload consistent.
      console.log('Skipped Cookies sync: source and destination os_crypt.encrypted_key differ');
    } else {
      // Stage both files next to the destination, then swap them in an order that can be rolled
      // back. Local State (the decryption key) is replaced first and restored from the snapshot
      // below if the Cookies swap fails: otherwise a failed swap would leave the old, differently
      // encrypted Cookies DB next to the new key, so every existing login would become
      // undecryptable — strictly worse than not syncing at all.
      const tmpCookies = `${dstCookies}.fmb-sync-tmp`;
      const tmpLocalState = `${dstLocalStatePath}.fmb-sync-tmp`;
      // Snapshot the raw bytes (not a UTF-8 decode/re-encode) so a failed swap puts back the exact
      // same file, byte for byte, even if it was not valid UTF-8.
      let prevLocalState = null;
      try { if (existsSync(dstLocalStatePath)) prevLocalState = readFileSync(dstLocalStatePath); } catch { prevLocalState = null; }
      try {
        mkdirSync(dstCookiesDir, { recursive: true });
        copyFileSync(srcCookies, tmpCookies);
        const dstLs = readDestinationLocalState(dstLocalStatePath);
        dstLs.os_crypt = srcOsCrypt;
        writeFileSync(tmpLocalState, JSON.stringify(dstLs), 'utf8');
        renameSync(tmpLocalState, dstLocalStatePath);
        try {
          renameSync(tmpCookies, dstCookies);
        } catch (swapErr) {
          // Cookies could not be replaced: put the previous key back so the pair stays intact.
          // Cookies-journal/-wal/-shm are deliberately left untouched: the destination DB is still
          // the live one after a failed swap, and those sidecars carry its un-checkpointed writes.
          try {
            if (prevLocalState === null) {
              if (existsSync(dstLocalStatePath)) unlinkSync(dstLocalStatePath);
            } else {
              writeFileSync(dstLocalStatePath, prevLocalState);
            }
          } catch {}
          throw swapErr;
        }
        // The rename succeeded, so `dstCookies` is now the freshly copied database and the old
        // sidecars describe a DB that no longer exists — dropping them here cannot lose anything.
        for (const ext of ['-journal', '-wal', '-shm']) {
          try { if (existsSync(dstCookies + ext)) unlinkSync(dstCookies + ext); } catch {}
        }
        console.log(`Synced Cookies (${Math.round(fileSize(srcCookies) / 1024)} KB) + Local State os_crypt from: ${srcCookies}`);
      } catch {
        for (const tmp of [tmpCookies, tmpLocalState]) {
          try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
        }
      }
    }
  }

  // Sync Local Storage leveldb if profile-agent Local Storage is empty/small (< 2 MB vs larger source)
  const srcLsDir = join(bestCandidate.profDir, 'Local Storage', 'leveldb');
  const dstLsDir = join(profileDef, 'Local Storage', 'leveldb');
  const srcLsSz = dirSize(srcLsDir);
  const dstLsSz = dirSize(dstLsDir);
  if (srcLsSz > 0 && (forceSync || (dstLsSz < 1500000 && dstLsSz < srcLsSz * 0.3))) {
    try {
      syncTreeStaged(srcLsDir, dstLsDir, (name) => name !== 'LOCK');
      console.log(`Synced Local Storage (${Math.round(srcLsSz / 1024)} KB) from: ${srcLsDir}`);
    } catch {}
  }

  // Sync missing https_* IndexedDB origins from primary browser into profile-agent
  const srcIdbDir = join(bestCandidate.profDir, 'IndexedDB');
  const dstIdbDir = join(profileDef, 'IndexedDB');
  if (existsSync(srcIdbDir)) {
    try {
      mkdirSync(dstIdbDir, { recursive: true });
      for (const entry of readdirSync(srcIdbDir)) {
        if (!entry.startsWith('https_')) continue;
        const dstEntry = join(dstIdbDir, entry);
        if (!existsSync(dstEntry)) {
          try {
            syncTreeStaged(join(srcIdbDir, entry), dstEntry, (name) => name !== 'LOCK');
          } catch {}
        }
      }
    } catch {}
  }
}

