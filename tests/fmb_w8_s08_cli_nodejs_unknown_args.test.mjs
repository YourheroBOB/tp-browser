// tests/fmb_w8_s08_cli_nodejs_unknown_args.test.mjs
// 回歸測試（fan-out w8 / s08）：`tp-browser nodejs` 與 `ego-browser nodejs` 的參數與空腳本處理。
//
// 重現的 bug：runNodeJs 只認 args[0]==='-e'，其餘一律靜默改讀 stdin。使用者誤傳檔案路徑
// （`nodejs ./x.js`）、`--eval`、`-c`、`--help` 時參數被無聲丟棄；若 stdin 又是 /dev/null 或
// 空管線（agent／CI 常見），CLI 會先 ensureRunning() 啟動瀏覽器，再執行一支空腳本並 exit 0。
//
// 全部離線：不連線任何正式服務、不真的啟動瀏覽器。
// ・ TP_DAEMON_PORT 指向一個「黑洞」埠：由本檔自己 listen，一收到連線就 RST。
//   因此 health() 會快速失敗（不必等 2.5s 逾時），我們也能精確數到「CLI 連了幾次」。
// ・ DATA_DIR/app/scripts/tp-start.sh（非 Windows 分支的第一候選）與 PATH 內的
//   tp-start／ego-start／curl／chromium… 都換成 spy：任何「啟動器被呼叫」的企圖
//   都會被記錄到暫存 spy log，而不是真的把瀏覽器拉起來。
// ・ 暫存一律用 mkdtempSync(tmpdir())；測試內不出現任何真實憑證。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w8-s08-nodejs-cli-'));
const home = join(tempRoot, 'home');
const dataDir = join(home, '.local', 'share', 'ego-linux');
const pathSpyDir = join(tempRoot, 'path-bin');
const spyLog = join(tempRoot, 'launcher-spy.log');

mkdirSync(home, { recursive: true });
mkdirSync(join(dataDir, 'app', 'scripts'), { recursive: true });
mkdirSync(join(dataDir, 'scripts'), { recursive: true });
mkdirSync(pathSpyDir, { recursive: true });

const SH_SPY = '#!/bin/sh\n# fmb-w8-s08 測試用假啟動器：被呼叫就把名字與參數寫進 spy 記錄檔。\nprintf \'%s\\n\' "launcher-called:$0 $*" >> "$TP_SPY_LOG"\nexit 0\n';
const PS_SPY = '# fmb-w8-s08 測試用假啟動器（Windows 分支）\nAdd-Content -Path $env:TP_SPY_LOG -Value "launcher-called:ego-start.ps1"\nexit 0\n';

// 非 Windows 的 runLauncher 用 /bin/sh 執行 resolveScript() 找到的第一個腳本，候選順序是
// DATA_DIR/app/scripts/<name> → DATA_DIR/scripts/<name> → repo scripts/<name>。
// 把 DATA_DIR/app/scripts/tp-start.sh 換成 spy，就能攔截「ensureRunning 想啟動瀏覽器」。
for (const name of ['tp-start.sh', 'tp-stop.sh']) {
  writeFileSync(join(dataDir, 'app', 'scripts', name), SH_SPY, { mode: 0o755 });
}
// Windows 分支的第一候選是 DATA_DIR/scripts/ego-start.ps1。
writeFileSync(join(dataDir, 'scripts', 'ego-start.ps1'), PS_SPY, { mode: 0o644 });
writeFileSync(join(dataDir, 'app', 'scripts', 'ego-start.ps1'), PS_SPY, { mode: 0o644 });
// 萬一真的回落 repo 內的真啟動器，它會用 PATH 找 curl／chromium；這些 PATH spy 會記錄下來，
// 讓測試失敗，而不是真的把瀏覽器拉起來。
for (const name of ['tp-start', 'ego-start', 'tp-stop', 'ego-stop', 'curl', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
  writeFileSync(join(pathSpyDir, name), SH_SPY, { mode: 0o755 });
}

// 黑洞埠：接受連線後立刻銷毀，確保 CLI 的 health() 快速失敗，也讓我們能數到連線次數。
const tcpAttempts = [];
const blackhole = net.createServer((sock) => {
  tcpAttempts.push(Date.now());
  sock.destroy();
});
await new Promise((resolve, reject) => {
  blackhole.once('error', reject);
  blackhole.listen(0, '127.0.0.1', resolve);
});
const daemonPort = blackhole.address().port;

const childEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  TP_DAEMON_PORT: String(daemonPort),
  TP_SPY_LOG: spyLog,
  PATH: `${pathSpyDir}${delimiter}${process.env.PATH || ''}`,
};

