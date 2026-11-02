import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ego-browser.js');

function runNodeJs(args) {
  const home = mkdtempSync(join(tmpdir(), 'ego-nodejs-opt-'));
  try {
    return spawnSync(process.execPath, [cli, 'nodejs', ...args], {
      input: '',
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('ego-browser nodejs --eval is rejected and does not fall through to stdin', () => {
  const r = runNodeJs(['--eval', 'console.log("SHOULD_NOT_RUN")']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --eval/);
  assert.match(r.stderr, /only -e is supported/);
  assert.doesNotMatch(r.stderr, /script is empty/);
  assert.equal(r.stdout, '');
});

test('ego-browser nodejs -z is rejected and does not fall through to stdin', () => {
  const r = runNodeJs(['-z']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option -z/);
  assert.doesNotMatch(r.stderr, /script is empty/);
  assert.doesNotMatch(r.stderr, /pass -e "code" or pipe a heredoc/);
  assert.equal(r.stdout, '');
});
