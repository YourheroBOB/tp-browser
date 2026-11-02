// Client-side SDK injected as globals into `ego-browser nodejs` scripts.
// Mirrors the ego-browser v2 API surface (taskSpace / Page / Download /
// FileChooser / mouse / keyboard). Talks to ego-browserd over HTTP+SSE.
export class EgoError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// waitForSelector 只認這四種 state（Playwright 語意）。拼錯的值（例如把 visible
// 寫成 'visble'）若被當成「未知」而落到判斷式的 `false` 分支，會一路輪詢到 timeout
// 才丟 TimeoutError，真正的原因（拼字錯誤）完全被吃掉，呼叫端得白等 30 秒。
// 因此在第一次 probe 之前就明確拒絕。
const SELECTOR_STATES = new Set(['attached', 'visible', 'hidden', 'detached']);

const DEFAULT_PORT = 9772;
const MAX_PORT = 65535;

// CLI（bin/ego-browser.js）會依 TP_DAEMON_PORT 或 daemon.json 決定 daemon 埠，
// 因此 SDK 必須直接採用呼叫端傳入的埠；只有未提供或明顯不合法時才回落到預設 9772。
// 舊寫法只認 9774、其餘一律 9772，於是自訂埠（例如 9780）時 CLI 的健康檢查打對了
// daemon，SDK 的 /rpc 與 /events 卻連到 9772（或根本沒有任何程序在聽）——兩邊分裂。
function resolveBase(port) {
  let n = NaN;
  if (typeof port === 'number') n = port;
  else if (typeof port === 'string' && /^\d+$/.test(port.trim())) n = Number(port.trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_PORT) n = DEFAULT_PORT;
  return `http://127.0.0.1:${n}`;
}

export function createClient({ port, token, fetchImpl = fetch }) {
  // rpc 與 /events 共用同一個 base（/events 原本就吃 base），所以只要修好 base。
  const base = resolveBase(port);
  let rpcId = 0;
  const pushWaiters = new Set(); // {match(fn), resolve, reject, timer}
  let sseStarted = false;
  let sseGen = 0; // 每次啟動 /events 串流就 +1，用來辨識「目前這一條」串流

  async function rpc(method, params) {
    const res = await fetchImpl(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ego-token': token },
      body: JSON.stringify({ id: ++rpcId, method, params: params || {} }),
    });
    if (res.status === 403) throw new EgoError('AuthError', 'daemon rejected the token');
    // /rpc 回應不是 JSON 時（連線中途被切斷、204、被本機代理攔截、daemon 半途掛掉…），
    // res.json() 會直接把原始 SyntaxError 丟給呼叫端：訊息裡沒有 HTTP 狀態碼，也沒有
    // 「是哪一個 RPC 方法失敗」，呼叫端無法判斷該重試、該重新認證，還是自己的程式有 bug。
    // 這裡改拋帶狀態碼與方法名稱的 EgoError；能正常解析的 {ok:false} 轉換流程完全不變。
    let j;
    try {
      j = await res.json();
    } catch {
      const status = typeof res?.status === 'number' ? res.status : 0;
      throw new EgoError('HttpError', `${method} failed: /rpc returned a non-JSON response (HTTP ${status})`);
    }
    if (!j.ok) throw new EgoError(j.error?.name || 'Error', j.error?.message || 'rpc failed');
    return j.result;
  }

  // 讓目前所有等待中的 waitPush 立刻失敗（用於 /events 直接拒絕，例如 403）。
  function rejectWaiters(err) {
    for (const w of [...pushWaiters]) {
      clearTimeout(w.timer);
      pushWaiters.delete(w);
      try { w.reject(err); } catch { /* 等待者自行處理 */ }
    }
  }

  function startEvents() {
    if (sseStarted) return;
    sseStarted = true;
    const gen = ++sseGen;
    // 只有「目前這條」串流能改 sseStarted，避免舊串流的收尾蓋掉新串流的狀態。
    const resetIfCurrent = () => { if (gen === sseGen) sseStarted = false; };
    (async () => {
      try {
        const res = await fetchImpl(`${base}/events`, { headers: { 'x-ego-token': token } });
        const status = typeof res?.status === 'number' ? res.status : 200;
        if (status < 200 || status >= 300) {
          try { await res?.body?.cancel?.(); } catch { /* 已無法取消，忽略 */ }
          if (status === 403) throw new EgoError('AuthError', 'daemon rejected the token on /events');
          throw new EgoError('EventStreamError', `/events failed with HTTP ${status}`);
        }
        // 2xx 但沒有可讀 body（204、主體已被上游消耗、回的根本不是串流）時，
        // res.body.getReader() 會拋 TypeError；舊版把它跟「連線中斷」一起吞掉，只重設
        // sseStarted，於是所有等待者要一路等到 timeout（預設 30 秒），錯誤訊息還完全
        // 指向錯誤的原因。這裡明確轉成 EventStreamError，讓下方 catch 立刻 reject 等待者。
        if (!res?.body || typeof res.body.getReader !== 'function') {
          throw new EgoError('EventStreamError', '/events returned a response without a readable body');
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            let msg; try { msg = JSON.parse(dataLine.slice(6)); } catch { continue; }
            for (const w of [...pushWaiters]) {
              try { if (w.match(msg)) { clearTimeout(w.timer); pushWaiters.delete(w); w.resolve(msg); } } catch {}
            }
          }
        }
      } catch (e) {
        // /events 被直接拒絕（403 或其他非 2xx）：立刻讓等待者失敗，不要等到逾時。
        if (e instanceof EgoError && (e.name === 'AuthError' || e.name === 'EventStreamError')) {
          resetIfCurrent();
          rejectWaiters(e);
        }
        // 其他錯誤（連線中斷、reader 拋錯）只重設狀態；等待者可被重連後的串流滿足或自行逾時。
      } finally {
        // 串流結束／出錯後一定要放掉 sseStarted，下一次 waitPush 才會重新訂閱。
        resetIfCurrent();
      }
    })();
  }

  function waitPush(match, timeout = 30000, message = 'event timeout') {
    startEvents();
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          pushWaiters.delete(w);
          reject(new EgoError('TimeoutError', `${message} timed out after ${timeout}ms`));
        }, timeout),
      };
      pushWaiters.add(w);
    });
  }

  return { rpc, waitPush };
}

