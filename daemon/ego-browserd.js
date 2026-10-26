#!/usr/bin/env node
// ego-browserd — daemon for the Linux agent browser (ego-browser compatible).
// Connects to an already-running Chromium DevTools endpoint (never launches
// processes), owns task spaces, and serves the CLI over authenticated
// localhost HTTP: POST /rpc for calls and GET /events (SSE) for pushes.
// Zero npm dependencies; Node >= 22.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync, realpathSync, readlinkSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.js';
import { Store } from './store.js';
import { BrowserHub, EgoError } from './page-ops.js';
import { keyDescriptor } from './keys.js';
import { handleFlushAndClose } from './flush-and-close.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every caller-supplied filesystem path passes through safePath():
// absolute only, no '..' anywhere, no '.' components, no NUL bytes, symlink-resolved.
function assertSafePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) throw new EgoError('BadPath', 'invalid path');
  if (p.includes('..')) throw new EgoError('BadPath', `path traversal rejected: ${p}`);
  if (!isAbsolute(p)) throw new EgoError('BadPath', `absolute path required, got: ${p}`);
  const norm = resolve(p);
  const parts = norm.split(sep);
  if (parts.includes('..') || parts.includes('.')) throw new EgoError('BadPath', `path traversal rejected: ${p}`);
  return norm;
}
function safePath(p, { mustExist = false } = {}) {
  const norm = assertSafePath(p);
  if (mustExist) {
    if (!existsSync(norm)) throw new EgoError('BadPath', `path does not exist: ${p}`);
    return assertSafePath(realpathSync.native(norm));
  }
  const dir = dirname(norm);
  if (existsSync(dir)) assertSafePath(realpathSync.native(dir));
  return norm;
}

// Data root is a fixed constant (symlink the directory to relocate it).
// Nothing environment-derived ever reaches a filesystem write or a fetch URL.
const DATA_DIR = join(homedir(), '.local', 'share', 'ego-linux');
// Ports: defaults 9772 (daemon) / 9773 (Chromium CDP); --alt-port keeps the legacy 9774/9775 pair.
// FIX-1151022: EGO_BROWSERD_PORT / EGO_CHROME_PORT override them (previously every value except '9774'
// silently fell back to 9772, so private instances grabbed the main TP port). Only a validated integer
// port is taken from the environment; the host is always the fixed loopback 127.0.0.1.
function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    console.error(`[tp-browserd] FATAL: ${name}=${JSON.stringify(raw)} is not a port in 1024-65535`);
    process.exit(2);
  }
  return Number(raw);
}
const ALT_PORT = process.argv.includes('--alt-port');
const PORT = envPort('EGO_BROWSERD_PORT', ALT_PORT ? 9774 : 9772);
const CHROME_DEBUG_PORT = envPort('EGO_CHROME_PORT', ALT_PORT ? 9775 : 9773);
const CHROME_VERSION_URL = `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`;
const STARTED_AT = new Date().toISOString();
let chromeIdentity = null; // { cdpPort, wsPort, browserId, product, pid, userDataDir }
const DOWNLOADS_DIR = join(DATA_DIR, 'downloads');
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
mkdirSync(DOWNLOADS_DIR, { recursive: true, mode: 0o700 });

const store = new Store(join(DATA_DIR, 'spaces.json'));
let hub = null;
let chromeReady = false;

function log(...a) { console.log('[tp-browserd]', ...a); }

// Identify which Chromium we attached to (so launchers can verify "my daemon + my Chrome").
// Linux: resolve the process listening on the CDP port via /proc/net/tcp* -> socket inode -> /proc/<pid>/fd.
// Runs once per attach; failures just leave pid/userDataDir null.
function findListenerPid(port) {
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    const inodes = new Set();
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let txt = ''; try { txt = readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of txt.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length > 9 && c[1].endsWith(':' + hex) && c[3] === '0A') inodes.add(c[9]);
      }
    }
    if (!inodes.size) return null;
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let fds; try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let l; try { l = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(l);
        if (m && inodes.has(m[1])) return Number(pid);
      }
    }
  } catch {}
  return null;
}
function describeChrome(info, wsUrl) {
  const id = { cdpPort: CHROME_DEBUG_PORT, wsPort: null, browserId: null, product: info?.Browser || null, pid: null, userDataDir: null };
  try { const u = new URL(wsUrl); id.wsPort = Number(u.port); id.browserId = u.pathname.split('/').pop() || null; } catch {}
  if (process.platform === 'linux') {
    id.pid = findListenerPid(CHROME_DEBUG_PORT);
    if (id.pid) {
      try {
        const args = readFileSync(`/proc/${id.pid}/cmdline`, 'utf8').split('\0');
        const a = args.find((x) => x.startsWith('--user-data-dir='));
        if (a) id.userDataDir = a.slice('--user-data-dir='.length);
      } catch {}
    }
  }
  return id;
}

