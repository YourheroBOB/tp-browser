// tests/muse1103_test_daemon_inpage_agent.test.mjs
//
// Focused unit tests for daemon/inpage.agent.js edge cases and error paths
// that nearby tests do not cover yet: ref selectors, role selectors (+name),
// invalid css/cssText/href inputs, resolve() handle stability, ensureVisible /
// focusEl / fileInfo / markForDom stale-handle paths, selectOptions pick forms,
// checkValue variants, roleOf INPUT types, accessName fallbacks,
// visibleInViewport gates, snap() invalid subtree root, and the reuse guard.
//
// The agent is a browser-side IIFE (never imported by Node); it is loaded from
// source with node:vm-style Function injection plus a minimal fake DOM.
// No network, no real browser, no sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);


// Objects created inside the vm realm carry that realm's prototypes, so
// strict deepEqual (which checks prototypes) cannot compare them with host
// literals. Comparing their JSON projections is deterministic and exact.
function assertPlainEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (msg === undefined) assert.equal(a, e);
  else assert.equal(a, e, msg);
}

const RECT = { left: 10, top: 20, right: 110, bottom: 44, width: 100, height: 24 };
const HIDDEN_RECT = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

function makeEnv({ querySelectorAll = () => [], querySelector = () => null } = {}) {
  const document = {
    title: 'fixture',
    activeElement: null,
    documentElement: { clientWidth: 1280, clientHeight: 800, scrollWidth: 1280, scrollHeight: 2000 },
    getElementById: () => null,
    querySelector,
    querySelectorAll,
    evaluate: () => { throw new SyntaxError('not a valid XPath expression'); },
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
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
  const location = { href: 'http://127.0.0.1/fixture' };
  // vm.runInContext returns the script completion value, i.e. the IIFE's own
  // 'installed' / 'reuse' string; new Function would swallow it (undefined).
  const context = vm.createContext({
    window,
    document,
    location,
    CSS,
    XPathResult,
    Event: FakeEvent,
  });
  const status = vm.runInContext(SOURCE, context, { filename: 'daemon/inpage.agent.js' });
  assert.equal(status, 'installed');
  context.window.document = context.document;
  return {
    window: context.window,
    document: context.document,
    agent: context.window.__egoAgent,
    reinstall: () => vm.runInContext(SOURCE, context, { filename: 'daemon/inpage.agent.js' }),
  };
}

function makeEl(document, spec = {}) {
  const attrs = { ...(spec.attrs || {}) };
  const el = {
    nodeType: 1,
    tagName: spec.tagName || 'DIV',
    id: spec.id || '',
    type: spec.type,
    value: spec.value,
    placeholder: spec.placeholder || '',
    title: spec.title || '',
    alt: spec.alt || '',
    control: spec.control || null,
    disabled: !!spec.disabled,
    textContent: spec.text !== undefined ? spec.text : '',
    childNodes: spec.childNodes || [],
    isContentEditable: !!spec.contentEditable,
    href: spec.href,
    options: spec.options || [],
    multiple: !!spec.multiple,
    accept: spec.accept || '',
    selected: false,
    events: [],
    queried: spec.queried || null,
    focus() { document.activeElement = el; },
    select() { el.selected = true; },
    scrollIntoView() {},
    setAttribute(name, v) { attrs[name] = String(v); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getBoundingClientRect() { return { ...(spec.rect || RECT) }; },
    querySelector(sel) { return el.queried && el.queried[sel] !== undefined ? el.queried[sel] : null; },
    dispatchEvent(ev) { el.events.push(ev.type); return true; },
  };
  return el;
}

const textNode = (text) => ({ nodeType: 3, textContent: text });

// --- ref selectors ---------------------------------------------------------

test('ref selectors: unknown ref resolves to count=0/error=null, known ref is stable', () => {
  const btn = makeEl(null, { tagName: 'BUTTON', text: 'Go' });
  const { agent, document } = makeEnv({
    querySelectorAll: (sel) => (sel === 'button' ? [btn] : []),
  });
  document.activeElement = null;

  const missing = agent.resolve('@99999');
  assert.equal(missing.count, 0);
  assert.equal(missing.hid, null);
  assert.equal(missing.error, null);

  const alsoMissing = agent.resolve('ref=99999');
  assert.equal(alsoMissing.count, 0);
  assert.equal(alsoMissing.hid, null);

  const first = agent.resolve('css=button');
  assert.equal(first.count, 1);
  assert.equal(first.error, null);
  const ref = first.d.ref;
  assert.ok(ref > 0);

  // @<ref> and ref=<ref> point at the same element with a stable handle.
  const viaAt = agent.resolve(`@${ref}`);
  const viaRef = agent.resolve(`ref=${ref}`);
  assert.equal(viaAt.count, 1);
  assert.equal(viaRef.count, 1);
  assert.equal(viaAt.hid, first.hid);
  assert.equal(viaRef.hid, first.hid);

  // describe() twice yields the same ref number (WeakMap-backed).
  assert.equal(agent.describe(btn).ref, ref);
  assert.equal(agent.describe(btn).ref, agent.describe(btn).ref);
});

// --- role selectors --------------------------------------------------------

test('loc=role: malformed shape reports invalid selector without throwing', () => {
  const { agent } = makeEnv();
  for (const sel of ['loc=role:', 'loc=role:button[']) {
    let res;
    assert.doesNotThrow(() => { res = agent.resolve(sel); }, sel);
    assert.equal(res.count, 0, sel);
    assert.equal(res.hid, null, sel);
    assert.equal(res.error, 'invalid selector', sel);
  }
  // A garbage name filter still parses as a role query, so it behaves like a
  // valid role with no matching name: zero matches and no handle (error null).
  let res;
  assert.doesNotThrow(() => { res = agent.resolve('loc=role:button[!]'); });
  assert.equal(res.count, 0);
  assert.equal(res.hid, null);
  assert.equal(res.error, null);
});

test('loc=role: matches role with exact name and case-insensitive contains', () => {
  const save = makeEl(null, { tagName: 'BUTTON', text: 'Save changes' });
  const cancel = makeEl(null, { tagName: 'BUTTON', text: 'Cancel' });
  const { agent } = makeEnv({ querySelectorAll: () => [save, cancel] });

  const exact = agent.resolve('loc=role:button[name="Save changes"]');
  assert.equal(exact.count, 1);
  assert.equal(exact.error, null);
  assert.equal(exact.d.text, 'Save changes');

  const contains = agent.resolve('loc=role:button[name*="save"]');
  assert.equal(contains.count, 1);
  assert.equal(contains.error, null);

  const noMatch = agent.resolve('loc=role:button[name="Nope"]');
  assert.equal(noMatch.count, 0);
  assert.equal(noMatch.hid, null);
  assert.equal(noMatch.error, null);
});

// --- invalid css / cssText / href inputs ------------------------------------

test('invalid css selector reports invalid selector without throwing', () => {
  const { agent, document } = makeEnv();
  document.querySelectorAll = () => { throw new SyntaxError('not a valid selector'); };
  let res;
  assert.doesNotThrow(() => { res = agent.resolve('css=div[[['); });
  assert.equal(res.count, 0);
  assert.equal(res.hid, null);
  assert.equal(res.error, 'invalid selector');
});

test('malformed :has-text() reports invalid selector without throwing', () => {
  const { agent } = makeEnv();
  let res;
  assert.doesNotThrow(() => { res = agent.resolve('css=div:has-text(unquoted)'); });
  assert.equal(res.count, 0);
  assert.equal(res.hid, null);
  assert.equal(res.error, 'invalid selector');
});

test('blank loc=href: reports invalid selector without matching the page', () => {
  const link = makeEl(null, { tagName: 'A', text: 'Home', href: 'https://example.com/' });
  link.getAttribute = (n) => (n === 'href' ? '/' : null);
  const { agent } = makeEnv({ querySelectorAll: (sel) => (sel === 'a[href]' ? [link] : []) });
  for (const sel of ['loc=href:', 'loc=href:   ']) {
    const res = agent.resolve(sel);
    assert.equal(res.count, 0, sel);
    assert.equal(res.hid, null, sel);
    assert.equal(res.error, 'invalid selector', sel);
  }
});

// --- resolve() handle semantics ---------------------------------------------

test('resolve(): multiple matches return count without a handle', () => {
  const a = makeEl(null, { tagName: 'BUTTON', text: 'Dup' });
  const b = makeEl(null, { tagName: 'BUTTON', text: 'Dup' });
  const { agent } = makeEnv({ querySelectorAll: (sel) => (sel === 'button' ? [a, b] : []) });
  const res = agent.resolve('css=button');
  assert.equal(res.count, 2);
  assert.equal(res.hid, null);
  assert.equal(res.error, null);
});

test('resolve(): same element reuses one handle id across selectors', () => {
  const btn = makeEl(null, { tagName: 'BUTTON', text: 'Solo' });
  btn.childNodes = [textNode('Solo')];
  const { agent } = makeEnv({
    querySelectorAll: (sel) => {
      if (sel === 'button') return [btn];
      if (typeof sel === 'string' && sel.includes('button')) return [btn];
      return [btn];
    },
  });
  const viaCss = agent.resolve('css=button');
  const viaText = agent.resolve('text=Solo');
  assert.equal(viaCss.count, 1);
  assert.equal(viaText.count, 1);
  assert.equal(viaCss.hid, viaText.hid);
});

test('resolve(): requireVisible=false can resolve a hidden element', () => {
  const hidden = makeEl(null, { tagName: 'DIV', text: 'behind', rect: HIDDEN_RECT });
  const { agent } = makeEnv({ querySelectorAll: () => [hidden] });
  const strict = agent.resolve('css=div');
  assert.equal(strict.count, 0);
  assert.equal(strict.hid, null);
  const lax = agent.resolve('css=div', { requireVisible: false });
  assert.equal(lax.count, 1);
  assert.equal(lax.error, null);
  assert.ok(lax.hid);
});

// --- ensureVisible / focusEl / markForDom / fileInfo -------------------------

test('ensureVisible(): stale handle yields zeros; throwing scrollIntoView still returns rect', () => {
  const { agent, document } = makeEnv();
  assertPlainEqual(agent.ensureVisible(424242), { cx: 0, cy: 0, x: 0, y: 0, w: 0, h: 0 });

  const btn = makeEl(document, { tagName: 'BUTTON', text: 'Hi' });
  btn.scrollIntoView = () => { throw new Error('no scroll in stub'); };
  const { agent: a2 } = makeEnv({ querySelectorAll: () => [btn] });
  const r = a2.resolve('css=button');
  const pos = a2.ensureVisible(r.hid);
  assert.equal(pos.w, RECT.width);
  assert.equal(pos.h, RECT.height);
  assert.equal(pos.cx, RECT.left + RECT.width / 2);
  assert.equal(pos.cy, RECT.top + RECT.height / 2);
});

test('focusEl(): stale handle and throwing focus() both report ok:false', () => {
  const { agent, document } = makeEnv();
  assertPlainEqual(agent.focusEl(777777), { ok: false });

  // The element must belong to the same env: focusEl() verifies
  // document.activeElement of the agent's own document.
  const els = [];
  const { agent: a2, document: d2 } = makeEnv({ querySelectorAll: () => els });
  const btn = makeEl(d2, { tagName: 'BUTTON', text: 'Hi' });
  els.push(btn);
  const r = a2.resolve('css=button');
  assertPlainEqual(a2.focusEl(r.hid), { ok: true });

  btn.focus = () => { throw new Error('cannot focus'); };
  assertPlainEqual(a2.focusEl(r.hid), { ok: false });
});

test('markForDom(): stale handle returns null; live handle tags the element', () => {
  const { agent, document } = makeEnv();
  assert.equal(agent.markForDom(31337), null);

  const btn = makeEl(document, { tagName: 'BUTTON', text: 'Hi' });
  const { agent: a2 } = makeEnv({ querySelectorAll: () => [btn] });
  const r = a2.resolve('css=button');
  const mark = a2.markForDom(r.hid);
  assert.ok(typeof mark === 'string' && mark.length > 0);
  assert.equal(btn.getAttribute('data-ego-dom'), mark);
});

test('fileInfo(): stale / non-file report null; file input reports multiple+accept', () => {
  const { agent, document } = makeEnv();
  assert.equal(agent.fileInfo(999001), null);

  const btn = makeEl(document, { tagName: 'BUTTON', text: 'Hi' });
  const { agent: a2 } = makeEnv({ querySelectorAll: () => [btn] });
  const rb = a2.resolve('css=button');
  assert.equal(a2.fileInfo(rb.hid), null);

  const file = makeEl(document, { tagName: 'INPUT', type: 'file' });
  file.multiple = true;
  file.accept = 'image/*';
  const { agent: a3 } = makeEnv({ querySelectorAll: () => [file] });
  const rf = a3.resolve('css=input');
  assert.equal(rf.count, 1);
  assertPlainEqual(a3.fileInfo(rf.hid), { multiple: true, accept: 'image/*' });

  // Container wrapping a nested file input is found via querySelector.
  const nested = makeEl(document, { tagName: 'INPUT', type: 'file' });
  const wrap = makeEl(document, { tagName: 'DIV', queried: { 'input[type=file]': nested } });
  const { agent: a4 } = makeEnv({ querySelectorAll: () => [wrap] });
  const rw = a4.resolve('css=div');
  assertPlainEqual(a4.fileInfo(rw.hid), { multiple: false, accept: '' });
});

// --- selectOptions pick forms -----------------------------------------------

function selectEnv({ multiple = false } = {}) {
  const { agent, document } = makeEnv();
  const mkOpt = (value, label) => ({
    value,
    textContent: label,
    selected: false,
  });
  const sel = makeEl(document, { tagName: 'SELECT', text: '' });
  sel.multiple = multiple;
  sel.value = '';
  sel.options = [mkOpt('tpe', '台北'), mkOpt('khh', '高雄')];
  sel.querySelectorAll = () => [];
  const { agent: a } = makeEnv({ querySelectorAll: () => [sel] });
  void agent;
  const r = a.resolve('css=select');
  assert.equal(r.count, 1);
  return { agent: a, sel, hid: r.hid };
}

test('selectOptions(): non-select and stale handles fail loudly', () => {
  const { agent: a, hid } = selectEnv();
  void hid;
  assertPlainEqual(a.selectOptions(987654, ['tpe']), { ok: false, error: 'not a select' });

  const { agent: b, document } = makeEnv();
  const btn = makeEl(document, { tagName: 'BUTTON', text: 'Hi' });
  const { agent: c } = makeEnv({ querySelectorAll: () => [btn] });
  void b;
  const rb = c.resolve('css=button');
  assertPlainEqual(c.selectOptions(rb.hid, ['tpe']), { ok: false, error: 'not a select' });
});

test('selectOptions(): index, {value}, {label} picks work; bad pick names itself', () => {
  const { agent, sel, hid } = selectEnv();
  const byIndex = agent.selectOptions(hid, [1]);
  assertPlainEqual(byIndex, { ok: true, selected: ['khh'] });
  assert.equal(sel.value, 'khh');

  const byValue = agent.selectOptions(hid, [{ value: 'tpe' }]);
  assertPlainEqual(byValue, { ok: true, selected: ['tpe'] });

  const byLabel = agent.selectOptions(hid, [{ label: '高雄' }]);
  assertPlainEqual(byLabel, { ok: true, selected: ['khh'] });
  assertPlainEqual(sel.events.slice(-2), ['input', 'change']);

  const badIndex = agent.selectOptions(hid, [7]);
  assert.equal(badIndex.ok, false);
  assert.match(badIndex.error, /index 7/);

  const badObj = agent.selectOptions(hid, [{ value: 'nowhere' }]);
  assert.equal(badObj.ok, false);
  assert.match(badObj.error, /nowhere/);

  const badBare = agent.selectOptions(hid, [{}]);
  assert.equal(badBare.ok, false);
  assert.match(badBare.error, /no option matches/);
});

test('selectOptions(): multi-select applies every pick together', () => {
  const { agent, sel, hid } = selectEnv({ multiple: true });
  const res = agent.selectOptions(hid, ['tpe', 'khh']);
  assertPlainEqual(res, { ok: true, selected: ['tpe', 'khh'] });
  assertPlainEqual(sel.options.map((o) => o.selected), [true, true]);
});

// --- checkValue / fillValue ---------------------------------------------------

test('checkValue(): stale handle is false; contentEditable compares normalized text', () => {
  const { agent } = makeEnv();
  assert.equal(agent.checkValue(555555, 'x'), false);

  const { agent: a2, document } = makeEnv();
  const ed = makeEl(document, { tagName: 'DIV', text: '  hello   world ', contentEditable: true });
  const { agent: a3 } = makeEnv({ querySelectorAll: () => [ed] });
  void a2;
  const r = a3.resolve('css=div');
  assert.equal(a3.checkValue(r.hid, 'hello world'), true);
  assert.equal(a3.checkValue(r.hid, 'other'), false);
});

test('checkValue(): plain input compares stringified values; label delegates to control', () => {
  const { document } = makeEnv();
  const input = makeEl(document, { tagName: 'INPUT', type: 'text', value: 42 });
  const label = makeEl(document, { tagName: 'LABEL', text: 'Age', control: input });
  const { agent } = makeEnv({ querySelectorAll: () => [label] });
  const r = agent.resolve('css=label');
  assert.equal(r.count, 1);
  assert.equal(agent.checkValue(r.hid, '42'), true);
  assert.equal(agent.checkValue(r.hid, '43'), false);
});

test('fillValue(): contentEditable reports editable:true; stale handle is stale', () => {
  const { agent } = makeEnv();
  assertPlainEqual(agent.fillValue(123456, 'v'), { ok: false, error: 'stale handle' });

  const { document } = makeEnv();
  const ed = makeEl(document, { tagName: 'DIV', text: 'old', contentEditable: true });
  const { agent: a2 } = makeEnv({ querySelectorAll: () => [ed] });
  const r = a2.resolve('css=div');
  assertPlainEqual(a2.fillValue(r.hid, 'new'), { ok: true, editable: true });
  assert.equal(document.activeElement, ed);
});

// --- roleOf / describe / accessName / visibility ------------------------------

test('roleOf via describe(): INPUT types map to checkbox/radio/searchbox/button/textbox', () => {
  const cases = [
    [{ type: 'checkbox' }, 'checkbox'],
    [{ type: 'radio' }, 'radio'],
    [{ type: 'search' }, 'searchbox'],
    [{ type: 'submit' }, 'button'],
    [{ type: 'text' }, 'textbox'],
    [{}, 'textbox'],
  ];
  for (const [extra, want] of cases) {
    const { agent } = makeEnv();
    const input = makeEl(null, { tagName: 'INPUT', ...extra });
    assert.equal(agent.describe(input).role, want, JSON.stringify(extra));
  }
});

test('role attribute wins and only its first token is used', () => {
  const { agent } = makeEnv();
  const el = makeEl(null, { tagName: 'DIV', text: 'x', attrs: { role: 'button extra' } });
  assert.equal(agent.describe(el).role, 'button');
});

test('describe(): long text truncates to 160 chars plus ellipsis', () => {
  const { agent } = makeEnv();
  const el = makeEl(null, { tagName: 'P', text: 'z'.repeat(500) });
  const d = agent.describe(el);
  assert.equal(d.role, 'paragraph');
  assert.equal(d.text.length, 161);
  assert.ok(d.text.endsWith('…'));
});

test('accessName(): aria-label > labelledby > label[for] > value > placeholder > title > alt', () => {
  const { agent: a2 } = makeEnv({
    querySelectorAll: () => [],
    querySelector: (sel) => (sel === 'label[for="age"]' ? makeEl(null, { tagName: 'LABEL', text: 'Age label' }) : null),
  });
  assert.equal(typeof a2.accessName, 'function');

  const aria = makeEl(null, { tagName: 'BUTTON', text: 'inner', attrs: { 'aria-label': '  Spoken  name ' } });
  assert.equal(a2.accessName(aria), 'Spoken name');

  const by = makeEl(null, { tagName: 'INPUT', attrs: { 'aria-labelledby': 'fn' } });
  by.textContent = '';
  // swap getElementById on the fly is not possible on the closed sandbox, so
  // exercise the remaining fallbacks with plain elements instead.
  assert.equal(a2.accessName(by), '');

  const withLabel = makeEl(null, { tagName: 'INPUT', id: 'age', attrs: {} });
  withLabel.textContent = '';
  withLabel.value = '';
  assert.equal(a2.accessName(withLabel), 'Age label');

  const withValue = makeEl(null, { tagName: 'INPUT', value: 'typed' });
  withValue.textContent = '';
  assert.equal(a2.accessName(withValue), 'typed');

  const withPh = makeEl(null, { tagName: 'INPUT', placeholder: 'Search here' });
  withPh.textContent = '';
  withPh.value = '';
  assert.equal(a2.accessName(withPh), 'Search here');

  const withTitle = makeEl(null, { tagName: 'DIV', title: 'tip' });
  withTitle.textContent = '';
  assert.equal(a2.accessName(withTitle), 'tip');

  const withAlt = makeEl(null, { tagName: 'IMG', alt: 'photo' });
  withAlt.textContent = '';
  assert.equal(a2.accessName(withAlt), 'photo');

  const empty = makeEl(null, { tagName: 'DIV' });
  empty.textContent = '';
  assert.equal(a2.accessName(empty), '');
});

test('visibleInViewport(): zero area, display:none, opacity 0, and offscreen are hidden', () => {
  const { agent } = makeEnv();
  const zero = makeEl(null, { tagName: 'DIV', rect: HIDDEN_RECT });
  assert.equal(agent.visibleInViewport(zero), false);

  const { window } = makeEnv();
  void window;
  const env2 = makeEnv();
  env2.window.getComputedStyle = () => ({ visibility: 'visible', display: 'none', opacity: '1' });
  const disp = makeEl(null, { tagName: 'DIV' });
  assert.equal(env2.agent.visibleInViewport(disp), false);

  const env3 = makeEnv();
  env3.window.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '0' });
  assert.equal(env3.agent.visibleInViewport(makeEl(null, { tagName: 'DIV' })), false);

  const env4 = makeEnv();
  const off = makeEl(null, {
    tagName: 'DIV',
    rect: { left: 2000, top: 2000, right: 2100, bottom: 2050, width: 100, height: 50 },
  });
  assert.equal(env4.agent.visibleInViewport(off), false);

  assert.equal(env4.agent.visibleInViewport(makeEl(null, { tagName: 'DIV' })), true);
});

