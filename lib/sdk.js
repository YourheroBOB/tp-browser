// Client-side SDK injected as globals into `ego-browser nodejs` scripts.
// Mirrors the ego-browser v2 API surface (taskSpace / Page / Download /
// FileChooser / mouse / keyboard). Talks to ego-browserd over HTTP+SSE.
export class EgoError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ port, token, fetchImpl = fetch }) {
  const base = port === 9774 ? 'http://127.0.0.1:9774' : 'http://127.0.0.1:9772';
  let rpcId = 0;
  const pushWaiters = new Set(); // {match(fn), resolve, reject, timer}
  let sseStarted = false;
  let sseGen = 0; // 每次啟動 /events 串流就 +1，用來辨識「目前這一條」串流

  // 讀出 /rpc 回應本文並盡可能解析成 JSON。
  // 回傳 { status, json, text }；json === null 代表本文不是合法 JSON
  // （例如反向代理或 Host/Origin 檢查回的中間層純文字 404/400）。
  async function readRpcBody(res) {
    const status = typeof res?.status === 'number' ? res.status : 200;
    let text = null;
    if (res && typeof res.text === 'function') {
      try { text = await res.text(); } catch { text = null; }
    }
    let json = null;
    if (text !== null) {
      try { json = JSON.parse(text); } catch { json = null; }
    } else if (res && typeof res.json === 'function') {
      // 只有完全取不到本文時才退回 res.json()，避免重複消費同一個 body。
      try { json = await res.json(); } catch { json = null; }
    }
    return { status, json, text: text === null ? '' : String(text) };
  }

  async function rpc(method, params) {
    const res = await fetchImpl(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ego-token': token },
      body: JSON.stringify({ id: ++rpcId, method, params: params || {} }),
    });
    if (res.status === 403) throw new EgoError('AuthError', 'daemon rejected the token');
    const { status, json, text } = await readRpcBody(res);
    const okHttp = status >= 200 && status < 300;
    if (json && typeof json === 'object') {
      if (!json.ok) throw new EgoError(json.error?.name || 'Error', json.error?.message || 'rpc failed');
      return json.result;
    }
    // 非 JSON 本文：不要讓 res.json() 的 SyntaxError 冒出來，改成帶狀態碼與本文片段的
    // HttpError，呼叫端才判斷得出是 HTTP 層還是 daemon 的 RPC 錯誤。
    const snippet = text.slice(0, 200);
    if (!okHttp) throw new EgoError('HttpError', `rpc failed with HTTP ${status}: ${snippet}`);
    throw new EgoError('HttpError', `rpc returned a non-JSON body (HTTP ${status}): ${snippet}`);
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
      const receipt = await this._task._pageCall(this._label, 'chooserSetFiles', [this._backendNodeId, files]);
      await this._task._pageCall(this._label, 'enableChooserIntercept', [false]);
      return receipt;
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
      const me = view.pages.find((p) => p.label === this.label);
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
      const deadline = Date.now() + timeout;
      for (;;) {
        const probe = await this._task._pageCall(this.label, 'waitForSelectorProbe', [sel, { state }]);
        const gone = probe.count === 0;
        const ok = state === 'attached' ? !gone
          : state === 'visible' ? (!gone && probe.visible)
          : state === 'hidden' || state === 'detached' ? gone
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
      await this._refresh();
      const tid = this._targetId;
      if (event === 'popup') {
        const msg = await waitPush((m) => m.type === 'push' && m.kind === 'popup' && m.payload.openerId === tid, timeout, `page.waitForEvent('popup')`);
        const adopted = await rpc('page.adopt', { spaceId: this._task.spaceId, targetId: msg.payload.targetId });
        return this._task.page(adopted.label);
      }
      if (event === 'download') {
        const msg = await waitPush((m) => m.type === 'push' && m.kind === 'download' && m.kind === 'download' && m.targetId === tid && m.payload.kind === 'begin', timeout, `page.waitForEvent('download')`);
        return new Download(msg.payload.guid);
      }
      throw new EgoError('NotSupportedError', `waitForEvent('${event}') is not supported (use 'popup' or 'download')`);
    }

    async waitForFileChooser({ timeout = 30000 } = {}) {
      await this._task._pageCall(this.label, 'enableChooserIntercept', [true]);
      try {
        const msg = await waitPush((m) => m.type === 'push' && m.kind === 'fileChooser' && m.targetId === this._targetId, timeout, 'page.waitForFileChooser');
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
    async finish({ keep = [] } = {}) { return rpc('space.finish', { id: this.spaceId, keep }); }
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

  // daemon 找不到空間時的錯誤；用 id 查詢失敗時要能安全退回「依名稱查找或建立」。
  function isUnknownSpace(err) {
    if (!err) return false;
    if (err.name === 'UnknownSpace') return true;
    return /unknown space|space not found|no such space/i.test(String(err.message || ''));
  }

  // 解析 taskSpace() 的參數：
  //  1. 純數字（含數字字串）先當 id 試 space.use —— 真正的數字 id 走這條。
  //  2. space.use 回 UnknownSpace 時，改用名稱查找；名稱也不存在才 space.create。
  // 這樣 taskSpace('2024') 這種「純數字名稱」才建得出來，而不是卡在 id 查詢直接失敗。
  async function resolveSpaceView(nameOrId) {
    const name = typeof nameOrId === 'string' ? nameOrId : String(nameOrId);
    const asId = typeof nameOrId === 'number'
      ? (Number.isFinite(nameOrId) ? nameOrId : null)
      : (/^\d+$/.test(name.trim()) ? Number(name.trim()) : null);

    if (asId !== null) {
      try {
        return await rpc('space.use', { idOrName: asId });
      } catch (e) {
        // 認證／傳輸等其他錯誤照原樣往上丟，只有「找不到空間」才進 fallback。
        if (!isUnknownSpace(e)) throw e;
      }
    }

    const spaces = (await rpc('space.list')) || [];
    const hit = spaces.find((s) => s && s.name === name);
    if (!hit) return rpc('space.create', { name });
    try {
      return await rpc('space.use', { idOrName: hit.id });
    } catch (e) {
      if (!isUnknownSpace(e)) throw e;
      // 清單與 daemon 實際狀態不同步（空間剛被回收）：退回建立同名空間。
      return rpc('space.create', { name });
    }
  }

  async function taskSpace(nameOrId, _opts = {}) {
    const view = await resolveSpaceView(nameOrId);
    const ts = new TaskSpace(view);
    _activeTask = ts;
    _activePage = ts.page('p1');
    return ts;
  }
  async function useOrCreateTaskSpace(nameOrId, opts = {}) { return taskSpace(nameOrId, opts); }
  async function completeTaskSpace(idOrTask, opts = {}) {
    const id = typeof idOrTask === 'object' && idOrTask ? (idOrTask.spaceId ?? idOrTask.id) : idOrTask;
    const keep = opts.keep === true ? 'all' : Array.isArray(opts.keep) ? opts.keep : [];
    return rpc('space.finish', { id, keep });
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
