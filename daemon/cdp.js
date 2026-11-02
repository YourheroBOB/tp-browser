// CDP client over Node built-in WebSocket (>=22). Flat session protocol.
export class CdpError extends Error {
  constructor(method, data) {
    super(`${method}: ${data?.message ?? JSON.stringify(data)}`);
    this.name = 'CdpError';
    this.cdpError = data;
  }
}

// Node 的 setTimeout 只接受 0..2^31-1 毫秒；Infinity 與更大值會被夾成 1ms，
// 伴隨 TimeoutOverflowWarning，使「不逾時」的請求幾乎立刻失敗。回傳 null 代表
// 不設定計時器（Infinity＝不逾時）；大於上限的有限值夾到上限，而不是 1ms。
const MAX_TIMEOUT_MS = 2_147_483_647;
const normalizeTimeoutMs = (value, fallbackMs) => {
  const ms = value === undefined || value === null ? fallbackMs : value;
  if (typeof ms !== 'number' || Number.isNaN(ms)) return fallbackMs;
  if (ms === Number.POSITIVE_INFINITY) return null;
  if (ms < 0) return 0;
  if (ms > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return ms;
};

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
    // connect() 握手期間建立的 socket 與其 reject 回呼：close() 可能在 WebSocket
    // onopen 之前抵達（呼叫端不等握手就收手），此時 this.ws 仍是 null，若只設
    // closed=true 會漏掉這條正在建立的連線。close() 據此主動關閉並讓 connect()
    // 以「closed」理由拒絕，而不是留下一條無人持有的 socket。
    this.connectSockets = new Set(); // WebSocket instances still handshaking
    this.connectRejects = new Set(); // fn(error) to reject an in-flight connect()
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
      if (this.closed) {
        // close() 已先發生：不應再開一條新連線。此訊息與逾時／連線失敗可區分。
        reject(new Error(`CDP connect closed: ${this.wsUrl}`));
        return;
      }

      const ws = new WebSocket(this.wsUrl);
      this.connectSockets.add(ws);
      // connect() 必須恰好 settle 一次，而且理由必須是「真正先發生」的那一個。
      // 舊版逾時回呼「先 ws.close() 才 reject」：關閉正在握手的 socket 會先觸發 onerror，
      // 對外訊息因此變成誤導性的 "CDP connect failed"（真正原因是逾時）；更糟的是逾時之後
      // 才完成的握手會把半死的 socket 掛回 this.ws，讓已失敗的 client 看似可用。
      let settled = false;
      let timer = null;
      let rejectConnect = () => {};
      const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs, 15000);
      const settle = (ok, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.connectSockets.delete(ws);
        this.connectRejects.delete(rejectConnect);
        if (ok) resolve(value);
        else reject(value);
        return true;
      };
      rejectConnect = (err) => settle(false, err);
      this.connectRejects.add(rejectConnect);

      if (effectiveTimeoutMs !== null) {
        timer = setTimeout(() => {
          if (!settle(false, new Error(`CDP connect timeout: ${this.wsUrl}`))) return;
          try { ws.close(); } catch {}
        }, effectiveTimeoutMs);
      }

      ws.onopen = () => {
        // 已由逾時（或更早的 error／close）定案：晚到的 open 直接關掉，不讓 client 變成半死可用。
        if (settled) { try { ws.close(); } catch {} return; }
        // close() 在握手期間抵達：這條晚到的 socket 不屬於任何人，關掉並以 closed 拒絕。
        if (this.closed) {
          try { ws.close(); } catch {}
          settle(false, new Error(`CDP connect closed: ${this.wsUrl}`));
          return;
        }
        this.ws = ws;
        settle(true, this);
      };
      ws.onerror = () => { settle(false, new Error(`CDP connect failed: ${this.wsUrl}`)); };
      ws.onclose = () => {
        if (!settled) {
          // 握手完成前就斷線：不可讓 connect() 永遠 pending。close() 已發生時理由必須是 closed。
          settle(false, new Error(this.closed ? `CDP connect closed: ${this.wsUrl}` : `CDP connect failed: ${this.wsUrl}`));
          return;
        }
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
    const effectiveTimeoutMs = normalizeTimeoutMs(timeout, 30000);
    const timeoutLabel = effectiveTimeoutMs === null ? 'Infinity' : effectiveTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      const pending = { resolve, reject, timer, method };
      this.pending.set(id, pending);
      const failTimeout = () => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutLabel}ms`));
      };
      if (effectiveTimeoutMs !== null) {
        timer = setTimeout(failTimeout, effectiveTimeoutMs);
        pending.timer = timer;
      }
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        // ws.send 可能同步丟錯（例如 socket 剛好進入 closing 狀態）。此時若不在此
        // 收拾，pending 項目與計時器會殘留到逾時，promise 也不會立刻失敗。
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(`${method} send failed: ${String(err)}`));
      }
    });
  }

  close() {
    this.closed = true;

    // 同步拒絕所有 in-flight 請求，不能只把收拾工作交給 ws.onclose。本地 close() 之後
    // 對端不一定會（立刻）回 close frame：socket 已半死、關閉握手卡住、或實作要等到
    // 內部關閉逾時才 fire onclose。這段空窗期內每個未完成的 send() 都要一路等到自己的
    // timeout（預設 30 秒）才失敗，呼叫端因此卡住、計時器把事件迴圈多撐住、pending
    // 也繼續留在 Map 裡。先清空 Map 再 reject，晚到的 onclose 只會看到空集合，
    // 不會重複拒絕；連 close() 被重複呼叫也是安全 no-op。
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const p of inFlight) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP connection closed'));
    }

    const handshaking = [...this.connectSockets];
    this.connectSockets.clear();
    const rejects = [...this.connectRejects];
    this.connectRejects.clear();
    const closedError = new Error(`CDP connect closed: ${this.wsUrl}`);

    // 先讓 in-flight connect() 以「closed」定案，再關 socket。否則真實 WebSocket
    // 在握手期間被 close() 可能先觸發 onerror，把對外理由變成連線失敗。
    for (const rejectConnect of rejects) {
      try { rejectConnect(closedError); } catch {}
    }
    for (const ws of handshaking) {
      try { ws.close(); } catch {}
    }

    try { this.ws?.close(); } catch {}
  }
}

export const once = (cdp, method, { sessionId, timeout = 30000 } = {}) =>
  new Promise((resolve, reject) => {
    let offEvent = () => {};
    let offClose = () => {};
    let timer = null;
    let settled = false;
    const effectiveTimeoutMs = normalizeTimeoutMs(timeout, 30000);
    const timeoutLabel = effectiveTimeoutMs === null ? 'Infinity' : effectiveTimeoutMs;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      offEvent();
      offClose();
    };
    const fail = (err) => { if (settled) return; cleanup(); reject(err); };
    if (effectiveTimeoutMs !== null) {
      timer = setTimeout(() => fail(new Error(`${method} event timed out after ${timeoutLabel}ms`)), effectiveTimeoutMs);
    }
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
