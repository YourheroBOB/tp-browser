// tests/fmb_w6_s07_inpage_xpath_nodes_index.test.mjs
//
// 回歸測試（inpage agent）：
//   1. xpath 選到文字節點（//p/text()）或屬性節點（//a/@href）時，resolve() 不得再對
//      非元素節點呼叫 getBoundingClientRect 而拋 TypeError；文字節點取 parentElement、
//      屬性節點取 ownerElement，同一元素去重，全部非元素時回空結果。
//   2. selectOptions(hid, { index: N }) 必須支援物件形式的 index；超出範圍時依既有的
//      「全有或全無」規則失敗，且原本的選取與事件都不變。
//
// 零依賴：直接讀 daemon/inpage.agent.js 的原始碼，注入一個最小 DOM（不使用 jsdom）。
// 不連線任何服務、不讀寫 repo 以外的路徑（本檔完全不寫檔）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AGENT_SRC = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);

const box = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

class FakeEvent {
  constructor(type, init = {}) { this.type = String(type); this.bubbles = !!init.bubbles; }
}

class TextNode {
  constructor(data, parentElement = null) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentElement = parentElement;
  }
  get textContent() { return this.data; }
}

class AttrNode {
  constructor(name, value, ownerElement) {
    this.nodeType = 2;
    this.name = String(name);
    this.value = String(value);
    this.ownerElement = ownerElement || null;
    this.parentElement = null;
  }
  get textContent() { return this.value; }
}

class CommentNode {
  constructor(data) {
    this.nodeType = 8;
    this.data = String(data);
    this.parentElement = null;
  }
  get textContent() { return this.data; }
}

class El {
  constructor(tag, rect = box(20, 20, 120, 24)) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.id = '';
    this._attrs = Object.create(null);
    this._box = rect;
    this.dispatched = [];
    this.disabled = false;
    this.multiple = false;
    this.placeholder = '';
    this.title = '';
    this.alt = '';
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  get options() { return this.childNodes.filter((c) => c.nodeType === 1 && c.tagName === 'OPTION'); }
  append(...nodes) {
    for (const n of nodes) {
      if (n instanceof El || n instanceof TextNode || n instanceof CommentNode) {
        n.parentElement = this;
        this.childNodes.push(n);
      } else {
        this.childNodes.push(new TextNode(n, this));
      }
    }
    return this;
  }
  getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; }
  setAttribute(name, value) { this._attrs[String(name)] = String(value); }
  hasAttribute(name) { return name in this._attrs; }
  getBoundingClientRect() { return { ...this._box }; }
  dispatchEvent(ev) { this.dispatched.push(ev.type); return true; }
  addEventListener() {}
  scrollIntoView() {}
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class SelectEl extends El {
  constructor(rect) { super('select', rect); }
  get value() {
    const picked = this.options.find((o) => o.selected);
    return picked ? picked.value : '';
  }
  set value(v) {
    const want = String(v);
    for (const o of this.options) o.selected = o.value === want;
  }
}

function makeEnv() {
  const all = [];
  const xpathResults = new Map();

  const doc = {
    title: 'fmb-w6-s07 fixture',
    activeElement: null,
    documentElement: null,
    register(...els) { for (const el of els) all.push(el); return els[0]; },
    getElementById(id) { return all.find((el) => el.id === id) || null; },
    querySelector(sel) { const list = doc.querySelectorAll(sel); return list.length ? list[0] : null; },
    querySelectorAll(sel) {
      if (typeof sel !== 'string' || sel === '') return [];
      if (sel.startsWith('#')) return all.filter((el) => el.id === sel.slice(1));
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(sel)) {
        const tag = sel.toUpperCase();
        return all.filter((el) => el.tagName === tag);
      }
      return [];
    },
    setXPathResult(expr, nodes) { xpathResults.set(expr, nodes); },
    evaluate(expr) {
      const nodes = xpathResults.get(expr);
      if (!nodes) throw new Error('unexpected xpath in fixture: ' + expr);
      return {
        snapshotLength: nodes.length,
        snapshotItem(i) { return nodes[i] || null; },
      };
    },
  };

  doc.documentElement = new El('html', box(0, 0, 1024, 768));
  doc.documentElement.clientWidth = 1024;
  doc.documentElement.clientHeight = 768;

  const win = {
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle() { return { visibility: 'visible', display: 'block', opacity: '1' }; },
  };

  const factory = new Function(
    'window', 'document', 'XPathResult', 'CSS', 'location', 'Event',
    `${AGENT_SRC}\n;return window.__egoAgent;`,
  );
  const agent = factory(
    win,
    doc,
    { ORDERED_NODE_SNAPSHOT_TYPE: 7, ANY_TYPE: 0 },
    { escape: (s) => String(s) },
    { href: 'http://127.0.0.1:8899/tests/testpage.html' },
    FakeEvent,
  );

  return { agent, doc, window: win };
}

