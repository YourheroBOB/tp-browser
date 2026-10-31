#!/usr/bin/env node
// Automatically initializes `profile-agent/Default/Preferences` to always show the
// native Bookmarks Bar (`bookmark_bar.show_on_all_tabs = true`), enable session persistence,
// and import the user's existing local browser Bookmarks & Favicons.
// RG-A1: saved logins, cookies, os_crypt key, Web Data, Local Storage & IndexedDB are copied ONLY
// when explicitly requested (--sync-auth / --import-auth / TP_IMPORT_AUTH=1). Default is a clean agent profile.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
if (!prefs.bookmark_bar || typeof prefs.bookmark_bar !== 'object') prefs.bookmark_bar = {};
prefs.bookmark_bar.show_on_all_tabs = true;
if (!prefs.session || typeof prefs.session !== 'object') prefs.session = {};
prefs.session.restore_on_startup = 1;
if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
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

const dstBookmarks = join(profileDef, 'Bookmarks');
const dstAccountBookmarks = join(profileDef, 'AccountBookmarks');
const dstFavicons = join(profileDef, 'Favicons');
const syncAuth = process.argv.includes('--sync-auth') || process.argv.includes('--import-auth') || process.env.TP_IMPORT_AUTH === '1';
// RG-A1b: --sync-auth only widens WHAT is copied; it no longer bypasses the size guards that
// protect newer agent-side files. Use --force explicitly to overwrite.
const forceSync = process.argv.includes('--force');

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
  addRoot(join(appSup, 'Google', 'Chrome Beta'));
  addRoot(join(appSup, 'Google', 'Chrome Dev'));
  addRoot(join(appSup, 'Google', 'Chrome Canary'));
  addRoot(join(appSup, 'Citro Labs', 'ego lite'));
  addRoot(join(appSup, 'Microsoft Edge'));
  addRoot(join(appSup, 'Microsoft Edge Beta'));
  addRoot(join(appSup, 'Microsoft Edge Dev'));
  addRoot(join(appSup, 'Microsoft Edge Canary'));
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
      for (const ext of ['-journal', '-wal', '-shm']) {
        try { if (existsSync(dstFavicons + ext)) unlinkSync(dstFavicons + ext); } catch {}
      }
      copyFileSync(bestCandidate.favFile, dstFavicons);
      console.log(`Synced Favicons DB (${Math.round(bestCandidate.favSz / 1024)} KB) from: ${bestCandidate.favFile}`);
    } catch {}
  }

  if (!syncAuth) {
    console.log('Auth data (logins/cookies/storage) not imported; pass --sync-auth or TP_IMPORT_AUTH=1 to opt in.');
  } else {
    // Sync Login Data, Login Data For Account, and Web Data if missing or smaller in profile-agent
    for (const dbName of ['Login Data', 'Login Data For Account', 'Web Data']) {
      const srcDb = join(bestCandidate.profDir, dbName);
      const dstDb = join(profileDef, dbName);
      const srcSz = fileSize(srcDb);
      const dstSz = fileSize(dstDb);
      if (srcSz > 0 && (forceSync || dstSz < srcSz * 0.5)) {
        try {
          for (const ext of ['-journal', '-wal', '-shm']) {
            try { if (existsSync(dstDb + ext)) unlinkSync(dstDb + ext); } catch {}
          }
          copyFileSync(srcDb, dstDb);
        } catch {}
      }
    }

    // Sync Local State os_crypt & initial Cookies DB when profile-agent Cookies is empty/tiny
    const srcCookies = existsSync(join(bestCandidate.profDir, 'Network', 'Cookies'))
      ? join(bestCandidate.profDir, 'Network', 'Cookies')
      : join(bestCandidate.profDir, 'Cookies');
    // Chrome 96+ reads Default/Network/Cookies on macOS, Linux, and Windows.
    // Writing the legacy Default/Cookies file (the old non-Windows path) is ignored,
    // so an opt-in import on macOS never showed up in the agent profile.
    const dstCookiesDir = join(profileDef, 'Network');
    const dstCookies = join(dstCookiesDir, 'Cookies');
    if (fileSize(srcCookies) > 32768 && (forceSync || fileSize(dstCookies) < 65536)) {
      try {
        mkdirSync(dstCookiesDir, { recursive: true });
        for (const ext of ['-journal', '-wal', '-shm']) {
          try { if (existsSync(dstCookies + ext)) unlinkSync(dstCookies + ext); } catch {}
        }
        copyFileSync(srcCookies, dstCookies);
        const srcLocalStatePath = join(bestCandidate.baseDir, 'Local State');
        const dstLocalStatePath = join(profileRoot, 'Local State');
        if (existsSync(srcLocalStatePath)) {
          const srcLs = JSON.parse(readFileSync(srcLocalStatePath, 'utf8'));
          let dstLs = {};
          if (existsSync(dstLocalStatePath)) {
            try { dstLs = JSON.parse(readFileSync(dstLocalStatePath, 'utf8')); } catch { dstLs = {}; }
          }
          if (srcLs.os_crypt) {
            dstLs.os_crypt = srcLs.os_crypt;
            writeFileSync(dstLocalStatePath, JSON.stringify(dstLs), 'utf8');
          }
        }
      } catch {}
    }

    // Sync Local Storage leveldb if profile-agent Local Storage is empty/small (< 2 MB vs larger source)
    const srcLsDir = join(bestCandidate.profDir, 'Local Storage', 'leveldb');
    const dstLsDir = join(profileDef, 'Local Storage', 'leveldb');
    const srcLsSz = dirSize(srcLsDir);
    const dstLsSz = dirSize(dstLsDir);
    if (srcLsSz > 0 && (forceSync || (dstLsSz < 1500000 && dstLsSz < srcLsSz * 0.3))) {
      try {
        mkdirSync(dstLsDir, { recursive: true });
        for (const f of readdirSync(srcLsDir)) {
          if (f === 'LOCK') continue;
          try { copyFileSync(join(srcLsDir, f), join(dstLsDir, f)); } catch {}
        }
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
              cpSync(join(srcIdbDir, entry), dstEntry, {
                recursive: true,
                filter: (src) => !src.endsWith('LOCK'),
              });
            } catch {}
          }
        }
      } catch {}
    }
  }
}

