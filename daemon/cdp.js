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

      // 同一 client 上再次 connect()（例如 daemon 重新附掛、暫時性失敗後重試成功再重連）：
      // 舊的「現役」socket 若還在，必須先解除掛載、解除回呼、再關掉。舊版直接覆寫
      // this.ws，留下兩條問題：
      //   1. 舊 socket 永遠沒人關閉（長期執行的 daemon 每重連一次就多洩漏一條連線）；
      //   2. 舊 socket 仍掛著 onmessage，會把「上一條連線」的 CDP 事件繼續派送給
      //      this.handlers，呼叫端看到的是已失效連線的事件混進新連線的資料流；
      //      它稍後派送的 close 也仍會走進 onclose 的一般路徑。
      // 解除回呼後，舊 socket 之後的任何事件都不再屬於這條 client（onclose 的
      // `this.ws !== ws` 防線則保留給「逾時／失敗被中止」的握手 socket）。
      if (this.ws) {
        const previous = this.ws;
        this.ws = null;
        previous.onopen = null;
        previous.onmessage = null;
        previous.onerror = null;
        previous.onclose = null;
        try { previous.close(); } catch {}
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
        // 只有「本 client 現役的 socket（this.ws）」或「呼叫端已自行 close()」這兩種情況，
        // close 事件才代表這條 client 的連線結束。握手逾時／失敗而被中止的 socket，以及被
        // 較新 connect() 取代的舊 socket，真實 WebSocket 仍會派送 close；若照一般路徑處理，
        // 會把從未連上的 client 永久標成 closed（之後重試 connect() 一律以 closed 失敗），
        // 並對從未存在的連線誤發 close handler（daemon 的重新附掛邏輯因此被觸發）。
        if (this.ws !== ws && !this.closed) return;
        this.closed = true;
        this._rejectPending();
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

  // 連線已死後把等待中的請求全部收掉：對端斷線（ws.onclose）與呼叫端主動 close()
  // 共用同一條路徑，理由字串一律是 "CDP connection closed"。
  // 必須清計時器：否則每個未完成的 send 都會把事件迴圈多撐住最多 timeout 毫秒
  // （CLI 與測試因此卡住）。timeout 為 Infinity 的請求根本沒有任何計時器，少了這條
  // 路徑就永遠不會 settle。
  _rejectPending() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;

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

    // 主動 close() 之後這條 client 永久不可用，回應不可能再到；收尾不可寄望在對端
    // 的 close frame 上。真實 WebSocket 對「不回應的對端」要等關閉握手逾時才會派送
    // onclose（TCP 半開、對端程序已死、握手卡住都是常見情境），期間等待中的請求會
    // 一直懸置，計時器也把事件迴圈多撐住最多 timeout 毫秒；timeout 為 Infinity 的
    // 請求更永遠不會 settle。先收掉 pending 再關 socket，讓後續任何 close handler
    // 觀察到的都是已清空的狀態。
    this._rejectPending();

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
