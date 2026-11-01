// tests/fmb_w4_s06_inpage_empty_text.test.mjs
//
// 回歸測試：daemon/inpage.agent.js —— 「空文字選擇器」不得默默命中頁面元素。
//
// Bug（輸入驗證／靜默錯誤動作）：
//   select() 的 text 分支用 String#includes() 比對，而 `text=`（空值、只有空白、或空變數插值）、
//   `text=""`、`css=div:has-text("")`、`text= >> nth=0` 都會讓過濾字串變成空字串；
//   includes('') 對任何元素都成立，於是整頁元素都算「命中」。
//   resolve() 只要命中數為 1 就回傳可操作的 handle，因此當頁面上剛好只有一個候選元素
//   （或 nth 指到其中一個）時，agent 的 click / fill 會對著完全不相關的元素動作，
//   而且回傳值是成功的、沒有任何錯誤可以讓呼叫端發現。
//
// 修法：want 為空時視為 invalid selector（沿用 css 分支既有的 error: 'invalid selector'），
//   resolve() 於是回 { count: 0, error: 'invalid selector', hid: null }，呼叫端會明確失敗。
//
// 測試方式：inpage.agent.js 是注入頁面的 IIFE（不是 Node 模組），這裡用 node:vm 搭配最小假 DOM
// 執行它，只驗證選擇器解析與錯誤回報。零網路、零檔案讀寫、零真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const AGENT_SRC = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);
const RECT = { left: 10, top: 10, width: 100, height: 24 };

const textNode = (text) => ({ nodeType: 3, textContent: text });

function makeEl(tagName, { text = null, attrs = {}, rect = RECT } = {}) {
  const el = {
    nodeType: 1,
    tagName,
    id: attrs.id || '',
    disabled: false,
    childNodes: text === null ? [] : [textNode(text)],
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.hasOwn(attrs, name);
    },
    getBoundingClientRect() {
      return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      return el.childNodes.map((n) => n.textContent || '').join('');
    },
  });
  return el;
}

// 在 vm 沙箱中執行 inpage.agent.js，回傳 window.__egoAgent。
function loadAgent(elements, { innerWidth = 1200, innerHeight = 900 } = {}) {
  const documentStub = {
    title: 'fmb-w4-s06',
    documentElement: {
      clientWidth: innerWidth,
      clientHeight: innerHeight,
      scrollWidth: innerWidth,
      scrollHeight: innerHeight,
    },
    // text= 的候選清單以是否含 'button' 辨識；cssText 測試只會查 'div'。
    querySelectorAll(selector) {
      if (selector === 'div') return elements.filter((el) => el.tagName === 'DIV');
      if (selector.includes('button')) return elements;
      return [];
    },
    querySelector() {
      return null;
    },
    getElementById() {
      return null;
    },
    evaluate() {
      throw new Error('xpath evaluate is not stubbed for this test');
    },
  };
  const context = {
    window: {
      innerWidth,
      innerHeight,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    },
    document: documentStub,
    location: { href: 'http://127.0.0.1:8899/testpage.html' },
    CSS: { escape: (v) => String(v).replace(/["\\]/g, '\\$&') },
    XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 },
    Event: class FakeEvent {
      constructor(type, init) {
        this.type = type;
        this.bubbles = !!(init && init.bubbles);
      }
    },
  };
  vm.runInNewContext(AGENT_SRC, context, { filename: 'daemon/inpage.agent.js' });
  return context.window.__egoAgent;
}

test('inpage: 空 text= 選擇器不得默默鎖定頁面上唯一的元素', () => {
  const button = makeEl('BUTTON', { text: '送出' });
  const agent = loadAgent([button]);

  const r = agent.resolve('text=');
  assert.equal(r.count, 0, '空字串 text= 不應匹配任何元素');
  assert.equal(r.hid, null, '不得回傳可操作的 handle');
  assert.equal(r.error, 'invalid selector');
});

test('inpage: 只有空白的 text=  同樣視為無效選擇器', () => {
  const button = makeEl('BUTTON', { text: '送出' });
  const agent = loadAgent([button]);

  const r = agent.resolve('text=   ');
  assert.equal(r.count, 0);
  assert.equal(r.hid, null);
  assert.equal(r.error, 'invalid selector');
});

test('inpage: text= >> nth=1 不會退化成「頁面第二個元素」', () => {
  const link = makeEl('A', { text: '首頁', attrs: { href: '/home' } });
  const button = makeEl('BUTTON', { text: '送出' });
  const agent = loadAgent([link, button]);

  const r = agent.resolve('text= >> nth=1');
  assert.equal(r.count, 0, '空文字 + nth 不得指到任意元素');
  assert.equal(r.hid, null);
  assert.equal(r.error, 'invalid selector');
});

test('inpage: text="" 明確空字串不得匹配「沒有文字」的元素', () => {
  const input = makeEl('INPUT', { attrs: { type: 'text' } });
  const agent = loadAgent([input]);

  const r = agent.resolve('text=""');
  assert.equal(r.count, 0);
  assert.equal(r.hid, null);
  assert.equal(r.error, 'invalid selector');
});

test('inpage: :has-text("") 也不得匹配全部元素', () => {
  const div = makeEl('DIV', { text: '容器' });
  const agent = loadAgent([div]);

  const r = agent.resolve('css=div:has-text("")');
  assert.equal(r.count, 0);
  assert.equal(r.hid, null);
  assert.equal(r.error, 'invalid selector');
});

test('inpage: 正常（非空）的 text= 與 :has-text() 仍可解析（回歸保護）', () => {
  const button = makeEl('BUTTON', { text: '送出' });
  const div = makeEl('DIV', { text: '容器' });
  const agent = loadAgent([button, div]);

  const byText = agent.resolve('text=送出');
  assert.equal(byText.count, 1);
  assert.equal(typeof byText.hid, 'number');
  assert.equal(byText.d.tag, 'button');
  assert.equal(byText.d.name, '送出');
  assert.equal(byText.error, null);

  const byCssText = agent.resolve('css=div:has-text("容器")');
  assert.equal(byCssText.count, 1);
  assert.equal(byCssText.d.tag, 'div');
  assert.equal(byCssText.error, null);
});
