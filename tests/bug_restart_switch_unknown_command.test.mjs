import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

test('ego-browser -Restart runs the restart launcher instead of unknown command', () => {
  const home = mkdtempSync(join(tmpdir(), 'ego-bug-restart-'));
  try {
    const scripts = join(home, '.local', 'share', 'ego-linux', 'app', 'scripts');
    mkdirSync(scripts, { recursive: true });
    const argsFile = join(home, 'launcher-args.txt');
    writeFileSync(
      join(scripts, 'tp-start.sh'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TP_TEST_LAUNCH_ARGS"\nexit 0\n',
    );
    const cli = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '-Restart'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TP_TEST_LAUNCH_ARGS: argsFile },
      timeout: 5000,
    });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(readFileSync(argsFile, 'utf8').trim(), '--restart');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