async function attachChrome() {
  for (;;) {
    try {
      const res = await fetch(CHROME_VERSION_URL, { signal: AbortSignal.timeout(3000) });
      const info = await res.json();
      const wsUrl = info.webSocketDebuggerUrl;
      if (!wsUrl || !String(wsUrl).startsWith('ws://127.0.0.1:')) throw new Error('unexpected webSocketDebuggerUrl');
      const cdp = new Cdp(wsUrl, 'chrome');
      await cdp.connect();
      chromeIdentity = describeChrome(info, wsUrl);
      hub = new BrowserHub(cdp, { downloadsDir: DOWNLOADS_DIR, onPush: broadcastPush, daemonPort: PORT });
      log('attached to Chromium:', wsUrl);
      cdp.onClose(() => { chromeReady = false; hub = null; chromeIdentity = null; log('Chromium connection lost; retrying'); setTimeout(attachChrome, 2000); });
      // Restore persistent + promoted session cookies from vault before any navigation
      await hub.restoreVaultToBrowser();
      // wait for target discovery to deliver existing targets first, then prune dead spaces & blank tabs
      await new Promise((r) => setTimeout(r, 800));
      await rebindSpaces();
      const realTabs = [];
      const blankTabs = [];
      for (const [tid, st] of hub.sessions) {
        const u = String(st.url || '');
        if (!u || u === 'about:blank' || u.startsWith('chrome://newtab') || u.startsWith('chrome://new-tab-page') || u.startsWith('edge://newtab')) {
          blankTabs.push({ tid, st });
        } else if (!u.startsWith('chrome://') && !u.startsWith('devtools://') && !u.startsWith('edge://')) {
          realTabs.push({ tid, st });
        }
      }
      if (realTabs.length > 0) {
        for (const b of blankTabs) {
          try { await hub.cdp.send('Target.closeTarget', { targetId: b.tid }); } catch {}
        }
        for (const r of realTabs) {
          hub._ensureCoRideBar(r.st, true);
        }
      } else if (blankTabs.length > 0) {
        const keep = blankTabs[0];
        try {
          await hub.cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/newtab` }, { sessionId: keep.st.sessionId });
        } catch {}
        for (const b of blankTabs.slice(1)) {
          try { await hub.cdp.send('Target.closeTarget', { targetId: b.tid }); } catch {}
        }
      }
      // In headed mode, if no https:// user tabs are open yet, restore saved https:// tabs from session-tabs.json
      const isHeadless = Boolean(await hub._cleanUaPromise);
      const httpsTabs = realTabs.filter((r) => String(r.st.url || '').startsWith('https://'));
      if (!isHeadless && httpsTabs.length === 0) {
        const savedTabs = hub.getSavedTabs();
        for (const t of savedTabs.slice(0, 4)) {
          if (t?.url && String(t.url).startsWith('https://')) {
            try { await hub.cdp.send('Target.createTarget', { url: t.url, background: true }); } catch {}
          }
        }
      }
      await hub.syncVaultNow();
      chromeReady = true;
      return;
    } catch {
      chromeReady = false;
      log(`waiting for Chromium on 127.0.0.1:${CHROME_DEBUG_PORT} (start it with --remote-debugging-port=${CHROME_DEBUG_PORT})…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function rebindSpaces() {
  for (const sp of store.list()) {
    for (const [label, p] of Object.entries(sp.pages)) {
      if (p.targetId && hub.sessions.has(p.targetId)) continue;
      delete sp.pages[label];
    }
    if (Object.keys(sp.pages).length === 0) {
      store.deleteSpace(sp.id);
    }
  }
  store.persist();
}

function requireHub() {
  if (!chromeReady || !hub) throw new EgoError('BrowserNotReady', `Chromium is not attached yet; ensure it runs with --remote-debugging-port=${CHROME_DEBUG_PORT}`);
  return hub;
}

// ---------- auth ----------
function tokenPath() { return join(DATA_DIR, 'token'); }
function ensureToken() {
  const p = tokenPath();
  if (!existsSync(p)) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(p, randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(p, 'utf8').trim();
}
const TOKEN = ensureToken();
const TOKEN_BUF = Buffer.from(TOKEN);
function checkToken(req) {
  const t = String(req.headers['x-tp-token'] || req.headers['x-ego-token'] || '');
  const b = Buffer.from(t);
  return b.length === TOKEN_BUF.length && timingSafeEqual(b, TOKEN_BUF);
}
// daemon.json is written only after listen() succeeds (see bottom), so a daemon that lost the port race
// can no longer overwrite the record of the daemon that actually owns it.

// ---------- SSE push channels ----------
const sseClients = new Set();
function broadcastPush(targetId, kind, payload) {
  if (kind === 'coride' && payload?.action === 'resetSiteAuth') {
    if (hub) hub.resetSiteAuth(targetId).catch(() => {});
  }
  if (kind === 'coride' && payload?.mode) {
    const found = store.findByTargetId(targetId);
    if (found) {
      found.space.ownership = payload.mode === 'human' ? 'user' : 'agent';
      found.space.state = payload.mode === 'human' ? 'handed-off' : 'active';
      store.persist();
    }
  }
  const line = `data: ${JSON.stringify({ type: 'push', targetId, kind, payload })}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch {} }
}

const NEWTAB_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<title>⚡[TP] TooPower Browser — 人機共駕戰情中心</title>
<style>
  :root { --bg:#0E0C0A; --card:#171411; --amber:#C99A4B; --green:#10B981; --text:#FAF6EE; --muted:#9E9589; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:radial-gradient(circle at 50% 0%, rgba(201,154,75,0.14), transparent 60%), var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:32px; }
  .wrap { max-width:820px; width:100%; text-align:center; }
  .badge { display:inline-flex; align-items:center; gap:8px; padding:6px 16px; border:1.5px solid rgba(16,185,129,0.55); background:rgba(16,185,129,0.12); border-radius:999px; color:#34D399; font-size:13px; font-weight:700; font-family:monospace; margin-bottom:14px; }
  h1 { font-size:36px; letter-spacing:0.5px; margin-bottom:8px; }
  h1 span { color:var(--amber); }
  .sub { color:var(--muted); font-size:14.5px; margin-bottom:20px; }
  .indicators { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:24px; text-align:left; }
  .ind { background:rgba(201,154,75,0.08); border:1px solid rgba(201,154,75,0.3); border-radius:10px; padding:10px 14px; font-size:12.5px; }
  .ind b { display:block; color:var(--amber); margin-bottom:3px; font-size:13px; }
  .ind span { color:var(--text); opacity:0.88; }
  form { display:flex; gap:10px; margin-bottom:26px; }
  input { flex:1; background:var(--card); border:1.5px solid rgba(201,154,75,0.35); color:var(--text); padding:14px 18px; border-radius:12px; font-size:15px; outline:none; }
  input:focus { border-color:var(--amber); box-shadow:0 0 0 3px rgba(201,154,75,0.18); }
  button { background:var(--amber); color:#12100E; font-weight:700; border:none; padding:0 22px; border-radius:12px; cursor:pointer; font-size:14.5px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(175px, 1fr)); gap:12px; text-align:left; }
  .card { background:var(--card); border:1px solid rgba(255,255,255,0.08); padding:14px 16px; border-radius:12px; color:var(--text); text-decoration:none; transition:border-color 0.15s, transform 0.15s; }
  .card:hover { border-color:var(--amber); transform:translateY(-2px); }
  .card b { display:block; font-size:14px; margin-bottom:4px; color:var(--amber); }
  .card span { font-size:12px; color:var(--muted); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="badge">🟢 ⚡ TooPower Browser v0.3.2 · Daemon :${PORT} / CDP :${CHROME_DEBUG_PORT} 已掛載</div>
    <h1>⚡[TP] TooPower <span>人機共駕戰情中心</span></h1>
    <p class="sub">看到此畫面代表本瀏覽器視窗已 100% 由 TooPower Agent Daemon 接管並掛載成功</p>
    <div class="indicators">
      <div class="ind"><b>指標 ①：分頁標題 ⚡[TP]</b><span>所有受控分頁與工作列縮圖均帶 ⚡[TP] 前綴</span></div>
      <div class="ind"><b>指標 ②：頂部 4px 狀態光條</b><span>網頁最上方邊緣常駐金綠漸層發光條</span></div>
      <div class="ind"><b>指標 ③：右下角共駕膠囊</b><span>隨時可點「🧑 我要接手」或「🔄 換帳號」</span></div>
    </div>
    <form id="sf">
      <input id="q" type="text" placeholder="輸入網址或 Google 搜尋關鍵字，按 Enter 前往..." autofocus />
      <button type="submit">前往 →</button>
    </form>
    <div class="grid">
      <a class="card" href="https://outlook.live.com/mail/0/"><b>Outlook / Hotmail</b><span>微軟個人與事務所信箱</span></a>
      <a class="card" href="https://www.perplexity.ai/"><b>Perplexity Pro</b><span>AI 搜尋與模型委員會</span></a>
      <a class="card" href="https://chatgpt.com/"><b>ChatGPT / Dots</b><span>OpenAI 旗艦工作區</span></a>
      <a class="card" href="https://claude.ai/"><b>Claude</b><span>Anthropic 深度推理</span></a>
      <a class="card" href="https://www.kimi.ai/"><b>Kimi K3</b><span>K3 極致叢集工作台</span></a>
      <a class="card" href="https://fugu.sakana.ai/"><b>Sakana FUGU</b><span>FUGU Max / Ultra</span></a>
      <a class="card" href="https://www.genspark.ai/"><b>Genspark</b><span>AI 超級代理工作區</span></a>
      <a class="card" href="https://github.com/YourheroBOB/tp-browser"><b>GitHub 開源倉庫</b><span>YourheroBOB/tp-browser</span></a>
    </div>
  </div>
  <script>
    document.getElementById('sf').onsubmit = function(e) {
      e.preventDefault();
      var v = document.getElementById('q').value.trim();
      if (!v) return;
      if (/^https?:\\/\\//i.test(v)) location.href = v;
      else if (/^[a-z0-9.-]+\\.[a-z]{2,}(\\/.*)?$/i.test(v) && !v.includes(' ')) location.href = 'https://' + v;
      else location.href = 'https://www.google.com/search?q=' + encodeURIComponent(v);
    };
  </script>
</body>
</html>`;

// ---------- HTTP server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/newtab' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(NEWTAB_HTML);
    return;
  }
  if ((url.pathname === '/showcase' || url.pathname === '/docs') && req.method === 'GET') {
    try {
      const html = readFileSync(join(__dirname, '..', 'docs', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    } catch (e) {
      res.writeHead(404).end('Not found');
    }
    return;
  }
  if (req.headers.origin || !/^127\.0\.0\.1(:\d+)?$/.test(req.headers.host || '')) {
    res.writeHead(403).end('forbidden host/origin');
    return;
  }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, chrome: chromeReady, spaces: store.list().length, dataDir: DATA_DIR, port: PORT, cdpPort: CHROME_DEBUG_PORT, pid: process.pid, startedAt: STARTED_AT, chromeIdentity: chromeReady ? chromeIdentity : null })); return; }
  if (url.pathname === '/flush-and-close') {
    await handleFlushAndClose(hub, res);
    return;
  }
  if (url.pathname === '/events') {
    if (!checkToken(req)) { res.writeHead(403).end('bad token'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/rpc' && req.method === 'POST') {
    if (!checkToken(req)) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { name: 'AuthError', message: 'bad token' } })); return; }
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > 1048576) { req.destroy(); return; }
      chunks.push(c);
    }
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { name: 'BadRequest', message: 'invalid JSON' } })); return; }
    try {
      const result = await dispatch(msg.method, msg.params || {});
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: msg.id ?? null, ok: true, result }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: msg.id ?? null, ok: false, error: { name: e.name || 'Error', message: e.message } }));
    }
    return;
  }
  res.writeHead(404).end('not found');
});

