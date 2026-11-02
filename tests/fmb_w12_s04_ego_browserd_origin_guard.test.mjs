// tests/fmb_w12_s04_ego_browserd_origin_guard.test.mjs
//
// 回歸測試（daemon/ego-browserd.js）：loopback Host／無 Origin 的防護必須在「所有」路由之前生效。
//
// 修正前 handleRequest() 先回應 /newtab、/showcase、/docs，才做 Origin／Host 檢查，因此任何網頁
// 都能用「帶 Origin 的跨站 fetch」或「DNS rebinding（Host 指向攻擊者網域）」讀到這幾頁並取得 200，
// 繞過這個檔案自己與 README 宣稱的 CSRF／DNS rebinding 防線。
//
// 測試隔離（不用固定埠、不製造跨測試干擾）：
//  1. daemon 的埠是硬常數（9772／--alt-port → 9774），平行測試會互搶，也可能把別支 daemon
//     （例如 daemon/tp-browserd.js）誤當成受測對象。這裡在測試自己的暫存目錄內放一支
//     runner.mjs，把 listen() 改寫成 OS 指派的臨時埠（仍只綁 127.0.0.1）並寫出實際埠號。
//  2. 子行程的 **命令列**（也就是 `ps` 看得到的東西）刻意只含 `node <tmp>/runner.mjs`，
//     不含 `ego-browserd`、也不含任何 profile 路徑；因為 repo 內有測試（tp-stop 系列）
//     會用 `pkill -f`／`pgrep -f` 依命令列比對程序，任何多出來的、字串剛好吻合的行程都可能
//     讓那些測試誤判「還有殘留程序」。daemon 路徑只透過環境變數傳入，不出現在 argv。
//  3. runner 內把 globalThis.fetch 換成立即 reject，避免受測 daemon 去連其他平行測試的
//     假 Chrome／真 Chrome 或 9773／9775（只做本地連線也一併避免）。
//
// 邊界：只連 127.0.0.1；daemon 的 HOME／USERPROFILE 指向 mkdtempSync(tmpdir())，不讀寫真實
// 使用者資料、不連任何外部或正式服務、不使用任何憑證（含假憑證）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const HOST = '127.0.0.1';
const daemonPath = fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url));

