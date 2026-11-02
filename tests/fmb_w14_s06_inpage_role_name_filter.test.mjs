// tests/fmb_w14_s06_inpage_role_name_filter.test.mjs
// 回歸測試：daemon/inpage.agent.js 的選擇器驗證
//   1) `loc=role:<role>[name=...]` 的 aria 名稱過濾器（空名稱 / 未加引號 / 殘缺引號）
//   2) `>> nth=` 的非法索引（css= 與 text= 兩條路徑）
//
// daemon/inpage.agent.js 是「注入瀏覽器端」的 IIFE 字串（不是 ESM 模組），因此這裡用
// node:vm 在最小假 DOM 上載入該檔文字後呼叫 window.__egoAgent。零依賴、零網路、
// 不 spawn 任何子程序、不讀寫 repo 以外的路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const AGENT_SRC = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);

function makeElement(tagName, { attrs = {}, text = '' } = {}) {
  const rect = { left: 10, top: 10, width: 120, height: 24 };
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    value: '',
    disabled: false,
    isContentEditable: false,
    textContent: text,
    href: attrs.href || null,
    placeholder: '',
    title: '',
    alt: '',
    childNodes: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    setAttribute(name, value) { attrs[name] = String(value); },
    getBoundingClientRect() {
      return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
    },
    focus() {},
    select() {},
    querySelector() { return null; },
  };
}

// 兩個可見按鈕，accessName() 會取 textContent → name 分別是 "Save" / "Delete"。
// 刻意讓 document.querySelectorAll() 對任何 CSS 選擇器都回空集合，這樣就能單獨
// 驗證「解析階段」的驗證行為（不會被查詢結果干擾）。
function loadAgent() {
  const buttons = [
    makeElement('button', { text: 'Save' }),
    makeElement('button', { text: 'Delete' }),
  ];
  const elements = buttons.slice();
  const document = {
    documentElement: { clientWidth: 1000, clientHeight: 800, scrollWidth: 1000, scrollHeight: 800 },
    title: 'fake page',
    querySelectorAll(sel) { return sel === '*' ? elements : []; },
    getElementById() { return null; },
  };
  const sandbox = {
    document,
    location: { href: 'http://127.0.0.1/' },
    CSS: { escape: (s) => String(s) },
    XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 },
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    console,
    window: {
      innerWidth: 1000,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    },
  };
  vm.createContext(sandbox);
  const installed = vm.runInContext(AGENT_SRC, sandbox, { filename: 'inpage.agent.js' });
  return { agent: sandbox.window.__egoAgent, installed, buttons };
}

test('載入：inpage.agent.js 在最小假 DOM 上安裝 window.__egoAgent', () => {
  const { agent, installed } = loadAgent();
  assert.equal(installed, 'installed');
  assert.equal(typeof agent.resolve, 'function');
});

test('loc=role name 過濾器：合法選擇器仍正確命中唯一元素（陽性對照）', () => {
  const { agent } = loadAgent();

  const exact = agent.resolve('loc=role:button[name="Save"]');
  assert.equal(exact.error, null);
  assert.equal(exact.count, 1);
  assert.equal(typeof exact.hid, 'number');
  assert.equal(exact.d.role, 'button');
  assert.equal(exact.d.name, 'Save');
  assert.equal(exact.d.text, 'Save');

  const contains = agent.resolve('loc=role:button[name*="elet"]');
  assert.equal(contains.error, null);
  assert.equal(contains.count, 1);
  assert.equal(contains.d.name, 'Delete');

  const singleQuoted = agent.resolve("loc=role:button[name*='av']");
  assert.equal(singleQuoted.count, 1);
  assert.equal(singleQuoted.d.name, 'Save');

  // 沒有 name 過濾器時仍應看到兩個按鈕（多匹配 → 不給 handle、也不算錯誤）。
  const noFilter = agent.resolve('loc=role:button');
  assert.equal(noFilter.count, 2);
  assert.equal(noFilter.hid, null);
  assert.equal(noFilter.error, null);
});

test('回歸：空的 name 過濾器不得匹配整個 role（String#includes("") 陷阱）', () => {
  const { agent } = loadAgent();
  for (const sel of [
    'loc=role:button[name*=""]',
    "loc=role:button[name*='']",
    'loc=role:button[name=""]',
    "loc=role:button[name='']",
  ]) {
    const r = agent.resolve(sel);
    assert.equal(r.hid, null, `${sel} 不應交出 handle`);
    assert.equal(r.count, 0, `${sel} 應回報 0 個匹配`);
    assert.equal(r.error, 'invalid selector', `${sel} 應回報 invalid selector`);
  }
});

test('回歸：未加引號或殘缺的 name= 必須回報 invalid selector，不可靜默 0 匹配', () => {
  const { agent } = loadAgent();
  for (const sel of [
    'loc=role:button[name=Save]',
    'loc=role:button[name="Save]',
    'loc=role:button[nam="Save"]',
    'loc=role:button[name*="Save"',
  ]) {
    const r = agent.resolve(sel);
    assert.equal(r.hid, null, `${sel} 不應交出 handle`);
    assert.equal(r.count, 0, `${sel} 應回報 0 個匹配`);
    assert.equal(r.error, 'invalid selector', `${sel} 應回報 invalid selector`);
  }
});

test('控制組：合法但無匹配的 name 仍是 count 0 / error null', () => {
  const { agent } = loadAgent();
  const r = agent.resolve('loc=role:button[name="Nope"]');
  assert.equal(r.count, 0);
  assert.equal(r.hid, null);
  assert.equal(r.error, null);
});

test('回歸：非數字 >> nth= 必須回報 invalid selector，不可靜默 0 匹配', () => {
  const { agent } = loadAgent();
  for (const sel of [
    'css=button >> nth=abc',
    'css=button >> nth=',
    'css=button:has-text("Save") >> nth=x',
    'text=Save >> nth=abc',
  ]) {
    const r = agent.resolve(sel);
    assert.equal(r.hid, null, `${sel} 不應交出 handle`);
    assert.equal(r.count, 0, `${sel} 應回報 0 個匹配`);
    assert.equal(r.error, 'invalid selector', `${sel} 應回報 invalid selector`);
  }
});

test('控制組：合法（含負數）的 >> nth= 仍照常解析，不被誤判為 invalid', () => {
  const { agent } = loadAgent();
  for (const sel of ['css=button >> nth=0', 'css=button >> nth=-1', 'text=Save >> nth=1']) {
    const r = agent.resolve(sel);
    assert.equal(r.error, null, `${sel} 不應被判定為 invalid selector`);
    assert.equal(r.hid, null, `${sel} 假 DOM 無匹配，不應交出 handle`);
    assert.equal(r.count, 0, `${sel} 假 DOM 無匹配，應為 0`);
  }
});
