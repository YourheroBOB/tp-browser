// tests/fmb_w13_s06_inpage_select_options.test.mjs
// daemon/inpage.agent.js 的回歸測試（w13 / s06）：
//   1. 單選 <select> 內有重複 value 的 <option> 時，selectOptions 必須真的選中「被挑到的那一個」，
//      不能只靠 `select.value = v`（瀏覽器只會選中第一個 value 相同的 option）。
//   2. 數字型 label（{ label: 20 }）不得讓 norm() 拋出 TypeError。
//   3. 非字串 selector 與 null options 必須回報 invalid selector，不得把 TypeError 丟過 CDP 邊界。
// 全部在記憶體中的假 DOM 上執行：零依賴、零網路、只讀 repo 內的 agent 原始碼，不寫任何檔案。
//
// 隔離性：本檔不 spawn 子程序、不開 socket、不碰 9772/9773/9774/9775 任一埠、不建立暫存檔，
// 因此不會干擾同套件中需要啟停 daemon／Chrome 的測試（例如 tests/fmb_w9_s01_tp_stop_regex_path）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AGENT_SRC = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);

function loadAgent() {
  const RECT = { left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34 };
  const registry = new Map();

  const fakeDocument = {
    activeElement: null,
    title: 'fmb-w13-s06-fake',
    documentElement: { clientWidth: 1280, clientHeight: 800, scrollWidth: 1280, scrollHeight: 800 },
    getElementById() { return null; },
    querySelector(sel) {
      const list = this.querySelectorAll(sel);
      return list.length ? list[0] : null;
    },
    querySelectorAll(sel) {
      const hit = registry.get(String(sel));
      return hit ? hit.slice() : [];
    },
    evaluate() { throw new Error('fake document has no XPath'); },
  };

  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };

  function makeEl(tagName, props = {}) {
    return {
      tagName,
      nodeType: 1,
      childNodes: [],
      attributes: {},
      textContent: '',
      disabled: false,
      events: [],
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
      getBoundingClientRect() { return { ...RECT }; },
      scrollIntoView() {},
      focus() { fakeDocument.activeElement = this; },
      dispatchEvent(ev) { this.events.push(ev && ev.type); return true; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const hit = registry.get(String(sel));
        return hit ? hit.slice() : [];
      },
      ...props,
    };
  }

  // 假 <select>：`value` setter 依 HTML 標準只選中「第一個」value 相同的 option，
  // 這樣測試才有辦法重現「重複 value 時選錯 option」的真實行為。
  function makeSelect(specs, { multiple = false, id = 'city' } = {}) {
    const options = specs.map((spec) => {
      const opt = makeEl('OPTION', { textContent: spec.text, selected: false });
      opt.value = spec.value === undefined ? spec.text : String(spec.value);
      return opt;
    });
    const select = makeEl('SELECT', {
      id,
      multiple,
      options,
      type: multiple ? 'select-multiple' : 'select-one',
    });
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() {
        const hit = this.options.find((o) => o.selected);
        return hit ? hit.value : '';
      },
      set(next) {
        const wanted = String(next);
        let hit = null;
        for (const o of this.options) if (hit === null && o.value === wanted) hit = o;
        for (const o of this.options) o.selected = o === hit;
      },
    });
    return { select, options };
  }

  // The agent source is a trailing *expression* statement (`(() => {...})()`), so a bare
  // `AGENT_SRC` function body evaluates the IIFE and throws the completion value away,
  // making the injection check always see `undefined`. Wrap it in `return (...)` so the
  // 'installed' / 'reuse' sentinel is observable. (Parentheses, not a bare `return`,
  // because the file starts with `//` comment lines.)
  const install = new Function(
    'window', 'document', 'location', 'CSS', 'XPathResult', 'Event',
    `return (\n${AGENT_SRC}\n);`,
  );
  const installed = install(
    fakeWindow,
    fakeDocument,
    { href: 'http://127.0.0.1:1/fake' },
    { escape: (value) => String(value).replace(/[^A-Za-z0-9_-]/g, (ch) => '\\' + ch) },
    undefined,
    globalThis.Event,
  );
  assert.equal(installed, 'installed', 'inpage.agent.js 必須完成注入');

  return {
    agent: fakeWindow.__egoAgent,
    register: (selector, elements) => registry.set(selector, elements),
    makeSelect,
  };
}

test('s06/inpage：單選 select 內重複 value 時，selectOptions 必須選中指定索引的 option', () => {
  const { agent, register, makeSelect } = loadAgent();
  const { select, options } = makeSelect([
    { text: 'foo', value: 'foo' },
    { text: 'bar', value: 'foo' }, // 同 value、不同 label（真實網站常見）
    { text: 'baz', value: 'baz' },
  ]);
  register('#city', [select]);

  const found = agent.resolve('css=#city');
  assert.equal(found.count, 1);
  assert.equal(found.error, null);
  assert.notEqual(found.hid, null);

  const result = agent.selectOptions(found.hid, [1]);
  assert.deepEqual(result, { ok: true, selected: ['foo'] });
  assert.equal(options[1].selected, true, '必須選中索引 1（label=bar）');
  assert.equal(options[0].selected, false, '索引 0（label=foo）不可被選中');
  assert.equal(options[2].selected, false);
});

test('s06/inpage：用 { label } 挑選重複 value 的 option 時也要選中該 option', () => {
  const { agent, register, makeSelect } = loadAgent();
  const { select, options } = makeSelect([
    { text: 'foo', value: 'foo' },
    { text: 'bar', value: 'foo' },
  ]);
  register('#city', [select]);

  const found = agent.resolve('css=#city');
  assert.equal(found.count, 1);

  const result = agent.selectOptions(found.hid, { label: 'bar' });
  assert.deepEqual(result, { ok: true, selected: ['foo'] });
  assert.equal(options[1].selected, true, '依 label=bar 必須選中索引 1');
  assert.equal(options[0].selected, false);
});

test('s06/inpage：數字型 label 不會拋 TypeError，且能比對到文字相同的 option', () => {
  const { agent, register, makeSelect } = loadAgent();
  const { select, options } = makeSelect([{ text: '10' }, { text: '20' }]);
  register('#city', [select]);

  const found = agent.resolve('css=#city');
  assert.equal(found.count, 1);

  const result = agent.selectOptions(found.hid, { label: 20 });
  assert.deepEqual(result, { ok: true, selected: ['20'] });
  assert.equal(options[1].selected, true);
  assert.equal(options[0].selected, false);
});

test('s06/inpage：非字串 selector 與 null options 不可拋 TypeError', () => {
  const { agent, register, makeSelect } = loadAgent();

  for (const bad of [undefined, null, 42, {}, []]) {
    assert.deepEqual(
      agent.resolve(bad),
      { count: 0, error: 'invalid selector', hid: null },
      `selector=${String(bad)}`,
    );
  }

  const { select } = makeSelect([{ text: 'tpe' }]);
  register('#city', [select]);
  const withNullOpts = agent.resolve('css=#city', null);
  assert.equal(withNullOpts.count, 1);
  assert.equal(withNullOpts.error, null);
});
