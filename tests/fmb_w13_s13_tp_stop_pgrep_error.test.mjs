import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Check the next standard location.
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

test('tp-stop refuses to report success when pgrep fails', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w13-s13-tp-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // The test uses only temporary HOME and command stubs; curl cannot reach a service
  // and pkill cannot signal real processes.
  const stubs = {
    curl: '#!/bin/sh\nexit 22\n',
    pkill: '#!/bin/sh\nexit 0\n',
    pgrep: '#!/bin/sh\nexit 2\n',
    sleep: '#!/bin/sh\nexit 0\n',
  };

  symlinkSync(findExecutable('sed'), join(bin, 'sed'));
  for (const [name, contents] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, contents, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  const result = spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    timeout: 5000,
    env: { HOME: home, PATH: bin },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pgrep failed; refusing to report success/);
  assert.match(result.stdout, /TP_STOP_FAILED/);
  assert.doesNotMatch(result.stdout, /TP_STOPPED/);
});
