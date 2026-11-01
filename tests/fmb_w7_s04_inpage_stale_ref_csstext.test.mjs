// w7 / s04 regression tests for daemon/inpage.agent.js
//
// Bug 1 — stale ref: a ref (@N / ref=N) pointing at an element that was removed
//   from the DOM still resolved to the detached node. That node reports an
//   all-zero bounding rect and INTERACTIVE tags pass the requireVisible filter,
//   so resolve() returned count 1 + a hid + zero coordinates, and the daemon
//   clicked whatever happens to sit at (0,0).
// Bug 2 — :has-text() / :text-is() kept the backslash escapes of a quoted
//   argument, so css=button:has-text('it\'s') never matched the page text `it's`.
//
// The agent is browser-side code; it is loaded here by evaluating the real source
// against a minimal in-memory DOM stub. Zero dependency, zero network, no access
// to any path outside this repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agentSrc = readFileSync(fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)), 'utf8');

// ---- minimal DOM stub (only what the agent touches) ----
function mkText(t) { return { nodeType: 3, textContent: String(t), parentNode: null }; }

function mkEl(tag, opts = {}) {
  const attrs = Object.assign({}, opts.attrs);
  const childNodes = [];
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes,
    parentNode: null,
    isConnected: false,
    scrollWidth: 1280,
    scrollHeight: 800,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    setAttribute(name, val) { attrs[name] = String(val); },
    getBoundingClientRect() { return { left: 8, top: 16, width: 96, height: 28, right: 104, bottom: 44 }; },
    scrollIntoView() {},
    focus() {},
    dispatchEvent() { return true; },
    remove() {
      const p = el.parentNode;
      if (p) { const i = p.childNodes.indexOf(el); if (i !== -1) p.childNodes.splice(i, 1); el.parentNode = null; }
      el.isConnected = false;
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return childNodes.map((c) => c.textContent).join(''); },
    set(v) { childNodes.length = 0; if (v !== '' && v != null) childNodes.push(mkText(v)); },
  });
  for (const c of opts.children || []) { childNodes.push(c); c.parentNode = el; }
  return el;
}

// Supports the only selector shapes the agent emits in these tests:
// `*`, `tag`, `[attr]`, `[attr="v"]`, `tag[attr="v"]`, comma lists.
function matchesSimple(el, sel) {
  sel = String(sel).trim();
  if (!sel) return false;
  if (sel === '*') return true;
  const m = sel.match(/^([A-Za-z][\w-]*)?((?:\[[^\]]*\])*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const a of (m[2].match(/\[[^\]]*\]/g) || [])) {
    const am = a.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
    if (!am) return false;
    if (!el.hasAttribute(am[1])) return false;
    const want = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : am[4]);
    if (want !== undefined && el.getAttribute(am[1]) !== want) return false;
  }
  return true;
}

function makeDocument(root) {
  const all = [root];
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      c.isConnected = true;
      all.push(c);
      walk(c);
    }
  })(root);
  root.isConnected = true;
  return {
    documentElement: root,
    title: 'fake page',
    querySelectorAll(sel) {
      const out = [];
      for (const part of String(sel).split(',')) {
        for (const el of all) if (matchesSimple(el, part) && !out.includes(el)) out.push(el);
      }
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    getElementById(id) { return all.find((e) => e.getAttribute('id') === id) || null; },
    evaluate() { throw new Error('xpath is not supported by the inpage test stub'); },
  };
}

