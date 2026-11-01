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
  // 連線關閉後才註冊的 handler 永遠等不到 onclose（close 只會發生一次），呼叫端因此
  // 無從得知連線已死。這裡在下一個 microtask 補呼叫一次，並維持「回傳可取消的 off
  // 函式」契約：補呼叫發生前呼叫 off() 可取消，回傳 true；已觸發或已取消則回傳 false。
  onClose(fn) {
    if (this.closed) {
      let cancelled = false;
      let fired = false;
      queueMicrotask(() => {
        if (cancelled) return;
        fired = true;
        try { fn(); } catch (e) { console.error('[ego-browserd] close handler error:', e); }
      });
      return () => {
        if (fired || cancelled) return false;
        cancelled = true;
        return true;
      };
    }
    this.closeHandlers ??= new Set();
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      // connect() 必須恰好 settle 一次，而且理由必須是「真正先發生」的那一個。
      // 舊版逾時回呼「先 ws.close() 才 reject」：關閉正在握手的 socket 會先觸發 onerror，
      // 對外訊息因此變成誤導性的 "CDP connect failed"（真正原因是逾時）；更糟的是逾時之後
      // 才完成的握手會把半死的 socket 掛回 this.ws，讓已失敗的 client 看似可用。
      let settled = false;
      let timer = null;
      const settle = (ok, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        if (ok) resolve(value);
        else reject(value);
        return true;
      };
      timer = setTimeout(() => {
        if (!settle(false, new Error(`CDP connect timeout: ${this.wsUrl}`))) return;
        try { ws.close(); } catch {}
      }, timeoutMs);
      ws.onopen = () => {
        // 已由逾時（或更早的 error）定案：晚到的 open 直接關掉，不讓 client 變成半死可用。
        if (settled) { try { ws.close(); } catch {} return; }
        this.ws = ws;
        // 同一個實例重新 connect() 後必須恢復可用：上一次連線（失敗或已關閉）留下的
        // this.closed 要在這裡重設，否則 send() 的 this.closed 閘門會永遠拒絕這條新連線。
        this.closed = false;
        settle(true, this);
      };
      ws.onerror = () => { settle(false, new Error(`CDP connect failed: ${this.wsUrl}`)); };
      ws.onclose = () => {
        // 只有這個 socket 仍是目前的 this.ws 時，關閉才算數。重新 connect() 之後舊 socket
        // 才慢悠悠送達 onclose 是常見競態：不理會它會把新連線的 closed 設回 true、拒絕
        // 新連線所有 pending 的 send，並誤觸 close handlers。
        if (ws !== this.ws) return;
        this.closed = true;
        for (const [, p] of this.pending) {
          // 連線已死，回應永遠不會到；不清計時器的話每個未完成的 send 都會把
          // 事件迴圈多撐住最多 timeout 毫秒（CLI 與測試因此卡住）。
          clearTimeout(p.timer);
          p.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
        // 與 _recv 相同：先快照再迭代。close handler 在分派中途 off() 其他 close
        // handler 時，直接迭代 Set 會把後者跳過（漏呼叫）；快照則保證本輪已註冊的
        // handler 都恰好被呼叫一次，且中途註冊的不會被同一輪走訪到。
        for (const fn of [...(this.closeHandlers ?? [])]) {
          // 單一 close handler 丟錯不可中斷後續 handler（例如 daemon 的重新附掛邏輯），
          // 也不可讓錯誤從事件回呼往外冒；比照 onEvent 逐個隔離並記錄。
          try { fn(); } catch (e) { console.error('[ego-browserd] close handler error:', e); }
        }
      };
      ws.onmessage = (ev) => {
        // 同上：舊 socket 遲到的訊息不得進入 _recv——它的 id 屬於舊連線，會配對到新連線的
        // pending、污染事件派送與 session 記錄。
        if (ws !== this.ws) return;
        this._recv(ev.data);
      };
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
    // 以「分派開始時的快照」迭代，不可直接迭代 this.handlers：Set 迭代器會走訪
    // 迭代期間新增的元素，因此在 handler 內註冊的監聽器（最典型是 once()）會吃到
    // 「觸發它的那一個事件」——once() 立刻以過期事件的 params resolve。
    // 快照同時保證每個本輪已註冊的 handler 恰好被呼叫一次：中途被 off() 的仍會收到
    // 本次事件（避免漏呼叫），但不會收到後續事件；中途新增的要等下一個事件；
    // 「off() 後重新註冊同一函式」也不會在同一輪被呼叫兩次。
    for (const fn of [...this.handlers]) {
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
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        // ws.send 可能同步丟錯（例如 socket 剛好進入 closing 狀態）。此時若不在此
        // 收拾，pending 項目與計時器會殘留到逾時，promise 也不會立刻失敗。
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(`${method} send failed: ${String(err)}`));
      }
    });
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

export const once = (cdp, method, { sessionId, timeout = 30000 } = {}) =>
  new Promise((resolve, reject) => {
    let offEvent = () => {};
    let offClose = () => {};
    let timer = null;
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      offEvent();
      offClose();
    };
    const fail = (err) => { if (settled) return; cleanup(); reject(err); };
    timer = setTimeout(() => fail(new Error(`${method} event timed out after ${timeout}ms`)), timeout);
    offEvent = cdp.onEvent((ev) => {
      if (settled) return;
      if (ev.method !== method) return;
      if (sessionId && ev.sessionId !== sessionId) return;
      cleanup();
      resolve(ev.params);
    });
    // 連線關閉後事件永遠不會再到；不在此一併拒絕的話，呼叫端只能一路等到 timeout
    // （預設 30 秒），期間計時器與事件 handler 全部留著，CLI／daemon 因此卡住。
    // 對只提供 onEvent 的極簡 emitter（測試用）維持舊行為。
    if (typeof cdp.onClose === 'function') {
      offClose = cdp.onClose(() => fail(new Error(`CDP connection closed while waiting for ${method}`)));
    }
  });
