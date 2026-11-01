import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const egoStopScript = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w9-s02-ego-stop-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8',
  timeout: 5000,
});
const hasPwsh = !pwshProbe.error && pwshProbe.status === 0;
const maybe = hasPwsh ? test : test.skip;

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runScenario({ home, procs, noOpStop }) {
  const killLog = join(home, 'stopped-pids.txt');
  const wrapper = join(home, 'runner.ps1');
  const procLines = procs
    .map((p) => `[pscustomobject]@{ Name = ${psQuote(p.name)}; CommandLine = ${psQuote(p.commandLine)}; ProcessId = ${p.pid} }`)
    .join('\n  ');
  const wrapperText = `$ErrorActionPreference = 'Continue'
$HOME = ${psQuote(home)}
$global:FakeProcs = @(
  ${procLines}
)
$global:KillLog = ${psQuote(killLog)}
$global:NoOpStop = ${noOpStop ? '$true' : '$false'}
function Invoke-WebRequest { param([string]$Uri, [string]$Method, [switch]$UseBasicParsing, [int]$TimeoutSec, $ErrorAction) }
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }
function Get-CimInstance { param([string]$ClassName) return $global:FakeProcs }
function Stop-Process {
  param([int]$Id, [switch]$Force, $ErrorAction)
  Add-Content -Path $global:KillLog -Value $Id
  if (-not $global:NoOpStop) {
    $global:FakeProcs = @($global:FakeProcs | Where-Object { $_.ProcessId -ne $Id })
  }
}
. ${psQuote(egoStopScript)}
`;
  writeFileSync(wrapper, wrapperText, 'utf8');
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let killed = [];
  if (existsSync(killLog)) {
    killed = readFileSync(killLog, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    killed,
  };
}

maybe('ego-stop.ps1 會停止以 profile-agent 為 user-data-dir 的自訂 Chromium exe', () => {
  const home = mkdtempSync(join(tempRoot, 'custom-exe-'));
  const profile = join(home, '.local', 'share', 'ego-linux', 'profile-agent');
  const res = runScenario({
    home,
    noOpStop: false,
    procs: [
      {
        name: 'thorium.exe',
        commandLine: `--user-data-dir=${profile} --headless=new --remote-debugging-port=9773 about:blank`,
        pid: 4242,
      },
    ],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EGO_STOPPED \(terminated 1 processes\)/);
  assert.ok(res.killed.includes('4242'), `killed=${JSON.stringify(res.killed)}`);
});

maybe('ego-stop.ps1 在自訂瀏覽器仍存在時回報 EGO_STOP_FAILED 並 exit 1', () => {
  const home = mkdtempSync(join(tempRoot, 'still-running-'));
  const profile = join(home, '.local', 'share', 'ego-linux', 'profile-agent');
  const res = runScenario({
    home,
    noOpStop: true,
    procs: [
      {
        name: 'thorium.exe',
        commandLine: `--user-data-dir=${profile} --headless=new --remote-debugging-port=9773 about:blank`,
        pid: 4243,
      },
    ],
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /EGO_STOP_FAILED/);
  assert.ok(res.killed.includes('4243'), `killed=${JSON.stringify(res.killed)}`);
});

maybe('ego-stop.ps1 不會停止不帶該 profile-agent user-data-dir 的 thorium.exe', () => {
  const home = mkdtempSync(join(tempRoot, 'other-profile-'));
  const otherProfile = join(home, '.local', 'share', 'ego-linux', 'profile-other');
  const res = runScenario({
    home,
    noOpStop: false,
    procs: [
      {
        name: 'thorium.exe',
        commandLine: `--user-data-dir=${otherProfile} --headless=new --remote-debugging-port=9773 about:blank`,
        pid: 777,
      },
      {
        name: 'thorium.exe',
        commandLine: `--headless=new --remote-debugging-port=9773 about:blank`,
        pid: 778,
      },
    ],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /EGO_STOPPED \(terminated 0 processes\)/);
  assert.equal(res.killed.length, 0, `killed=${JSON.stringify(res.killed)}`);
});
