// Offline CLI smoke: help, version, and empty input.
// Fake HOME only. Does not start daemons or browsers.
// Run: node --test tests/fmb_smoke_cli.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);
const CLIS = ['bin/tp-browser.js', 'bin/ego-browser.js'];

function offlineEnv(home) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_CACHE_HOME: join(home, 'xdg-cache'),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    LANG: 'C',
    LC_ALL: 'C',
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'tp-fmb-smoke-'));
  mkdirSync(join(home, 'xdg-config'), { recursive: true });
  mkdirSync(join(home, 'xdg-data'), { recursive: true });
  mkdirSync(join(home, 'xdg-cache'), { recursive: true });
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function formatRun(r) {
  const err = r && r.error ? r.error.message : '';
  return [
    `status=${r && r.status}`,
    `signal=${r && r.signal}`,
    err ? `error=${err}` : '',
    `stdout=${JSON.stringify(r && r.stdout || '').slice(0, 500)}`,
    `stderr=${JSON.stringify(r && r.stderr || '').slice(0, 500)}`,
  ].filter(Boolean).join(' ');
}

function assertNoHostHome(text) {
  for (const key of ['HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value && value.length > 3) {
      assert.equal(String(text).includes(value), false, `${key} appeared in smoke output`);
    }
  }
}

function runCli(rel, args, home) {
  return spawnSync(process.execPath, [join(repoRoot, rel), ...args], {
    cwd: home,
    env: offlineEnv(home),
    encoding: 'utf8',
    timeout: 8000,
    killSignal: 'SIGKILL',
    input: '',
  });
}

function firstMatch(rel, forms, predicate, home) {
  const dumps = [];
  for (const form of forms) {
    const r = runCli(rel, form, home);
    if (r.status === null || r.signal) {
      assert.fail(`${rel} ${form.join(' ')} did not exit: ${formatRun(r)}`);
    }
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    assertNoHostHome(text);
    dumps.push({ form, status: r.status, text: text.slice(0, 500) });
    if (predicate(r, text)) return;
  }
  assert.fail(JSON.stringify(dumps, null, 1));
}

describe('fmb smoke cli', { concurrency: 1 }, () => {
  for (const rel of CLIS) {
    test(`${rel} answers version offline`, { timeout: 20000 }, () => {
      withTempHome((home) => {
        firstMatch(
          rel,
          [['version'], ['--version'], ['-v']],
          (r, text) => r.status === 0 && /0\.3\.\d+/.test(text),
          home,
        );
      });
    });

    test(`${rel} answers help offline`, { timeout: 30000 }, () => {
      withTempHome((home) => {
        firstMatch(
          rel,
          [['help'], ['--help'], ['-h']],
          (r, text) => r.status === 0
            && /version|版本/i.test(text)
            && /tp-browser|ego-browser|toopower|doctor|status|nodejs|skill|usage|用法|指令/i.test(text),
          home,
        );
      });
    });

    test(`${rel} answers empty args offline`, { timeout: 20000 }, () => {
      withTempHome((home) => {
        const r = runCli(rel, [], home);
        assert.equal(r.signal, null, formatRun(r));
        assert.ok(r.status === 0 || r.status === 1 || r.status === 2, formatRun(r));
        const text = `${r.stdout || ''}\n${r.stderr || ''}`;
        assert.ok(text.trim().length > 0, formatRun(r));
        assertNoHostHome(text);
      });
    });
  }
});
