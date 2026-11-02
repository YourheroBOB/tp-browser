// tests/fmb_w13_s02_tp_browser_unknown_command.test.mjs
// 回歸測試（bin/tp-browser.js）：未知子命令必須以非 0 退出碼結束。
// 舊行為是「印完 usage 就 exit 0」，因此 `tp-browser strat`（打錯字）或 `tp-browser statsu`
// 會讓自動化流程誤判「指令已成功執行」——與本檔 nodejs 參數驗證修掉的是同一個病灶。
//
// 覆蓋方式刻意分成兩層，把「子程序數量」壓到最低（測試機是多個工作流平行共用的，
// 每次 spawn 都會和其它對時間敏感的測試搶 CPU）：
//   1. 純函式 unknownCommandError()：逐條驗證所有已知命令／別名都不會被誤擋，打錯字才回錯誤。
//   2. 只留兩個 spawn 測試：真正鎖住「exit 2 + stderr 指名」與「help 仍 exit 0」這兩個 CLI 契約。
// 只 spawn 本 repo 的 CLI，且只走不連線的分支：不啟動 daemon／瀏覽器、不呼叫啟動器、
// 不寫任何檔案、不使用任何真實憑證。本檔被 import 時 CLI 不會執行 main()（見 isCliEntryPoint）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unknownCommandError } from '../bin/tp-browser.js';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));

function runCli(args) {
  const env = { ...process.env };
  // 清掉可能影響埠號選擇的本機設定；以下命令都不連線。
  delete env.TP_DAEMON_PORT;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000, env });
}

test('unknownCommandError：所有已知命令與別名都不會被誤擋', () => {
  const known = [
    'start', '--start',
    'headed', '--headed', '-Headed',
    'restart', '--restart',
    'stop', '--stop',
    'nodejs',
    'status', 'spaces',
    'doctor', 'skill',
    'version', '--version',
    'help', '--help', '-h',
  ];
  for (const cmd of known) {
    assert.equal(unknownCommandError(cmd), null, `不該誤擋合法命令：${cmd}`);
  }
});

test('unknownCommandError：空值走舊路徑，打錯字才回報錯誤訊息', () => {
  // 不帶參數時 main() 會把 sub 預設成 'help'；純函式對空值仍回 null，維持舊行為。
  assert.equal(unknownCommandError(''), null);
  assert.equal(unknownCommandError(undefined), null);

  for (const typo of ['strat', 'statsu', 'bogus-command-fmb', '--bogus-flag-fmb']) {
    const lines = unknownCommandError(typo);
    assert.ok(Array.isArray(lines) && lines.length === 2, `打錯字必須回報錯誤：${typo}`);
    assert.equal(lines[0], `tp-browser: unknown command: ${typo}`);
    assert.match(lines[1], /tp-browser help/);
  }
});

test('tp-browser：help 仍是成功路徑（exit 0、印出 usage）', () => {
  const r = runCli(['help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage:/);
  assert.doesNotMatch(r.stderr, /unknown command/);
});

test('tp-browser：未知子命令以 exit 2 結束，並在 stderr 指名該命令', () => {
  const label = 'bogus-command-fmb';
  const r = runCli([label]);
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(
    r.stderr.includes(`unknown command: ${label}`),
    `stderr 應指名未知命令，實際為：${JSON.stringify(r.stderr)}`,
  );
  // 仍然把可用指令印給使用者（維持原本 stdout 內容），但不得再回報成功。
  assert.match(r.stdout, /usage:/);
  // 未知命令絕不能去動啟動器（否則單純打錯字會連帶拉起瀏覽器）。
  assert.doesNotMatch(r.stderr, /failed to run launcher/);
});
