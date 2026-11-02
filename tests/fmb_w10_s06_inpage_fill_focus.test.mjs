// tests/fmb_w10_s06_inpage_fill_focus.test.mjs
// Regression for daemon/inpage.agent.js → fillValue():
// when the resolved handle points at a <label>, the agent redirects to `label.control`
// for every field operation except focus, which was applied to the label itself.
// Labels are not focusable, so focus stayed on <body> and the daemon's following
// CDP key events were delivered to the wrong element (text silently never arrived).
//
// The browser agent is loaded as TEXT into a throwaway vm context with a tiny DOM
// shim: zero network, zero filesystem writes, no real credentials or personal data
// (a fake form value is used only as the obvious placeholder "FAKE_VALUE_FOR_TEST").

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const AGENT_SRC = readFileSync(
  fileURLToPath(new URL('../daemon/inpage.agent.js', import.meta.url)),
  'utf8',
);

const ON_SCREEN = { left: 24, top: 32, width: 160, height: 28 };

function rectOf({ left, top, width, height }) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeNode(tagName, text, extra = {}) {
  const node = {
    nodeType: 1,
    tagName,
    textContent: text,
    childNodes: [{ nodeType: 3, textContent: text }],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => rectOf(ON_SCREEN),
    focus() {
      node.focused = true;
      node.focusCalls = (node.focusCalls || 0) + 1;
    },
    ...extra,
  };
  return node;
}

// `nodes` is what document.querySelectorAll() returns for every query, so each test
// passes exactly the element(s) its selector is expected to match.
function loadAgent(nodes) {
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  };
  const document = {
    title: 'fmb-w10-s06',
    documentElement: { clientWidth: 1280, clientHeight: 800, scrollWidth: 1280, scrollHeight: 800 },
    querySelectorAll: () => nodes,
    getElementById: () => null,
    querySelector: () => null,
  };
  window.document = document;
  vm.runInNewContext(AGENT_SRC, {
    window,
    document,
    location: { href: 'http://127.0.0.1:0/fmb-w10-s06' },
    CSS: { escape: (value) => String(value) },
  });
  assert.ok(window.__egoAgent, 'injected agent must expose window.__egoAgent');
  return window.__egoAgent;
}

test('fillValue on a <label> handle focuses the label control, not the label', () => {
  const input = makeNode('INPUT', '', { type: 'text', value: '' });
  const label = makeNode('LABEL', 'Name', { control: input });

  const agent = loadAgent([label]);
  const resolved = agent.resolve('css=label');
  assert.equal(resolved.count, 1);
  assert.equal(typeof resolved.hid, 'number');

  const out = agent.fillValue(resolved.hid, 'FAKE_VALUE_FOR_TEST');
  assert.equal(out.ok, true);
  assert.equal(out.editable, false);
  assert.equal(
    input.focused,
    true,
    'typing must land in the control, therefore the control has to receive focus',
  );
  assert.equal(label.focused, undefined, 'the label itself is not focusable and must not be focused');
  assert.equal(input.value, '');
});

test('fillValue on a plain <input> handle focuses itself and clears the value', () => {
  const input = makeNode('INPUT', '', { type: 'text', value: 'old' });
  const agent = loadAgent([input]);

  const resolved = agent.resolve('css=input');
  assert.equal(resolved.count, 1);

  const out = agent.fillValue(resolved.hid, 'FAKE_VALUE_FOR_TEST');
  assert.equal(out.ok, true);
  assert.equal(out.editable, false);
  assert.equal(input.focused, true);
  assert.equal(input.value, '');
});

test('fillValue clears a contenteditable target and reports it as editable', () => {
  const box = makeNode('DIV', 'old text', { isContentEditable: true });
  const agent = loadAgent([box]);

  const resolved = agent.resolve('css=div');
  assert.equal(resolved.count, 1);

  const out = agent.fillValue(resolved.hid, 'FAKE_VALUE_FOR_TEST');
  assert.equal(out.ok, true);
  assert.equal(out.editable, true);
  assert.equal(box.focused, true);
  assert.equal(box.textContent, '');
});

test('checkValue on a <label> handle reads the redirected control value', () => {
  const input = makeNode('INPUT', '', { type: 'text', value: 'FAKE_VALUE_FOR_TEST' });
  const label = makeNode('LABEL', 'Name', { control: input });
  const agent = loadAgent([label]);

  const resolved = agent.resolve('css=label');
  assert.equal(resolved.count, 1);
  assert.equal(agent.checkValue(resolved.hid, 'FAKE_VALUE_FOR_TEST'), true);
  assert.equal(agent.checkValue(resolved.hid, 'something-else'), false);
});
