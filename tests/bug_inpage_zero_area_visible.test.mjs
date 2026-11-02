import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const agentSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../daemon/inpage.agent.js'),
  'utf8',
);

function withAgent(scenario) {
  const context = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle() {
      return { visibility: 'visible', display: 'block', opacity: '1' };
    },
    document: {
      documentElement: { clientWidth: 800, clientHeight: 600 },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${agentSrc}\n${scenario}`, context);
  return context.hit;
}

test('collapsed in-viewport div is not resolved as visible', () => {
  const hit = withAgent(`
    document.querySelectorAll = () => [{
      tagName: 'DIV',
      nodeType: 1,
      childNodes: [],
      textContent: 'collapsed',
      getAttribute() { return null; },
      getBoundingClientRect() {
        return { left: 10, top: 20, right: 210, bottom: 20, width: 200, height: 0 };
      },
    }];
    globalThis.hit = window.__egoAgent.resolve('css=div');
  `);
  assert.equal(hit.count, 0);
  assert.equal(hit.hid, null);
});

test('zero-height duplicate does not block the visible button', () => {
  const hit = withAgent(`
    const collapsed = {
      tagName: 'BUTTON',
      nodeType: 1,
      childNodes: [{ nodeType: 3, textContent: 'Save' }],
      textContent: 'Save',
      getAttribute() { return null; },
      getBoundingClientRect() {
        return { left: 10, top: 20, right: 110, bottom: 20, width: 100, height: 0 };
      },
    };
    const shown = {
      tagName: 'BUTTON',
      nodeType: 1,
      childNodes: [{ nodeType: 3, textContent: 'Save' }],
      textContent: 'Save',
      getAttribute() { return null; },
      getBoundingClientRect() {
        return { left: 10, top: 48, right: 110, bottom: 78, width: 100, height: 30 };
      },
    };
    document.querySelectorAll = () => [collapsed, shown];
    globalThis.hit = window.__egoAgent.resolve('css=button');
  `);
  assert.equal(hit.count, 1);
  assert.equal(hit.d.h, 30);
  assert.equal(hit.d.visible, true);
});

test('positive-size element in the viewport still resolves', () => {
  const hit = withAgent(`
    document.querySelectorAll = () => [{
      tagName: 'BUTTON',
      nodeType: 1,
      childNodes: [{ nodeType: 3, textContent: 'OK' }],
      textContent: 'OK',
      getAttribute() { return null; },
      getBoundingClientRect() {
        return { left: 8, top: 12, right: 48, bottom: 36, width: 40, height: 24 };
      },
    }];
    globalThis.hit = window.__egoAgent.resolve('css=button');
  `);
  assert.equal(hit.count, 1);
  assert.equal(hit.d.text, 'OK');
  assert.equal(hit.d.visible, true);
});