// ---------- RPC ----------
async function dispatch(method, p) {
  switch (method) {
    case 'status': {
      let chromeVersion = null;
      if (chromeReady) { try { chromeVersion = (await hub.cdp.send('Browser.getVersion')).product; } catch {} }
      return { chrome: chromeReady, chromeVersion, spaces: store.list().map((s) => ({ id: s.id, name: s.name, ownership: s.ownership, state: s.state })) };
    }
    case 'profiles': {
      if (!existsSync(DATA_DIR)) return [];
      return readdirSync(DATA_DIR).filter((n) => n.startsWith('profile-')).map((n) => ({ profileId: n.slice(8) }));
    }
    case 'space.create': {
      requireHub();
      const sp = store.create({ name: String(p.name || 'unnamed task') });
      await syncSpaceTargets(sp.id);
      return spaceView(sp.id);
    }
    case 'space.list': return store.list().map((s) => ({ id: s.id, name: s.name, ownership: s.ownership, state: s.state }));
    case 'space.use': {
      requireHub();
      const sp = resolveSpace(p.idOrName);
      await syncSpaceTargets(sp.id);
      sp.state = 'active'; store.persist();
      return spaceView(sp.id);
    }
    case 'space.claim':
    case 'space.takeOver': {
      requireHub();
      const sp = store.get(p.id);
      if (!sp) throw new EgoError('UnknownSpace', `no task space ${p.id}`);
      await syncSpaceTargets(sp.id);
      sp.state = 'active'; store.persist();
      return spaceView(sp.id);
    }
    case 'space.handOff': {
      const sp = store.get(p.id);
      if (sp) { sp.state = 'handed-off'; store.persist(); }
      return { handedOff: true };
    }
    case 'space.waitForControl': return { control: true };
    case 'space.finish': {
      const h = requireHub();
      const sp = store.get(p.id);
      if (!sp) throw new EgoError('UnknownSpace', `no task space ${p.id}`);
      const keep = Array.isArray(p.keep) ? p.keep : p.keep === 'all' ? Object.keys(sp.pages) : [];
      const closed = [];
      for (const label of Object.keys(sp.pages)) {
        if (keep.includes(label)) continue;
        const pg = sp.pages[label];
        if (pg.targetId) { try { await h.cdp.send('Target.closeTarget', { targetId: pg.targetId }); } catch {} }
        closed.push(label);
      }
      let deleted = false;
      if (keep.length === 0) { store.deleteSpace(sp.id); deleted = true; }
      return { retained: keep, closed, deleted };
    }
    case 'space.tabs': {
      const h = requireHub();
      const sp = resolveSpace(p.idOrName ?? p.id);
      const bound = new Set();
      for (const s2 of store.list()) for (const pg of Object.values(s2.pages)) if (pg.targetId) bound.add(pg.targetId);
      const out = [];
      for (const [label, pg] of Object.entries(sp.pages)) {
        if (!pg.targetId || !h.sessions.has(pg.targetId)) continue;
        const st = h.sessions.get(pg.targetId);
        out.push({ label, page: true, targetId: pg.targetId, title: st.title || pg.title || '', url: st.url || pg.url || '', active: sp.activeTargetId === pg.targetId, openedBy: pg.openedBy });
      }
      for (const [tid, st] of h.sessions) {
        if (bound.has(tid)) continue;
        out.push({ label: null, page: true, targetId: tid, title: st.title || '', url: st.url || '', active: false, openedBy: 'unknown' });
      }
      return out;
    }
    case 'page.new': {
      const h = requireHub();
      const sp = store.get(p.spaceId);
      if (!sp) throw new EgoError('UnknownSpace', `no task space ${p.spaceId}`);
      const t = await h.cdp.send('Target.createTarget', { url: 'about:blank', background: true });
      const label = p.as || store.nextLabel(sp.id);
      store.addPage(sp.id, label, t.targetId, 'agent');
      await waitSession(t.targetId);
      return { label, targetId: t.targetId };
    }
    case 'page.adopt': {
      const h = requireHub();
      const sp = store.get(p.spaceId);
      if (!sp) throw new EgoError('UnknownSpace', `no task space ${p.spaceId}`);
      if (!h.sessions.has(p.targetId)) {
        if (!h.adoptedPopups) h.adoptedPopups = new Set();
        h.adoptedPopups.add(p.targetId);
        await h.cdp.send('Target.attachToTarget', { targetId: p.targetId, flatten: true }).catch(() => {});
        await waitSession(p.targetId);
      }
      const label = p.as || store.nextLabel(sp.id);
      store.addPage(sp.id, label, p.targetId, 'agent');
      return { label, targetId: p.targetId };
    }
    case 'page.release': {
      const sp = store.get(p.spaceId);
      if (sp) store.removePage(sp.id, p.label);
      return { released: p.label };
    }
    case 'download.call': return downloadCall(p);
    case 'task.cdp': {
      const h = requireHub();
      return h.cdp.send(p.method, p.params || {}, { timeout: p.timeout || 30000 });
    }
    case 'page.call': return pageCall(p);
    default: throw new EgoError('UnknownMethod', `unknown RPC method ${method}`);
  }
}