function boot(bodyChildren) {
  const html = mkEl('html');
  const body = mkEl('body');
  html.childNodes.push(body); body.parentNode = html;
  const els = [];
  for (const c of bodyChildren) { body.childNodes.push(c); c.parentNode = body; els.push(c); }
  const win = {
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    getComputedStyle() { return { visibility: 'visible', display: 'block', opacity: '1' }; },
  };
  const doc = makeDocument(html);
  const CSSstub = { escape: (s) => String(s).replace(/(["\\])/g, '\\$1') };
  const XPathResultStub = { ORDERED_NODE_SNAPSHOT_TYPE: 0 };
  const EventStub = class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } };
  new Function('window', 'document', 'location', 'CSS', 'XPathResult', 'Event', agentSrc)(
    win, doc, { href: 'http://127.0.0.1:8899/fake' }, CSSstub, XPathResultStub, EventStub,
  );
  assert.ok(win.__egoAgent, 'agent must install itself on the stub window');
  return { agent: win.__egoAgent, doc, els };
}

function refsOfTag(agent, tag) {
  const refs = agent.snap().lines
    .filter((l) => l.trim().startsWith(tag + ' [ref='))
    .map((l) => Number(/ref=(\d+)/.exec(l)[1]));
  assert.ok(refs.length > 0, `snapshot must expose refs for <${tag}>`);
  return refs;
}

test('w7-s04: @ref 指向已從 DOM 移除的元素 → count 0、無 hid、不留零座標', () => {
  const { agent, els } = boot([mkEl('button', { children: [mkText('Go')] })]);
  const ref = refsOfTag(agent, 'button')[0];

  const live = agent.resolve('@' + ref);
  assert.equal(live.count, 1);
  assert.ok(live.hid !== null);
  assert.equal(live.d.tag, 'button');

  els[0].remove();
  const dead = agent.resolve('@' + ref);
  assert.equal(dead.count, 0);
  assert.equal(dead.hid, null);
  assert.equal(dead.d, undefined);
  assert.equal(dead.error, null);

  // idempotent: the stale refIndex entry was dropped, repeat lookups stay "not found"
  assert.equal(agent.resolve('@' + ref).count, 0);
  assert.equal(agent.resolve('ref=' + ref).count, 0);
});

test('w7-s04: 仍在 DOM 中的 ref 照常可 resolve（@N 與 ref=N）', () => {
  const { agent } = boot([
    mkEl('button', { children: [mkText('First')] }),
    mkEl('button', { children: [mkText('Second')] }),
  ]);
  const refs = refsOfTag(agent, 'button');
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1]);

  const r = agent.resolve('@' + refs[1]);
  assert.equal(r.count, 1);
  assert.ok(r.hid !== null);
  assert.equal(r.d.text, 'Second');
  assert.equal(agent.resolve('ref=' + refs[1]).count, 1);
});

test("w7-s04: css=button:has-text('it\\'s') 解開單引號跳脫", () => {
  const { agent } = boot([mkEl('button', { children: [mkText("it's")] })]);
  const r = agent.resolve("css=button:has-text('it\\'s')");
  assert.equal(r.count, 1);
  assert.equal(r.d.text, "it's");
});

test('w7-s04: css=button:has-text("say \\"hi\\"") 解開雙引號跳脫', () => {
  const { agent } = boot([mkEl('button', { children: [mkText('say "hi"')] })]);
  const r = agent.resolve('css=button:has-text("say \\"hi\\"")');
  assert.equal(r.count, 1);
  assert.equal(r.d.text, 'say "hi"');
});

test("w7-s04: css=button:text-is('it\\'s') 解開跳脫且仍做全等比對", () => {
  const { agent } = boot([mkEl('button', { children: [mkText("it's")] })]);
  const hit = agent.resolve("css=button:text-is('it\\'s')");
  assert.equal(hit.count, 1);
  assert.equal(hit.d.text, "it's");
  assert.equal(agent.resolve("css=button:text-is('its')").count, 0);
});

test('w7-s04: 不含跳脫的既有寫法（css=:has-text、text=）不受影響', () => {
  const { agent } = boot([mkEl('button', { children: [mkText('Go')] })]);
  assert.equal(agent.resolve("css=button:has-text('Go')").count, 1);
  assert.equal(agent.resolve('css=button:has-text("Go")').count, 1);
  assert.equal(agent.resolve('text="Go"').count, 1);
  assert.equal(agent.resolve('text=Go').count, 1);
  assert.equal(agent.resolve('css=button').count, 1);
  assert.equal(agent.resolve("css=button:has-text('Nope')").count, 0);
});

test('w7-s04: text= 既有的跳脫解開行為維持（與 :has-text 同一套 unescape）', () => {
  const { agent } = boot([mkEl('button', { children: [mkText('say "hi"')] })]);
  assert.equal(agent.resolve('text="say \\"hi\\""').count, 1);
});
