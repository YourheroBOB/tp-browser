// 離線冒煙：只做語法檢查與靜態契約字串檢查。
// 不執行 daemon、安裝器、啟動／停止腳本、profile-init 或頁面端代理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHECK_JS = [
  'bin/ego-browser.js',
  'bin/tp-browser.js',
  'daemon/cdp.js',
  'daemon/ego-browserd.js',
  'daemon/inpage.agent.js',
  'daemon/keys.js',
  'daemon/page-ops.js',
  'daemon/store.js',
  'daemon/tp-browserd.js',
  'lib/sdk.js',
  'tools/profile-init.js',
  'fmb_feature2/cli.js',
  'fmb_feature2/reaper.js',
  'tests/serve.mjs',
  'tests/bench/bench-server.mjs',
];

const CHECK_SH = [
  'install.sh',
  'scripts/tp-start.sh',
  'scripts/tp-stop.sh',
];

function checkSyntax(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    `${label}\n${result.error?.message ?? ''}\n${result.stderr ?? ''}`,
  );
}

for (const rel of CHECK_JS) {
  test(`node --check ${rel}`, () => {
    const abs = path.join(repoRoot, rel);
    checkSyntax(process.execPath, ['--check', abs], rel);
    if (rel === 'daemon/inpage.agent.js') {
      const src = readFileSync(abs, 'utf8');
      assert.match(src, /__egoAgent/);
    }
  });
}

for (const rel of CHECK_SH) {
  test(`sh -n ${rel}`, () => {
    checkSyntax('/bin/sh', ['-n', path.join(repoRoot, rel)], rel);
  });
}

test('package.json bins exist and stay on the 0.3.x line', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'tp-browser');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.version, /^0\.3\.\d+$/);
  for (const rel of Object.values(pkg.bin)) {
    assert.equal(existsSync(path.join(repoRoot, rel)), true, rel);
  }
});

test('tp-start.sh keeps the loopback ready contract', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/tp-start.sh'), 'utf8');
  assert.match(src, /127\.0\.0\.1/);
  assert.match(src, /TP_READY/);
});

test('tp-stop.sh keeps the loopback stop contract', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/tp-stop.sh'), 'utf8');
  assert.match(src, /127\.0\.0\.1/);
  assert.match(src, /TP_STOPPED/);
});

test('ego-stop.ps1 keeps the loopback stop contract', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/ego-stop.ps1'), 'utf8');
  assert.match(src, /127\.0\.0\.1/);
  assert.match(src, /EGO_STOPPED/);
});

test('systemd units point at loopback chrome and the daemon script', () => {
  const chrome = readFileSync(path.join(repoRoot, 'scripts/ego-linux-chrome.service'), 'utf8');
  const daemon = readFileSync(path.join(repoRoot, 'scripts/ego-linux-browserd.service'), 'utf8');
  assert.match(chrome, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(chrome, /--remote-debugging-port=9773/);
  assert.match(daemon, /ego-browserd\.js/);
});

test('windows entry files are present and not launched', () => {
  const cmd = readFileSync(path.join(repoRoot, 'install.cmd'), 'utf8');
  assert.match(cmd, /install\.ps1/);
  for (const rel of ['scripts/ego-start.ps1', 'install.ps1']) {
    const src = readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.ok(src.length > 0, rel);
  }
});
