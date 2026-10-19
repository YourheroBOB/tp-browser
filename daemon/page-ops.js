// Page-level operations, executed by the daemon against one attached browser.
// All actions map to the ego-browser Page API surface (see references/api.md).
import { once } from './cdp.js';
import { parseChord, keyDescriptor, modifierBit } from './keys.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPAGE_SRC = readFileSync(join(__dirname, 'inpage.agent.js'), 'utf8');
const DATA_DIR = join(homedir(), '.local', 'share', 'ego-linux');
const COOKIES_VAULT_PATH = join(DATA_DIR, 'cookies-vault.json');
const STORAGE_VAULT_PATH = join(DATA_DIR, 'storage-vault.json');
const TABS_VAULT_PATH = join(DATA_DIR, 'session-tabs.json');

function cookieKey(c) {
  return `${c.name || ''}|${c.domain || ''}|${c.path || '/'}`;
}

function toCookieParam(c) {
  const host = String(c?.domain || '').replace(/^\./, '');
  if (!host || !c?.name || typeof c.value !== 'string') return null;
  const isHostPrefix = String(c.name).startsWith('__Host-');
  const isSecurePrefix = String(c.name).startsWith('__Secure-');
  const secure = Boolean(c.secure || isHostPrefix || isSecurePrefix || c.sameSite === 'None');
  const path = isHostPrefix ? '/' : (c.path || '/');
  const url = (secure ? 'https://' : 'http://') + host + path;
  const now = Math.floor(Date.now() / 1000);
  const expires = (!c.expires || c.expires <= 0 || c.session) ? (now + 30 * 86400) : c.expires;
  if (expires <= now) return null;
  const param = {
    name: c.name,
    value: c.value,
    url,
    path,
    secure,
    httpOnly: Boolean(c.httpOnly),
    expires,
  };
  if (!isHostPrefix && c.domain) {
    param.domain = c.domain;
  }
  if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) {
    param.sameSite = c.sameSite;
  }
  if (c.priority && ['Low', 'Medium', 'High'].includes(c.priority)) {
    param.priority = c.priority;
  }
  if (c.partitionKey && typeof c.partitionKey === 'object' && typeof c.partitionKey.topLevelSite === 'string') {
    param.partitionKey = {
      topLevelSite: c.partitionKey.topLevelSite,
      hasCrossSiteAncestor: Boolean(c.partitionKey.hasCrossSiteAncestor),
    };
  }
  return param;
}

export class EgoError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}

