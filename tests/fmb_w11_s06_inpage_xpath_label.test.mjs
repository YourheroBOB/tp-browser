// tests/fmb_w11_s06_inpage_xpath_label.test.mjs
// 回歸測試：daemon/inpage.agent.js（瀏覽器端代理，以 window.__egoAgent 暴露）
//  1) 無效的 xpath 必須回報 { error: 'invalid selector' }，不可讓 document.evaluate()
//     丟出的 SyntaxError 穿過 CDP Runtime.evaluate 邊界；其他 selector 種類（css/cssText）
//     都是走回報路線，xpath 是唯一漏掉的。
//  2) xpath 命中文字節點／屬性節點時只能忽略，不能讓 describe()/visibleInViewport()
//     在非元素節點上呼叫 getBoundingClientRect() 而整個 evaluate 爆掉。
//  3) fillValue() 以 <label> 當 handle 時，焦點要落在 label 的 control 上；label 本身
//     在瀏覽器不可聚焦，舊行為會讓後續輸入打進 <body>。
// 只使用假的 DOM stub；零網路、零正式服務；唯一檔案讀取是被測來源檔本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);

const RECT = { left: 0, top: 0, right: 120, bottom: 24, width: 120, height: 24 };

// The agent module is a plain IIFE with free variables window/document/CSS/
// XPathResult/Event, so it can be evaluated with those injected as parameters.
function makeEnv() {
  const document = {
    activeElement: null,
    documentElement: { clientWidth: 1024, clientHeight: 768, scrollWidth: 1024, scrollHeight: 2400 },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    evaluate: () => { throw new SyntaxError('evaluate() not configured for this test'); },
  };
  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };
  const CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  const XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7 };
  class FakeEvent {
    constructor(type, init) {
      this.type = type;
      this.bubbles = !!(init && init.bubbles);
    }
  }
  const install = new Function('window', 'document', 'CSS', 'XPathResult', 'Event', SOURCE);
  install(window, document, CSS, XPathResult, FakeEvent);
  assert.equal(typeof window.__egoAgent, 'object', 'agent module did not install window.__egoAgent');
  return { window, document, agent: window.__egoAgent };
}

