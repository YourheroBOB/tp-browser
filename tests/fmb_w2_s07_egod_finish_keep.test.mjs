// tests/fmb_w2_s07_egod_finish_keep.test.mjs
// 回歸測試（fmb 波次 w2 / 子任務 s07）：
//   ego-browserd 的 space.finish({ id, keep }) 必須
//     1. 對要關閉的分頁送出 CDP Target.closeTarget；
//     2. 把該分頁從 ledger 移除並 persist（spaces.json 只剩被保留的分頁）；
//     3. 在回傳的 closed 中列出實際關閉的標籤；
//     4. 把 keep 裡「不存在」的標籤列在 missing。
// 全程只連 127.0.0.1：以假的 Chromium（9775）驅動真的 ego-browserd（--alt-port ⇒ 9774），
// HOME 指向 mkdtemp 建立的暫存目錄，不讀寫 repo 以外的真實使用者資料、不連任何正式服務。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const DAEMON_PORT = 9774; // ego-browserd --alt-port 綁定的 daemon 埠
const CDP_PORT = 9775; // --alt-port 對應的 Chromium DevTools 埠
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const FAKE_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/999.0.0.0 Safari/537.36';

// ---------- 最小 WebSocket / CDP 伺服器（零依賴） ----------
function encodeWsFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createFakeChromium(port) {
  const targets = new Map();
  const conns = new Set();
  const closedTargetIds = [];
  let targetSeq = 0;
  let sessionSeq = 0;
  let discoverEnabled = false;

  function targetInfo(t) {
    return {
      targetId: t.targetId,
      type: t.type || 'page',
      title: t.title || '',
      url: t.url || 'about:blank',
      attached: true,
      canAccessOpener: false,
      browserContextId: 'FAKE-BROWSER-CONTEXT',
    };
  }

  function sendJson(conn, obj) {
    if (!conn.open) return;
    try {
      conn.socket.write(encodeWsFrame(Buffer.from(JSON.stringify(obj), 'utf8')));
    } catch {
      conn.open = false;
    }
  }

  function attach(conn, t) {
    const existing = conn.sessions.get(t.targetId);
    if (existing) return existing;
    sessionSeq += 1;
    const sessionId = `FAKE-SESSION-${sessionSeq}`;
    conn.sessions.set(t.targetId, sessionId);
    sendJson(conn, {
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: targetInfo(t), waitingForDebugger: false },
    });
    return sessionId;
  }

  function handle(conn, msg) {
    const id = msg.id;
    const method = String(msg.method || '');
    const params = msg.params || {};
    const sessionId = msg.sessionId;
    const reply = (result) => sendJson(conn, { id, sessionId, result: result === undefined ? {} : result });

    switch (method) {
      case 'Browser.getVersion':
        reply({ protocolVersion: '1.3', product: 'FakeChrome/999.0.0.0', revision: 'FAKE', userAgent: FAKE_UA, jsVersion: '9.9.0' });
        return;
      case 'Target.setDiscoverTargets':
        discoverEnabled = params.discover !== false;
        reply({});
        return;
      case 'Target.setAutoAttach':
      case 'Target.autoAttachRelated':
        reply({});
        for (const t of targets.values()) attach(conn, t);
        return;
      case 'Target.createTarget': {
        targetSeq += 1;
        const targetId = `FAKE-TARGET-${targetSeq}`;
        const t = { targetId, type: 'page', url: String(params.url || 'about:blank'), title: '' };
        targets.set(targetId, t);
        reply({ targetId });
        if (discoverEnabled) sendJson(conn, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(t) } });
        attach(conn, t);
        return;
      }
      case 'Target.attachToTarget': {
        const known = targets.get(params.targetId);
        const t = known || { targetId: String(params.targetId), type: 'page', url: 'about:blank', title: '' };
        const sid = attach(conn, t);
        reply({ sessionId: sid });
        return;
      }
      case 'Target.closeTarget': {
        const targetId = String(params.targetId);
        closedTargetIds.push(targetId);
        targets.delete(targetId);
        reply({ success: true });
        const sid = conn.sessions.get(targetId);
        if (sid) {
          conn.sessions.delete(targetId);
          sendJson(conn, { method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId } });
        }
        sendJson(conn, { method: 'Target.targetDestroyed', params: { targetId } });
        return;
      }
      case 'Target.getTargets':
        reply({ targetInfos: [...targets.values()].map(targetInfo) });
        return;
      case 'Target.getTargetInfo': {
        const known = targets.get(params.targetId);
        reply({ targetInfo: targetInfo(known || { targetId: String(params.targetId) }) });
        return;
      }
      case 'Storage.getCookies':
      case 'Network.getAllCookies':
      case 'Network.getCookies':
        reply({ cookies: [] });
        return;
      case 'Page.getFrameTree':
        reply({
          frameTree: {
            frame: {
              id: 'FAKE-FRAME-ID',
              loaderId: 'FAKE-LOADER-ID',
              url: 'about:blank',
              domainAndRegistry: '',
              securityOrigin: '://',
              mimeType: 'text/html',
              secureContextType: 'Secure',
              crossOriginIsolatedContextType: 'NotIsolated',
              gatedAPIFeatures: [],
            },
          },
        });
        return;
      case 'Page.navigate':
        reply({ frameId: 'FAKE-FRAME-ID', loaderId: 'FAKE-LOADER-ID' });
        return;
      case 'Page.addScriptToEvaluateOnNewDocument':
        reply({ identifier: 'FAKE-SCRIPT-ID' });
        return;
      case 'Runtime.evaluate':
        reply({ result: { type: 'undefined' } });
        return;
      default:
        // 其餘 Target.* / Page.* / Network.* / Emulation.* 一律給空的成功回應，
        // 讓 daemon 的 attach 流程不會卡在未知指令上。
        reply({});
        return;
    }
  }

  function drain(conn) {
    for (;;) {
      const buf = conn.buf;
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      conn.buf = buf.subarray(off + len);

      if (opcode === 0x8) {
        try { conn.socket.write(encodeWsFrame(Buffer.alloc(0), 0x8)); } catch {}
        conn.open = false;
        try { conn.socket.end(); } catch {}
        return;
      }
      if (opcode === 0x9) {
        try { conn.socket.write(encodeWsFrame(payload, 0xa)); } catch {}
        continue;
      }
      if (opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        handle(conn, msg);
        continue;
      }
      // binary / continuation 在這個測試情境中不需要。
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'FakeChrome/999.0.0.0',
        'Protocol-Version': '1.3',
        'User-Agent': FAKE_UA,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE-BROWSER-ID`,
      }));
      return;
    }
    if (url.pathname === '/json/list' || url.pathname === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...targets.values()].map((t) => ({
        id: t.targetId,
        type: 'page',
        url: t.url,
        title: t.title,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.targetId}`,
      }))));
      return;
    }
    res.writeHead(404).end('not found');
  });

  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = { socket, buf: Buffer.alloc(0), sessions: new Map(), open: true };
    conns.add(conn);
    socket.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      drain(conn);
    });
    socket.on('error', () => { conn.open = false; conns.delete(conn); });
    socket.on('close', () => { conn.open = false; conns.delete(conn); });
  });

  return {
    closedTargetIds,
    async listen() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ok = await new Promise((resolve) => {
          const onError = () => { server.off('listening', onListening); resolve(false); };
          const onListening = () => { server.off('error', onError); resolve(true); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '127.0.0.1');
        });
        if (ok) return true;
        await delay(250);
      }
      return false;
    },
    async close() {
      for (const conn of conns) { try { conn.socket.destroy(); } catch {} }
      conns.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------- 小工具 ----------
async function portFree(port) {
  const probe = createServer();
  const ok = await new Promise((resolve) => {
    probe.once('error', () => resolve(false));
    probe.once('listening', () => resolve(true));
    probe.listen(port, '127.0.0.1');
  });
  if (ok) await new Promise((resolve) => probe.close(resolve));
  return ok;
}

async function rpc(method, params, token) {
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tp-token': token },
    body: JSON.stringify({ id: 1, method, params }),
  });
  const body = await res.json();
  if (!body || body.ok !== true) throw new Error(`${method} 失敗：${JSON.stringify(body)}`);
  return body.result;
}

