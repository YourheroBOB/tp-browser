// tests/fmb_w2_s09_inpage_xpath_label.test.mjs
// inpage agent 回歸測試（w2 / s09）：
//   1. 非法 xpath：document.evaluate 會拋錯，resolve() 必須吞掉並回
//      { count: 0, error: 'invalid selector' }，不可讓例外一路往外丟。
//   2. <label for=x>名字</label><input id=x>：以 resolve('text=名字') 取得 label 的 hid
//      再呼叫 fillValue(hid, '')，焦點必須落在 label 的 control（input），
//      否則後續 insertText 會打到 label 而不是輸入框。
// 零外部依賴、零網路、不讀寫檔案：以 node:vm 在沙箱內執行 daemon/inpage.agent.js 本體，
// DOM 由本檔以最小 mock 自建（沿用 fmb_w1_s11 的「讀原始碼 + 自建 DOM」載入方式）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const AGENT_PATH = fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url));
const AGENT_SRC = readFileSync(AGENT_PATH, 'utf8');

// 最小 DOM：<label for="x">名字</label><input id="x" value="先前的內容">
function createDom() {
  const doc = {
    activeElement: null,
    title: 'fmb_w2_s09 fixture',
    documentElement: { clientWidth: 1280, clientHeight: 800, scrollWidth: 1280, scrollHeight: 800 },
  };

  class TextNode {
    constructor(text) {
      this.nodeType = 3;
      this.parentNode = null;
      this.childNodes = [];
      this.textContent = String(text);
    }
  }

  class Element {
    constructor(tagName, attrs = {}, children = []) {
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this.attributes = { ...attrs };
      this.childNodes = children.map((c) => (typeof c === 'string' ? new TextNode(c) : c));
      for (const child of this.childNodes) child.parentNode = this;
      this.disabled = false;
      this.isContentEditable = false;
      if (this.attributes.value !== undefined) this.value = this.attributes.value;
      else if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') this.value = '';
    }
    get id() { return this.attributes.id ?? ''; }
    get type() { return this.attributes.type ?? 'text'; }
    get control() {
      if (this.tagName !== 'LABEL') return null;
      const forId = this.attributes.for;
      return forId ? doc.getElementById(forId) : null;
    }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    get options() { return []; }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 120, height: 24, right: 130, bottom: 44, x: 10, y: 20 };
    }
    focus() { doc.activeElement = this; }
    select() {}
    scrollIntoView() {}
    querySelector() { return null; }
    dispatchEvent() { return true; }
  }

  const registry = [];
  const make = (tagName, attrs = {}, children = []) => {
    const el = new Element(tagName, attrs, children);
    registry.push(el);
    return el;
  };

  doc.getElementById = (id) => registry.find((el) => el.id === id) ?? null;

  const matchAttribute = (el, part) => {
    const m = /^\[([\w-]+)(?:=["']([^"']*)["'])?\]$/.exec(part);
    if (!m) return false;
    return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
  };

  const matchesSimple = (el, selector) => {
    if (selector === '*') return true;
    if (selector.startsWith('[')) return matchAttribute(el, selector);
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    const withAttr = /^([A-Za-z][\w-]*)(\[[\w-]+(?:=["'][^"']*["'])?\])$/.exec(selector);
    if (withAttr) return el.tagName === withAttr[1].toUpperCase() && matchAttribute(el, withAttr[2]);
    return el.tagName === selector.toUpperCase();
  };

  doc.querySelectorAll = (selector) => {
    const parts = String(selector).split(',').map((p) => p.trim()).filter(Boolean);
    const out = [];
    for (const el of registry) {
      if (out.includes(el)) continue;
      if (parts.some((p) => matchesSimple(el, p))) out.push(el);
    }
    return out;
  };
  doc.querySelector = (selector) => doc.querySelectorAll(selector)[0] ?? null;

  // 只支援 `//tag` 與 `//*`；其餘（含 '//[' 、'//input[]'）比照真實瀏覽器拋 SyntaxError。
  doc.evaluate = (expression) => {
    const m = typeof expression === 'string' ? /^\/\/([A-Za-z][\w-]*|\*)$/.exec(expression) : null;
    if (!m) {
      const err = new Error(
        `Failed to execute 'evaluate' on 'Document': The string '${expression}' is not a valid XPath expression.`,
      );
      err.name = 'SyntaxError';
      throw err;
    }
    const nodes = m[1] === '*' ? registry.slice() : registry.filter((el) => el.tagName === m[1].toUpperCase());
    return {
      snapshotLength: nodes.length,
      snapshotItem: (i) => (i >= 0 && i < nodes.length ? nodes[i] : null),
    };
  };

  const label = make('label', { for: 'x' }, ['名字']);
  const input = make('input', { id: 'x', name: 'x', type: 'text', value: '先前的內容' }, []);

  const window = {
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };

  return { window, document: doc, elements: { label, input } };
}