// --- snap() ------------------------------------------------------------------

test('snap(): invalid subtree root ref reports a marker line, not a crash', () => {
  const { agent } = makeEnv();
  let snap;
  assert.doesNotThrow(() => { snap = agent.snap({ scope: 'subtree', rootRef: 424242 }); });
  assertPlainEqual(snap.lines, ['(invalid subtree root ref)']);
  assert.equal(snap.title, 'fixture');
  assert.equal(snap.url, 'http://127.0.0.1/fixture');
});

test('snap(): subtree walks from the referenced root', () => {
  const inner = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: '',
    textContent: 'Inner',
    childNodes: [textNode('Inner')],
    title: '',
    placeholder: '',
    alt: '',
    disabled: false,
    href: undefined,
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...RECT }),
  };
  const root = {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    textContent: '',
    childNodes: [inner],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ ...RECT }),
  };
  const { agent } = makeEnv({ querySelectorAll: () => [root] });
  const r = agent.resolve('css=div', { requireVisible: false });
  assert.equal(r.count, 1);
  const snap = agent.snap({ scope: 'subtree', rootRef: r.d.ref });
  assert.ok(snap.lines[0].includes(`[ref=${r.d.ref}]`), snap.lines.join('\n'));
  assert.ok(snap.lines.some((l) => l.includes('button')), snap.lines.join('\n'));
});

// --- reuse guard ---------------------------------------------------------------

test('second install in the same page reuses the agent instead of resetting refs', () => {
  const btn = makeEl(null, { tagName: 'BUTTON', text: 'Go' });
  const { agent, reinstall } = makeEnv({ querySelectorAll: () => [btn] });
  const first = agent.resolve('css=button');
  assert.equal(reinstall(), 'reuse');
  assert.equal(agent.describe(btn).ref, first.d.ref);
});