function makeEl(document, spec = {}) {
  const attrs = spec.attrs || {};
  const el = {
    nodeType: 1,
    tagName: spec.tagName || 'DIV',
    id: spec.id,
    type: spec.type,
    value: spec.value,
    control: spec.control || null,
    disabled: !!spec.disabled,
    textContent: spec.text || '',
    childNodes: spec.childNodes || [],
    focus() { document.activeElement = el; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getBoundingClientRect() { return { ...RECT }; },
    setAttribute(name, v) { attrs[name] = v; },
  };
  return el;
}

// Fake document.evaluate(): known expressions return their node list, everything
// else throws exactly like a real browser does for a malformed XPath.
function withXPath(document, map) {
  document.evaluate = (expr) => {
    const nodes = map[expr];
    if (!nodes) throw new SyntaxError(`Failed to execute 'evaluate' on 'Document': not a valid XPath expression: ${expr}`);
    return { snapshotLength: nodes.length, snapshotItem: (i) => nodes[i] };
  };
}

test('resolve(): 無效／空的 xpath 回報 invalid selector，不拋例外', () => {
  const { agent, document } = makeEnv();
  withXPath(document, {}); // 任何運算式都會丟 SyntaxError

  for (const sel of ['xpath=//div[', 'xpath=', 'xpath=///', 'xpath=//*[']) {
    let res;
    assert.doesNotThrow(() => { res = agent.resolve(sel); }, `resolve(${sel}) threw`);
    assert.equal(res.count, 0, sel);
    assert.equal(res.error, 'invalid selector', sel);
    assert.equal(res.hid, null, sel);
  }
});

test('resolve(): 合法但無結果的 xpath 回 count=0／error=null（不是 invalid selector）', () => {
  const { agent, document } = makeEnv();
  withXPath(document, { '//nope': [] });

  const res = agent.resolve('xpath=//nope');
  assert.equal(res.count, 0);
  assert.equal(res.error, null);
  assert.equal(res.hid, null);
});

test('resolve(): 合法 xpath 仍可解析出元素（未破壞正常路徑）', () => {
  const { agent, document } = makeEnv();
  const btn = makeEl(document, { tagName: 'BUTTON', text: '送出' });
  withXPath(document, { '//button': [btn] });

  const res = agent.resolve('xpath=//button');
  assert.equal(res.count, 1);
  assert.equal(res.error, null);
  assert.ok(res.hid, 'handle id should be assigned');
  assert.equal(res.d.tag, 'button');
  assert.equal(res.d.role, 'button');
  assert.equal(res.d.name, '送出');

  // 同一個元素重複解析要沿用同一個 handle，否則 daemon 端的 click/fill 會指向新 hid。
  const again = agent.resolve('xpath=//button');
  assert.equal(again.hid, res.hid);
});

test('resolve(): xpath 命中文字節點時安全忽略，不因描述非元素而崩潰', () => {
  const { agent, document } = makeEnv();
  const textNode = { nodeType: 3, textContent: 'hello' };
  const attrLike = { nodeType: 2, textContent: 'x' };
  withXPath(document, { '//text()': [textNode, attrLike] });

  let res;
  assert.doesNotThrow(() => { res = agent.resolve('xpath=//text()'); });
  assert.equal(res.count, 0);
  assert.equal(res.error, null);
  assert.equal(res.hid, null);
});

test('resolve(): xpath 混合元素與文字節點時只回傳唯一元素', () => {
  const { agent, document } = makeEnv();
  const link = makeEl(document, { tagName: 'A', text: '下一頁' });
  const textNode = { nodeType: 3, textContent: '下一頁' };
  withXPath(document, { '//a': [textNode, link] });

  const res = agent.resolve('xpath=//a');
  assert.equal(res.count, 1);
  assert.equal(res.error, null);
  assert.equal(res.d.role, 'anchor');
});

test('fillValue(): 以 label 為 handle 時焦點與清值都落在 control 上', () => {
  const { agent, document } = makeEnv();
  const input = makeEl(document, { tagName: 'INPUT', type: 'text', value: 'old value' });
  const label = makeEl(document, { tagName: 'LABEL', text: '姓名', control: input });
  document.querySelectorAll = (sel) => (sel === 'label' ? [label] : []);

  const r = agent.resolve('css=label');
  assert.equal(r.count, 1);
  assert.equal(r.d.role, 'label');

  const out = agent.fillValue(r.hid, 'FAKE_VALUE_FOR_TEST');
  assert.deepEqual(out, { ok: true, editable: false });
  assert.equal(input.value, '', 'control value must be cleared');
  assert.equal(document.activeElement, input, 'focus must land on the labelled control');
  assert.notEqual(document.activeElement, label, 'focusing a LABEL is a no-op in browsers');
});

test('fillValue(): contentEditable 清空文字並回報 editable', () => {
  const { agent, document } = makeEnv();
  const div = makeEl(document, { tagName: 'DIV', text: 'old text' });
  div.isContentEditable = true;
  document.querySelectorAll = (sel) => (sel === 'div' ? [div] : []);

  const r = agent.resolve('css=div');
  assert.equal(r.count, 1);

  const out = agent.fillValue(r.hid, 'FAKE_VALUE_FOR_TEST');
  assert.deepEqual(out, { ok: true, editable: true });
  assert.equal(div.textContent, '');
  assert.equal(document.activeElement, div);
});

test('fillValue(): 失效 handle 回報 stale handle（錯誤處理不被本次改動影響）', () => {
  const { agent } = makeEnv();
  const out = agent.fillValue(987654, 'FAKE_VALUE_FOR_TEST');
  assert.deepEqual(out, { ok: false, error: 'stale handle' });
});
