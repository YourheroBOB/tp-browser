import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// DOM: tagName is ASCII-uppercased only for the HTML namespace. An <svg> in an
// HTML document reports "svg", and the injected agent must still describe it
// as svg_root (snapshot + describe are the daemon's real call path).
function bootAgent(document) {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'inpage.agent.js'),
    'utf8',
  );
  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle() {
      return { visibility: 'visible', display: 'block', opacity: '1' };
    },
  };
  const context = vm.createContext({
    window,
    document,
    location: { href: 'http://127.0.0.1/svg-fixture' },
    CSS: { escape: (s) => String(s) },
  });
  vm.runInContext(source, context);
  return window.__egoAgent;
}

function el(tagName, children = []) {
  return {
    nodeType: 1,
    tagName,
    childNodes: children,
    textContent: '',
    id: '',
    getAttribute() { return null; },
    hasAttribute() { return false; },
    getBoundingClientRect() {
      return { left: 4, top: 4, width: 32, height: 32, right: 36, bottom: 36 };
    },
  };
}

test('HTML-document svg (lowercase tagName) is svg_root in describe and snapshot', () => {
  const svg = el('svg');
  const root = el('HTML', [svg]);
  const document = {
    title: 'fixture',
    documentElement: root,
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const agent = bootAgent(document);
  assert.equal(agent.describe(svg).role, 'svg_root');
  const snap = agent.snap();
  assert.ok(
    snap.lines.some((line) => /^\s*svg_root \[ref=\d+\]$/.test(line)),
    `expected svg_root in snapshot, got:\n${snap.lines.join('\n')}`,
  );
});
