import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));

test(
  'tp-stop flushes the configured daemon port from pretty-printed daemon.json',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fmb-w14-s13-tp-stop-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const home = join(root, 'home');
    const dataDir = join(home, '.local', 'share', 'ego-linux');
    const bin = join(root, 'bin');
    const curlLog = join(root, 'curl.log');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(bin, { recursive: true });

    writeFileSync(
      join(dataDir, 'daemon.json'),
      '{\n  "port": 18802,\n  "chromePort": 18803\n}\n',
      'utf8',
    );
    writeFileSync(curlLog, '', 'utf8');

    const stubs = {
      curl: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\nexit 0\n',
      pgrep: '#!/bin/sh\nexit 1\n',
      pkill: '#!/bin/sh\nexit 0\n',
      sleep: '#!/bin/sh\nexit 0\n',
    };
    for (const [name, contents] of Object.entries(stubs)) {
      const path = join(bin, name);
      writeFileSync(path, contents, { mode: 0o755 });
      chmodSync(path, 0o755);
    }

    const result = spawnSync('/bin/sh', [SCRIPT], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CURL_LOG: curlLog,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /TP_STOPPED/);

    const calls = readFileSync(curlLog, 'utf8');
    assert.match(calls, /http:\/\/127\.0\.0\.1:9772\/flush-and-close/);
    assert.match(calls, /http:\/\/127\.0\.0\.1:9774\/flush-and-close/);
    assert.match(calls, /http:\/\/127\.0\.0\.1:18802\/flush-and-close/);
  },
);
