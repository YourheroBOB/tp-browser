import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, 'bin', 'tp-browser.js');

test('tp-browser unknown subcommand exits 2 and keeps usage off stdout', () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-bug-unknown-cmd-'));
  try {
    const r = spawnSync(process.execPath, [cli, 'statsu'], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
      },
    });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /unknown command "statsu"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