const BTN = { left: 'left', right: 'right', middle: 'middle' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORIDE_BAR_SCRIPT = `(function(){
  if (window !== window.top) return;
  try { if (window.opener && window.opener !== window) return; } catch {}
  if (!/^(https?|file):$/i.test(location.protocol)) return;
  if (location.href === 'about:blank' || location.href.startsWith('about:')) return;
  function syncTpTitle() {
    try {
      if (document.readyState === 'loading' || !document.body) return;
      const t = String(document.title || '').trim();
      if (t && !t.startsWith('⚡[TP]')) {
        document.title = '⚡[TP] ' + t;
      }
    } catch {}
  }
  function syncTpStorage() {
    try {
      if (location.protocol !== 'https:' || typeof window.__tpCoRideAction !== 'function') return;
      const ls = [];
      const ss = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && !k.startsWith('__tp_coride_')) {
          const v = localStorage.getItem(k);
          if (typeof v === 'string' && v.length < 65536) ls.push([k, v]);
        }
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && !k.startsWith('__tp_coride_')) {
          const v = sessionStorage.getItem(k);
          if (typeof v === 'string' && v.length < 65536) ss.push([k, v]);
        }
      }
      if (ls.length === 0 && ss.length === 0) return;
      const sig = ls.length + ':' + ss.length + ':' + ls.map(x => x[0].length + ':' + x[1].length).join(',') + '|' + ss.map(x => x[0].length + ':' + x[1].length).join(',');
      if (window.__tpLastStorageSig === sig) return;
      window.__tpLastStorageSig = sig;
      window.__tpCoRideAction(JSON.stringify({ action: 'syncStorage', origin: location.origin, ls, ss }));
    } catch {}
  }
  function mountTpBar() {
    try {
      if (document.readyState === 'loading' || !document.body) return;
      syncTpTitle();
      syncTpStorage();
      const parent = document.body;
      if (!parent || document.getElementById('__tp_coride_host')) return;
      const host = document.createElement('div');
      host.id = '__tp_coride_host';
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed !important;bottom:18px !important;right:18px !important;z-index:2147483647 !important;pointer-events:auto !important;display:block !important;';
      const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      let mode = 'agent';
      let min = false;
      try {
        mode = sessionStorage.getItem('__tp_coride_mode') || 'agent';
        min = sessionStorage.getItem('__tp_coride_min') === '1';
      } catch {}

      const render = () => {
        while (root.firstChild) root.removeChild(root.firstChild);
        const isHuman = mode === 'human';
        const style = document.createElement('style');
        style.textContent = [
          '.top-strip { position:fixed; top:0; left:0; right:0; height:4px; z-index:2147483647; pointer-events:none; background:' + (isHuman ? 'linear-gradient(90deg, #F59E0B 0%, #8FB379 50%, #F59E0B 100%)' : 'linear-gradient(90deg, #C99A4B 0%, #10B981 50%, #C99A4B 100%)') + '; box-shadow:0 1px 10px rgba(201,154,75,0.75); }',
          '.bar { display:flex; align-items:center; gap:8px; background:rgba(18,16,14,0.96); border:2px solid ' + (isHuman ? '#8FB379' : '#C99A4B') + '; color:#FAF6EE; padding:' + (min ? '8px 12px' : '10px 16px') + '; border-radius:999px; font:600 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace; box-shadow:0 12px 32px rgba(0,0,0,0.65); backdrop-filter:blur(10px); user-select:none; }',
          '.brand { color:#C99A4B; font-weight:800; letter-spacing:0.3px; display:flex; align-items:center; gap:6px; cursor:pointer; }',
          '.status { color:' + (isHuman ? '#A8C296' : '#E6C786') + '; font-size:12px; padding:3px 8px; border-radius:999px; background:' + (isHuman ? 'rgba(124,139,111,0.22)' : 'rgba(201,154,75,0.18)') + '; }',
          'button.act { cursor:pointer; border:none; border-radius:999px; padding:6px 12px; font:700 12px/1 -apple-system,BlinkMacSystemFont,sans-serif; color:#12100E; background:' + (isHuman ? '#8FB379' : '#C99A4B') + '; transition:transform 0.12s,filter 0.15s; }',
          'button.act:hover { filter:brightness(1.1); transform:translateY(-1px); }',
          'button.sub { cursor:pointer; border:1px solid rgba(201,154,75,0.45); border-radius:999px; padding:5px 10px; font:600 11.5px/1 -apple-system,BlinkMacSystemFont,sans-serif; color:#E6C786; background:rgba(201,154,75,0.12); transition:background 0.15s; }',
          'button.sub:hover { background:rgba(201,154,75,0.26); color:#FAF6EE; }',
          'button.min { cursor:pointer; border:none; background:transparent; color:#9E9589; font-size:13px; padding:2px 6px; }',
          'button.min:hover { color:#FAF6EE; }'
        ].join('\\n');
        root.appendChild(style);

        const strip = document.createElement('div');
        strip.className = 'top-strip';
        root.appendChild(strip);

        const bar = document.createElement('div');
        bar.className = 'bar';

        const brand = document.createElement('span');
        brand.className = 'brand';
        brand.title = 'TooPower Browser — 強到沒朋友';
        brand.textContent = '⚡ TooPower';
        if (min) {
          brand.onclick = () => {
            min = false;
            try { sessionStorage.setItem('__tp_coride_min', '0'); } catch {}
            render();
          };
        }
        bar.appendChild(brand);

        if (!min) {
          const st = document.createElement('span');
          st.className = 'status';
          st.textContent = isHuman ? '🧑 人類接手模式 (Agent 暫停)' : '🟢 Agent 共乘待命';
          bar.appendChild(st);

          const btn = document.createElement('button');
          btn.className = 'act';
          btn.textContent = isHuman ? '🤖 完成並交還 Agent' : '🧑 我要接手操控';
          btn.onclick = () => {
            mode = (mode === 'agent') ? 'human' : 'agent';
            try { sessionStorage.setItem('__tp_coride_mode', mode); } catch {}
            try { if (typeof window.__tpCoRideAction === 'function') window.__tpCoRideAction(JSON.stringify({ mode })); } catch {}
            render();
          };
          bar.appendChild(btn);

          const rstBtn = document.createElement('button');
          rstBtn.className = 'sub';
          rstBtn.title = '清除本站舊登入 Cookie 並強制跳出帳號選擇器（解決 Hotmail/Google 自動帶錯帳號被擋）';
          rstBtn.textContent = '🔄 換帳號';
          rstBtn.onclick = () => {
            rstBtn.textContent = '清除中...';
            try { if (typeof window.__tpCoRideAction === 'function') window.__tpCoRideAction(JSON.stringify({ action: 'resetSiteAuth', url: location.href })); } catch {}
          };
          bar.appendChild(rstBtn);
        }

        const minBtn = document.createElement('button');
        minBtn.className = 'min';
        minBtn.title = '收合/展開';
        minBtn.textContent = min ? '展開' : '—';
        minBtn.onclick = () => {
          min = !min;
          try { sessionStorage.setItem('__tp_coride_min', min ? '1' : '0'); } catch {}
          render();
        };
        bar.appendChild(minBtn);

        root.appendChild(bar);
      };
      render();
      parent.appendChild(host);
    } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountTpBar, { once: true });
  else mountTpBar();
  setTimeout(mountTpBar, 600);
  if (!window.__tpCoRideTimer) {
    window.__tpCoRideTimer = setInterval(mountTpBar, 1800);
  }
})();`;

export class BrowserHub {
  // One attached Chromium. sessions: targetId -> state.
  constructor(cdp, { downloadsDir, onPush, daemonPort }) {
    this.cdp = cdp;
    this.downloadsDir = downloadsDir;
    this.onPush = onPush; // fn(targetId, kind, payload)
    this.daemonPort = daemonPort || 9772;
    this.sessions = new Map(); // targetId -> {sessionId, mainFrameId, frames:Set, net:Set, title, url, modBits}
    this.downloads = new Map(); // guid -> record
    this.popupsSeen = []; // {targetId, openerId, at}
    this.cookieVault = new Map(); // cookieKey -> cookie
    this.storageVault = {}; // origin -> { ls: [[k,v]], ss: [[k,v]], updatedAt }
    this._loadVaultsFromDisk();
    this._wire();
    this._sweepTick = 0;
    this._sweepTimer = setInterval(() => {
      this._sweepTick++;
      const now = Date.now();
      const totalTabs = this.sessions.size;
      for (const [tid, st] of this.sessions) {
        const u = String(st.url || '');
        const isBlank = !u || u === 'about:blank';
        if (st.isPopup) {
          // If an OAuth/window.open popup got stuck on about:blank for >6s with no pending network activity, auto-close it
          if (isBlank && st.net.size === 0 && (now - (st.attachedAt || now)) > 6000) {
            this.cdp.send('Target.closeTarget', { targetId: tid }).catch(() => {});
          }
          continue;
        }
        if (isBlank && !st.agentNavigating && totalTabs > 1 && (now - (st.attachedAt || now)) > 5000) {
          this.cdp.send('Target.closeTarget', { targetId: tid }).catch(() => {});
          continue;
        }
        if (st.domReady) {
          this._ensureCoRideBar(st, true);
        }
      }
      if (this._sweepTick % 2 === 0) {
        this.syncVaultNow().catch(() => {});
      }
    }, 2000);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  _loadVaultsFromDisk() {
    try {
      if (existsSync(COOKIES_VAULT_PATH)) {
        const raw = JSON.parse(readFileSync(COOKIES_VAULT_PATH, 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw.cookies || []);
        const now = Math.floor(Date.now() / 1000);
        for (const c of list) {
          if (!c || !c.name || !c.domain) continue;
          if (!c.expires || c.expires <= 0 || c.session) {
            c.expires = now + 30 * 86400;
            c.session = false;
          }
          if (c.expires > now) {
            this.cookieVault.set(cookieKey(c), c);
          }
        }
      }
    } catch {}
    try {
      if (existsSync(STORAGE_VAULT_PATH)) {
        const raw = JSON.parse(readFileSync(STORAGE_VAULT_PATH, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.storageVault = raw;
        }
      }
    } catch {}
  }

  _persistCookieVault() {
    try {
      const cookies = [...this.cookieVault.values()];
      writeFileSync(COOKIES_VAULT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), cookies }), { mode: 0o600 });
    } catch {}
  }

  _persistStorageVault() {
    try {
      writeFileSync(STORAGE_VAULT_PATH, JSON.stringify(this.storageVault), { mode: 0o600 });
    } catch {}
  }

  _buildStoragePreloadScript() {
    const json = JSON.stringify(this.storageVault || {});
    return `(function(){
      try {
        if (location.protocol !== 'https:') return;
        const vault = ${json};
        const entry = vault[location.origin];
        if (!entry) return;
        if (Array.isArray(entry.ls)) {
          for (const [k, v] of entry.ls) {
            if (typeof k === 'string' && typeof v === 'string' && localStorage.getItem(k) === null) {
              localStorage.setItem(k, v);
            }
          }
        }
        if (Array.isArray(entry.ss)) {
          for (const [k, v] of entry.ss) {
            if (typeof k === 'string' && typeof v === 'string' && sessionStorage.getItem(k) === null) {
              sessionStorage.setItem(k, v);
            }
          }
        }
      } catch {}
    })();`;
  }

  _injectOriginStorageIfPresent(st) {
    try {
      if (!st || st.isPopup) return;
      const u = String(st.url || '');
      if (!u.startsWith('https://')) return;
      const origin = new URL(u).origin;
      const entry = this.storageVault[origin];
      if (!entry) return;
      const expr = `(function(){
        try {
          const entry = ${JSON.stringify(entry)};
          let restored = 0;
          if (Array.isArray(entry.ls)) {
            for (const [k, v] of entry.ls) {
              if (typeof k === 'string' && typeof v === 'string' && localStorage.getItem(k) === null) {
                localStorage.setItem(k, v);
                restored++;
              }
            }
          }
          if (Array.isArray(entry.ss)) {
            for (const [k, v] of entry.ss) {
              if (typeof k === 'string' && typeof v === 'string' && sessionStorage.getItem(k) === null) {
                sessionStorage.setItem(k, v);
                restored++;
              }
            }
          }
          return restored;
        } catch { return 0; }
      })();`;
      this.cdp.send('Runtime.evaluate', { expression: expr }, { sessionId: st.sessionId }).catch(() => {});
    } catch {}
  }

  async restoreVaultToBrowser() {
    try {
      const params = [];
      for (const c of this.cookieVault.values()) {
        const p = toCookieParam(c);
        if (p) params.push(p);
      }
      if (params.length > 0) {
        await this.cdp.send('Storage.setCookies', { cookies: params });
      }
    } catch {}
  }

  async syncVaultNow() {
    if (this._syncingVault) return;
    this._syncingVault = true;
    try {
      const { cookies } = await this.cdp.send('Storage.getCookies', {});
      if (Array.isArray(cookies) && cookies.length > 0) {
        const now = Math.floor(Date.now() / 1000);
        const toPromote = [];
        let changed = false;
        for (const c of cookies) {
          if (!c || !c.name || !c.domain) continue;
          const isSession = !c.expires || c.expires <= 0 || c.session;
          if (isSession) {
            c.expires = now + 30 * 86400;
            c.session = false;
            const p = toCookieParam(c);
            if (p) toPromote.push(p);
            changed = true;
          }
          const key = cookieKey(c);
          const prev = this.cookieVault.get(key);
          if (!prev || prev.value !== c.value || Math.abs((prev.expires || 0) - (c.expires || 0)) > 60) {
            this.cookieVault.set(key, c);
            changed = true;
          }
        }
        if (toPromote.length > 0) {
          await this.cdp.send('Storage.setCookies', { cookies: toPromote }).catch(() => {});
        }
        if (changed) {
          this._persistCookieVault();
        }
      }
      // Also record open user https:// tabs (excluding login/oauth interstitials)
      const openUrls = [];
      const seen = new Set();
      for (const [, st] of this.sessions) {
        if (st.isPopup) continue;
        const u = String(st.url || '');
        if (!u.startsWith('https://')) continue;
        if (/login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|\/oauth|\/signin|\/login/i.test(u)) continue;
        if (!seen.has(u)) {
          seen.add(u);
          openUrls.push({ url: u, title: st.title || '' });
        }
      }
      if (openUrls.length > 0) {
        writeFileSync(TABS_VAULT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), tabs: openUrls.slice(0, 8) }), { mode: 0o600 });
      }
    } catch {} finally {
      this._syncingVault = false;
    }
  }

  getSavedTabs() {
    try {
      if (existsSync(TABS_VAULT_PATH)) {
        const raw = JSON.parse(readFileSync(TABS_VAULT_PATH, 'utf8'));
        return Array.isArray(raw?.tabs) ? raw.tabs : [];
      }
    } catch {}
    return [];
  }

  _handleStorageSync(payload) {
    try {
      const origin = String(payload?.origin || '');
      if (!origin.startsWith('https://')) return;
      const prev = this.storageVault[origin] || { ls: [], ss: [] };
      const lsMap = new Map(Array.isArray(prev.ls) ? prev.ls : []);
      const ssMap = new Map(Array.isArray(prev.ss) ? prev.ss : []);
      if (Array.isArray(payload.ls)) {
        for (const [k, v] of payload.ls) {
          if (typeof k === 'string' && typeof v === 'string') lsMap.set(k, v);
        }
      }
      if (Array.isArray(payload.ss)) {
        for (const [k, v] of payload.ss) {
          if (typeof k === 'string' && typeof v === 'string') ssMap.set(k, v);
        }
      }
      this.storageVault[origin] = {
        updatedAt: new Date().toISOString(),
        ls: [...lsMap.entries()],
        ss: [...ssMap.entries()],
      };
      this._persistStorageVault();
    } catch {}
  }

  _ensureCoRideBar(st, isDomReady = false) {
    if (!st || st.isPopup) return;
    const u = String(st.url || '');
    if (u.startsWith('chrome://newtab') || u.startsWith('chrome://new-tab-page') || u.startsWith('edge://newtab')) {
      if (!st._newtabRedirectTimer && !st.agentNavigating) {
        st._newtabRedirectTimer = setTimeout(() => {
          st._newtabRedirectTimer = null;
          const cur = String(st.url || '');
          if (!st.agentNavigating && (cur.startsWith('chrome://newtab') || cur.startsWith('chrome://new-tab-page') || cur.startsWith('edge://newtab'))) {
            this.cdp.send('Page.navigate', { url: `http://127.0.0.1:${this.daemonPort}/newtab` }, { sessionId: st.sessionId }).catch(() => {});
          }
        }, 250);
      }
      return;
    }
    if (!u || u === 'about:blank' || u.startsWith('about:') || u.startsWith('chrome://') || u.startsWith('devtools://') || u.startsWith('edge://')) {
      return;
    }
    if (isDomReady) {
      this._injectOriginStorageIfPresent(st);
      this.cdp.send('Runtime.evaluate', { expression: CORIDE_BAR_SCRIPT }, { sessionId: st.sessionId }).catch(() => {});
    }
  }

  async resetSiteAuth(targetId) {
    const st = this.sessionOf(targetId);
    const curUrl = st.url || (await this.evalIn(targetId, 'location.href').catch(() => '')) || '';
    let host = '';
    try { host = new URL(curUrl).hostname.toLowerCase(); } catch {}
    const matchDomains = new Set();
    if (host) {
      matchDomains.add(host);
      const parts = host.split('.');
      if (parts.length >= 2) matchDomains.add(parts.slice(-2).join('.'));
    }
    if (/microsoft|live\.com|office|azure|hotmail/i.test(host)) {
      for (const d of ['microsoftonline.com', 'live.com', 'microsoft.com', 'office.com', 'azure.com']) matchDomains.add(d);
    }
    if (/google|youtube|gmail/i.test(host)) {
      for (const d of ['google.com', 'accounts.google.com', 'youtube.com']) matchDomains.add(d);
    }
    try {
      const { cookies } = await this.cdp.send('Storage.getCookies', {});
      for (const c of cookies || []) {
        const cd = String(c.domain || '').replace(/^\./, '').toLowerCase();
        for (const md of matchDomains) {
          if (cd === md || cd.endsWith('.' + md)) {
            await this.cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }, { sessionId: st.sessionId }).catch(() => {});
            break;
          }
        }
      }
    } catch {}
    // Also purge matching domains from Cookie Vault & Storage Vault so old account is not re-injected
    for (const [k, c] of this.cookieVault.entries()) {
      const cd = String(c.domain || '').replace(/^\./, '').toLowerCase();
      for (const md of matchDomains) {
        if (cd === md || cd.endsWith('.' + md)) {
          this.cookieVault.delete(k);
          break;
        }
      }
    }
    this._persistCookieVault();
    for (const orig of Object.keys(this.storageVault)) {
      try {
        const oh = new URL(orig).hostname.toLowerCase();
        for (const md of matchDomains) {
          if (oh === md || oh.endsWith('.' + md)) {
            delete this.storageVault[orig];
            break;
          }
        }
      } catch {}
    }
    this._persistStorageVault();
    try {
      if (curUrl.startsWith('http')) {
        const origin = new URL(curUrl).origin;
        await this.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,session_storage,indexeddb' }, { sessionId: st.sessionId }).catch(() => {});
      }
    } catch {}
    let nextUrl = curUrl;
    try {
      const u = new URL(curUrl);
      if (/login\.microsoftonline\.com|accounts\.google\.com|login\.live\.com/i.test(u.hostname)) {
        u.searchParams.set('prompt', 'select_account');
        nextUrl = u.toString();
      }
    } catch {}
    if (nextUrl) {
      await this.cdp.send('Page.navigate', { url: nextUrl }, { sessionId: st.sessionId }).catch(() => {});
    }
    return { clearedDomains: [...matchDomains], url: nextUrl };
  }

  _wire() {
    const cdp = this.cdp;
    cdp.onEvent(({ sessionId, method, params }) => {
      // browser-level events have sessionId === null
      if (!sessionId) return this._browserEvent(method, params);
      for (const [tid, st] of this.sessions) {
        if (st.sessionId === sessionId) { this._sessionEvent(tid, st, method, params); return; }
      }
    });
    // IMPORTANT: Do NOT use Browser-level Target.setAutoAttach!
    // In Chromium, Browser-level Target.setAutoAttach hooks WebContentsCreated inside synchronous window.open(),
    // which intercepts OAuth popups (Google/Microsoft/Apple login) at url="" / about:blank and stalls their navigation!
    // Instead, use Target.setDiscoverTargets and selectively attach ONLY to non-popup top-level page targets.
    cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', eventsEnabled: true, downloadPath: this.downloadsDir }).catch(() => {});
    // ONLY override User-Agent when running in HeadlessChrome mode!
    // In headed mode, the real Chrome/Edge binary already has 100% authentic UA + Client Hints,
    // and overriding them via CDP breaks hCaptcha/Cloudflare/OAuth client attestation!
    this._cleanUaPromise = cdp.send('Browser.getVersion').then((v) => {
      const rawUa = v?.userAgent || '';
      if (!/Headless/i.test(rawUa)) return null;
      const userAgent = rawUa.replace('HeadlessChrome/', 'Chrome/');
      const fullVer = (v?.product || 'Chrome/155.0.0.0').split('/')[1] || '155.0.0.0';
      const majorVer = fullVer.split('.')[0] || '155';
      const isWin = /Windows/i.test(userAgent);
      const isMac = /Macintosh/i.test(userAgent);
      const isEdge = /Edg\//i.test(userAgent);
      const brandName = isEdge ? 'Microsoft Edge' : 'Google Chrome';
      const platform = isWin ? 'Windows' : (isMac ? 'macOS' : 'Linux');
      const platformVersion = isWin ? '15.0.0' : (isMac ? '15.0.0' : '6.8.0');
      const arch = isMac && process.arch === 'arm64' ? 'arm' : 'x86';
      const userAgentMetadata = {
        brands: [
          { brand: 'Not_A Brand', version: '24' },
          { brand: 'Chromium', version: majorVer },
          { brand: brandName, version: majorVer },
        ],
        fullVersionList: [
          { brand: 'Not_A Brand', version: '24.0.0.0' },
          { brand: 'Chromium', version: fullVer },
          { brand: brandName, version: fullVer },
        ],
        platform,
        platformVersion,
        architecture: arch,
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      };
      return { userAgent, userAgentMetadata };
    }).catch(() => null);
  }

  async _browserEvent(method, params) {
    if (method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = params;
      if (targetInfo.type !== 'page') {
        try { await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }); } catch {}
        return;
      }
      const isPopup = Boolean(targetInfo.openerId);
      if (isPopup && !(this.adoptedPopups && this.adoptedPopups.has(targetInfo.targetId))) {
        try { await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }); } catch {}
        try { await this.cdp.send('Target.detachFromTarget', { sessionId }); } catch {}
        return;
      }
      const curUrl = targetInfo.url || '';
      const isAlreadyLoaded = Boolean(curUrl && curUrl !== 'about:blank' && !curUrl.startsWith('about:'));
      const st = {
        sessionId, targetInfo, mainFrameId: null, frames: new Set(),
        net: new Set(), netQuietAt: Date.now(), events: [], dialogs: [], choosers: [],
        title: targetInfo.title || '', url: curUrl, modBits: 0, interceptingChooser: false, uaCleaned: false,
        isPopup: false, attachedAt: Date.now(), domReady: isAlreadyLoaded,
      };
      this.sessions.set(targetInfo.targetId, st);
      const opts = { sessionId };
      await Promise.all(['Page.enable', 'Runtime.enable', 'DOM.enable', 'Network.enable'].map((x) => this.cdp.send(x, {}, opts).catch(() => {})));
      if (this._cleanUaPromise) {
        this._cleanUaPromise.then((uaInfo) => {
          if (uaInfo && uaInfo.userAgent) {
            this.cdp.send('Network.setUserAgentOverride', { userAgent: uaInfo.userAgent, userAgentMetadata: uaInfo.userAgentMetadata }, opts).catch(() => {});
            st.uaCleaned = true;
          }
        }).catch(() => {});
      }
      await this.cdp.send('Runtime.addBinding', { name: '__tpCoRideAction' }, opts).catch(() => {});
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: this._buildStoragePreloadScript() }, opts).catch(() => {});
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CORIDE_BAR_SCRIPT }, opts).catch(() => {});
      if (isAlreadyLoaded) {
        this._ensureCoRideBar(st, true);
      }
      return;
    }
    if (method === 'Target.targetCreated') {
      const ti = params.targetInfo;
      if (ti.type === 'page') {
        if (ti.openerId) {
          this.popupsSeen.push({ targetId: ti.targetId, openerId: ti.openerId, at: Date.now() });
          this.onPush(ti.openerId, 'popup', { targetId: ti.targetId, openerId: ti.openerId });
        } else if (!this.sessions.has(ti.targetId)) {
          this.cdp.send('Target.attachToTarget', { targetId: ti.targetId, flatten: true }).catch(() => {});
        }
      }
      return;
    }
    if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
      const tid = params.targetId;
      if (tid && this.sessions.has(tid)) this.sessions.delete(tid);
      return;
    }
    if (method === 'Browser.downloadWillBegin') {
      const { guid, url, suggestedFilename, frameId } = params;
      let targetId = null;
      for (const [tid, st] of this.sessions) if (st.frames.has(frameId)) { targetId = tid; break; }
      const rec = { guid, url, suggestedFilename, targetId, state: 'inProgress', failure: null };
      this.downloads.set(guid, rec);
      if (targetId) this.onPush(targetId, 'download', { kind: 'begin', guid });
      return;
    }
    if (method === 'Browser.downloadProgress') {
      const rec = this.downloads.get(params.guid);
      if (!rec) return;
      if (params.state === 'completed') rec.state = 'completed';
      else if (params.state === 'canceled') { rec.state = 'canceled'; rec.failure = 'canceled'; }
      if (rec.targetId) this.onPush(rec.targetId, 'download', { kind: params.state, guid: params.guid });
    }
  }

  _sessionEvent(tid, st, method, params) {
    switch (method) {
      case 'Page.frameNavigated':
        st.frames.add(params.frame.id);
        if (!params.frame.parentId) {
          st.mainFrameId = params.frame.id;
          st.url = params.frame.url || '';
          st.domReady = false;
          if (params.frame.name) st.title = params.frame.name;
          this._injectOriginStorageIfPresent(st);
          this._ensureCoRideBar(st, false);
        }
        return;
      case 'Page.domContentEventFired':
        st.domReady = true;
        this._ensureCoRideBar(st, true);
        return;
      case 'Page.loadEventFired':
        st.domReady = true;
        this._ensureCoRideBar(st, true);
        this.syncVaultNow().catch(() => {});
        return;
      case 'Page.navigatedWithinDocument':
        st.url = params.url;
        st.domReady = true;
        this._ensureCoRideBar(st, true);
        return;
      case 'Page.downloadWillBegin':
        return;
      case 'Runtime.executionContextsCleared':
        st.injected = false;
        return;
      case 'Page.javascriptDialogOpening':
        st.dialogs.push({ type: params.type, message: params.message, url: params.url, defaultPrompt: params.defaultPrompt });
        this.onPush(tid, 'dialog', st.dialogs[st.dialogs.length - 1]);
        return;
      case 'Page.fileChooserOpened': {
        const rec = { mode: params.mode, backendNodeId: params.backendNodeId ?? null, frameId: params.frameId };
        st.choosers.push(rec);
        this.onPush(tid, 'fileChooser', rec);
        return;
      }
      case 'Network.requestWillBeSent':
        st.net.add(params.requestId); st.netQuietAt = null;
        return;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        st.net.delete(params.requestId);
        if (st.net.size === 0) st.netQuietAt = Date.now();
        return;
      case 'Page.windowOpen':
        return;
      case 'Runtime.bindingCalled':
        if (params.name === '__tpCoRideAction') {
          try {
            const payload = JSON.parse(params.payload || '{}');
            if (payload?.action === 'syncStorage') {
              this._handleStorageSync(payload);
            } else {
              this.onPush(tid, 'coride', payload);
            }
          } catch {}
        }
        return;
      default:
        st.events.push({ method, params });
        if (st.events.length > 300) st.events.splice(0, st.events.length - 300);
    }
  }

  sessionOf(targetId) {
    const st = this.sessions.get(targetId);
    if (!st) throw new EgoError('PageClosedError', `target ${targetId} is not attached`);
    return st;
  }

  async evalIn(targetId, expression, { awaitPromise = false, timeout = 30000 } = {}) {
    const st = this.sessionOf(targetId);
    const res = await this.cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    }, { sessionId: st.sessionId, timeout });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new EgoError('PageError', (d.exception?.description || d.text || 'evaluation failed').split('\n')[0]);
    }
    return res.result?.value;
  }

  async ensureInpage(targetId) {
    const r = await this.evalIn(targetId, INPAGE_SRC);
    return r;
  }

  async call(targetId, helper, argsJson) {
    await this.ensureInpage(targetId);
    return this.evalIn(targetId, `(window.__egoAgent.${helper}(...${argsJson}))`, { awaitPromise: false });
  }

  async popupsFor(targetId, sinceMs) {
    return this.popupsSeen.filter((p) => p.openerId === targetId && p.at >= sinceMs);
  }

  // ---- goto / waits ----
  async goto(targetId, url, { referer, timeout = 30000, waitUntil = 'load', bringToFront } = {}) {
    const st = this.sessionOf(targetId);
    st.agentNavigating = true;
    if (st._newtabRedirectTimer) { clearTimeout(st._newtabRedirectTimer); st._newtabRedirectTimer = null; }
    if (bringToFront || /login\.microsoftonline\.com|devicelogin|login\.live\.com|accounts\.google\.com|oauth2\/|signin/i.test(String(url || ''))) {
      await this.cdp.send('Page.bringToFront', {}, { sessionId: st.sessionId }).catch(() => {});
    }
    if (!st.uaCleaned && this._cleanUaPromise) {
      const uaInfo = await this._cleanUaPromise;
      if (uaInfo && uaInfo.userAgent) {
        await this.cdp.send('Network.setUserAgentOverride', {
          userAgent: uaInfo.userAgent,
          userAgentMetadata: uaInfo.userAgentMetadata,
        }, { sessionId: st.sessionId }).catch(() => {});
        st.uaCleaned = true;
      }
    }
    const started = Date.now();
    // Arm the load-event waiter BEFORE sending Page.navigate: a fast page can
    // finish loading between the navigate command and a later once().
    let waitP = null; let evName = null;
    if (waitUntil === 'load' || waitUntil === 'domcontentloaded') {
      evName = waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired';
      waitP = once(this.cdp, evName, { sessionId: st.sessionId, timeout });
      waitP.catch(() => {});
    }
    const res = await this.cdp.send('Page.navigate', { url, referer }, { sessionId: st.sessionId, timeout: Math.min(timeout, 30000) }).catch((e) => { throw new EgoError('NavigationError', `page.goto: ${e.message}`); });
    if (res.errorText) throw new EgoError('NavigationError', `page.goto: ${res.errorText} (${url})`);
    if (waitUntil === 'commit') { st.url = url; return { url: res.url || url, frameId: res.frameId }; }
    if (waitP) {
      // Hybrid wait: resolve on the load event OR on a readyState poll that
      // observes the committed navigation reaching 'complete'. Event-only
      // waits are timing-fragile on freshly attached targets.
      const targetUrl = res.url || url;
      let done = false;
      waitP.then(() => { done = true; }, () => {});
      const deadline = started + timeout;
      while (!done && Date.now() < deadline) {
        await sleep(150);
        let rs = null; let cur = null;
        try { rs = await this.evalIn(targetId, 'document.readyState', { timeout: 1500 }); } catch {}
        if (rs === 'complete') {
          try { cur = await this.evalIn(targetId, 'location.href', { timeout: 1500 }); } catch {}
          if (cur === targetUrl || (cur && targetUrl.startsWith(cur.replace(/\/$/, '')))) done = true;
        }
      }
      if (!done) throw new EgoError('NavigationError', `page.goto: timeout ${timeout}ms exceeded waiting for ${waitUntil} at ${url}`);
      return { url: targetUrl, frameId: res.frameId };
    }
    if (waitUntil === 'networkidle') {
      const deadline = started + timeout;
      while (Date.now() < deadline) {
        if (st.net.size === 0 && st.netQuietAt && Date.now() - st.netQuietAt >= 500) return { url: res.url || url, frameId: res.frameId };
        await sleep(120);
      }
      throw new EgoError('NavigationError', `page.goto: timeout ${timeout}ms exceeded waiting for networkidle at ${url}`);
    }
    return { url: res.url || url, frameId: res.frameId };
  }

  async waitForLoadState(targetId, state = 'load', { timeout = 30000 } = {}) {
    const st = this.sessionOf(targetId);
    const expr = state === 'load'
      ? 'document.readyState'
      : `({"domcontentloaded": document.readyState !== "loading", "networkidle": document.readyState === "complete"})`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let ready = false;
      if (state === 'load') ready = (await this.evalIn(targetId, 'document.readyState', {})) === 'complete';
      else if (state === 'domcontentloaded') ready = (await this.evalIn(targetId, 'document.readyState !== "loading"')) === true;
      else ready = st.net.size === 0 && st.netQuietAt != null && Date.now() - st.netQuietAt >= 500;
      if (ready) return { state };
      await sleep(120);
    }
    throw new EgoError('TimeoutError', `page.waitForLoadState timed out after ${timeout}ms waiting for ${state}`);
  }

  // ---- selector-driven actions ----
  async resolveInTime(targetId, selector, actionName, timeout = 3000, requireVisible = true) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.call(targetId, 'resolve', JSON.stringify([selector, { requireVisible }]));
      if (last && last.count === 1 && last.hid) return last;
      await sleep(120);
    }
    const count = last ? last.count : 0;
    const extra = last && last.error ? ` (${last.error})` : '';
    throw new EgoError('ElementResolutionError', `page.${actionName} timed out after ${timeout}ms: Locator ${selector} matched ${count} elements${extra}`);
  }

  async mouseInput(targetId, type, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    const st = this.sessionOf(targetId);
    // A synchronous JS dialog opened by this very input can block the
    // renderer's command response forever; the input itself is already
    // dispatched, so never wait longer than 1.5s for the ack.
    const sent = this.cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: BTN[button] || 'left', clickCount, buttons: type === 'mouseReleased' ? 0 : 1, modifiers }, { sessionId: st.sessionId }).catch(() => {});
    await Promise.race([sent, sleep(1500)]);
  }

  async click(targetId, selector, opts = {}) {
    const { button = 'left', clickCount = 1, delay = 0, position, force = false, timeout = 3000, _action = 'click' } = opts;
    const since = Date.now();
    const r = force
      ? await this.call(targetId, 'resolve', JSON.stringify([selector, { requireVisible: false }])).then(async (res) => {
        if (!res || res.count !== 1) throw new EgoError('ElementResolutionError', `page.${_action}: Locator ${selector} matched ${res ? res.count : 0} elements`);
        return res;
      })
      : await this.resolveInTime(targetId, selector, _action, timeout);
    const box = await this.call(targetId, 'ensureVisible', JSON.stringify([r.hid]));
    const x = position ? box.x + position.x : box.cx;
    const y = position ? box.y + position.y : box.cy;
    for (let i = 0; i < clickCount; i++) {
      await this.mouseInput(targetId, 'mouseMoved', x, y);
      await this.mouseInput(targetId, 'mousePressed', x, y, { button, clickCount: 1 });
      if (delay) await sleep(delay);
      await this.mouseInput(targetId, 'mouseReleased', x, y, { button, clickCount: 1 });
      if (i + 1 < clickCount) await sleep(40);
    }
    return this.actionReceipt(targetId, since);
  }

  async actionReceipt(targetId, sinceMs) {
    const st = this.sessions.get(targetId);
    const receipt = {};
    const popups = await this.popupsFor(targetId, sinceMs);
    if (popups.length) receipt.popups = popups.map((p) => ({ label: null, targetId: p.targetId }));
    const dlg = st && st.dialogs.length ? { type: st.dialogs[st.dialogs.length - 1].type, message: st.dialogs[st.dialogs.length - 1].message } : undefined;
    if (dlg) receipt.dialog = dlg;
    return receipt;
  }

  async fill(targetId, selector, value, { timeout = 3000, clearFirst = true } = {}) {
    const r = await this.resolveInTime(targetId, selector, 'fill', timeout);
    await this.call(targetId, 'focusEl', JSON.stringify([r.hid]));
    const prep = await this.call(targetId, 'fillValue', JSON.stringify([r.hid, clearFirst ? '' : undefined]));
    if (prep && prep.editable) {
      await this.insertText(targetId, value);
    } else {
      await this.insertText(targetId, value);
    }
    const ok = await this.call(targetId, 'checkValue', JSON.stringify([r.hid, value]));
    if (!ok) throw new EgoError('ElementResolutionError', `page.fill: editing did not take effect on ${selector}`);
    return this.actionReceipt(targetId, Date.now() - 1500);
  }

  async insertText(targetId, text) {
    const st = this.sessionOf(targetId);
    await this.cdp.send('Input.insertText', { text: String(text) }, { sessionId: st.sessionId });
  }

  async selectOption(targetId, selector, valueOrValues, { timeout = 3000 } = {}) {
    const r = await this.resolveInTime(targetId, selector, 'selectOption', timeout);
    const picks = valueOrValues === null ? [] : Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues];
    const out = await this.call(targetId, 'selectOptions', JSON.stringify([r.hid, picks]));
    if (!out || !out.ok) throw new EgoError('ElementResolutionError', `page.selectOption: ${out && out.error ? out.error : 'failed'} on ${selector}`);
    return { selected: out.selected };
  }

  async focus(targetId, selector, { timeout = 3000 } = {}) {
    const r = await this.resolveInTime(targetId, selector, 'focus', timeout);
    const ok = await this.call(targetId, 'focusEl', JSON.stringify([r.hid]));
    if (!ok || !ok.ok) throw new EgoError('ElementResolutionError', `page.focus: cannot focus ${selector}`);
    return {};
  }

  // ---- keyboard ----
  // "ControlOrMeta" is platform-dependent: Cmd on macOS (where the browser
  // host runs), Ctrl elsewhere. Normalize before parsing the chord.
  normalizeChord(chord) {
    const main = process.platform === 'darwin' ? 'Meta' : 'Control';
    return String(chord).split('+').map((k) => (k.trim() === 'ControlOrMeta' ? main : k.trim())).join('+');
  }

  async keyEvent(targetId, type, desc, modifiers = 0) {
    const st = this.sessionOf(targetId);
    const ev = { type, modifiers, key: desc.key, windowsVirtualKeyCode: desc.vk, nativeVirtualKeyCode: desc.vk };
    if (desc.code) ev.code = desc.code;
    // With modifiers held the keystroke is a shortcut, not text input.
    if (type === 'keyDown' && desc.text && !modifiers) { ev.text = desc.text; ev.unmodifiedText = desc.text; }
    // Shortcut reliability: map the classic edit chords to CDP commands.
    if (type === 'keyDown' && modifiers) {
      const k = (desc.key || '').toLowerCase();
      if (k === 'a') ev.commands = ['SelectAll'];
      else if (k === 'c') ev.commands = ['Copy'];
      else if (k === 'v') ev.commands = ['Paste'];
      else if (k === 'x') ev.commands = ['Cut'];
    }
    await this.cdp.send('Input.dispatchKeyEvent', ev, { sessionId: st.sessionId });
  }

  async press(targetId, chord, { delay = 0 } = {}) {
    const { modifiers, main } = parseChord(this.normalizeChord(chord));
    let bits = 0;
    for (const m of modifiers) {
      const md = keyDescriptor(m);
      bits |= modifierBit(m);
      await this.keyEvent(targetId, 'keyDown', md, bits);
    }
    const mainDesc = keyDescriptor(main);
    await this.keyEvent(targetId, 'keyDown', mainDesc, bits);
    if (delay) await sleep(delay);
    await this.keyEvent(targetId, 'keyUp', mainDesc, bits);
    for (const m of [...modifiers].reverse()) {
      const md = keyDescriptor(m);
      bits &= ~modifierBit(m);
      await this.keyEvent(targetId, 'keyUp', md, bits);
    }
    return {};
  }

  async typeText(targetId, text, { delay = 0 } = {}) {
    for (const ch of String(text)) {
      const d = keyDescriptor(ch);
      if (d && d.text) {
        await this.keyEvent(targetId, 'keyDown', d);
        await this.keyEvent(targetId, 'keyUp', d);
      } else {
        await this.insertText(targetId, ch);
      }
      if (delay) await sleep(delay);
    }
    return {};
  }

  // ---- raw mouse ops ----
  async rawMouse(targetId, op, args, opts = {}) {
    if (op === 'click') return this.click(targetId, null, opts, args);
    const st = this.sessionOf(targetId);
    const [x, y] = args;
    if (op === 'move') {
      const steps = opts.steps ?? 1;
      for (let i = 1; i <= steps; i++) {
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x * i / steps), y: Math.round(y * i / steps) }, { sessionId: st.sessionId });
      }
      this._pos = { x, y };
      return {};
    }
    if (op === 'down' || op === 'up') {
      await this.cdp.send('Input.dispatchMouseEvent', { type: op === 'down' ? 'mousePressed' : 'mouseReleased', x: this._pos?.x ?? 0, y: this._pos?.y ?? 0, button: BTN[opts.button] || 'left', clickCount: opts.clickCount ?? 1, buttons: op === 'down' ? 1 : 0 }, { sessionId: st.sessionId });
      return {};
    }
    if (op === 'wheel') {
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this._pos?.x ?? 0, y: this._pos?.y ?? 0, deltaX: args[0], deltaY: args[1] }, { sessionId: st.sessionId });
      return {};
    }
    throw new EgoError('NotSupportedError', `mouse.${op} is not supported`);
  }

  // ---- observation ----
  async snapshot(targetId, { scope = 'only_within_viewport', root = null } = {}) {
    const rootRef = root ? String(root).replace(/^@/, '') : null;
    const snap = await this.call(targetId, 'snap', JSON.stringify([{ scope, rootRef }]));
    if (!snap) throw new EgoError('PageError', 'snapshot failed');
    return snap;
  }

  async info(targetId) {
    const st = this.sessions.get(targetId);
    if (!st) throw new EgoError('PageClosedError', `target ${targetId} is not attached`);
    // A modal JS dialog blocks the renderer; report cached state instead of
    // evaluating (which would hang until the dialog is handled).
    if (st.dialogs.length) {
      const d = st.dialogs[st.dialogs.length - 1];
      return { url: st.url, title: st.title, w: 0, h: 0, sx: 0, sy: 0, pw: 0, ph: 0, dialog: { type: d.type, message: d.message } };
    }
    const i = await this.evalIn(targetId, '({url: location.href, title: document.title, w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, pw: document.documentElement.scrollWidth, ph: document.documentElement.scrollHeight})');
    return i;
  }

  async screenshot(targetId, { fullPage = false, clip = null } = {}) {
    const st = this.sessionOf(targetId);
    const params = { format: 'png' };
    if (fullPage) params.captureBeyondViewport = true;
    if (clip && typeof clip === 'object') params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
    const res = await this.cdp.send('Page.captureScreenshot', params, { sessionId: st.sessionId, timeout: 60000 });
    return res.data; // base64
  }

  async evaluate(targetId, fnSource, arg, { timeout = 30000 } = {}) {
    const argJson = JSON.stringify(arg === undefined ? null : arg);
    const expression = `(async()=>{try{const __f=(${fnSource});const v=typeof __f==='function'?await __f(${argJson}):await __f;return {__ok:true,v:v===undefined?null:v}}catch(e){return {__ok:false,e:String(e&&e.message||e)}}})()`;
    const st = this.sessionOf(targetId);
    let res;
    try {
      res = await Promise.race([
        this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId: st.sessionId, timeout: timeout + 5000 }),
        sleep(timeout, true).then(() => { throw Object.assign(new Error('timeout'), { code: 'evalTimeout' }); }),
      ]);
    } catch (e) {
      if (e.code === 'evalTimeout' || /timed out/.test(e.message)) {
        this.cdp.send('Runtime.terminateExecution', {}, { sessionId: st.sessionId }).catch(() => {});
        throw new EgoError('TimeoutError', `page.evaluate safety timeout after ${timeout}ms (executionStopped)`);
      }
      throw e;
    }
    if (res.exceptionDetails) throw new EgoError('PageError', String(res.exceptionDetails.exception?.description || res.exceptionDetails.text).split('\n')[0]);
    const v = res.result?.value;
    if (v && v.__ok === false) throw new EgoError('PageError', v.e);
    return v ? v.v : null;
  }

  async fetchIn(targetId, url, options = {}) {
    const { saveAs, ...fetchOpts } = options;
    const src = `async (url, opts) => {
      const r = await window.fetch(url, opts);
      const headers = {}; r.headers.forEach((v,k)=>headers[k]=v);
      let body = null; let b64 = null;
      if (opts.__saveAs) {
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf); let s=''; const CH=0x8000;
        for (let i=0;i<bytes.length;i+=CH) s+=String.fromCharCode.apply(null, bytes.subarray(i,i+CH));
        b64 = btoa(s);
      } else { body = await r.text(); }
      return { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers, body, b64 };
    }`;
    const opts = { ...fetchOpts, __saveAs: !!saveAs };
    const v = await this.evaluate(targetId, src, [url, opts], { timeout: 60000 });
    if (saveAs && v && v.b64 !== null && v.b64 !== undefined) v.__b64 = v.b64;
    return v;
  }

  // ---- dialogs ----
  async acceptDialog(targetId, promptText) {
    const st = this.sessionOf(targetId);
    if (!st.dialogs.length) return false;
    await this.cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: promptText ?? st.dialogs[0].defaultPrompt ?? '' }, { sessionId: st.sessionId });
    st.dialogs.shift();
    return true;
  }
  async dismissDialog(targetId) {
    const st = this.sessionOf(targetId);
    if (!st.dialogs.length) return false;
    await this.cdp.send('Page.handleJavaScriptDialog', { accept: false }, { sessionId: st.sessionId });
    st.dialogs.shift();
    return true;
  }

  // ---- files ----
  async setInputFiles(targetId, selector, paths) {
    const files = (Array.isArray(paths) ? paths : [paths]).map(String);
    const r = await this.resolveInTime(targetId, selector, 'setInputFiles', 3000, false);
    const info = await this.call(targetId, 'fileInfo', JSON.stringify([r.hid]));
    if (!info) throw new EgoError('ElementResolutionError', `page.setInputFiles: no file input resolves from ${selector}`);
    if (files.length > 1 && !info.multiple) throw new EgoError('NotSupportedError', 'input does not accept multiple files');
    const mark = await this.call(targetId, 'markForDom', JSON.stringify([r.hid]));
    if (typeof mark !== 'string' || !/^ego-\d+$/.test(mark)) throw new EgoError('PageError', 'invalid DOM mark');
    const st = this.sessionOf(targetId);
    const doc = await this.cdp.send('DOM.getDocument', { depth: 0 }, { sessionId: st.sessionId });
    const node = await this.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `[data-ego-dom="${mark}"]` }, { sessionId: st.sessionId });
    if (!node.nodeId) throw new EgoError('ElementResolutionError', `page.setInputFiles: DOM lookup failed for ${selector}`);
    const resolved = await this.cdp.send('DOM.resolveNode', { nodeId: node.nodeId }, { sessionId: st.sessionId });
    await this.cdp.send('DOM.setFileInputFiles', { files, backendNodeId: resolved.backendNodeId ?? undefined, nodeId: node.nodeId }, { sessionId: st.sessionId });
    await this.evalIn(targetId, `(document.querySelector('[data-ego-dom="${mark}"]')||{}).removeAttribute?.('data-ego-dom')`);
    const receipt = await this.actionReceipt(targetId, Date.now() - 1000);
    return receipt;
  }

  async enableChooserIntercept(targetId, on) {
    const st = this.sessionOf(targetId);
    await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: !!on, intercept: !!on }, { sessionId: st.sessionId });
    st.interceptingChooser = !!on;
  }

  async chooserSetFiles(targetId, backendNodeId, files) {
    const st = this.sessionOf(targetId);
    await this.cdp.send('DOM.setFileInputFiles', { files: files.map(String), backendNodeId }, { sessionId: st.sessionId });
    return this.actionReceipt(targetId, Date.now() - 1000);
  }

  takeChooser(targetId) {
    const st = this.sessions.get(targetId);
    if (!st || !st.choosers.length) return null;
    return st.choosers.shift();
  }

  events(targetId) {
    const st = this.sessions.get(targetId);
    if (!st) return [];
    const out = st.events;
    st.events = [];
    return out;
  }

  // ---- downloads ----
  downloadInfo(guid) { return this.downloads.get(guid) ?? null; }
}
