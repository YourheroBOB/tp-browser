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

function anchor({ attr, href, text }) {
  return {
    tagName: 'A',
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

function resolveQuiet(agent, sel) {
  try {
    return { crashed: false, res: agent.resolve(sel) };
  } catch {
    return { crashed: true, res: null };
  }
}

test('loc=href still resolves an HTML link when an SVG anchor is on the page', () => {
  const svg = anchor({
    attr: '/icon.svg',
    href: { baseVal: '/icon.svg', animVal: '/icon.svg' },
    text: 'Icon',
  });
  const html = anchor({
    attr: '/docs',
    href: 'https://example.com/docs',
    text: 'Docs',
  });
  const agent = install([svg, html]);
  const out = resolveQuiet(agent, 'loc=href:https://example.com/docs');
  assert.equal(out.crashed, false);
  assert.equal(out.res.error, null);
  assert.equal(out.res.count, 1);
  assert.equal(out.res.d.href, 'https://example.com/docs');
  assert.equal(out.res.d.text, 'Docs');
});

test('loc=href matches an SVG anchor through its href attribute', () => {
  const svg = anchor({
    attr: '/icon.svg',
    href: { baseVal: '/icon.svg', animVal: '/icon.svg' },
    text: 'Icon',
  });
  const agent = install([svg]);
  const out = resolveQuiet(agent, 'loc=href:/icon.svg');
  assert.equal(out.crashed, false);
  assert.equal(out.res.error, null);
  assert.equal(out.res.count, 1);
  assert.equal(out.res.d.tag, 'a');
  assert.equal(out.res.d.text, 'Icon');
});
