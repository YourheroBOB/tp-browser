#!/usr/bin/env node
// ego-browserd — daemon for the Linux agent browser (ego-browser compatible).
// Connects to an already-running Chromium DevTools endpoint (never launches
// processes), owns task spaces, and serves the CLI over authenticated
// localhost HTTP: POST /rpc for calls and GET /events (SSE) for pushes.
// Zero npm dependencies; Node >= 22.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp } from './cdp.js';
import { Store } from './store.js';
import { BrowserHub, EgoError } from './page-ops.js';
import { keyDescriptor } from './keys.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every caller-supplied filesystem path passes through safePath():
// absolute only, no '..' anywhere, no '.' components, no NUL bytes.
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
  if (mustExist && !existsSync(norm)) throw new EgoError('BadPath', `path does not exist: ${p}`);
  return norm;
}

// Data root is a fixed constant (symlink the directory to relocate it).
// Nothing environment-derived ever reaches a filesystem write or a fetch URL.
const DATA_DIR = join(homedir(), '.local', 'share', 'ego-linux');
const ALT_PORT = process.argv.includes('--alt-port') || process.env.EGO_BROWSERD_PORT === '9774';
const PORT = ALT_PORT ? 9774 : 9772;
// Chromium attach target is a fixed loopback constant (no env/config input).
const CHROME_DEBUG_PORT = ALT_PORT ? 9775 : 9773;
const CHROME_VERSION_URL = ALT_PORT ? 'http://127.0.0.1:9775/json/version' : 'http://127.0.0.1:9773/json/version';
const DOWNLOADS_DIR = join(DATA_DIR, 'downloads');
mkdirSync(DOWNLOADS_DIR, { recursive: true });

const store = new Store(join(DATA_DIR, 'spaces.json'));
let hub = null;
let chromeReady = false;

function log(...a) { console.log('[ego-browserd]', ...a); }

async function attachChrome() {
  for (;;) {
    try {
      const res = await fetch(CHROME_VERSION_URL, { signal: AbortSignal.timeout(3000) });
      const info = await res.json();
      const wsUrl = info.webSocketDebuggerUrl;
      if (!wsUrl || !String(wsUrl).startsWith('ws://127.0.0.1:')) throw new Error('unexpected webSocketDebuggerUrl');
      const cdp = new Cdp(wsUrl, 'chrome');
      await cdp.connect();
      hub = new BrowserHub(cdp, { downloadsDir: DOWNLOADS_DIR, onPush: broadcastPush });
      chromeReady = true;
      log('attached to Chromium:', wsUrl);
      cdp.onClose(() => { chromeReady = false; hub = null; log('Chromium connection lost; retrying'); setTimeout(attachChrome, 2000); });
      await rebindSpaces();
      // close leftover blank tabs from previous sessions (never space-bound pages);
      // wait for auto-attach to deliver existing targets first
      await new Promise((r) => setTimeout(r, 800));
      const bound = new Set();
      for (const s of store.list()) for (const pg of Object.values(s.pages)) if (pg.targetId) bound.add(pg.targetId);
      for (const [tid, st] of hub.sessions) {
        if (bound.has(tid)) continue;
        if (!st.url || st.url === 'about:blank' || st.url.startsWith('chrome://newtab') || st.url.startsWith('edge://newtab')) {
          try { await hub.cdp.send('Target.closeTarget', { targetId: tid }); } catch {}
        }
      }
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
      try {
        const t = await hub.cdp.send('Target.createTarget', { url: 'about:blank' });
        store.bindPage(sp.id, label, t.targetId, p.openedBy);
      } catch (e) { log(`rebind failed for ${sp.id}/${label}:`, e.message); }
    }
  }
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
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(p, randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(p, 'utf8').trim();
}
const TOKEN = ensureToken();
writeFileSync(join(DATA_DIR, 'daemon.json'), JSON.stringify({ port: PORT, chromePort: CHROME_DEBUG_PORT, pid: process.pid, startedAt: new Date().toISOString() }, null, 1));

// ---------- SSE push channels ----------
const sseClients = new Set();
function broadcastPush(targetId, kind, payload) {
  const line = `data: ${JSON.stringify({ type: 'push', targetId, kind, payload })}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch {} }
}

// ---------- HTTP server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, chrome: chromeReady, spaces: store.list().length })); return; }
  if (url.pathname === '/events') {
    if (req.headers['x-ego-token'] !== TOKEN) { res.writeHead(403).end('bad token'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/rpc' && req.method === 'POST') {
    if (req.headers['x-ego-token'] !== TOKEN) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { name: 'AuthError', message: 'bad token' } })); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
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
      const t = await h.cdp.send('Target.createTarget', { url: 'about:blank' });
      const label = p.as || store.nextLabel(sp.id);
      store.addPage(sp.id, label, t.targetId, 'agent');
      await waitSession(t.targetId);
      return { label, targetId: t.targetId };
    }
    case 'page.adopt': {
      const sp = store.get(p.spaceId);
      if (!sp) throw new EgoError('UnknownSpace', `no task space ${p.spaceId}`);
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
  for (const [label, pg] of Object.entries(sp.pages)) {
    if (pg.targetId && h.sessions.has(pg.targetId)) continue;
    const t = await h.cdp.send('Target.createTarget', { url: 'about:blank' });
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

server.listen(PORT, '127.0.0.1', () => {
  log(`rpc: http://127.0.0.1:${PORT}/rpc  events: /events  (token at ${tokenPath()})`);
  log(`data dir: ${DATA_DIR}`);
});
attachChrome();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); process.exit(0); });
