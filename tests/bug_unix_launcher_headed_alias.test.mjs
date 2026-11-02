import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ego-browser.js');

function launcherArgs(cliArgs) {
  const home = mkdtempSync(join(tmpdir(), 'ego-bug-launcher-'));
  const scriptDir = join(home, '.local', 'share', 'ego-linux', 'app', 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  const argvFile = join(home, 'launcher-argv.txt');
  writeFileSync(
    join(scriptDir, 'tp-start.sh'),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TP_LAUNCHER_ARGV"\nexit 0\n',
  );
  try {
    const r = spawnSync(process.execPath, [cli, ...cliArgs], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, HOME: home, TP_LAUNCHER_ARGV: argvFile },
    });
    assert.equal(r.error, undefined);
    const recorded = readFileSync(argvFile, 'utf8').replace(/\n$/, '').split('\n');
    return { status: r.status, recorded };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('ego-browser start headed passes --headed to tp-start.sh', () => {
  const { status, recorded } = launcherArgs(['start', 'headed']);
  assert.equal(status, 0);
  assert.deepEqual(recorded, ['--headed']);
});

test('ego-browser start -AltPort passes --alt-port to tp-start.sh', () => {
  const { status, recorded } = launcherArgs(['start', '-AltPort']);
  assert.equal(status, 0);
  assert.deepEqual(recorded, ['--alt-port']);
});
