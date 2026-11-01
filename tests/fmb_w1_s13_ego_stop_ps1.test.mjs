// tests/fmb_w1_s13_ego_stop_ps1.test.mjs
// scripts/ego-stop.ps1 regression: flush-and-close must run on 9772/9774 before any Stop-Process,
// and the process filter must cover tp-browserd.js. Parses with pwsh when available.
// No network, no writes outside os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const raw = readFileSync(SCRIPT, 'utf8').replace(/^\uFEFF/, '');
const code = raw
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

test('ego-stop.ps1: flush-and-close on 9772 and 9774 happens before Stop-Process', () => {
  const stopIdx = code.indexOf('Stop-Process');
  assert.ok(stopIdx > 0, 'Stop-Process must exist');

  const flushIdx = code.indexOf('/flush-and-close');
  assert.ok(flushIdx >= 0, 'flush-and-close call must exist');
  assert.ok(flushIdx < stopIdx, 'flush-and-close must come before Stop-Process');

  for (const port of ['9772', '9774']) {
    const m = new RegExp(`\\b${port}\\b`).exec(code);
    assert.ok(m, `port ${port} must be targeted`);
    assert.ok(m.index < stopIdx, `port ${port} must be flushed before Stop-Process`);
  }

  const portsInit = /\$Ports\s*=\s*@\(\s*9772\s*,\s*9774\s*\)/.exec(code);
  assert.ok(portsInit, '$Ports must start with 9772 and 9774');
  const loop = /foreach\s*\(\s*\$Port\s+in\s+\$Ports\s*\)\s*\{[\s\S]*?http:\/\/127\.0\.0\.1:\$Port\/flush-and-close/.exec(code);
  assert.ok(loop, 'flush-and-close must be called for every port in $Ports');
  assert.ok(loop.index < stopIdx);
});

test('ego-stop.ps1: flush uses a 3s timeout, ignores failures, then sleeps before killing', () => {
  const stopIdx = code.indexOf('Stop-Process');
  assert.match(code, /flush-and-close[^\n]*-TimeoutSec\s+3\b/);
  assert.match(code, /try\s*\{[^}]*flush-and-close[^}]*\}\s*catch\s*\{\s*\}/);

  const sleep = /Start-Sleep\s+(-Milliseconds\s+(\d+)|-Seconds\s+(\d+(?:\.\d+)?))/.exec(code);
  assert.ok(sleep, 'Start-Sleep must exist');
  const ms = sleep[2] !== undefined ? Number(sleep[2]) : Number(sleep[3]) * 1000;
  assert.ok(ms >= 500 && ms <= 3000, `sleep should be about 1s, got ${ms}ms`);
  assert.ok(sleep.index > code.lastIndexOf('/flush-and-close'), 'sleep must follow flush');
  assert.ok(sleep.index < stopIdx, 'sleep must precede Stop-Process');
});

test('ego-stop.ps1: process filter covers tp-browserd.js, ego-browserd.js and the agent profile', () => {
  const where = /Where-Object\s*\{([\s\S]*?)\}\s*\|\s*ForEach-Object/.exec(code);
  assert.ok(where, 'Where-Object filter must exist');
  const filter = where[1];
  assert.match(filter, /-like\s+"\*tp-browserd\.js\*"/);
  assert.match(filter, /-like\s+"\*ego-browserd\.js\*"/);
  assert.match(filter, /-like\s+"\*ego-linux\*profile-agent\*"/);
  assert.match(filter, /node\|chrome\|msedge\|brave/);
});

function hasPwsh() {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return !r.error && r.status === 0;
}

test('ego-stop.ps1: PowerShell parser reports no syntax errors', (t) => {
  if (!hasPwsh()) {
    t.skip('pwsh not available');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'fmb-w1-s13-pwsh-'));
  try {
    const cmd = [
      '$tokens = $null; $errs = $null;',
      '[void][System.Management.Automation.Language.Parser]::ParseFile($env:FMB_PS1_PATH, [ref]$tokens, [ref]$errs);',
      'if ($errs.Count -gt 0) { $errs | ForEach-Object { $_.Message }; exit 1 }; exit 0',
    ].join(' ');
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FMB_PS1_PATH: SCRIPT,
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        POWERSHELL_UPDATECHECK: 'Off',
      },
    });
    assert.ifError(r.error);
    assert.equal(r.status, 0, `parse errors:\n${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