function fnSource(fnOrString) {
  return typeof fnOrString === 'function' ? fnOrString.toString() : String(fnOrString);
}

// 把 finish / completeTaskSpace 的 keep 參數正規化成 daemon 認得的形狀：
// 要保留的分頁 label 陣列，或字串 'all'（true 是 SDK 的糖）。
// 轉換集中在這裡，避免同一個輸入在兩條路徑上得到不同結果——例如 'all'
// 若被當成「不是陣列」而轉成 []，就等於叫 daemon 關掉整個 space 的所有分頁，
// 與呼叫端的意圖完全相反。
function normalizeKeep(keep) {
  if (keep === true || keep === 'all') return 'all';
  if (Array.isArray(keep)) return keep;
  if (typeof keep === 'string' && keep.length > 0) return keep; // 單一 label 照原樣傳，語意交給 daemon
  return [];
}

export function buildSdk({ rpc, waitPush }) {
  class Download {
    constructor(guid) { this.guid = guid; }
    async url() { return rpc('download.call', { guid: this.guid, method: 'url' }); }
    async suggestedFilename() { return rpc('download.call', { guid: this.guid, method: 'suggestedFilename' }); }
    async failure() { return rpc('download.call', { guid: this.guid, method: 'failure' }); }
    async path() { return rpc('download.call', { guid: this.guid, method: 'path' }); }
    async saveAs(p) { return rpc('download.call', { guid: this.guid, method: 'saveAs', args: [p] }); }
    async cancel() { return rpc('download.call', { guid: this.guid, method: 'cancel' }); }
    async delete() { return rpc('download.call', { guid: this.guid, method: 'delete' }); }
    page() { return null; }
  }

  class FileChooser {
    constructor(task, label, backendNodeId, mode) { this._task = task; this._label = label; this._backendNodeId = backendNodeId; this._mode = mode; }
    isMultiple() { return this._mode === 'selectMultiple'; }
    async setFiles(pathOrPaths) {
      const files = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
      // setFiles 失敗（路徑不存在、權限、CDP 逾時…）時若不關閉攔截器，該分頁之後真正的
      // file chooser 會被靜默吞掉：推播送給早就消失的等待者，使用者只看到「點檔案輸入框
      // 沒反應」，而且沒有任何錯誤訊息。關閉動作放 finally，且關閉失敗不覆蓋原始錯誤。
      try {
        return await this._task._pageCall(this._label, 'chooserSetFiles', [this._backendNodeId, files]);
      } finally {
        await this._task._pageCall(this._label, 'enableChooserIntercept', [false]).catch(() => {});
      }
    }
  }

  class Mouse {
    constructor(task, label) { this._task = task; this._label = label; }
    async click(x, y, opts = {}) { return this._task._pageCall(this._label, 'mouse.click', [x, y, opts]); }
    async move(x, y, opts = {}) { return this._task._pageCall(this._label, 'mouse.move', [x, y, opts]); }
    async down(opts = {}) { return this._task._pageCall(this._label, 'mouse.down', [opts]); }
    async up(opts = {}) { return this._task._pageCall(this._label, 'mouse.up', [opts]); }
    async wheel(dx, dy, opts = {}) { return this._task._pageCall(this._label, 'mouse.wheel', [dx, dy, opts]); }
  }

  class Keyboard {
    constructor(task, label) { this._task = task; this._label = label; }
    async down(key) { return this._task._pageCall(this._label, 'keyboard.down', [key]); }
    async up(key) { return this._task._pageCall(this._label, 'keyboard.up', [key]); }
    async press(chord, opts = {}) { return this._task._pageCall(this._label, 'keyboard.press', [chord, opts]); }
    async type(text, opts = {}) { return this._task._pageCall(this._label, 'keyboard.type', [text, opts]); }
    async insertText(text) { return this._task._pageCall(this._label, 'keyboard.insertText', [text]); }
    async paste(content) {
      // no native clipboard on headless Linux; insert text (and HTML as plain text)
      const text = typeof content === 'string' ? content : (content?.text ?? '');
      return this.insertText(text);
    }
  }

  class Page {
    constructor(task, label, targetId = null) {
      this._task = task;
      this.label = label;
      this._targetId = targetId;
      this.mouse = new Mouse(task, label);
      this.keyboard = new Keyboard(task, label);
    }
    get spaceId() { return this._task.spaceId; }
    get openedBy() { return 'agent'; }
    get targetId() { return this._targetId; }

    async _refresh() {
      const view = await rpc('space.use', { idOrName: this._task.spaceId });
      // ledger 形狀不完整（缺 pages）時，`view.pages.find` 會丟
      // TypeError: Cannot read properties of undefined (reading 'find')，把真正的情況
      // （頁面資訊拿不到）蓋成一個看起來像 SDK 內部 bug 的例外；waitForEvent /
      // waitForFileChooser 的呼叫端因此完全查不到原因。同一個檔案的其他地方
      // （TaskSpace 建構子、userPage()）都已經用 `view.pages || []` 防守，這裡比照辦理：
      // 查不到就維持原 _targetId，讓後續流程照自己的逾時語意收斂。
      const me = (view?.pages || []).find((p) => p.label === this.label);
      if (me) this._targetId = me.targetId;
      return view;
    }

    goto(url, opts = {}) { return this._task._pageCall(this.label, 'goto', [url, opts]); }
    reload(opts = {}) { return this._task._pageCall(this.label, 'reload', [opts]); }
    async url() { return this._task._pageCall(this.label, 'url', []); }
    async title() { return this._task._pageCall(this.label, 'title', []); }
    info() { return this._task._pageCall(this.label, 'info', []); }
    snapshot(opts = {}) { return this._task._pageCall(this.label, 'snapshot', [opts]); }
    async screenshot(opts = {}) {
      const r = await this._task._pageCall(this.label, 'screenshot', [opts]);
      return opts.path ? r.path : r;
    }
    click(sel, opts = {}) { return this._task._pageCall(this.label, 'click', [sel, opts]); }
    dblclick(sel, opts = {}) { return this._task._pageCall(this.label, 'dblclick', [sel, opts]); }
    hover(sel, opts = {}) { return this._task._pageCall(this.label, 'hover', [sel, opts]); }
    dragAndDrop(source, target, opts = {}) { return this._task._pageCall(this.label, 'dragAndDrop', [source, target, opts]); }
    fill(sel, value, opts = {}) { return this._task._pageCall(this.label, 'fill', [sel, value, opts]); }
    selectOption(sel, valueOrValues, opts = {}) { return this._task._pageCall(this.label, 'selectOption', [sel, valueOrValues, opts]); }
    focus(sel, opts = {}) { return this._task._pageCall(this.label, 'focus', [sel, opts]); }
    press(sel, chord, opts = {}) { return this._task._pageCall(this.label, 'press', [sel, chord, opts]); }
    setInputFiles(sel, pathOrPaths) { return this._task._pageCall(this.label, 'setInputFiles', [sel, pathOrPaths]); }
    acceptDialog(promptText) { return this._task._pageCall(this.label, 'acceptDialog', [promptText]); }
    dismissDialog() { return this._task._pageCall(this.label, 'dismissDialog', []); }
    evaluate(fnOrString, arg) { return this._task._pageCall(this.label, 'evaluate', [fnSource(fnOrString), arg === undefined ? null : arg]); }
    eval(fnOrString, arg) { return this.evaluate(fnOrString, arg); }
    async text({ maxChars = 100000 } = {}) {
      const t = await this.evaluate(() => (document.body ? document.body.innerText : ''));
      return String(t || '').slice(0, maxChars);
    }
    fetch(url, opts = {}) { return this._task._pageCall(this.label, 'fetch', [url, opts]); }
    waitForLoadState(state, opts = {}) { return this._task._pageCall(this.label, 'waitForLoadState', [state, opts]); }
    waitForTimeout(ms) { return sleep(ms); }
    wait(ms) { return sleep(ms <= 60 ? ms * 1000 : ms); }
    events() { return this._task._pageCall(this.label, 'events', []); }
    resetSiteAuth() { return this._task._pageCall(this.label, 'resetSiteAuth', []); }
    cdp(method, params, opts = {}) { return this._task._pageCall(this.label, 'pageCdp', [method, params, opts]); }
    close() { return this._task._pageCall(this.label, 'close', []); }

    async waitForURL(matcher, { timeout = 30000 } = {}) {
      const deadline = Date.now() + timeout;
      const test = (urlStr) => {
        if (typeof matcher === 'string') return urlStr === matcher;
        if (matcher instanceof RegExp) return matcher.test(urlStr);
        if (typeof matcher === 'function') { try { return !!matcher(new URL(urlStr)); } catch { return false; } }
        return false;
      };
      for (;;) {
        const u = await this.url();
        if (test(u)) return u;
        if (Date.now() > deadline) throw new EgoError('TimeoutError', `page.waitForURL timed out after ${timeout}ms (last: ${u})`);
        await sleep(150);
      }
    }

    async waitForSelector(sel, { state = 'visible', timeout = 30000 } = {}) {
      if (!SELECTOR_STATES.has(state)) {
        throw new EgoError(
          'InvalidArgumentError',
          `page.waitForSelector: unknown state ${JSON.stringify(String(state))} (expected one of ${[...SELECTOR_STATES].join(', ')})`,
        );
      }
      const deadline = Date.now() + timeout;
      for (;;) {
        const probe = await this._task._pageCall(this.label, 'waitForSelectorProbe', [sel, { state }]);
        const gone = probe.count === 0;
        // Playwright 語意：hidden = 不存在「或」不可見；detached 則只認 count === 0。
        const ok = state === 'attached' ? !gone
          : state === 'visible' ? (!gone && probe.visible)
          : state === 'hidden' ? (gone || !probe.visible)
          : state === 'detached' ? gone
          : false;
        if (ok) return probe;
        if (Date.now() > deadline) throw new EgoError('TimeoutError', `page.waitForSelector timed out after ${timeout}ms waiting for ${sel} to be ${state}`);
        await sleep(150);
      }
    }

    async waitForFunction(fnOrString, arg, { timeout = 30000, polling = 100 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const v = await this._task._pageCall(this.label, 'waitForFunctionProbe', [fnSource(fnOrString), arg === undefined ? null : arg]);
        if (v) return v;
        if (Date.now() > deadline) throw new EgoError('TimeoutError', `page.waitForFunction timed out after ${timeout}ms`);
        await sleep(Math.max(50, polling));
      }
    }

    async waitForEvent(event, { timeout = 30000 } = {}) {
      // 先驗證事件名稱，再做 I/O。舊版把檢查放在 _refresh() 之後：space 已被回收
      // （NoSuchSpace）或 daemon 暫時連不上時，space.use 的錯誤會蓋掉「這個事件不支援」，
      // 呼叫端最需要知道的資訊反而消失。與 waitForSelector 的 state 驗證同一原則。
      if (event !== 'popup' && event !== 'download') {
        throw new EgoError('NotSupportedError', `waitForEvent('${event}') is not supported (use 'popup' or 'download')`);
      }
      await this._refresh();
      const tid = this._targetId;
      if (event === 'popup') {
        const msg = await waitPush((m) => m.type === 'push' && m.kind === 'popup' && m.payload.openerId === tid, timeout, `page.waitForEvent('popup')`);
        const adopted = await rpc('page.adopt', { spaceId: this._task.spaceId, targetId: msg.payload.targetId });
        return this._task.page(adopted.label);
      }
      const msg = await waitPush((m) => m.type === 'push' && m.kind === 'download' && m.targetId === tid && m.payload.kind === 'begin', timeout, `page.waitForEvent('download')`);
      return new Download(msg.payload.guid);
    }

    async waitForFileChooser({ timeout = 30000 } = {}) {
      // 先刷新頁面資訊取得 targetId：以 ts.page('p1') 建立的 Page 初始 _targetId 是 null，
      // 不刷新就會拿 null 去比對，真正的 fileChooser 推播永遠命中不了。
      await this._refresh();
      const tid = this._targetId;
      await this._task._pageCall(this.label, 'enableChooserIntercept', [true]);
      try {
        const msg = await waitPush((m) => m.type === 'push' && m.kind === 'fileChooser' && m.targetId === tid, timeout, 'page.waitForFileChooser');
        return new FileChooser(this._task, this.label, msg.payload.backendNodeId, msg.payload.mode);
      } catch (e) {
        await this._task._pageCall(this.label, 'enableChooserIntercept', [false]).catch(() => {});
        throw e;
      }
    }
  }

  class TaskSpace {
    constructor(view) {
      this.spaceId = view.id;
      this.id = view.id;
      this.name = view.name;
      this.ownership = view.ownership;
      this._state = view.state;
      for (const p of view.pages || []) if (p.label) void p;
    }
    page(label) { return new Page(this, label); }
    async userPage() {
      const view = await rpc('space.use', { idOrName: this.spaceId });
      const first = (view.pages || [])[0];
      return first ? new Page(this, first.label, first.targetId) : null;
    }
    async pages() { return (await this.tabs()).filter((t) => t.label).map((t) => new Page(this, t.label, t.targetId)); }
    async tabs() { return rpc('space.tabs', { idOrName: this.spaceId }); }
    async newPage() {
      const r = await rpc('page.new', { spaceId: this.spaceId });
      return new Page(this, r.label, r.targetId);
    }
    async adopt(tabOrTarget, { as } = {}) {
      const targetId = typeof tabOrTarget === 'string' ? tabOrTarget : tabOrTarget?.targetId;
      const r = await rpc('page.adopt', { spaceId: this.spaceId, targetId, as });
      return new Page(this, r.label, r.targetId);
    }
    async release(label) { return rpc('page.release', { spaceId: this.spaceId, label }); }
    async closePage(label) { return this.release(label); }
    async waitForControl(opts = {}) { return rpc('space.waitForControl', { id: this.spaceId, ...opts }); }
    async handOff() { return rpc('space.handOff', { id: this.spaceId }); }
    async finish({ keep = [] } = {}) {
      // daemon 只認得 keep 陣列與 'all'；true 若原封不動送出會被當成 []，
      // 反而關掉整個 space 的所有分頁。轉換集中在 normalizeKeep，與 completeTaskSpace 一致。
      return rpc('space.finish', { id: this.spaceId, keep: normalizeKeep(keep) });
    }
    async cdp(method, params, opts = {}) { return rpc('task.cdp', { method, params, timeout: opts.timeout }); }

    async _pageCall(label, method, args) {
      return rpc('page.call', { spaceId: this.spaceId, label, method, args });
    }
  }

  let _activeTask = null;
  let _activePage = null;
  async function _ensurePage() {
    if (!_activeTask) _activeTask = await taskSpace('default');
    if (!_activePage) _activePage = _activeTask.page('p1');
    return _activePage;
  }

  async function taskSpace(nameOrId, _opts = {}) {
    let view;
    if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))) view = await rpc('space.use', { idOrName: Number(nameOrId) });
    else {
      const spaces = await rpc('space.list');
      const hit = spaces.find((s) => s.name === nameOrId);
      view = hit ? await rpc('space.use', { idOrName: hit.id }) : await rpc('space.create', { name: nameOrId });
    }
    const ts = new TaskSpace(view);
    _activeTask = ts;
    _activePage = ts.page('p1');
    return ts;
  }
  async function useOrCreateTaskSpace(nameOrId, opts = {}) { return taskSpace(nameOrId, opts); }
  async function completeTaskSpace(idOrTask, opts = {}) {
    const id = typeof idOrTask === 'object' && idOrTask ? (idOrTask.spaceId ?? idOrTask.id) : idOrTask;
    // 舊寫法只認 true 與陣列：呼叫端若直接傳 daemon 原生的 'all'（或單一 label），
    // 會被靜默轉成 []，等於「要求保留所有分頁」卻反而全部關掉。改走與 TaskSpace.finish
    // 相同的正規化，兩條路徑對同一個輸入必然給出一致的 keep。
    return rpc('space.finish', { id, keep: normalizeKeep(opts.keep) });
  }
  async function pageInfo() { return (await _ensurePage()).info(); }
  async function gotoAndWait(url, opts = {}) {
    const rawT = opts.timeout ?? 30000;
    const timeout = rawT <= 300 ? rawT * 1000 : rawT;
    return (await _ensurePage()).goto(url, { waitUntil: opts.waitUntil || 'load', timeout });
  }
  async function wait(seconds) { return sleep((Number(seconds) || 0) * 1000); }
  async function js(expr, arg) { return (await _ensurePage()).evaluate(expr, arg); }
  async function click(target, opts = {}) {
    const p = await _ensurePage();
    if (Array.isArray(target)) return p.mouse.click(target[0], target[1], opts);
    return p.click(target, opts);
  }
  async function typeText(text, opts = {}) { return (await _ensurePage()).keyboard.type(text, opts); }
  async function pressKey(chord, opts = {}) { return (await _ensurePage()).keyboard.press(chord, opts); }
  async function fillInput(sel, value, opts = {}) { return (await _ensurePage()).fill(String(sel).replace(/^css:/, ''), value, opts); }
  async function uploadFile(sel, filePath) { return (await _ensurePage()).setInputFiles(String(sel).replace(/^css:/, ''), filePath); }
  async function cdp(method, params, opts = {}) { return (await _ensurePage()).cdp(method, params, opts); }

  async function listTaskSpaces() { return rpc('space.list'); }
  async function claimTaskSpace(id) { return new TaskSpace(await rpc('space.claim', { id })); }
  async function takeOverTaskSpace(id) { return new TaskSpace(await rpc('space.takeOver', { id })); }
  async function profiles() { return rpc('profiles'); }

  function help(topic) {
    const text = {
      default: `ego-linux SDK (ego-browser compatible subset)
Entry: await taskSpace(nameOrId) / listTaskSpaces() / claimTaskSpace(id) / takeOverTaskSpace(id) / profiles()
TaskSpace: page(label) userPage() pages() tabs() newPage() adopt(tab,{as}) release(label) closePage(label) waitForControl() handOff() finish({keep}) cdp(method,params)
Page: goto reload url title info snapshot screenshot click dblclick hover dragAndDrop fill selectOption focus press
      setInputFiles waitForFileChooser acceptDialog dismissDialog evaluate eval text wait fetch waitForURL waitForEvent waitForSelector
      waitForFunction waitForLoadState waitForTimeout events close cdp mouse.* keyboard.*
Selectors: @N | ref=N | text=... (quoted = exact) | loc=css: | loc=role:button[name="..."] | loc=href: | xpath= | raw CSS
Not implemented: keyboard.paste rich clipboard, profileId per-space on one daemon (single attached browser).`,
      profiles: `profiles() lists persistent profile directories under the data root.
The daemon attaches to ONE Chromium (start it with --remote-debugging-port).
Profiles = separate user-data-dir Chrome instances; run one daemon per profile with EGO_BROWSERD_PORT/EGO_BROWSER_PORT.`,
    };
    console.log(text[topic] || text.default);
    return undefined;
  }
  function cliLog(...a) { console.log(...a); }

  return {
    taskSpace, listTaskSpaces, claimTaskSpace, takeOverTaskSpace, profiles, help, cliLog, Page, TaskSpace, Download, FileChooser,
    useOrCreateTaskSpace, completeTaskSpace, pageInfo, gotoAndWait, wait, sleep, js, click, typeText, pressKey, fillInput, uploadFile, cdp,
  };
}