after(() => {
  try { blackhole.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
});

function resetSpies() {
  tcpAttempts.length = 0;
  rmSync(spyLog, { force: true });
}

function spyCalls() {
  return existsSync(spyLog) ? readFileSync(spyLog, 'utf8') : '';
}

function runCli(bin, args, input = '') {
  const cli = fileURLToPath(new URL(`../bin/${bin}`, import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'nodejs', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    input,
    env: childEnv,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// 自我檢查：黑洞埠必須真的收得到連線，否則下面「不應有任何連線」的断言沒有意義。
test('基礎建設自我檢查：黑洞埠會記錄到探測連線', async () => {
  const before = tcpAttempts.length;
  await new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: daemonPort });
    const timer = setTimeout(() => { sock.destroy(); resolve(); }, 3000);
    sock.once('error', () => { clearTimeout(timer); resolve(); });
    sock.once('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.ok(tcpAttempts.length > before, '黑洞伺服器應記錄到探測連線（否則本檔的負面案例無意義）');
});

for (const bin of ['ego-browser.js', 'tp-browser.js']) {
  test(`${bin}：無法識別的參數 → 用法錯誤 exit 2，不連線也不啟動任何東西`, () => {
    const cases = [
      { label: '檔案路徑', args: ['./x.js'] },
      { label: '--eval', args: ['--eval', 'console.log(1)'] },
      { label: '-c', args: ['-c', 'console.log(1)'] },
      { label: '--help', args: ['--help'] },
      { label: '檔案路徑加額外參數', args: ['script.js', '--foo'] },
    ];
    for (const { label, args } of cases) {
      resetSpies();
      const r = runCli(bin, args, '');
      assert.equal(r.error, undefined, `${label}: spawn failed: ${r.error?.message}`);
      assert.equal(r.status, 2, `${label} (${bin}) 應 exit 2；stderr=${r.stderr}`);
      assert.match(r.stderr, /unrecognized argument/i, `${label} (${bin}) 未印出無法識別參數：${r.stderr}`);
      assert.match(r.stderr, /-e/, `${label} (${bin}) 未提示 -e 用法：${r.stderr}`);
      assert.match(r.stderr, /stdin/i, `${label} (${bin}) 未提示 stdin 用法：${r.stderr}`);
      assert.match(r.stderr, /file path/i, `${label} (${bin}) 未說明不接受檔案路徑：${r.stderr}`);
      // 進入 ensureRunning 才會出現的訊息：有它就代表已經連線／啟動過了。
      assert.doesNotMatch(r.stderr, /not reachable/i, `${label} (${bin}) 不應走到 ensureRunning：${r.stderr}`);
      assert.equal(tcpAttempts.length, 0, `${label} (${bin}) 不應有任何連線嘗試`);
      assert.equal(spyCalls(), '', `${label} (${bin}) 不應呼叫啟動器：${spyCalls()}`);
      assert.equal(existsSync(join(dataDir, 'token')), false, `${label} (${bin}) 不應建立 token`);
      assert.equal(existsSync(join(dataDir, 'daemon.json')), false, `${label} (${bin}) 不應建立 daemon.json`);
    }
  });

  test(`${bin}：stdin 去除 BOM 與空白後為空 → exit 2，不得先啟動瀏覽器`, () => {
    const cases = [
      { label: '/dev/null 空輸入', input: '' },
      { label: '只有空白', input: '  \n\t\n' },
      { label: 'BOM＋空白', input: '\uFEFF  \n' },
    ];
    for (const { label, input } of cases) {
      resetSpies();
      const r = runCli(bin, [], input);
      assert.equal(r.error, undefined, `${label}: spawn failed: ${r.error?.message}`);
      assert.equal(r.status, 2, `${label} (${bin}) 應 exit 2；stderr=${r.stderr}`);
      assert.match(r.stderr, /empty/i, `${label} (${bin}) 未印出空腳本錯誤：${r.stderr}`);
      assert.doesNotMatch(r.stderr, /not reachable/i, `${label} (${bin}) 不應走到 ensureRunning：${r.stderr}`);
      assert.equal(tcpAttempts.length, 0, `${label} (${bin}) 不應有任何連線嘗試`);
      assert.equal(spyCalls(), '', `${label} (${bin}) 不應呼叫啟動器：${spyCalls()}`);
      assert.equal(existsSync(join(dataDir, 'token')), false);
      assert.equal(existsSync(join(dataDir, 'daemon.json')), false);
    }
  });

  test(`${bin}：-e 缺少腳本字串 → exit 2，不啟動`, () => {
    resetSpies();
    const r = runCli(bin, ['-e'], '');
    assert.equal(r.status, 2, `stderr=${r.stderr}`);
    assert.match(r.stderr, /-e requires a script string/);
    assert.doesNotMatch(r.stderr, /not reachable/i, `不應走到 ensureRunning：${r.stderr}`);
    assert.equal(tcpAttempts.length, 0, `不應有任何連線嘗試`);
    assert.equal(spyCalls(), '', `不應呼叫啟動器：${spyCalls()}`);
  });

  test(`${bin}：正常 -e 行為不變（仍會 ensureRunning／嘗試啟動）`, () => {
    resetSpies();
    const r = runCli(bin, ['-e', 'console.log(1)'], '');
    assert.equal(r.status, 2, `daemon 不可達時仍以 2 結束；stderr=${r.stderr}`);
    assert.match(r.stderr, /not reachable/, `-e 應進入正常流程而不是用法錯誤：${r.stderr}`);
    assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${daemonPort}`), `-e 應使用 TP_DAEMON_PORT：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /unrecognized argument/i);
    assert.ok(tcpAttempts.length > 0, '-e 應該真的去連 daemon');
    assert.match(spyCalls(), /launcher-called/, 'ensureRunning 應該呼叫啟動器（對照：錯誤案例不會）');
  });

  test(`${bin}：非空 heredoc stdin 行為不變（仍會 ensureRunning／嘗試啟動）`, () => {
    resetSpies();
    const r = runCli(bin, [], 'console.log(1)\n');
    assert.equal(r.status, 2, `daemon 不可達時仍以 2 結束；stderr=${r.stderr}`);
    assert.match(r.stderr, /not reachable/, `非空 stdin 應進入正常流程：${r.stderr}`);
    assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${daemonPort}`), `應使用 TP_DAEMON_PORT：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /empty/i);
    assert.ok(tcpAttempts.length > 0, '非空 stdin 應該真的去連 daemon');
    assert.match(spyCalls(), /launcher-called/, 'ensureRunning 應該呼叫啟動器（對照：錯誤案例不會）');
  });
}
