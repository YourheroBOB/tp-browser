// 離線冒煙：CLI 的 help / version。
// HOME 指向暫存目錄，stdin 關閉，不呼叫 doctor、status、nodejs，也不啟動瀏覽器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINS = ['bin/tp-browser.js', 'bin/ego-browser.js'];

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'fmb-smoke-cli-'));
  const data = path.join(home, '.local', 'share', 'ego-linux');
  mkdirSync(path.join(data, 'logs'), { recursive: true });
  mkdirSync(path.join(data, 'profile-agent'), { recursive: true });
  mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const fileOpts = { encoding: 'utf8', mode: 0o600 };
  writeFileSync(path.join(data, 'token'), 'FAKE_VALUE_FOR_TEST\n', fileOpts);
  // 埠 1 避開 9772/9774/18802，避免誤連到機器上已存在的 daemon。
  writeFileSync(path.join(data, 'daemon.json'), '{"port":1,"chromePort":1}\n', fileOpts);
  return home;
}

function envFor(home) {
  const temp = path.join(home, 'tmp');
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_NO_WARNINGS: '1',
    USER: 'fmb-smoke',
    LOGNAME: 'fmb-smoke',
    USERNAME: 'fmb-smoke',
  };
}

function runCli(rel, args, home) {
  return spawnSync(process.execPath, [path.join(repoRoot, rel), ...args], {
    encoding: 'utf8',
    timeout: 5000,
    cwd: home,
    env: envFor(home),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
}

function combined(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function runAccepted(rel, argLists, home, accept) {
  const attempts = [];
  for (const args of argLists) {
    const result = runCli(rel, args, home);
    const out = combined(result);
    attempts.push({
      args,
      status: result.status,
      signal: result.signal,
      excerpt: out.slice(0, 400),
    });
    if (result.error || result.signal) break;
    if (accept(result, out)) return out;
  }
  assert.fail(`${rel} ${JSON.stringify(attempts)}`);
}

function isVersion(result, out) {
  return result.status === 0
    && /0\.3\.\d+/.test(out)
    && !/unknown command|unrecognized|未知指令/i.test(out)
    && !out.includes('FAKE_VALUE_FOR_TEST');
}

function isHelp(result, out) {
  return result.status === 0
    && /nodejs|doctor|status|usage|指令|用法|skill/i.test(out)
    && !/unknown command|unrecognized|未知指令/i.test(out)
    && !out.includes('FAKE_VALUE_FOR_TEST');
}

for (const rel of BINS) {
  test(`${rel} prints a 0.3.x version offline`, () => {
    const home = makeHome();
    try {
      const out = runAccepted(rel, [['version'], ['--version']], home, isVersion);
      assert.match(out, /0\.3\.\d+/);
      assert.ok(out.length < 200000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${rel} prints help for a minimal offline invocation`, () => {
    const home = makeHome();
    try {
      const out = runAccepted(rel, [['help'], ['--help']], home, isHelp);
      assert.match(out, /nodejs|doctor|status|usage|指令|用法|skill/i);
      assert.ok(out.length < 200000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
