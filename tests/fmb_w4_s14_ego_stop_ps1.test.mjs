// tests/fmb_w4_s14_ego_stop_ps1.test.mjs
// scripts/ego-stop.ps1 的回歸測試（w4 / s14）：
//   1) 停止流程必須「先 flush-and-close 再終止程序」。
//   2) 終止後必須重新列舉驗證；殺不掉時印 EGO_STOP_FAILED 並以 exit 1 結束
//      —— 修好前：不論是否殺成功，一律印 EGO_STOPPED 且 exit 0。
//   3) daemon.json 的 port 必須做 1..65535 範圍驗證，且不得重複加入預設埠。
//   4) 既有的 Where-Object filter 保持完全相容。
// 零依賴、零外部網路；需要動態執行時只用 127.0.0.1 的臨時埠與 os.tmpdir()，
// 且在 Windows 上不安裝／執行停止流程（避免真的終止機器上的程序）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

function pwshRun(args, env) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: env ?? process.env,
  });
}

const hasPwsh = (() => {
  try {
    const probe = pwshRun(['-Command', 'Write-Output OK']);
    return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
  } catch {
    return false;
  }
})();

let cimCache;
function hasCim() {
  if (cimCache === undefined) {
    try {
      const probe = pwshRun([
        '-Command',
        'if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { "YES" } else { "NO" }',
      ]);
      cimCache = String(probe.stdout ?? '').includes('YES');
    } catch {
      cimCache = false;
    }
  }
  return cimCache;
}

const normalize = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function homeHonored(dir) {
  try {
    const probe = pwshRun(['-Command', 'Write-Output $HOME'], { ...process.env, HOME: dir, USERPROFILE: dir });
    return normalize(probe.stdout) === normalize(dir);
  } catch {
    return false;
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

test('ego-stop.ps1：flush-and-close 必須在終止程序之前送出', () => {
  const flushIdx = src.indexOf('/flush-and-close');
  const killIdx = src.indexOf('Stop-Process');
  assert.ok(flushIdx >= 0, '必須呼叫 /flush-and-close');
  assert.ok(killIdx >= 0, '必須使用 Stop-Process');
  assert.ok(flushIdx < killIdx, 'flush-and-close 必須早於 Stop-Process');
  for (const token of ['Invoke-WebRequest', '-TimeoutSec 3', '-ErrorAction Stop']) {
    assert.ok(src.includes(token), `缺少 ${token}`);
  }
});

test('ego-stop.ps1：終止後必須驗證，殺不掉時 EGO_STOP_FAILED 並 exit 1', () => {
  assert.ok(src.includes('EGO_STOP_FAILED'), '缺少失敗回報 EGO_STOP_FAILED');
  assert.ok(/exit\s+1/.test(src), '失敗時必須以非 0 結束碼離開');
  assert.match(src, /\$Remaining\s*=\s*@\(\s*Get-CimInstance/, '缺少終止後的重新列舉驗證');
  assert.match(src, /if\s*\(\s*\$Remaining\.Count\s+-gt\s+0\s*\)/, '缺少「仍有存活程序」的判斷');

  const guardIdx = src.search(/if\s*\(\s*\$Remaining\.Count\s+-gt\s+0\s*\)/);
  const failIdx = src.indexOf('EGO_STOP_FAILED');
  const okIdx = src.indexOf('EGO_STOPPED (terminated');
  assert.ok(failIdx > guardIdx, 'EGO_STOP_FAILED 必須在驗證判斷之內');
  assert.ok(okIdx > failIdx, 'EGO_STOPPED 只能在驗證通過後輸出');
  assert.ok(src.includes('Write-Output "EGO_STOPPED (terminated $Stopped processes)"'), '成功訊息格式不可變動');
});

test('ego-stop.ps1：既有 Where-Object filter 原封不動保留', () => {
  const expectedFilter =
    "($_.Name -match '^(node|chrome|msedge|brave)\\.exe$') -and\n" +
    '    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")';
  assert.ok(src.includes(expectedFilter), '既有 Where-Object filter 必須逐字存在');
});

test('ego-stop.ps1：daemon.json 的 port 只接受 1..65535 且不重複加入', () => {
  assert.ok(src.includes('$DaemonJson = Join-Path $DataDir "daemon.json"'), '必須從 daemon.json 讀取埠號');
  assert.ok(/\$Ports = @\(9772, 9774\)/.test(src), '必須保留預設埠 9772/9774');
  assert.match(src, /\$CfgPort -ge 1 -and \$CfgPort -le 65535/, '缺少埠號範圍驗證');
  assert.match(src, /-notcontains \$CfgPort/, '缺少重複埠號檢查');
});

test(
  'ego-stop.ps1：PowerShell parser 可完整解析（無語法錯誤）',
  { skip: hasPwsh ? false : 'pwsh not available' },
  () => {
    const result = pwshRun([
      '-Command',
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:EGO_STOP_SCRIPT, [ref]$null, [ref]$e);' +
        ' if ($e.Count -gt 0) { $e[0].Message; exit 1 } else { "PARSE_OK" }',
    ], { ...process.env, EGO_STOP_SCRIPT: SCRIPT });
    assert.equal(result.status, 0, String(result.stderr ?? '') || String(result.stdout ?? ''));
    assert.match(String(result.stdout ?? ''), /PARSE_OK/);
  },
);

test(
  'ego-stop.ps1：讀 daemon.json 的自訂埠，並在終止程序前送出 flush-and-close',
  {
    skip: !hasPwsh
      ? 'pwsh not available'
      : process.platform === 'win32'
        ? 'Windows 上執行會真的終止本機程序，不在測試中進行'
        : false,
  },
  async (t) => {
    if ((await portInUse(9772)) || (await portInUse(9774))) {
      t.skip('9772/9774 已被其他測試或服務佔用，跳過以免互相干擾');
      return;
    }

    const home = mkdtempSync(join(tmpdir(), 'fmb-w4-s14-ego-stop-'));
    if (!homeHonored(home)) {
      rmSync(home, { recursive: true, force: true });
      t.skip('此 pwsh 不採用 HOME 環境變數，無法隔離資料目錄');
      return;
    }

    const seen = [];
    const server = createServer((req, res) => {
      seen.push(String(req.url ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const port = server.address().port;
      const dataDir = join(home, '.local\\share\\ego-linux');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ port, chromePort: port + 1 }), 'utf8');

      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, USERPROFILE: home } },
      );

      assert.ok(
        seen.includes('/flush-and-close'),
        `自訂埠 ${port} 未收到 flush-and-close；stdout=${result.stdout} stderr=${result.stderr}`,
      );

      if (hasCim()) {
        assert.equal(result.status, 0, String(result.stderr ?? '') || String(result.stdout ?? ''));
        assert.match(String(result.stdout ?? ''), /EGO_STOPPED \(terminated \d+ processes\)/);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  },
);
