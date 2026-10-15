// CDP client over Node built-in WebSocket (>=22). Flat session protocol.
export class CdpError extends Error {
  constructor(method, data) {
    super(`${method}: ${data?.message ?? JSON.stringify(data)}`);
    this.name = 'CdpError';
    this.cdpError = data;
  }
}

export class Cdp {
  constructor(wsUrl, label = 'cdp') {
    this.wsUrl = wsUrl;
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set(); // fn({sessionId, method, params})
    this.sessions = new Set(); // known sessionIds
    this.ws = null;
    this.closed = false;
  }

  onEvent(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  onClose(fn) { this.closeHandlers ??= new Set(); this.closeHandlers.add(fn); return () => this.closeHandlers.delete(fn); }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`CDP connect timeout: ${this.wsUrl}`)); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; resolve(this); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${this.wsUrl}`)); };
      ws.onclose = () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('CDP connection closed'));
        this.pending.clear();
        for (const fn of this.closeHandlers ?? []) fn();
      };
      ws.onmessage = (ev) => this._recv(ev.data);
    });
  }

  _recv(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.sessionId) this.sessions.add(msg.sessionId);
    for (const fn of this.handlers) {
      try { fn({ sessionId: msg.sessionId ?? null, method: msg.method, params: msg.params ?? {} }); } catch (e) { console.error('[ego-browserd] handler error:', e); }
    }
  }

  send(method, params = {}, { sessionId, timeout = 30000 } = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

export const once = (cdp, method, { sessionId, timeout = 30000 } = {}) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`${method} event timed out after ${timeout}ms`)); }, timeout);
    const off = cdp.onEvent((ev) => {
      if (ev.method !== method) return;
      if (sessionId && ev.sessionId !== sessionId) return;
      clearTimeout(timer); off(); resolve(ev.params);
    });
  });
