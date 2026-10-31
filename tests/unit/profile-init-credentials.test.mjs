import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'tools/profile-init.js');

function runInit(home, prefs) {
  const data = join(home, '.local', 'share', 'ego-linux');
  const def = join(data, 'profile-agent', 'Default');
  mkdirSync(def, { recursive: true });
  const prefsPath = join(def, 'Preferences');
  if (prefs !== undefined) writeFileSync(prefsPath, JSON.stringify(prefs));
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, EGO_LINUX_DATA_DIR: data },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(prefsPath, 'utf8'));
}

test('profile-init leaves credentials keys alone when missing or false', () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-pi-'));
  try {
    const missing = runInit(home);
    assert.equal(Object.hasOwn(missing, 'credentials_enable_service'), false);
    assert.equal(Object.hasOwn(missing, 'credentials_enable_autosignin'), false);
    const home2 = mkdtempSync(join(tmpdir(), 'tp-pi2-'));
    try {
      const kept = runInit(home2, { credentials_enable_service: false, credentials_enable_autosignin: false });
      assert.equal(kept.credentials_enable_service, false);
      assert.equal(kept.credentials_enable_autosignin, false);
    } finally { rmSync(home2, { recursive: true, force: true }); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
