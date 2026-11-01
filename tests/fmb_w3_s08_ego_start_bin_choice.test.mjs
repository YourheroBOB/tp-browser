// tests/fmb_w3_s08_ego_start_bin_choice.test.mjs
// 回歸測試：scripts/ego-start.ps1 在下列情況必須「明確失敗」而不是靜默改用別的瀏覽器：
//   1) TP_BROWSER_BIN 有值但 Test-Path 失敗 → stderr 含 TP_BROWSER_BIN、exit 1
//   2) 明確指定 -Edge／-Chrome 但該瀏覽器不在自己的路徑清單裡 → exit 1 並說明缺哪一個
// 兩種情況都必須發生在 flush-and-close 與 Stop-Process 之前（不得先強殺正在運作的 daemon）。
// 零依賴、零外部網路：有 pwsh 才實跑（HOME／USERPROFILE／LOCALAPPDATA 一律指向暫存目錄），
// 沒有 pwsh 就只做腳本文字層級的順序斷言；flush 偵測只用 127.0.0.1 上的臨時 HTTP 伺服器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const scriptSrc = readFileSync(scriptPath, 'utf8');
const scriptLines = scriptSrc.split(/\r?\n/);

// 只檢查「固定絕對路徑」；LOCALAPPDATA 版本一律指向暫存目錄，不會存在。
const EDGE_FIXED_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME_FIXED_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

function pwshTestPaths(paths) {
  if (!hasPwsh) return false;
  const quoted = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  const cmd = `$found = @((${quoted}) | Where-Object { Test-Path -LiteralPath $_ }); if ($found.Count -gt 0) { 'YES' } else { 'NO' }`;
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return String(res.stdout ?? '').includes('YES');
}

const edgeInstalled = pwshTestPaths(EDGE_FIXED_PATHS);
const chromeInstalled = pwshTestPaths(CHROME_FIXED_PATHS);

function tempEnv(home) {
  const env = { ...process.env };
  // 不讓宿主環境的 TP_BROWSER_BIN 影響「明確指定 -Edge／-Chrome」的測試。
  delete env.TP_BROWSER_BIN;
  env.HOME = home;
  env.USERPROFILE = home;
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  env.APPDATA = join(home, 'AppData', 'Roaming');
  return env;
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'fmb-w3-s08-ego-start-'));
}

function runStartScript(args, env) {
  return spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', timeout: 60_000, env },
  );
}

// 在 127.0.0.1:9772 掛一個只記錄請求的假 daemon；port 被占用時回傳 null（無法觀測，僅靠文字斷言）。
async function withLoopbackProbe(port, fn) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(String(req.url ?? ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"chrome":true}');
  });
  const listening = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  try {
    return await fn(listening ? hits : null);
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve));
  }
}

function assertNoFlush(hits, label) {
  if (!hits) return;
  const flushed = hits.filter((u) => u.includes('flush-and-close'));
  assert.deepEqual(flushed, [], `${label}：不應呼叫 flush-and-close`);
}

// 只看「程式碼行」：說明註解裡也可能出現 flush-and-close／Stop-Process 字樣，不可當成呼叫點。
const isCodeLine = (l) => !/^\s*#/.test(l);
const findCodeIdx = (pred) => scriptLines.findIndex((l) => isCodeLine(l) && pred(l));

test('ego-start.ps1（文字層級）：瀏覽器選擇失敗的 exit 1 必須早於 flush-and-close 與 Stop-Process', () => {
  const envBinIdx = findCodeIdx(
    (l) => l.includes('[Console]::Error.WriteLine') && l.includes('TP_BROWSER_BIN'),
  );
  const explicitIdx = findCodeIdx(
    (l) => l.includes('[Console]::Error.WriteLine') && l.includes('$ExplicitBrowser was requested'),
  );
  const flushIdx = findCodeIdx((l) => l.includes('Invoke-RestMethod') && l.includes('flush-and-close'));
  const stopIdx = findCodeIdx((l) => l.includes('Stop-Process') && l.includes('Stop-Process -Id'));

  assert.notEqual(envBinIdx, -1, 'TP_BROWSER_BIN 錯誤必須用 [Console]::Error.WriteLine 輸出');
  assert.notEqual(explicitIdx, -1, '-Edge／-Chrome 缺裝錯誤必須用 [Console]::Error.WriteLine 輸出');
  assert.notEqual(flushIdx, -1, '找不到 flush-and-close 呼叫點');
  assert.notEqual(stopIdx, -1, '找不到 Stop-Process 呼叫點');
  assert.ok(flushIdx < stopIdx, 'flush-and-close 必須在 Stop-Process 之前');

  assert.ok(envBinIdx < flushIdx, 'TP_BROWSER_BIN 檢查必須在 flush-and-close 之前');
  assert.ok(envBinIdx < stopIdx, 'TP_BROWSER_BIN 檢查必須在 Stop-Process 之前');
  assert.ok(explicitIdx < flushIdx, '-Edge／-Chrome 檢查必須在 flush-and-close 之前');
  assert.ok(explicitIdx < stopIdx, '-Edge／-Chrome 檢查必須在 Stop-Process 之前');

  // 明確指定時只搜尋該瀏覽器自己的路徑清單，不得混入另一個瀏覽器。
  assert.match(
    scriptSrc,
    /\$ExplicitPaths\s*=\s*if\s*\(\$Edge\)\s*\{\s*\$EdgePaths\s*\}\s*else\s*\{\s*\$ChromePaths\s*\}/,
    '明確指定 -Edge／-Chrome 時必須只使用該瀏覽器自己的候選清單',
  );
  // TP_BROWSER_BIN 非空但 Test-Path 失敗 → 立即 exit 1，不得落入自動探測。
  assert.match(
    scriptSrc,
    /\$BrowserBin\s*=\s*\$env:TP_BROWSER_BIN[\s\S]{0,400}?Test-BrowserBinPath -Path \$BrowserBin[\s\S]{0,400}?exit 1/,
    'TP_BROWSER_BIN 無效時必須先 exit 1，不得落入自動探測',
  );
  // 未指定任何瀏覽器且完全找不到時，仍保留原本的致命錯誤訊息（既有測試依賴它）。
  assert.ok(
    scriptLines.some(
      (l) => l.includes('[Console]::Error.WriteLine') && l.includes('ERROR: No Chrome or Edge binary found on this Windows machine!'),
    ),
    '自動探測全數落空時仍須輸出原本的致命錯誤',
  );
});