function loadAgent() {
  const dom = createDom();
  const sandbox = {
    window: dom.window,
    document: dom.document,
    location: { href: 'http://127.0.0.1:8899/' },
    CSS: { escape: (s) => String(s) },
    XPathResult: { ANY_TYPE: 0, ORDERED_NODE_SNAPSHOT_TYPE: 7 },
    Event: class FakeEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${AGENT_SRC}\n;window.__egoAgent;`, context, { filename: 'inpage.agent.js' });
  assert.equal(typeof dom.window.__egoAgent, 'object', 'inpage agent 應完成安裝');
  return { api: dom.window.__egoAgent, document: dom.document, elements: dom.elements };
}

test('resolve() 對非法 xpath 回 {count:0,error:invalid selector}，不向外拋例外', () => {
  for (const bad of ['xpath=//[', 'xpath=//input[]']) {
    const { api, document } = loadAgent();
    let result;
    assert.doesNotThrow(() => { result = api.resolve(bad); }, `${bad} 不應拋例外`);
    assert.equal(result.count, 0, `${bad} 的 count 應為 0`);
    assert.equal(result.error, 'invalid selector', `${bad} 的 error 應為 invalid selector`);
    assert.equal(result.hid, null, `${bad} 不應回傳 hid`);
    assert.equal(document.activeElement, null, `${bad} 不應改變焦點`);
  }
});

test('resolve() 仍能正常處理合法 xpath（try/catch 不吞掉正常結果）', () => {
  const { api } = loadAgent();
  const res = api.resolve('xpath=//input');
  assert.equal(res.count, 1);
  assert.equal(res.error, null);
  assert.equal(typeof res.hid, 'number');
  assert.equal(res.d.tag, 'input');
});

test('fillValue() 對 label 的 hid 必須把焦點移到 label 對應的 input', () => {
  const { api, document, elements } = loadAgent();

  const resolved = api.resolve('text=名字');
  assert.equal(resolved.count, 1, 'text=名字 應只命中 label');
  assert.equal(resolved.d.tag, 'label');
  assert.equal(typeof resolved.hid, 'number');

  const fill = api.fillValue(resolved.hid, '');
  assert.equal(fill.ok, true);
  assert.equal(elements.input.value, '', 'input 既有值應被清空');
  assert.equal(document.activeElement, elements.input, '焦點必須落在 input');
  assert.notEqual(document.activeElement, elements.label, '焦點不可停在 label');
  assert.equal(document.activeElement.tagName, 'INPUT');
  assert.equal(api.checkValue(resolved.hid, ''), true, 'checkValue 應讀 label 的 control');
});

test('fillValue() 對一般 input 的 hid 仍直接把焦點放在該 input', () => {
  const { api, document, elements } = loadAgent();
  const resolved = api.resolve('css=#x');
  assert.equal(resolved.count, 1);
  const fill = api.fillValue(resolved.hid, '');
  assert.equal(fill.ok, true);
  assert.equal(document.activeElement, elements.input);
});
