#!/usr/bin/env node
// Automatically initializes `profile-agent/Default/Preferences` to always show the
// native Bookmarks Bar (`bookmark_bar.show_on_all_tabs = true`) and imports the
// user's existing local browser Bookmarks if `profile-agent/Default/Bookmarks` is empty.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// 2. Auto-import user's existing Bookmarks if profile-agent/Default/Bookmarks is missing or empty
function countBookmarks(file) {
  if (!existsSync(file)) return 0;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const b1 = (j.roots?.bookmark_bar?.children || []).length;
    const b2 = (j.roots?.other?.children || []).length;
    return b1 + b2;
  } catch { return 0; }
}

const dstBookmarks = join(profileDef, 'Bookmarks');
const forceSync = process.argv.includes('--force');

if (forceSync || countBookmarks(dstBookmarks) === 0) {
  const candidates = [];
  const addRoot = (baseDir) => {
    if (!baseDir || !existsSync(baseDir)) return;
    for (const sub of ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4', 'Profile 5']) {
      const f = join(baseDir, sub, 'Bookmarks');
      if (existsSync(f)) candidates.push(f);
    }
    try {
      for (const entry of readdirSync(baseDir)) {
        const f = join(baseDir, entry, 'Bookmarks');
        if (existsSync(f)) candidates.push(f);
      }
    } catch {}
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

  let bestFile = null;
  let bestCount = 0;
  for (const c of candidates) {
    const n = countBookmarks(c);
    if (n > bestCount) { bestCount = n; bestFile = c; }
  }

  if (bestFile && bestCount > 0) {
    try {
      copyFileSync(bestFile, dstBookmarks);
      console.log(`Synced ${bestCount} bookmarks from: ${bestFile}`);
    } catch {}
  }
}
