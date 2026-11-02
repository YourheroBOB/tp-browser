import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as cli from '../bin/tp-browser.js';

const cliSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tp-browser.js'),
  'utf8',
);

test('nodejs script process.exitCode is the CLI status when the script did not throw', () => {
  assert.match(
    cliSrc,
    /process\.exit\(cliExitCode\(exitCode,\s*process\.exitCode\)\)/,
  );
  assert.equal(typeof cli.cliExitCode, 'function');
  assert.equal(cli.cliExitCode(0, 2), 2);
  assert.equal(cli.cliExitCode(0, 0), 0);
});

test('a thrown script still exits 1 and an unset exit code stays 0', () => {
  assert.equal(typeof cli.cliExitCode, 'function');
  assert.equal(cli.cliExitCode(1, 4), 1);
  assert.equal(cli.cliExitCode(0, undefined), 0);
  assert.equal(cli.cliExitCode(0, 1.5), 0);
});
