// tests/fmb_w12_s01_ego_browser_unknown_command.test.mjs
// 回歸測試（bin/ego-browser.js）：CLI 必須把「使用者明確要求說明」與「無法辨識的子命令」分開。
//
// 舊行為：任何未知子命令（`tp-browser statsu`、`tp-browser --versoin`）都與 `help` 共用同一條
// console.log，把 usage 印到 stdout 後以 exit 0 結束。自動化（`... && next`、CI、Agent shell）
// 因此把「指令不存在」當成執行成功。修正後：help/--help/-h/無參數 → stdout + exit 0；
// 其他未知值 → stderr + exit 2。
//
// 這些分支在接觸任何 daemon／瀏覽器之前就結束，所以本測試：不連線、不啟動任何程序、
// 不讀寫 repo 以外的真實資料（唯一例外是 os.tmpdir() 下的隔離 HOME）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'fmb-w12-s01-home-'));
after(() => rmSync(home, { recursive: true, force: true }));

function run(args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // 明確清掉埠覆寫，避免真的連到本機既有 daemon。
  delete env.TP_DAEMON_PORT;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
    input: '',
  });
}

test('help／無參數：usage 印到 stdout 並以 exit 0 結束（原行為不變）', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stdout, /usage:/, `${JSON.stringify(args)} stdout`);
    assert.equal(r.stderr, '', `${JSON.stringify(args)} 不應輸出 stderr`);
  }
});

test('version：version 與 --version／-V 皆為 exit 0 且輸出產品資訊', () => {
  for (const args of [['version'], ['--version'], ['-V']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stdout, /TooPower Browser/, `${JSON.stringify(args)} stdout`);
    assert.equal(r.stdout.includes('usage:'), false, `${JSON.stringify(args)} 不應印出 usage`);
  }
});

test('未知子命令：usage 走 stderr、exit 2，且 stdout 不得冒充成功輸出', () => {
  const typo = run(['statsu']);
  assert.equal(typo.status, 2, `stdout=${typo.stdout}`);
  assert.equal(typo.stdout, '');
  assert.match(typo.stderr, /unknown command "statsu"/);
  assert.match(typo.stderr, /usage:/);

  const badFlag = run(['--versoin']);
  assert.equal(badFlag.status, 2, `stdout=${badFlag.stdout}`);
  assert.equal(badFlag.stdout, '');
  assert.match(badFlag.stderr, /unknown command "--versoin"/);
  assert.match(badFlag.stderr, /usage:/);
});

test('未知子命令不得啟動啟動器：不會產生任何檔案或程序副作用', () => {
  // 未知子命令路徑必須在 readPort()／ensureRunning()／runLauncher() 之前就結束。
  // 若誤走啟動路徑，這裡會因為 HOME 內沒有 scripts/ 而出現不同錯誤或耗時明顯變長。
  const started = Date.now();
  const r = run(['definitely-not-a-command']);
  const elapsed = Date.now() - started;
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /unknown command "definitely-not-a-command"/);
  assert.equal(r.stdout, '');
  assert.ok(elapsed < 15_000, `未知子命令不應耗時 ${elapsed}ms（疑似進入連線／啟動流程）`);
});
