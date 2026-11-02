// Syntax-only smoke for POSIX launchers.
// These scripts are not executed: tp-start would launch a browser and touch a data dir.
// Run: node --test tests/fmb_smoke_launchers.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const SHELLS = [
  'install.sh',
  'scripts/tp-start.sh',
  'scripts/tp-stop.sh',
];

describe('fmb smoke launchers', { concurrency: 1 }, () => {
  for (const rel of SHELLS) {
    test(`sh -n ${rel}`, { timeout: 15000 }, () => {
      const abs = join(repoRoot, rel);
      assert.equal(existsSync(abs), true, abs);
      const r = spawnSync('sh', ['-n', abs], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 8000,
      });
      const err = r.error ? r.error.message : '';
      assert.equal(r.status, 0, `status=${r.status} signal=${r.signal} error=${err} stderr=${r.stderr || ''}`);
    });
  }
});
