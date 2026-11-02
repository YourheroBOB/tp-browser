// tests/fmb_w11_s02_cli_nodejs_args.test.mjs
//
// 回歸測試（bug：靜默成功）：`tp-browser nodejs` 的參數驗證。
//
// 舊行為：`tp-browser nodejs -e`（shell 引號漏掉或變數展開失敗造成漏值）與
// `tp-browser nodejs --eval '...'` 都不符合 `args[0] === '-e'` 的判斷，於是掉進
// 「從 stdin 讀腳本」的分支；stdin 立刻 EOF ⇒ 執行空腳本 ⇒ exit 0。
// 呼叫端（自動化流程、Agent harness）因此誤判「任務已執行」，而且過程中
// 還會先跑 ensureRunning → 啟動器（tp-start.sh／ego-start.ps1）把瀏覽器拉起來。
//
// 期望：參數錯誤時在「連線 daemon／啟動啟動器」之前就以 exit 2 結束，
// 訊息要能指出問題（-e 需要腳本字串／未知選項）。
//
// 邊界：只連 127.0.0.1 上 OS 指派的假 daemon（絕不連正式服務），
// 只寫 mkdtempSync(tmpdir()) 內的檔案，憑證一律用 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));

// 假的 $HOME：CLI 會從 $HOME/.local/share/ego-linux/ 讀 token 與 daemon.json。
const home = mkdtempSync(join(tmpdir(), 'fmb-w11-s02-home-'));
const dataDir = join(home, '.local', 'share', 'ego-linux');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'token'), 'FAKE_VALUE_FOR_TEST', { mode: 0o600 });

// 假的 daemon：/health 回 ok+chrome，確保子程序永遠不會去啟動真的啟動器。
const hits = { health: 0, other: 0 };
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') {
    hits.health += 1;
    res.end(JSON.stringify({ ok: true, chrome: true }));
    return;
  }
  hits.other += 1;
  res.statusCode = 404;
  res.end('{"ok":false}');
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, TP_DAEMON_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // 20s：fan-out／CI 主機上多個測試檔並行、負載高時開程序可能明顯變慢；
    // 逾時放寬只影響「卡死」的偵測延遲，不改變任何斷言內容。
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI 逾時未結束: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, 20_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end('');
  });
}

test('nodejs -e 漏值不得靜默執行空腳本：exit 2、說明原因、且完全沒碰 daemon', async () => {
  const beforeHealth = hits.health;
  const beforeOther = hits.other;
  const r = await runCli(['nodejs', '-e']);
  assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /-e requires a script string/);
  assert.equal(hits.health, beforeHealth, '參數錯誤時不應先連線 daemon（更不應啟動啟動器）');
  assert.equal(hits.other, beforeOther, '參數錯誤時不應發出任何 RPC／SSE 請求');
});

test('nodejs 未知選項（例如 --eval）要明確報錯，不可退回 stdin 靜默成功', async () => {
  const beforeHealth = hits.health;
  const beforeOther = hits.other;
  const r = await runCli(['nodejs', '--eval', 'console.log(1)']);
  assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unknown option --eval/);
  assert.equal(hits.health, beforeHealth, '參數錯誤時不應先連線 daemon');
  assert.equal(hits.other, beforeOther, '參數錯誤時不應發出任何 RPC／SSE 請求');
});

test('回歸護欄：合法的 -e 腳本仍被接受（驗證不誤擋）', async () => {
  const before = hits.health;
  const r = await runCli(['nodejs', '-e', 'globalThis.__fmbW11S02 = 1;']);
  assert.doesNotMatch(r.stderr, /-e requires a script string/);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.ok(hits.health > before, '合法參數應繼續走 ensureRunning → GET /health');
});

test('回歸護欄：非旗標位置參數維持舊行為（從 stdin 讀，不被誤判成非法選項）', async () => {
  const before = hits.health;
  const r = await runCli(['nodejs', 'legacy-positional-arg']);
  assert.doesNotMatch(r.stderr, /unknown option/);
  assert.doesNotMatch(r.stderr, /-e requires a script string/);
  assert.ok(hits.health > before, '位置參數不應在驗證階段被擋掉');
});
