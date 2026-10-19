#!/usr/bin/env node
// Automatically initializes `profile-agent/Default/Preferences` to always show the
// native Bookmarks Bar (`bookmark_bar.show_on_all_tabs = true`) and imports the
// user's existing local browser Bookmarks + Favicons (1:1 icon fidelity) into `profile-agent/Default/`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const home = homedir();
const dataDir = process.env.EGO_LINUX_DATA_DIR || join(home, '.local', 'share', 'ego-linux');
const profileDef = join(dataDir, 'profile-agent', 'Default');
mkdirSync(profileDef, { recursive: true });

// 1. Force native Bookmarks Bar (`show_on_all_tabs: true`) in Default/Preferences
const prefsPath = join(profileDef, 'Preferences');
let prefs = {};
if (existsSync(prefsPath)) {
  try { prefs = JSON.parse(readFileSync(prefsPath, 'utf8')); } catch { prefs = {}; }
}
if (!prefs.bookmark_bar || typeof prefs.bookmark_bar !== 'object') prefs.bookmark_bar = {};
prefs.bookmark_bar.show_on_all_tabs = true;
if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
if (!prefs.profile.name || prefs.profile.name === 'Person 1' || prefs.profile.name === '第一位使用者') {
  prefs.profile.name = '⚡ TooPower';
}
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

const dstBookmarks = join(profileDef, 'Bookmarks');
const dstAccountBookmarks = join(profileDef, 'AccountBookmarks');
const dstFavicons = join(profileDef, 'Favicons');
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
        candidates.push({ bmFile: f, profDir, favFile: join(profDir, 'Favicons') });
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
  // Score combines bookmark count + whether Favicons DB exists and is populated
  const favSz = fileSize(c.favFile);
  const score = n * 1000 + (favSz > 100000 ? 500 : 0);
  if (score > bestScore) {
    bestScore = score;
    bestCandidate = { ...c, count: n, favSz };
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
}