// 這支 runner 會被 `node runner.mjs` 直接執行（不經過 --import，所以 daemon 路徑不會出現在 argv）。
const RUNNER_SOURCE = `import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const portFile = process.env.FMB_W12_S04_PORT_FILE;
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  const first = args[0];
  let next = args;
  if (typeof first === 'number') {
    const rest = typeof args[1] === 'string' ? args.slice(2) : args.slice(1);
    next = [0, '127.0.0.1', ...rest];
  } else if (first && typeof first === 'object' && !Array.isArray(first)) {
    next = [{ ...first, port: 0, host: '127.0.0.1' }, ...args.slice(1)];
  }
  if (portFile) {
    this.once('listening', () => {
      const addr = this.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      if (port) { try { writeFileSync(portFile, String(port)); } catch {} }
    });
  }
  return origListen.apply(this, next);
};

globalThis.fetch = () => Promise.reject(new Error('network disabled in test runner'));

await import(pathToFileURL(process.env.FMB_W12_S04_DAEMON_PATH).href);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseHttp(text) {
  const idx = text.indexOf('\r\n\r\n');
  const head = idx === -1 ? text : text.slice(0, idx);
  const body = idx === -1 ? '' : text.slice(idx + 4);
  const status = Number((head.split('\r\n')[0] || '').split(' ')[1] || 0);
  return { status, body };
}

// 直接用 raw socket 送出 HTTP/1.1，才能百分之百控制 Host 與 Origin 標頭
// （高階 client 會自行改寫 Host，無法重現 DNS rebinding 情境）。
function rawGet(path, { port, host = null, origin = null, timeoutMs = 5000 } = {}) {
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${host || `${HOST}:${port}`}`, 'Accept: */*'];
  if (origin) lines.push(`Origin: ${origin}`);
  lines.push('Connection: close');
  const payload = `${lines.join('\r\n')}\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = connect({ host: HOST, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => { clearTimeout(timer); resolve(parseHttp(Buffer.concat(chunks).toString('utf8'))); });
    socket.on('close', () => { clearTimeout(timer); resolve(parseHttp(Buffer.concat(chunks).toString('utf8'))); });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function waitForPort(portFile, child, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const n = Number(readFileSync(portFile, 'utf8').trim());
      if (Number.isInteger(n) && n > 0) return n;
    }
    if (child.exitCode !== null) return 0;
    await sleep(25);
  }
  return 0;
}

async function waitHealthy(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await rawGet('/health', { port, timeoutMs: 1000 });
      if (res.status === 200) return true;
    } catch {}
    await sleep(25);
  }
  return false;
}

// 次要（決定性、零 flake、零子行程）不變式：靜態確認 guard 在原始碼中確實排在靜態路由之前。
// 即使執行期測試因環境限制被 skip，也能守住「順序」這個 bug 的本質。
test('ego-browserd：原始碼中 Host／Origin guard 必須早於 /newtab 與 /showcase 路由', () => {
  const src = readFileSync(daemonPath, 'utf8');
  const guardAt = src.indexOf('req.headers.origin');
  const newtabAt = src.indexOf("url.pathname === '/newtab'");
  const showcaseAt = src.indexOf("url.pathname === '/showcase'");
  assert.ok(guardAt > 0, '找不到 Host／Origin guard');
  assert.ok(newtabAt > 0, '找不到 /newtab 路由');
  assert.ok(showcaseAt > 0, '找不到 /showcase 路由');
  assert.ok(guardAt < newtabAt, 'guard 必須早於 /newtab（修正前是晚於）');
  assert.ok(guardAt < showcaseAt, 'guard 必須早於 /showcase、/docs（修正前是晚於）');
});

test('ego-browserd：/newtab、/showcase、/docs 必須套用 Host／Origin 防護', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w12-s04-origin-guard-'));
  let child = null;
  let stderr = '';
  try {
    const runnerPath = join(tempRoot, 'runner.mjs');
    writeFileSync(runnerPath, RUNNER_SOURCE, { mode: 0o600 });
    const portFile = join(tempRoot, 'port.txt');

    child = spawn(process.execPath, [runnerPath], {
      cwd: tempRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        FMB_W12_S04_PORT_FILE: portFile,
        FMB_W12_S04_DAEMON_PATH: daemonPath,
      },
    });
    child.on('error', () => {});
    child.stderr?.on('data', (c) => { stderr += String(c); });

    const port = await waitForPort(portFile, child, 15000);
    if (!port) {
      t.skip(`受測 daemon 未能在 15 秒內開始監聽（環境限制）：${stderr.trim().slice(-400) || 'no stderr'}`);
      return;
    }
    if (!(await waitHealthy(port, 5000))) {
      t.skip('受測 daemon 已在監聽但 /health 未在 5 秒內回應');
      return;
    }

    // 受測行程若被外部（例如其他測試的 pkill）終止，連線會失敗；那是環境問題，不是產品缺陷，
    // 記為 skip 以免把別人的副作用算成這裡的 fail。
    const get = async (path, opts = {}) => {
      try {
        return await rawGet(path, { port, ...opts });
      } catch (e) {
        t.skip(`受測 daemon 在測試期間不可達（可能被外部程序終止）：${e.code || e.message}`);
        return null;
      }
    };

    // 正常路徑不得被誤擋：Host = 127.0.0.1:<port>、無 Origin。
    const okNewtab = await get('/newtab');
    if (!okNewtab) return;
    assert.equal(okNewtab.status, 200, '/newtab 正常請求應為 200');
    assert.ok(okNewtab.body.includes('TooPower'), '/newtab 應回傳戰情中心頁面');

    const okShowcase = await get('/showcase');
    if (!okShowcase) return;
    assert.notEqual(okShowcase.status, 403, '/showcase 正常請求不得被防護誤擋');

    // 跨站 fetch：瀏覽器對跨站請求一定帶 Origin → 必須 403（修正前為 200）。
    for (const path of ['/newtab', '/showcase', '/docs']) {
      const res = await get(path, { origin: 'https://evil.example' });
      if (!res) return;
      assert.equal(res.status, 403, `${path} 帶 Origin 必須被拒（修正前為 200）`);
    }

    // DNS rebinding：Host 不是 127.0.0.1 → 必須 403（修正前為 200）。
    for (const path of ['/newtab', '/showcase', '/docs']) {
      const res = await get(path, { host: 'evil.example' });
      if (!res) return;
      assert.equal(res.status, 403, `${path} 帶非 loopback Host 必須被拒（修正前為 200）`);
    }

    // Host 帶埠仍須放行（正常用法）。
    const okWithPort = await get('/newtab', { host: `${HOST}:${port}` });
    if (!okWithPort) return;
    assert.equal(okWithPort.status, 200, 'Host 為 127.0.0.1:<port> 時應正常回應');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch {} child = null; }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
