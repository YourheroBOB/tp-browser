import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const agentSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../daemon/inpage.agent.js'),
  'utf8',
);

function anchor({ tagName = 'A', attr, href, text }) {
  return {
    tagName,
    id: '',
    textContent: text,
    href,
    title: '',
    placeholder: '',
    alt: '',
    disabled: false,
    getAttribute(name) {
      if (name === 'href') return attr;
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
    },
  };
}

function install(anchors) {
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    getComputedStyle() {
      return { visibility: 'visible', display: 'block', opacity: '1' };
    },
  };
  const document = {
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    querySelectorAll(sel) {
      if (sel === 'a[href]') return anchors.slice();
      return [];
    },
    querySelector() { return null; },
    getElementById() { return null; },
  };
  window.document = document;
  const context = createContext({ window, document });
  runInContext(agentSrc, context);
  return window.__egoAgent;
}

test('describe() returns a string href for an SVG anchor (not SVGAnimatedString)', () => {
  const svg = anchor({
    tagName: 'a',
    attr: '/icon.svg',
    href: { baseVal: '/icon.svg', animVal: '/icon.svg' },
    text: 'Icon',
  });
  const agent = install([svg]);
  const out = agent.resolve('loc=href:/icon.svg');
  assert.equal(out.error, null);
  assert.equal(out.count, 1);
  assert.equal(typeof out.d.href, 'string');
  assert.equal(out.d.href, '/icon.svg');
  // Must survive JSON serialization as a plain string (CDP boundary).
  const roundTrip = JSON.parse(JSON.stringify(out.d));
  assert.equal(roundTrip.href, '/icon.svg');
});

test('describe() still returns the absolute URL string for an HTML anchor', () => {
  const html = anchor({
    attr: '/docs',
    href: 'https://example.com/docs',
    text: 'Docs',
  });
  const agent = install([html]);
  const out = agent.resolve('loc=href:https://example.com/docs');
  assert.equal(out.error, null);
  assert.equal(out.count, 1);
  assert.equal(out.d.href, 'https://example.com/docs');
});

test('describe() returns null href for a non-link element', () => {
  const agent = install([]);
  const btn = {
    tagName: 'BUTTON',
    id: '',
    textContent: 'Go',
    title: '',
    placeholder: '',
    alt: '',
    disabled: false,
    getAttribute() { return null; },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20 };
    },
  };
  assert.equal(agent.describe(btn).href, null);
});