function resolveSpace(idOrName) {
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const sp = store.get(Number(idOrName));
    if (sp) return sp;
  }
  const byName = store.list().find((s) => s.name === idOrName);
  if (byName) return byName;
  throw new EgoError('UnknownSpace', `no task space ${idOrName}`);
}

async function syncSpaceTargets(spaceId) {
  const h = requireHub();
  const sp = store.get(spaceId);
  const bound = new Set();
  for (const s2 of store.list()) {
    for (const pg2 of Object.values(s2.pages)) {
      if (pg2.targetId) bound.add(pg2.targetId);
    }
  }
  for (const [label, pg] of Object.entries(sp.pages)) {
    if (pg.targetId && h.sessions.has(pg.targetId)) continue;
    let reusedTid = null;
    for (const [tid, st] of h.sessions) {
      if (!bound.has(tid) && !st.isPopup && (!st.url || st.url === 'about:blank')) {
        reusedTid = tid;
        bound.add(tid);
        break;
      }
    }
    if (reusedTid) {
      store.bindPage(spaceId, label, reusedTid, pg.openedBy);
      continue;
    }
    const t = await h.cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    bound.add(t.targetId);
    store.bindPage(spaceId, label, t.targetId, pg.openedBy);
    await waitSession(t.targetId);
  }
}

