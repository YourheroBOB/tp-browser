// Regression: page labels that exist only on the prototype (`__proto__`,
// `constructor`, `toString`, or an inherited `p2`) were treated as real pages.
// Assigning them polluted Object.prototype or vanished on persist. nextLabel
// also threw when `pages` was null or an array, and an unknown space threw
// instead of returning `p?`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-pages-'));
  return { dir, file: join(dir, 'ledger.json') };
}

test('bindPage and addPage reject reserved labels and do not touch the prototype or the file', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'guards' });
    const protoBefore = Object.getPrototypeOf(space.pages);
    const toStringBefore = Object.prototype.toString;
    const before = readFileSync(file, 'utf8');

    for (const label of ['__proto__', 'constructor', 'toString']) {
      assert.throws(() => store.bindPage(space.id, label, 'T-X'), /invalid page label/);
      assert.throws(() => store.addPage(space.id, label, 'T-X'), /invalid page label/);
    }

    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(Object.getPrototypeOf(space.pages), protoBefore);
    assert.equal(Object.prototype.toString, toStringBefore);
    assert.equal(space.pages.p1.targetId, null);

    store.addPage(space.id, 'p7', 'T-ok', 'agent');
    assert.equal(space.pages.p7.targetId, 'T-ok');
    assert.equal(new Store(file).get(space.id).pages.p7.targetId, 'T-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setPage and removePage ignore inherited page names and nextLabel will still issue them', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'inherited-pages' });
    const inheritedPage = { targetId: 'INHERITED', openedBy: 'agent', title: '', url: '' };
    space.pages = Object.assign(Object.create({ p2: inheritedPage }), {
      p1: { targetId: null, openedBy: 'agent', title: '', url: '' },
    });
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);

    store.setPage(space.id, 'p2', { url: 'http://127.0.0.1/local-only', title: 'nope' });
    assert.equal(inheritedPage.url, '');
    assert.equal(inheritedPage.title, '');
    assert.equal(inheritedPage.targetId, 'INHERITED');
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);

    store.setPage(space.id, '__proto__', { fmbRegressSentinel: true });
    assert.equal(Object.prototype.fmbRegressSentinel, undefined);

    store.removePage(space.id, 'p2');
    assert.equal(space.pages.p2, inheritedPage);

    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);
    assert.equal(space.pages.p2, inheritedPage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextLabel tolerates null or array pages and unknown spaces do not rewrite the ledger', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'pages-shape' });

    space.pages = null;
    assert.equal(store.nextLabel(space.id), 'p2');

    space.pages = ['not-a-page-map'];
    assert.equal(store.nextLabel(space.id), 'p3');

    const before = readFileSync(file, 'utf8');
    assert.equal(store.nextLabel(space.id + 100), 'p?');
    assert.equal(store.nextLabel('missing-space'), 'p?');
    assert.doesNotThrow(() => store.setPage(space.id + 100, 'p1', { title: 'x' }));
    assert.doesNotThrow(() => store.removePage(space.id + 100, 'p1'));
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
