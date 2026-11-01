import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w1-s06-profile-init-'));
const home = join(tempRoot, 'empty-home');
const script = fileURLToPath(new URL('../tools/profile-init.js', import.meta.url));

mkdirSync(home);
after(() => rmSync(tempRoot, { recursive: true, force: true }));

test('profile-init replaces valid non-object Preferences JSON and writes required settings', () => {
  for (const content of ['null', '[]', '42']) {
    const dataDir = join(tempRoot, `data-${content.replace(/\W/g, '_')}`);
    const profileDef = join(dataDir, 'profile-agent', 'Default');
    mkdirSync(profileDef, { recursive: true });
    writeFileSync(join(profileDef, 'Preferences'), content, 'utf8');

    const result = spawnSync(process.execPath, [script], {
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

    assert.equal(result.status, 0, `input ${content}: ${result.stderr}`);
    const prefs = JSON.parse(readFileSync(join(profileDef, 'Preferences'), 'utf8'));
    assert.equal(prefs.bookmark_bar.show_on_all_tabs, true, `input ${content}`);
    assert.equal(prefs.session.restore_on_startup, 1, `input ${content}`);
  }
});