async function waitSession(targetId, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (hub?.sessions.has(targetId)) return hub.sessions.get(targetId);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new EgoError('PageOpenError', `target ${targetId} did not attach`);
}

function spaceView(spaceId) {
  const sp = store.get(spaceId);
  const pages = Object.entries(sp.pages).map(([label, pg]) => ({ label, targetId: pg.targetId, url: pg.url || '', title: pg.title || '' }));
  return { id: sp.id, name: sp.name, ownership: sp.ownership, state: sp.state, pages };
}

async function pageCall(p) {
  const h = requireHub();
  const sp = store.get(p.spaceId);
  if (!sp) throw new EgoError('UnknownSpace', `no task space ${p.spaceId}`);
  const pg = sp.pages[p.label];
  if (!pg) throw new EgoError('UnknownPage', `no page ${p.label} in space ${p.spaceId}`);
  if (!pg.targetId || !h.sessions.has(pg.targetId)) throw new EgoError('PageClosedError', `page ${p.label} is closed`);
  const tid = pg.targetId;
  const [method, ...args] = [p.method, ...(p.args || [])];
  sp.activeTargetId = tid;
  let result;
  switch (method) {
    case 'goto': result = await h.goto(tid, ...args); break;
    case 'reload': result = await h.goto(tid, pg.url || 'about:blank', args[0] || {}); break;
    case 'url': result = (await h.info(tid)).url; break;
    case 'title': result = (await h.info(tid)).title; break;
    case 'info': result = await h.info(tid); break;
    case 'snapshot': {
      const snap = await h.snapshot(tid, args[0] || {});
      const tabs = await dispatch('space.tabs', { idOrName: sp.id });
      const managed = tabs.filter((t) => t.label).length;
      const untracked = tabs.filter((t) => !t.label).length;
      const pagesStr = tabs.filter((t) => t.label).map((t) => `${t.label}${t.active ? '*' : ''} "${String(t.title).replace(/"/g, '')}"`).join(', ');
      const header = `[${p.label} "${(snap.title || '').replace(/"/g, '')}" | space "${sp.name}"(${sp.id}): ${managed} managed, ${untracked} untracked${pagesStr ? ' — ' + pagesStr : ''}]`;
      result = [header, ...snap.lines].join('\n');
      break;
    }
    case 'screenshot': {
      const opts = args[0] || {};
      const b64 = await h.screenshot(tid, { fullPage: opts.fullPage, clip: opts.clip });
      if (opts.path) {
        const path = safePath(opts.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(b64, 'base64'));
        result = { path: opts.path };
      } else result = { base64: b64 };
      break;
    }
    case 'click': result = await h.click(tid, args[0], { ...(args[1] || {}), _action: 'click' }); break;
    case 'dblclick': result = await h.click(tid, args[0], { ...(args[1] || {}), clickCount: 2, _action: 'dblclick' }); break;
    case 'hover': {
      const r = await h.resolveInTime(tid, args[0], 'hover', args[1]?.timeout ?? 3000);
      const box = await h.call(tid, 'ensureVisible', JSON.stringify([r.hid]));
      await h.mouseInput(tid, 'mouseMoved', box.cx, box.cy);
      result = await h.actionReceipt(tid, Date.now() - 500);
      break;
    }
    case 'dragAndDrop': {
      const src = await h.resolveInTime(tid, args[0], 'dragAndDrop', args[2]?.timeout ?? 3000);
      const dst = await h.resolveInTime(tid, args[1], 'dragAndDrop', args[2]?.timeout ?? 3000);
      const b1 = await h.call(tid, 'ensureVisible', JSON.stringify([src.hid]));
      const b2 = await h.call(tid, 'ensureVisible', JSON.stringify([dst.hid]));
      await h.mouseInput(tid, 'mouseMoved', b1.cx, b1.cy);
      await h.mouseInput(tid, 'mousePressed', b1.cx, b1.cy);
      await h.mouseInput(tid, 'mouseMoved', (b1.cx + b2.cx) / 2, (b1.cy + b2.cy) / 2);
      await h.mouseInput(tid, 'mouseMoved', b2.cx, b2.cy);
      await h.mouseInput(tid, 'mouseReleased', b2.cx, b2.cy);
      result = await h.actionReceipt(tid, Date.now() - 1000);
      break;
    }
    case 'fill': result = await h.fill(tid, args[0], args[1], args[2] || {}); break;
    case 'selectOption': result = await h.selectOption(tid, args[0], args[1], args[2] || {}); break;
    case 'focus': result = await h.focus(tid, args[0], args[1] || {}); break;
    case 'press': {
      await h.focus(tid, args[0], { timeout: args[2]?.timeout ?? 3000 });
      result = await h.press(tid, args[1], args[2] || {});
      result = { ...(result || {}) };
      break;
    }
    case 'keyboard.press': await h.press(tid, args[0], args[1] || {}); result = {}; break;
    case 'keyboard.type': await h.typeText(tid, args[0], args[1] || {}); result = {}; break;
    case 'keyboard.insertText': await h.insertText(tid, args[0]); result = {}; break;
    case 'keyboard.down': case 'keyboard.up': {
      const raw = String(args[0]);
      const key = raw === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : raw;
      const d = keyDescriptor(key);
      if (!d) throw new EgoError('BadKey', `unknown key ${args[0]}`);
      await h.keyEvent(tid, method === 'keyboard.down' ? 'keyDown' : 'keyUp', d);
      result = {};
      break;
    }
    case 'mouse.click': {
      const [x, y, opts = {}] = args;
      await h.mouseInput(tid, 'mouseMoved', x, y);
      await h.mouseInput(tid, 'mousePressed', x, y, { button: opts.button, clickCount: opts.clickCount });
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      await h.mouseInput(tid, 'mouseReleased', x, y, { button: opts.button, clickCount: opts.clickCount });
      result = {};
      break;
    }
    case 'mouse.move': {
      const [x, y, opts = {}] = args;
      const steps = opts.steps ?? 1;
      for (let i = 1; i <= steps; i++) await h.mouseInput(tid, 'mouseMoved', x * i / steps, y * i / steps);
      h._pos = { x, y };
      result = {};
      break;
    }
    case 'mouse.down': case 'mouse.up': {
      const [opts = {}] = args;
      await h.rawMouse(tid, method === 'mouse.down' ? 'down' : 'up', [h._pos?.x ?? 0, h._pos?.y ?? 0], opts);
      result = {};
      break;
    }
    case 'mouse.wheel': {
      const [dx, dy] = args;
      await h.rawMouse(tid, 'wheel', [dx, dy]);
      result = {};
      break;
    }
    case 'evaluate': {
      const src = typeof args[0] === 'function' ? args[0].toString() : String(args[0]);
      result = await h.evaluate(tid, src, args[1], { timeout: 30000 });
      break;
    }
    case 'waitForFunctionProbe': {
      const src = typeof args[0] === 'function' ? args[0].toString() : String(args[0]);
      result = await h.evaluate(tid, src, args[1], { timeout: 5000 });
      break;
    }
    case 'waitForSelectorProbe': {
      const res = await h.call(tid, 'resolve', JSON.stringify([args[0], { requireVisible: args[1]?.state !== 'attached' }]));
      result = { count: res?.count ?? 0, visible: res?.d?.visible ?? false, ref: res?.d?.ref ?? null };
      break;
    }
    case 'waitForLoadState': result = await h.waitForLoadState(tid, args[0], args[1] || {}); break;
    case 'fetch': {
      const v = await h.fetchIn(tid, args[0], args[1] || {});
      if (v && v.__b64 !== undefined && args[1]?.saveAs) {
        const path = safePath(args[1].saveAs);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(v.__b64, 'base64'));
        delete v.__b64; delete v.b64;
        v.savedAs = path;
      } else if (v) { delete v.b64; delete v.__b64; }
      result = v;
      break;
    }
    case 'acceptDialog': result = await h.acceptDialog(tid, args[0]); break;
    case 'dismissDialog': result = await h.dismissDialog(tid); break;
    case 'setInputFiles': {
      const files = (Array.isArray(args[1]) ? args[1] : [args[1]]).map((f) => safePath(f, { mustExist: true }));
      result = await h.setInputFiles(tid, args[0], files);
      break;
    }
    case 'enableChooserIntercept': result = await h.enableChooserIntercept(tid, args[0]); break;
    case 'chooserSetFiles': {
      const files = (Array.isArray(args[1]) ? args[1] : [args[1]]).map((f) => safePath(f, { mustExist: true }));
      result = await h.chooserSetFiles(tid, args[0], files);
      break;
    }
    case 'takeChooser': result = h.takeChooser(tid); break;
    case 'events': result = h.events(tid); break;
    case 'resetSiteAuth': result = await h.resetSiteAuth(tid); break;
    case 'pageCdp': result = await h.cdp.send(args[0], args[1] || {}, { sessionId: h.sessionOf(tid).sessionId, timeout: args[2]?.timeout || 30000 }); break;
    case 'close': {
      await h.cdp.send('Target.closeTarget', { targetId: tid });
      store.removePage(p.spaceId, p.label);
      result = { closed: p.label };
      break;
    }
    case 'noop': result = {}; break;
    default: throw new EgoError('UnknownMethod', `page.${method} is not implemented in ego-linux`);
  }
  return result;
}

