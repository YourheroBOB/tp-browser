// tests/fmb_w2_s13_ego_start_node_order.test.mjs
// 迴歸測試（s13）：ego-start.ps1 必須先確認找得到 node.exe（與 daemon 進入點），才可 flush-and-close
// 並強殺正在運作的 daemon／瀏覽器。否則在沒有 node 的 Windows 上 -Restart 會先把可用的瀏覽器殺掉，
// 然後才發現 node 不存在而 exit 1。
//
// 零依賴、零網路、零真實憑證：
//   - 有 pwsh 時：以 stub 覆蓋 Get-Command / Test-Path(node.exe) / Invoke-RestMethod / Stop-Process /
//     Get-CimInstance，呼叫紀錄寫進 tmpdir 內的 log，断言找不到 node 時上述副作用全部未發生且 rc=1。
//   - 沒有 pwsh 時：改做腳本結構断言（node 探測區塊位置必須早於 flush-and-close 與 Stop-Process）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

// 以 stub 覆蓋所有會碰到外界（網路／其他程序）的指令，並把每次呼叫寫進 log。
// 只 dot-source 目標腳本；腳本本身的 param() 會吃到 -Restart。
const WRAPPER = `param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$LogPath
)

function Add-FmbCall([string]$message) {
    try { [System.IO.File]::AppendAllText($LogPath, $message + [Environment]::NewLine) } catch {}
}

function Get-Command {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Name)
    Add-FmbCall "getcommand:$Name"
    return $null
}

function Test-Path {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Path, [string]$PathType, [string]$Filter)
    if ($Path -match '(?i)node\\.exe') {
        Add-FmbCall "testpath-node:$Path"
        return $false
    }
    return Microsoft.PowerShell.Management\\Test-Path -Path $Path
}

function Invoke-RestMethod {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Uri, [int]$TimeoutSec, [string]$Method)
    Add-FmbCall "irm:$Uri"
    throw "network disabled in tests"
}

function Stop-Process {
    [CmdletBinding()]
    param([Parameter(Position = 0)][int[]]$Id, [switch]$Force)
    Add-FmbCall "stopprocess:$($Id -join ',')"
}

function Get-CimInstance {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$ClassName)
    Add-FmbCall "ciminstance:$ClassName"
    return @(
        [pscustomobject]@{ Name = 'node.exe'; ProcessId = 4242; SessionId = 1; CommandLine = 'node ego-browserd.js' },
        [pscustomobject]@{ Name = 'msedge.exe'; ProcessId = 4243; SessionId = 1; CommandLine = 'msedge.exe profile-agent' }
    )
}

. $Target -Restart
`;

test('ego-start.ps1 結構：node 探測與「找不到即失敗」必須早於 flush-and-close 與 Stop-Process', () => {
  const src = readFileSync(scriptPath, 'utf8');
  const nodeProbe = src.indexOf('$NodeBin = (Get-Command node');
  const nodeFail = src.indexOf('node.exe not found');
  const daemonFail = src.indexOf('daemon entrypoint not found');
  const flush = src.indexOf('/flush-and-close');
  const stop = src.indexOf('Stop-Process -Id');

  assert.ok(nodeProbe >= 0, '找不到 $NodeBin 探測區塊');
  assert.ok(nodeFail >= 0, '找不到 node.exe not found 的失敗訊息');
  assert.ok(daemonFail >= 0, '找不到 daemon 進入點的失敗訊息');
  assert.ok(flush >= 0, '找不到 flush-and-close 呼叫');
  assert.ok(stop >= 0, '找不到 Stop-Process 強殺');

  assert.ok(nodeProbe < flush, `node 探測（${nodeProbe}）必須早於 flush-and-close（${flush}）`);
  assert.ok(nodeProbe < stop, `node 探測（${nodeProbe}）必須早於 Stop-Process（${stop}）`);
  assert.ok(nodeFail < flush, `node 失敗退出（${nodeFail}）必須早於 flush-and-close（${flush}）`);
  assert.ok(nodeFail < stop, `node 失敗退出（${nodeFail}）必須早於 Stop-Process（${stop}）`);
  assert.ok(daemonFail < flush, `daemon 檢查（${daemonFail}）必須早於 flush-and-close（${flush}）`);
  assert.ok(daemonFail < stop, `daemon 檢查（${daemonFail}）必須早於 Stop-Process（${stop}）`);

  // 失敗必須是可見的 stderr 且立即 exit 1，不能被 $ErrorActionPreference = SilentlyContinue 吞掉
  const failLine = src.split(/\r?\n/).find((l) => l.includes('node.exe not found')) ?? '';
  assert.match(failLine, /\[Console\]::Error\.WriteLine/);
  assert.match(
    src,
    /\[Console\]::Error\.WriteLine\("ERROR: node\.exe not found!"\)\s*\r?\n\s*exit 1/,
    '找不到 node 後必須立刻 exit 1',
  );

  // 探測與失敗只能各出現一次：不可留下「先殺再檢查」的舊副本
  assert.equal(src.split('$NodeBin = (Get-Command node').length - 1, 1);
  assert.equal((src.match(/node\.exe not found/g) ?? []).length, 1);
});

test('ego-start.ps1 -Restart：找不到 node 時 exit 1，且不 flush、不列舉／不強殺既有程序', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w2-s13-node-order-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    // 只是讓 TP_BROWSER_BIN 的存在性檢查過關（內容無意義，不含任何憑證）
    const fakeBrowser = join(root, 'msedge.exe');
    writeFileSync(fakeBrowser, 'stub-browser-binary-for-test', 'utf8');
    const logPath = join(root, 'calls.log');
    writeFileSync(logPath, '', 'utf8');
    const wrapper = join(root, 'run-ego-start.ps1');
    writeFileSync(wrapper, WRAPPER, 'utf8');

    const res = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-Target', scriptPath, '-LogPath', logPath],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'LocalAppData'),
          APPDATA: join(home, 'AppData'),
          TP_BROWSER_BIN: fakeBrowser,
        },
      },
    );

    const calls = readFileSync(logPath, 'utf8');
    const stderr = String(res.stderr ?? '').replace(/\u0000/g, '');

    assert.equal(res.status, 1, `rc=${res.status} stderr=${stderr} calls=${calls} err=${res.error?.message ?? ''}`);
    assert.match(stderr, /node\.exe not found/);

    // 核心回歸：既有 daemon／瀏覽器完全不能被碰
    assert.ok(!/flush-and-close/.test(calls), `不應呼叫 flush-and-close，實際呼叫：${calls}`);
    assert.ok(!/^stopprocess:/m.test(calls), `不應呼叫 Stop-Process，實際呼叫：${calls}`);
    assert.ok(!/^ciminstance:/m.test(calls), `不應為了強殺而列舉程序，實際呼叫：${calls}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
