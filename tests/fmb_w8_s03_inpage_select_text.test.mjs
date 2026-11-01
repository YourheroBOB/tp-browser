// Regression tests for daemon/inpage.agent.js selectOption/text selector bugs.
// Zero-dependency: loads the browser-side IIFE with node:vm and a minimal fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const agentSource = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
  }
}

class FakeElement {
  constructor(tag, props = {}) {
    // Element nodes must report nodeType 1; FakeDocument._all() and the agent's
    // childNodes walks both filter on it, otherwise every query returns nothing.
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.selected = false;
    Object.assign(this, props);
  }

  append(...nodes) {
    for (const n of nodes) {
      this.childNodes.push(n);
      if (n.nodeType === 1) n.parentNode = this;
    }
    return this;
  }

  appendText(text) {
    return this.append(new FakeText(text));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 };
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [new FakeText(String(value))];
  }

  dispatchEvent() {
    return true;
  }
}

class FakeOption extends FakeElement {
  constructor(value, label) {
    super('option', { value });
    this.appendText(label);
  }
}

class FakeSelect extends FakeElement {
  constructor(options = []) {
    super('select');
    this.options = options;
    this.multiple = false;
    for (const o of options) this.append(o);
  }

  // Browser-like value semantics: assigning value selects the FIRST option
  // whose value matches. This is exactly the behavior that exposed bug #1.
  get value() {
    const selected = this.options.find((o) => o.selected);
    return selected ? selected.value : '';
  }

  set value(v) {
    const idx = this.options.findIndex((o) => o.value === v);
    this.options.forEach((o, i) => { o.selected = i === idx; });
  }

  get selectedIndex() {
    return this.options.findIndex((o) => o.selected);
  }

  set selectedIndex(i) {
    this.options.forEach((o, idx) => { o.selected = idx === i; });
  }
}

class FakeDocument {
  constructor(root) {
    this.documentElement = root;
    this.title = '';
  }

  _all() {
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes || []) {
        if (c.nodeType === 1) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this.documentElement);
    return out;
  }

  getElementById(id) {
    return this._all().find((el) => el.id === id) || null;
  }

  querySelector(selector) {
    const m = selector.match(/^label\[for="(.+)"\]$/);
    if (m) return null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector.startsWith('#')) {
      const el = this.getElementById(selector.slice(1));
      return el ? [el] : [];
    }
    if (selector === '*' || selector.includes(',')) return this._all();
    return this._all().filter((el) => el.tagName === selector.toUpperCase());
  }
}

function loadAgent(doc) {
  const sandbox = {
    document: doc,
    location: { href: 'about:blank' },
    console,
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    CSS: { escape: (s) => String(s).replace(/"/g, '\\$&') },
    Event: class FakeEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
      }
    },
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(agentSource, context, { filename: 'inpage.agent.js' });

  const agent = context.window.__egoAgent;
  assert.equal(typeof agent.selectOptions, 'function');
  return agent;
}

function makeSelectEnvironment(optionSpecs) {
  const options = optionSpecs.map(([value, label]) => new FakeOption(value, label));
  const select = new FakeSelect(options);
  select.setAttribute('id', 's');

  const root = new FakeElement('body');
  root.append(select);

  const agent = loadAgent(new FakeDocument(root));
  const resolved = agent.resolve('css=#s');
  assert.equal(resolved.count, 1);
  assert.equal(resolved.error, null);

  return { agent, hid: resolved.hid, select, options };
}

function makeTextEnvironment(pageText) {
  const target = new FakeElement('div');
  target.setAttribute('id', 'target');
  target.appendText(pageText);

  const root = new FakeElement('body');
  root.append(target);

  return loadAgent(new FakeDocument(root));
}

test('fmb_w8_s03 bug1: duplicate option values selected by label choose the exact option object', () => {
  const { agent, hid, select, options } = makeSelectEnvironment([
    ['1', 'First'],
    ['1', 'Second'],
  ]);

  const result = agent.selectOptions(hid, { label: 'Second' });

  assert.equal(result.ok, true);
  assert.equal(options[0].selected, false);
  assert.equal(options[1].selected, true);
  assert.equal(select.selectedIndex, 1);
  assert.equal(select.value, '1');
});

test('fmb_w8_s03 bug2: object pick requires every provided field to match', () => {
  const { agent, hid, options } = makeSelectEnvironment([
    ['a', 'Alpha'],
    ['b', 'Beta'],
  ]);

  const mismatch = agent.selectOptions(hid, { value: 'a', label: 'Beta' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /no option matches/);
  assert.equal(options[0].selected, false);
  assert.equal(options[1].selected, false);

  const match = agent.selectOptions(hid, { value: 'b', label: 'Beta' });
  assert.equal(match.ok, true);
  assert.equal(options[1].selected, true);
});

test('fmb_w8_s03 bug3: exact text normalizes repeated whitespace in the query', () => {
  const agent = makeTextEnvironment('Hello  World');
  const result = agent.resolve('text="Hello  World"');

  assert.equal(result.count, 1);
  assert.equal(result.error, null);
  assert.notEqual(result.hid, null);
});

test('fmb_w8_s03 bug3: exact text normalizes leading/trailing whitespace in the query', () => {
  const agent = makeTextEnvironment(' Submit ');
  const result = agent.resolve('text=" Submit "');

  assert.equal(result.count, 1);
  assert.equal(result.error, null);
  assert.notEqual(result.hid, null);
});

test('fmb_w8_s03 bug3: exact text still honors backslash escapes after normalization', () => {
  const agent = makeTextEnvironment('say "hi"');
  const result = agent.resolve('text="say \\"hi\\""');

  assert.equal(result.count, 1);
  assert.equal(result.error, null);
  assert.notEqual(result.hid, null);
});
