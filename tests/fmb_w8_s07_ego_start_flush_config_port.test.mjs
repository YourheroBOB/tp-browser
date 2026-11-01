// tests/fmb_w8_s07_ego_start_flush_config_port.test.mjs
// s07（波次 w8）：ego-start.ps1 在 Stop-Process 強殺前只 flush 固定 @(9772, 9774)，
// 漏掉 daemon.json 指定的埠。自訂埠部署（daemon.json port=18802）重啟時，該 daemon 的
// Chrome 沒機會先寫出 cookie / storage 就被 -Force 殺掉，登入態遺失。
//
// 驗證方式比照既有 ps1 文字測試：靜態解析 scripts/ego-start.ps1，斷言 daemon.json 的埠
// 被讀取、經驗證、與固定埠去重，且出現在第一個 Stop-Process 之前。環境有 pwsh 時，另把
// 腳本內的 port 解析區塊抽出來，以暫存目錄的 daemon.json 實跑一次（無 pwsh 則略過）。
// 零網路、零正式服務連線、不讀寫 repo 以外的路徑（只用 os.tmpdir()）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

// 位置斷言必須只看程式碼、不看註解：ego-start.ps1 的步驟 2／4 註解裡就出現過
// 「flush-and-close」與「Stop-Process」字樣（「...BEFORE any flush-and-close or
// Stop-Process below...」），直接用原始文本比對會把註解誤判成第一個呼叫點。
const code = src.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');

// 第一個真正的 Stop-Process 呼叫（帶 -Id），排除註解中的文字提及。
const firstStopProcess = (() => {
  const m = /Stop-Process\s+-Id\b/.exec(code);
  return m ? m.index : -1;
})();

function indicesOf(haystack, needle) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

test('s07 靜態：固定埠 9772/9774 的 flush 迴圈保持原樣', () => {
  assert.match(src, /foreach\s*\(\$FlushPort\s+in\s+@\(9772,\s*9774\)\)/);
  assert.ok(indicesOf(code, 'http://127.0.0.1:$FlushPort/flush-and-close').length >= 1);
});

test('s07 靜態：daemon.json 的 port 被讀取，且解析發生在第一個 Stop-Process 之前', () => {
  assert.match(src, /Join-Path \$DataDir "daemon\.json"/);
  assert.match(src, /PSObject\.Properties\.Name -contains 'port'/);
  const at = code.indexOf('daemon.json');
  assert.ok(at > -1, 'ego-start.ps1 必須參考 daemon.json');
  assert.ok(firstStopProcess > -1, 'ego-start.ps1 應有 Stop-Process 呼叫');
  assert.ok(at < firstStopProcess, 'daemon.json 必須在第一個 Stop-Process 之前解析');
});

test('s07 靜態：port 經驗證為 1..65535 的整數', () => {
  assert.match(src, /-is \[int\]/);
  assert.match(src, /-is \[long\]/);
  assert.match(src, /-is \[double\]/);
  assert.match(src, /-ge 1\b/);
  assert.match(src, /-le 65535\b/);
});

test('s07 靜態：與固定埠去重（同一埠不會 flush 兩次）', () => {
  assert.match(src, /@\(9772,\s*9774\)\s*-notcontains \$ConfigFlushPort/);
});

test('s07 靜態：daemon.json 損壞不會中斷腳本（try/catch 包住解析）', () => {
  const start = code.indexOf('$ConfigFlushPort = $null');
  const end = code.indexOf('if ($null -ne $ConfigFlushPort');
  assert.ok(start > -1 && end > start, '找不到 config port 解析區塊');
  const block = code.slice(start, end);
  assert.match(block, /try\s*\{/);
  assert.match(block, /catch\s*\{\}/);
  assert.ok(start < firstStopProcess, 'config port 解析必須在第一個 Stop-Process 之前');
});

test('s07 靜態：所有 flush 都發生在第一個 Stop-Process 之前', () => {
  const flushAt = indicesOf(code, '/flush-and-close');
  assert.ok(flushAt.length >= 2, '固定埠與 config 埠都應有 flush');
  for (const at of flushAt) {
    assert.ok(at < firstStopProcess, `flush-and-close @ ${at} 必須在 Stop-Process @ ${firstStopProcess} 之前`);
  }
  const cfgFlushAt = code.indexOf('$ConfigFlushPort/flush-and-close');
  assert.ok(cfgFlushAt > -1 && cfgFlushAt < firstStopProcess, 'config 埠的 flush 必須在第一個 Stop-Process 之前');
});

// ---- 額外驗證：環境有 pwsh 時，把腳本內的解析區塊抽出來以暫存 daemon.json 實跑 ----
const PWSH = (() => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 ? 'pwsh' : null;
})();

const resolveStart = code.indexOf('$ConfigFlushPort = $null');
const resolveEnd = code.indexOf('if ($null -ne $ConfigFlushPort');
const RESOLVE_BLOCK = code.slice(resolveStart, resolveEnd);

function resolveConfigPort(daemonJson) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w8-s07-'));
  try {
    if (daemonJson !== null) writeFileSync(join(dir, 'daemon.json'), daemonJson, 'utf8');
    const cmd = `$DataDir = $env:FMB_W8_S07_DATA_DIR; ${RESOLVE_BLOCK}; Write-Output ([string]$ConfigFlushPort)`;
    const res = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, FMB_W8_S07_DATA_DIR: dir },
    });
    return { status: res.status, stdout: (res.stdout || '').trim(), stderr: res.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const liveOpts = PWSH ? {} : { skip: 'pwsh not available in this environment' };

test('s07 實跑：合法／邊界 port 會被解析出來（含 18802、1、65535、既有固定埠）', liveOpts, () => {
  const kept = [
    ['{"port":18802}', '18802'],
    ['{"port":1}', '1'],
    ['{"port":65535}', '65535'],
    ['{"chromePort":18800,"port":18802}', '18802'],
    // 解析結果與固定埠相同時，重複 flush 由 -notcontains 擋掉（靜態測試已鎖定）。
    ['{"port":9772}', '9772'],
    ['{"port":9774}', '9774'],
  ];
  for (const [content, expected] of kept) {
    const r = resolveConfigPort(content);
    assert.equal(r.status, 0, `daemon.json=${content}: ${r.stderr}`);
    assert.equal(r.stdout, expected, `daemon.json=${content}`);
  }
});

test('s07 實跑：字串、null、0、超界、缺 port、壞 JSON、缺檔一律略過且不中斷', liveOpts, () => {
  const skipped = [
    null,
    '',
    '   ',
    '{}',
    '{"chromePort":18800}',
    '{"port":null}',
    '{"port":0}',
    '{"port":-1}',
    '{"port":65536}',
    '{"port":70000}',
    '{"port":"18802"}',
    '{"port":"abc"}',
    '{"port":true}',
    '{"port":18802.5}',
    '{"port":[18802]}',
    '{"port":{}}',
    '[]',
    'null',
    '"hello"',
    '{"port":',
    'not json at all',
  ];
  for (const content of skipped) {
    const r = resolveConfigPort(content);
    assert.equal(r.status, 0, `daemon.json=${content} 不得讓腳本中斷: ${r.stderr}`);
    assert.equal(r.stdout, '', `daemon.json=${content} 應被略過`);
  }
});