function buildFixture() {
  const env = makeEnv();
  const { doc } = env;

  // <p id="para">你好，這是段落。</p>：刻意拆成兩個文字節點，用來驗證去重。
  const p = new El('p', box(20, 20, 300, 24));
  p.id = 'para';
  const pText1 = new TextNode('你好，', p);
  const pText2 = new TextNode('這是段落。', p);
  p.childNodes.push(pText1, pText2);

  // <a id="popup-link" href="...">開新視窗</a>，屬性節點由 xpath 的 @href 取得。
  const a = new El('a', box(20, 60, 140, 24));
  a.id = 'popup-link';
  a.href = 'http://127.0.0.1:8899/landing';
  a.setAttribute('href', 'http://127.0.0.1:8899/landing');
  a.append('開新視窗');
  const hrefAttr = new AttrNode('href', 'http://127.0.0.1:8899/landing', a);

  // <select id="city">台北 / 台中 / 高雄</select>
  const city = new SelectEl(box(20, 100, 160, 26));
  city.id = 'city';
  const tpe = new El('option'); tpe.value = 'tpe'; tpe.append('台北'); tpe.selected = true;
  const txg = new El('option'); txg.value = 'txg'; txg.append('台中'); txg.selected = false;
  const khh = new El('option'); khh.value = 'khh'; khh.append('高雄'); khh.selected = false;
  city.append(tpe, txg, khh);

  doc.register(p, a, city);
  doc.documentElement.append(p, a, city);

  doc.setXPathResult('//p', [p]);
  doc.setXPathResult('//p/text()', [pText1, pText2]);
  doc.setXPathResult('//a/@href', [hrefAttr]);
  doc.setXPathResult('//comment()', [new CommentNode('只有註解'), new TextNode('沒有父元素的文字')]);

  return { ...env, p, a, city, pText1, pText2, hrefAttr, options: [tpe, txg, khh] };
}

test('xpath 選到元素節點時行為不變', () => {
  const fx = buildFixture();
  const res = fx.agent.resolve('xpath=//p');
  assert.equal(res.error, null);
  assert.equal(res.count, 1);
  assert.equal(res.d.tag, 'p');
});

test('xpath=//p/text()：文字節點解析回父元素 <p>，同一父元素只算一次（不再拋 TypeError）', () => {
  const fx = buildFixture();

  // 修正前：els = [TextNode, TextNode] → visibleInViewport() 呼叫
  // getBoundingClientRect 直接 TypeError。
  const res = fx.agent.resolve('xpath=//p/text()');

  assert.equal(res.error, null);
  assert.equal(res.count, 1, '兩個文字節點應去重成同一個 <p>');
  assert.notEqual(res.hid, null);
  assert.equal(res.d.tag, 'p');
  assert.equal(res.d.ref, fx.agent.refOf(fx.p));
  assert.equal(res.d.role, 'paragraph');
});

test('xpath=//a/@href：屬性節點解析回 ownerElement <a>（不再拋 TypeError）', () => {
  const fx = buildFixture();
  const res = fx.agent.resolve('xpath=//a/@href');

  assert.equal(res.error, null);
  assert.equal(res.count, 1);
  assert.notEqual(res.hid, null);
  assert.equal(res.d.tag, 'a');
  assert.equal(res.d.ref, fx.agent.refOf(fx.a));
  assert.equal(res.d.href, 'http://127.0.0.1:8899/landing');
});

test('xpath 只選到非元素節點（註解／無父元素的文字）時回空結果，不拋錯', () => {
  const fx = buildFixture();
  const res = fx.agent.resolve('xpath=//comment()');

  assert.equal(res.count, 0);
  assert.equal(res.hid, null);
  assert.equal(res.error, null);
});

test('selectOptions：{ index: 1 } 選到第二個選項並觸發 input／change', () => {
  const fx = buildFixture();
  const sel = fx.agent.resolve('css=#city');
  assert.equal(sel.count, 1);

  const r = fx.agent.selectOptions(sel.hid, { index: 1 });

  assert.deepEqual(r, { ok: true, selected: ['txg'] });
  assert.equal(fx.city.value, 'txg');
  assert.equal(fx.options[1].selected, true);
  assert.equal(fx.options[0].selected, false);
  assert.equal(fx.options[2].selected, false);
  assert.deepEqual(fx.city.dispatched, ['input', 'change']);
});

test('selectOptions：{ index: 0 } 與既有的 value pick 仍正常', () => {
  const fx = buildFixture();
  const sel = fx.agent.resolve('css=#city');

  assert.deepEqual(fx.agent.selectOptions(sel.hid, { value: 'khh' }), { ok: true, selected: ['khh'] });
  assert.equal(fx.city.value, 'khh');
  assert.deepEqual(fx.agent.selectOptions(sel.hid, { index: 0 }), { ok: true, selected: ['tpe'] });
  assert.equal(fx.city.value, 'tpe');
});

test('selectOptions：{ index: 99 } 超出範圍時失敗，原本的選取與事件都不變', () => {
  const fx = buildFixture();
  const sel = fx.agent.resolve('css=#city');

  assert.deepEqual(fx.agent.selectOptions(sel.hid, { index: 1 }), { ok: true, selected: ['txg'] });
  const eventsBefore = fx.city.dispatched.slice();

  const bad = fx.agent.selectOptions(sel.hid, { index: 99 });

  assert.equal(bad.ok, false);
  assert.match(bad.error, /^no option matches /);
  assert.match(bad.error, /99/);
  assert.equal(fx.city.value, 'txg', '失敗時不得清掉原選取');
  assert.equal(fx.options[1].selected, true);
  assert.deepEqual(fx.city.dispatched, eventsBefore, '失敗時不得再送 input／change');
});

test('selectOptions：陣列中含超範圍 index 時整批失敗，不半套套用', () => {
  const fx = buildFixture();
  const sel = fx.agent.resolve('css=#city');

  const r = fx.agent.selectOptions(sel.hid, [{ index: 0 }, { index: 42 }]);

  assert.equal(r.ok, false);
  assert.match(r.error, /42/);
  assert.equal(fx.city.value, 'tpe', '原本選取（第一個選項）必須保留');
  assert.deepEqual(fx.city.dispatched, []);
});
