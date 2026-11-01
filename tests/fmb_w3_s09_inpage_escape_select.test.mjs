// tests/fmb_w3_s09_inpage_escape_select.test.mjs
//
// 回歸測試：daemon/inpage.agent.js
//  (1) text="..." 精確比對（含一般形式與 >> nth=N 形式）必須把引號內的 \\(.)
//      還原成被跳脫的字元，否則 text="say \"hi\"" 永遠對不到頁面上的 say "hi"。
//  (2) selectOptions() 在單選 <select> 上若沒有任何 pick 對到選項，必須回傳
//      { ok:false, error:'no option matches …' }、不改值、不派發 input/change；
//      不可像舊版一樣把 el.value 清成 '' 還回報 ok:true。
//  (3) 正常 pick 的行為必須完全不變。
//
// 載入方式沿用 fmb_w1_s11：把 inpage.agent.js 當「文字」讀進來，用 vm 加上最小
// 假 DOM 執行（該檔本來就是被 daemon 以 Runtime.evaluate 注入的瀏覽器端腳本）。
// 零網路、零外部服務、不讀寫 repo 以外的路徑、不需要任何憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const AGENT_SRC = readFileSync(fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)), 'utf8');

// 最小假 Event：agent 只用 type/bubbles。
class FakeEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = !!(init && init.bubbles);
  }
}

// 最小假元素：只實作 inpage.agent.js 真的會呼叫到的介面。
class FakeEl {
  constructor(tagName, { text = '', attrs = {}, value = '', options = null } = {}) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.attrs = { ...attrs };
    this.value = value;
    this.options = options;
    this.disabled = false;
    this.dispatched = [];
    this.listeners = new Map();
    this.childNodes = text ? [{ nodeType: 3, textContent: text }] : [];
  }

  get textContent() {
    const own = this.childNodes.filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
    const opts = this.options ? this.options.map((o) => o.textContent).join('') : '';
    return own + opts;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }

  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 120, bottom: 24, width: 120, height: 24 };
  }

  dispatchEvent(ev) {
    this.dispatched.push(ev.type);
    for (const fn of this.listeners.get(ev.type) || []) fn(ev);
    return true;
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  scrollIntoView() {}

  focus() {}

  querySelector() { return null; }
}

// 建一個乾淨的沙箱並回傳 window.__egoAgent。
function loadAgent() {
  const elements = [];
  const mk = (tag, opts) => {
    const el = new FakeEl(tag, opts);
    elements.push(el);
    return el;
  };

  const document = {
    title: 'fmb-w3-s09',
    documentElement: { clientWidth: 1280, clientHeight: 800, scrollWidth: 1280, scrollHeight: 800 },
    querySelectorAll(sel) {
      if (typeof sel !== 'string') return [];
      if (sel.startsWith('#')) return elements.filter((e) => e.getAttribute('id') === sel.slice(1));
      // text= 分支固定使用這條複合選擇器。
      if (sel.startsWith('a, button')) return elements.slice();
      return [];
    },
    querySelector(sel) {
      const list = this.querySelectorAll(sel);
      return list.length ? list[0] : null;
    },
    getElementById(id) {
      const list = elements.filter((e) => e.getAttribute('id') === id);
      return list.length ? list[0] : null;
    },
    evaluate() { throw new Error('xpath is not available in the test DOM'); },
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };

  const sandbox = { window, document, location: { href: 'http://127.0.0.1/' }, Event: FakeEvent, console };
  vm.createContext(sandbox);
  vm.runInContext(AGENT_SRC, sandbox, { filename: 'daemon/inpage.agent.js' });
  return { agent: window.__egoAgent, mk };
}

// 建一個三選項的單選 <select>，目前選中「台中」。
function makeCitySelect(mk) {
  const tpe = new FakeEl('option', { text: '台北', value: 'tpe' });
  const txg = new FakeEl('option', { text: '台中', value: 'txg' });
  const khh = new FakeEl('option', { text: '高雄', value: 'khh' });
  txg.selected = true;
  const select = mk('select', { attrs: { id: 'city' }, value: 'txg', options: [tpe, txg, khh] });
  return { select, tpe, txg, khh };
}

test('text="..." 精確比對會解開引號內的跳脫字元（含 >> nth=N 分支）', () => {
  const { agent, mk } = loadAgent();
  mk('div', { text: 'say "hi"' });
  mk('div', { text: 'say hi' }); // 不得被選到
  mk('div', { text: 'say \\"hi\\"' }); // 頁面上真的有反斜線：也不得被選到

  const plain = agent.resolve('text="say \\"hi\\""');
  assert.equal(plain.error, null);
  assert.equal(plain.count, 1);
  assert.notEqual(plain.hid, null);
  assert.equal(plain.d.text, 'say "hi"');

  const withNth = agent.resolve('text="say \\"hi\\"" >> nth=0');
  assert.equal(withNth.error, null);
  assert.equal(withNth.count, 1);
  assert.notEqual(withNth.hid, null);
  assert.equal(withNth.d.text, 'say "hi"');
});

test('selectOptions：沒有任何 pick 對上選項時回傳 ok:false，不改值也不派發事件', () => {
  const { agent, mk } = loadAgent();
  const { select, txg } = makeCitySelect(mk);
  const { hid } = agent.resolve('#city');
  assert.notEqual(hid, null);

  const res = agent.selectOptions(hid, ['不存在']);
  assert.equal(res.ok, false);
  assert.match(res.error, /no option matches/);
  assert.equal(res.selected, undefined);

  assert.equal(select.value, 'txg');
  assert.equal(txg.selected, true);
  assert.deepEqual(select.dispatched, []); // 連 input 都不該派發

  // 只要有一個 pick 沒對上，整批都不套用（全有或全無）。
  const mixed = agent.selectOptions(hid, ['台中', '不存在']);
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /no option matches/);
  assert.equal(select.value, 'txg');
  assert.deepEqual(select.dispatched, []);
});

test('selectOptions：正常 pick 的行為不變（value 更新、selected 回報、派發 input/change）', () => {
  const { agent, mk } = loadAgent();
  const { select } = makeCitySelect(mk);
  const { hid } = agent.resolve('#city');
  assert.notEqual(hid, null);

  const byValue = agent.selectOptions(hid, ['khh']);
  assert.equal(byValue.ok, true);
  assert.deepEqual([...byValue.selected], ['khh']);
  assert.equal(select.value, 'khh');
  assert.deepEqual(select.dispatched, ['input', 'change']);

  // 依可見文字（label）挑選仍可用。
  const byLabel = agent.selectOptions(hid, ['台北']);
  assert.equal(byLabel.ok, true);
  assert.deepEqual([...byLabel.selected], ['tpe']);
  assert.equal(select.value, 'tpe');
  assert.deepEqual(select.dispatched, ['input', 'change', 'input', 'change']);
});
