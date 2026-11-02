// tests/fmb_w12_s06_inpage_css_text_escape.test.mjs
//
// daemon/inpage.agent.js 的選擇器解析回歸測試（純單元層級）：
//
// 1) `css=…:has-text("…")` / `:text-is('…')` 必須比對「已還原轉義」的文字，與
//    `text="…"` 的既有契約一致（模組內 unescapeQuoted() 已為 text= 修過同一類問題）。
//    修正前，引號內容是連反斜線一起切出來的，於是
//    `css=div:has-text("say \"hi\"")` 會去找字面上的反斜線，對合法選擇器靜默回 0 筆。
//
// 2) `loc=href:` 篩選值為空時，String#includes('') 對每個 <a> 都成立，resolve() 可能
//    交回一個任意連結（與模組已對 `text=` 擋掉的「等於全頁」風險同類）。
//
// 零依賴、零網路、不寫任何檔案：瀏覽器端模組以 node:vm 沙箱＋極簡假 DOM 執行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const AGENT_SRC = readFileSync(fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)), 'utf8');

const textNode = (data) => ({ nodeType: 3, data, textContent: data });

// 假 DOM 的 rect 必須像真的 DOMRect 一樣帶 right / bottom，
// 否則 visibleInViewport() 的 `r.bottom > 0 && r.right > 0` 永遠為 false，
// 測試會誤以為選擇器壞掉（實務上是這個假物件不完整）。
function makeRect(base) {
  const b = base || {};
  const left = b.left === undefined ? 0 : b.left;
  const top = b.top === undefined ? 0 : b.top;
  const width = b.width === undefined ? 100 : b.width;
  const height = b.height === undefined ? 20 : b.height;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeEl(opts = {}) {
  const attrMap = opts.attrs || {};
  const rect = makeRect(opts.rect);
  const el = {
    nodeType: 1,
    tagName: opts.tag || 'DIV',
    disabled: false,
    childNodes: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrMap, name) ? attrMap[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrMap, name);
    },
    getBoundingClientRect() { return rect; },
    scrollIntoView() {},
    focus() {},
    select() {},
    addEventListener() {},
    dispatchEvent() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get() {
      return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join('');
    },
    set(v) {
      this.childNodes = v === '' || v === null || v === undefined ? [] : [textNode(String(v))];
    },
  });
  el.childNodes = opts.text !== undefined ? [textNode(opts.text)] : (opts.children || []);
  return el;
}

function loadAgent(elements) {
  const byTag = (tag) => elements.filter((e) => e.tagName === String(tag).toUpperCase());
  const document = {
    title: 'fake page',
    documentElement: { clientWidth: 1280, clientHeight: 800, scrollWidth: 1280, scrollHeight: 800 },
    querySelectorAll(sel) {
      if (sel === '*') return elements.slice();
      if (sel === 'a[href]') return byTag('A').filter((e) => e.hasAttribute('href'));
      return byTag(sel);
    },
    getElementById() { return null; },
    querySelector() { return null; },
    evaluate() { throw new Error('xpath is not available in the fake DOM'); },
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };
  const sandbox = {
    window,
    document,
    CSS: { escape: (s) => String(s) },
    location: { href: 'http://127.0.0.1/' },
    Event: class FakeEvent {
      constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); }
    },
  };
  vm.runInNewContext(AGENT_SRC, sandbox, { filename: 'inpage.agent.js' });
  const agent = sandbox.window.__egoAgent;
  assert.ok(agent, 'window.__egoAgent 應被安裝');
  return agent;
}

test('css=:has-text 內的雙引號轉義要還原後才比對', () => {
  const agent = loadAgent([makeEl({ tag: 'DIV', text: 'say "hi"' })]);
  // JS 字串 → 選擇器實際內容：css=div:has-text("say \"hi\"")
  const res = agent.resolve('css=div:has-text("say \\"hi\\"")');
  assert.equal(res.count, 1);
  assert.equal(res.error, null);
  assert.equal(res.d.text, 'say "hi"');
});

test('css=:text-is 內的單引號轉義要還原後才比對', () => {
  const agent = loadAgent([makeEl({ tag: 'DIV', text: "it's here" })]);
  // JS 字串 → 選擇器實際內容：css=div:text-is('it\'s here')
  const res = agent.resolve("css=div:text-is('it\\'s here')");
  assert.equal(res.count, 1);
});

test('未轉義的 :has-text 與 >> nth= 行為維持不變', () => {
  const agent = loadAgent([
    makeEl({ tag: 'DIV', text: 'alpha' }),
    makeEl({ tag: 'DIV', text: 'alpha beta' }),
  ]);
  assert.equal(agent.resolve('css=div:has-text("alpha")').count, 2);
  const nth = agent.resolve('css=div:has-text("alpha") >> nth=1');
  assert.equal(nth.count, 1);
  assert.equal(nth.d.text, 'alpha beta');
});

test('loc=href: 空篩選值視為無效選擇器，不得匹配所有連結', () => {
  const agent = loadAgent([makeEl({ tag: 'A', text: 'only link', attrs: { href: '/only' } })]);
  for (const sel of ['loc=href:', 'loc=href:   ']) {
    const res = agent.resolve(sel);
    assert.equal(res.count, 0, sel);
    assert.equal(res.error, 'invalid selector', sel);
  }
});

test('loc=href: 有實際篩選值時仍正常命中單一連結', () => {
  const agent = loadAgent([
    makeEl({ tag: 'A', text: 'one', attrs: { href: '/one' } }),
    makeEl({ tag: 'A', text: 'two', attrs: { href: '/two' } }),
  ]);
  const res = agent.resolve('loc=href:/two');
  assert.equal(res.count, 1);
  assert.equal(res.d.name, 'two');
});