test(
  'TP_BROWSER_BIN 指向不存在的檔案時 exit 1、stderr 含 TP_BROWSER_BIN、且未 flush',
  { skip: hasPwsh ? false : 'pwsh not available' },
  async (t) => {
    const home = makeHome();
    try {
      await withLoopbackProbe(9772, async (hits) => {
        const env = { ...tempEnv(home), TP_BROWSER_BIN: 'C:\\nope.exe' };
        const res = runStartScript([], env);
        const stderr = String(res.stderr ?? '').replace(/\u0000/g, '');
        const stdout = String(res.stdout ?? '');
        assert.equal(res.status, 1, stderr || stdout || res.error?.message || 'pwsh failed');
        assert.match(stderr, /TP_BROWSER_BIN/);
        assert.match(stderr, /nope\.exe/);
        assert.doesNotMatch(stdout, /EGO_READY/);
        if (!hits) t.diagnostic('127.0.0.1:9772 已被占用，flush-and-close 僅以文字層級斷言驗證');
        assertNoFlush(hits, 'TP_BROWSER_BIN 無效');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  '-Edge 但沒有 Edge 時 exit 1 且未 flush、未改用其他瀏覽器',
  {
    skip: !hasPwsh
      ? 'pwsh not available'
      : edgeInstalled
        ? '受測主機已安裝 Edge，無法模擬缺裝'
        : false,
  },
  async (t) => {
    const home = makeHome();
    try {
      await withLoopbackProbe(9772, async (hits) => {
        const env = tempEnv(home);
        delete env.TP_BROWSER_BIN;
        const res = runStartScript(['-Edge'], env);
        const stderr = String(res.stderr ?? '').replace(/\u0000/g, '');
        const stdout = String(res.stdout ?? '');
        assert.equal(res.status, 1, stderr || stdout || res.error?.message || 'pwsh failed');
        assert.match(stderr, /-Edge/);
        assert.match(stderr, /Edge/);
        assert.doesNotMatch(stdout, /EGO_READY/);
        if (!hits) t.diagnostic('127.0.0.1:9772 已被占用，flush-and-close 僅以文字層級斷言驗證');
        assertNoFlush(hits, '-Edge 缺裝');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  '-Chrome 但沒有 Chrome 時 exit 1 且未 flush、未改用其他瀏覽器',
  {
    skip: !hasPwsh
      ? 'pwsh not available'
      : chromeInstalled
        ? '受測主機已安裝 Chrome，無法模擬缺裝'
        : false,
  },
  async (t) => {
    const home = makeHome();
    try {
      await withLoopbackProbe(9772, async (hits) => {
        const env = tempEnv(home);
        delete env.TP_BROWSER_BIN;
        const res = runStartScript(['-Chrome'], env);
        const stderr = String(res.stderr ?? '').replace(/\u0000/g, '');
        const stdout = String(res.stdout ?? '');
        assert.equal(res.status, 1, stderr || stdout || res.error?.message || 'pwsh failed');
        assert.match(stderr, /-Chrome/);
        assert.match(stderr, /Chrome/);
        assert.doesNotMatch(stdout, /EGO_READY/);
        if (!hits) t.diagnostic('127.0.0.1:9772 已被占用，flush-and-close 僅以文字層級斷言驗證');
        assertNoFlush(hits, '-Chrome 缺裝');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