async function downloadCall(p) {
  const h = requireHub();
  const rec = h.downloads.get(p.guid);
  if (!rec && p.method !== 'url' && p.method !== 'suggestedFilename') throw new EgoError('UnknownDownload', `no download ${p.guid}`);
  switch (p.method) {
    case 'url': return rec?.url ?? null;
    case 'suggestedFilename': return rec?.suggestedFilename ?? null;
    case 'failure': return rec?.failure ?? null;
    case 'path': case 'saveAs': {
      const deadline = Date.now() + 120000;
      while (rec.state !== 'completed' && rec.state !== 'canceled' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      if (rec.state !== 'completed') throw new EgoError('DownloadError', `download ${p.guid} state=${rec.state}`);
      const src = join(h.downloadsDir, p.guid);
      const srcAlt = join(h.downloadsDir, rec.suggestedFilename);
      const from = existsSync(src) ? src : srcAlt;
      if (!existsSync(from)) throw new EgoError('DownloadError', `download file for ${p.guid} not found`);
      if (p.method === 'path') return from;
      const to = safePath((p.args || [])[0]);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      return { savedAs: to };
    }
    case 'cancel': await h.cdp.send('Browser.cancelDownload', { guid: p.guid }).catch(() => {}); return { canceled: true };
    case 'delete': {
      for (const f of [join(h.downloadsDir, p.guid), join(h.downloadsDir, rec.suggestedFilename)]) {
        try { if (existsSync(f)) rmSync(f); } catch {}
      }
      return { deleted: true };
    }
    default: throw new EgoError('UnknownMethod', `download.${p.method} not supported`);
  }
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[tp-browserd] FATAL: EADDRINUSE 127.0.0.1:${PORT} is already in use by another process; not starting (data dir ${DATA_DIR}, wanted CDP ${CHROME_DEBUG_PORT}). Pick a free EGO_BROWSERD_PORT.`);
    process.exit(98);
  }
  console.error(`[tp-browserd] FATAL: listen 127.0.0.1:${PORT} failed: ${e?.code || ''} ${e?.message || e}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(join(DATA_DIR, 'daemon.json'), JSON.stringify({ port: PORT, chromePort: CHROME_DEBUG_PORT, pid: process.pid, startedAt: STARTED_AT }, null, 1), { mode: 0o600 });
  log(`rpc: http://127.0.0.1:${PORT}/rpc  events: /events  (token at ${tokenPath()})`);
  log(`data dir: ${DATA_DIR}  cdp: 127.0.0.1:${CHROME_DEBUG_PORT}`);
  // Attach to Chromium only once we own the port: a daemon that loses the port race must not touch the browser
  // (previously it attached, restored the cookie vault and navigated tabs before crashing on EADDRINUSE).
  attachChrome();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); process.exit(0); });
