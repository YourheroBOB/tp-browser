// tests/fmb_no_autostart_leak.test.mjs
//
// 回歸測試：TP_DAEMON_PORT 明確指定、但該埠上沒有健康的 daemon 時，
// tp-browser／ego-browser 必須直接回報錯誤，絕不能去跑 tp-start.sh。
//
// 背景：啟動器只會在預設 9772/9773 起 daemon 與一個 detached 無頭 Chrome，
// 完全不理 TP_DAEMON_PORT。測試（假 daemon、或刻意模擬 daemon 不在）在負載下健康檢查逾時，
// CLI 就在隔離 HOME 下多開一個佔 9773 的 Chrome；HOME 刪掉後成孤兒，累積上百個拖垮整台機器。
//
// 這支測試自己絕不開瀏覽器：在隔離 HOME 的第一順位啟動器路徑放一支假 tp-start.sh，
// 被呼叫時只寫一個標記檔就 exit 1。after() 仍會把 cmdline 含隔離 HOME 的殘留程序全部殺掉。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BINS = ['bin/tp-browser.js', 'bin/ego-browser.js'];
const homes = [];

function killByPath(p) {
  if (process.platform !== 'linux') return 0;
  let n = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let cmd = '';
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.includes(p)) { try { process.kill(Number(pid), 'SIGKILL'); n++; } catch {} }
  }
  return n;
}

after(() => {
  for (const h of homes) { killByPath(h); rmSync(h, { recursive: true, force: true }); }
});

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'fmb-noauto-'));
  homes.push(home);
  const data = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(join(data, 'app', 'scripts'), { recursive: true });
  writeFileSync(join(data, 'token'), 'FAKE_VALUE_FOR_TEST\n', { mode: 0o600 });
  const marker = join(home, 'launcher-called');
  const stub = join(data, 'app', 'scripts', 'tp-start.sh');
  writeFileSync(stub, `#!/bin/sh\necho called > "${marker}"\nexit 1\n`);
  chmodSync(stub, 0o755);
  return { home, marker };
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function run(bin, home, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, bin), 'nodejs', '-e', '1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, TP_DAEMON_PORT: String(port) },
    });
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 20_000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stderr }); });
  });
}

for (const bin of BINS) {
  test(`${bin}: TP_DAEMON_PORT 上沒有 daemon 時不跑啟動器、不留下任何瀏覽器`, { timeout: 30_000, skip: process.platform === 'win32' }, async () => {
    const { home, marker } = makeHome();
    const r = await run(bin, home, await closedPort());
    assert.equal(existsSync(marker), false, `不應呼叫 tp-start.sh；stderr=${r.stderr}`);
    assert.equal(existsSync(join(home, '.local', 'share', 'ego-linux', 'profile-agent')), false);
    assert.equal(r.signal, null, `CLI 不應卡住；stderr=${r.stderr}`);
    assert.notEqual(r.status, 0, `daemon 不在時應以非零結束；stderr=${r.stderr}`);
    assert.equal(killByPath(home), 0, '不應留下 cmdline 含隔離 HOME 的程序');
  });
}
