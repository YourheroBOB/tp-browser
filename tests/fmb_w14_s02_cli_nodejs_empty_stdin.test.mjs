// tests/fmb_w14_s02_cli_nodejs_empty_stdin.test.mjs
// 回歸測試（bin/tp-browser.js）：stdin／heredoc 讀到「空腳本」時，`tp-browser nodejs` 必須
//   (1) 以退出碼 2 結束，並明確說明「什麼都沒執行」（不可靜默回 exit 0），
//   (2) 不得先連線 daemon 或拉起瀏覽器啟動器（舊寫法會偷跑啟動器）。
// 另外鎖住「不該誤擋」的兩條反向案例：非空 stdin、以及歷史相容的位置參數形式。
// 全部使用 mkdtempSync(tmpdir()) 的隔離 HOME；TP_DAEMON_PORT 指向刻意關閉的埠，
// 測試不連線任何網路服務、不讀寫 repo 以外的路徑、不使用任何真實憑證。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emptyStdinScriptError } from '../bin/tp-browser.js';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w14-s02-cli-'));

after(() => rmSync(tempRoot, { recursive: true, force: true }));

// 準備一個「如果被執行就會留下證據」的假啟動器（位於暫存 HOME 內，絕不碰真實安裝目錄）。
// 這讓我們能證明「空腳本這條路徑根本不會啟動瀏覽器」。
function makeFakeHome(name) {
  const home = join(tempRoot, name);
  const dataDirs = [
    join(home, '.local', 'share', 'ego-linux', 'app', 'scripts'), // 非 Windows 的第一順位
    join(home, '.local', 'share', 'ego-linux', 'scripts'),
  ];
  for (const dir of dataDirs) mkdirSync(dir, { recursive: true });
  const marker = join(home, 'launcher-ran.marker');
  for (const dir of dataDirs) {
    writeFileSync(
      join(dir, 'tp-start.sh'),
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  return { home, marker };
}

function runCli(home, input, extraArgs = []) {
  return spawnSync(process.execPath, [CLI, 'nodejs', ...extraArgs], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // 刻意沒有東西監聽的埠：若真的走到 ensureRunning()，health() 必然失敗。
      TP_DAEMON_PORT: '1',
    },
  });
}

test('空 stdin：回 exit 2、明確說明空腳本，且完全沒有啟動啟動器', () => {
  const { home, marker } = makeFakeHome('empty-stdin');
  const res = runCli(home, '');
  assert.equal(res.signal, null, `unexpected signal: ${res.signal}`);
  assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /script is empty/);
  assert.match(res.stderr, /nothing was executed/);
  assert.doesNotMatch(res.stderr, /not reachable/);
  assert.equal(existsSync(marker), false, 'empty stdin must not start the browser launcher');
});

test('只有 BOM／空白的 stdin 也算空腳本（不得靜默成功）', () => {
  const { home, marker } = makeFakeHome('blank-stdin');
  const res = runCli(home, '\uFEFF \n\t\n');
  assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /script is empty/);
  assert.match(res.stderr, /nothing was executed/);
  assert.equal(existsSync(marker), false, 'blank stdin must not start the browser launcher');
});

test('非空 stdin 不被誤擋：仍會前進到 daemon 連線階段', () => {
  const { home, marker } = makeFakeHome('nonempty-stdin');
  const res = runCli(home, 'console.log(1);\n');
  assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.doesNotMatch(res.stderr, /script is empty/);
  assert.match(res.stderr, /not reachable/);
  // 這同時證明「假 HOME＋假啟動器」的水管確實有效（否則上面的 marker 斷言會形同虛設）。
  if (process.platform !== 'win32') {
    assert.equal(existsSync(marker), true, 'fake launcher should have run for non-empty stdin');
  }
});

test('位置參數形式（nodejs script.js）維持舊行為：不套用空腳本護欄', () => {
  const { home } = makeFakeHome('positional-stdin');
  const res = runCli(home, '', ['script.js']);
  assert.equal(res.signal, null, `unexpected signal: ${res.signal}`);
  assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.doesNotMatch(res.stderr, /script is empty/);
  assert.doesNotMatch(res.stderr, /unknown option/);
  assert.match(res.stderr, /not reachable/);
});

test('emptyStdinScriptError：空字串／只有 BOM／只有空白都回報錯誤', () => {
  for (const code of ['', '   ', '\n\t\r\n', '\uFEFF', '\uFEFF \n\t']) {
    const lines = emptyStdinScriptError(code);
    assert.ok(Array.isArray(lines), `code=${JSON.stringify(code)}`);
    assert.equal(lines.length, 2, `code=${JSON.stringify(code)}`);
    assert.match(lines[0], /script is empty/);
    assert.match(lines[0], /nothing was executed/);
    assert.match(lines[1], /usage|pass real code/);
  }
});

test('emptyStdinScriptError：有內容的腳本（含前置 BOM）不受影響', () => {
  for (const code of ['console.log(1)', '\uFEFFconsole.log(1)', '\nconst a = 1;\n', '0', '" "', '// code']) {
    assert.equal(emptyStdinScriptError(code), null, `code=${JSON.stringify(code)}`);
  }
  // 非字串一律不判定（交由呼叫端處理），而且不得拋錯。
  for (const value of [null, undefined, 0, false, {}, []]) {
    assert.equal(emptyStdinScriptError(value), null, `value=${String(value)}`);
  }
});