async function waitForChrome(getLogs, timeoutMs = 45_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`);
      last = await res.json();
      if (last && last.chrome) return last;
    } catch {}
    await delay(100);
  }
  throw new Error(
    `ego-browserd 未能在時限內掛上假 Chromium（last=${JSON.stringify(last)}）；daemon log：\n${getLogs()}`,
  );
}

function findSpaceRecord(ledger, id) {
  const spaces = ledger && ledger.spaces;
  if (!spaces) return null;
  if (Array.isArray(spaces)) return spaces.find((s) => s && s.id === id) || null;
  return spaces[String(id)] || spaces[id] || null;
}

// ---------- 測試本體 ----------
test('space.finish({keep}) 會 removePage 並 persist 已關閉的分頁（fmb w2/s07 回歸）', { timeout: 120_000 }, async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'fmb-w2-s07-egod-'));
  const fake = createFakeChromium(CDP_PORT);
  let child = null;
  let logs = '';
  const collect = (chunk) => { logs = (logs + chunk).slice(-8000); };

  try {
    if (!(await portFree(DAEMON_PORT))) {
      t.skip(`127.0.0.1:${DAEMON_PORT} 已被占用，跳過（避免誤用他人的 daemon）`);
      return;
    }
    if (!(await fake.listen())) {
      t.skip(`127.0.0.1:${CDP_PORT} 已被占用，跳過`);
      return;
    }

    const daemonPath = fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url));
    child = spawn(process.execPath, [daemonPath, '--alt-port'], {
      env: { ...process.env, HOME: tmpRoot, USERPROFILE: tmpRoot, EGO_BROWSERD_PORT: '9774' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    await waitForChrome(() => logs);

    const token = readFileSync(join(tmpRoot, '.local', 'share', 'ego-linux', 'token'), 'utf8').trim();
    assert.match(token, /^[0-9a-f]{16,}$/, 'daemon 應在暫存 HOME 產生 token');

    const created = await rpc('space.create', { name: 'fmb-w2-s07' }, token);
    assert.ok(created && typeof created.id === 'number', `space.create 應回傳 id：${JSON.stringify(created)}`);
    const spaceId = created.id;
    const p1 = (created.pages || []).find((pg) => pg.label === 'p1');
    assert.ok(p1 && p1.targetId, `space.create 後 p1 應綁定 targetId：${JSON.stringify(created)}`);

    const p2 = await rpc('page.new', { spaceId }, token);
    assert.equal(p2.label, 'p2');
    assert.ok(p2.targetId && p2.targetId !== p1.targetId, `page.new 應開出不同的 target：${JSON.stringify(p2)}`);

    const finished = await rpc('space.finish', { id: spaceId, keep: ['p1'] }, token);
    assert.deepEqual(finished.closed, ['p2'], `closed 應只列出 p2：${JSON.stringify(finished)}`);
    assert.deepEqual(finished.retained, ['p1'], `retained 應只列出 p1：${JSON.stringify(finished)}`);
    assert.deepEqual(finished.missing, [], `keep 都在時 missing 應為空：${JSON.stringify(finished)}`);
    assert.equal(finished.deleted, false, `還有保留分頁時不應刪除 space：${JSON.stringify(finished)}`);

    // 真的送出 CDP Target.closeTarget：p2 有、p1 沒有。
    assert.ok(
      fake.closedTargetIds.includes(p2.targetId),
      `Target.closeTarget 應收到 ${p2.targetId}，實際：${JSON.stringify(fake.closedTargetIds)}`,
    );
    assert.ok(
      !fake.closedTargetIds.includes(p1.targetId),
      `保留的 p1 不應被關閉：${JSON.stringify(fake.closedTargetIds)}`,
    );

    // ledger 已持久化：spaces.json 只剩 p1。
    const ledger = JSON.parse(readFileSync(join(tmpRoot, '.local', 'share', 'ego-linux', 'spaces.json'), 'utf8'));
    const record = findSpaceRecord(ledger, spaceId);
    assert.ok(record, `spaces.json 應保留 space ${spaceId}：${JSON.stringify(ledger)}`);
    assert.deepEqual(
      Object.keys(record.pages).sort(),
      ['p1'],
      `spaces.json 應只剩 p1：${JSON.stringify(record.pages)}`,
    );
    assert.equal(record.pages.p1.targetId, p1.targetId, 'p1 的 targetId 不應被改寫');

    // 死掉的 targetId 不會再從 space.tabs 冒出來。
    const tabs = await rpc('space.tabs', { id: spaceId }, token);
    assert.equal(
      tabs.filter((entry) => entry.label === 'p2').length,
      0,
      `space.tabs 不應再有 p2：${JSON.stringify(tabs)}`,
    );

    // keep 指定不存在的標籤 → 回傳 missing，且不動既有分頁。
    const finished2 = await rpc('space.finish', { id: spaceId, keep: ['p1', 'p-does-not-exist'] }, token);
    assert.deepEqual(finished2.missing, ['p-does-not-exist'], `missing 應列出不存在的標籤：${JSON.stringify(finished2)}`);
    assert.deepEqual(finished2.closed, [], `沒有多餘分頁時 closed 應為空：${JSON.stringify(finished2)}`);
    assert.deepEqual(finished2.retained, ['p1'], `retained 只列實際保留的分頁：${JSON.stringify(finished2)}`);

    assert.equal(child.exitCode, null, `daemon 應保持存活；log：\n${logs}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
    }
    await fake.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
