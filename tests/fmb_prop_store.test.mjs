// Property / invariant tests for daemon/store.js (TaskSpace ledger).
// Every filesystem write stays inside a mkdtemp() directory — no repo or $HOME writes,
// no network, no new dependencies (node:test + node:assert only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { Store } from '../daemon/store.js';

const LABEL_RE = /^p\d+$/;

function freshPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-prop-store-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return join(dir, 'state', 'spaces.json');
}

function quietConsoleError(t) {
  const orig = console.error;
  console.error = () => {};
  t.after(() => { console.error = orig; });
}

const labelNumber = (label) => Number(label.slice(1));

// Deterministic PRNG (no Math.random) so a failing seed reproduces exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('create: a new space has the documented default shape', (t) => {
  const store = new Store(freshPath(t));
  assert.deepEqual(store.data.spaces, {});
  assert.equal(store.data.nextSpaceId, 1);

  const s = store.create({ name: '研究流程' });
  assert.equal(s.id, 1);
  assert.equal(s.name, '研究流程');
  assert.equal(s.profileId, 'agent');
  assert.equal(s.ownership, 'agent');
  assert.equal(s.state, 'active');
  assert.equal(s.activeTargetId, null);
  assert.deepEqual(Object.keys(s.pages), ['p1']);
  assert.deepEqual(s.pages.p1, { targetId: null, openedBy: 'agent', title: '', url: '' });
  assert.equal(Number.isNaN(Date.parse(s.createdAt)), false);

  const s2 = store.create({ name: 'second', profileId: 'guest' });
  assert.equal(s2.profileId, 'guest');
  assert.ok(Date.parse(s2.createdAt) >= Date.parse(s.createdAt));
  assert.deepEqual(store.list().map((x) => x.id), [1, 2]);
});

test('create: space ids are unique and strictly increasing over many creations', (t) => {
  const store = new Store(freshPath(t));
  const ids = [];
  for (let i = 0; i < 25; i += 1) ids.push(store.create({ name: `s${i}` }).id);
  assert.equal(new Set(ids).size, ids.length);
  for (let i = 1; i < ids.length; i += 1) assert.ok(ids[i] > ids[i - 1], `ids not increasing at ${i}`);
  assert.deepEqual(store.list().map((x) => x.id), ids);
});

test('nextLabel: strictly increasing pN per space and never reuses an existing page label', (t) => {
  const store = new Store(freshPath(t));
  const a = store.create({ name: 'A' });
  const b = store.create({ name: 'B' });
  const seenA = new Set(Object.keys(a.pages));
  const seenB = new Set(Object.keys(b.pages));
  const labelsA = [];
  const labelsB = [];

  for (let i = 0; i < 6; i += 1) {
    const la = store.nextLabel(a.id);
    const lb = store.nextLabel(b.id);
    assert.match(la, LABEL_RE);
    assert.match(lb, LABEL_RE);
    assert.equal(seenA.has(la), false, `space A reused label ${la}`);
    assert.equal(seenB.has(lb), false, `space B reused label ${lb}`);
    seenA.add(la);
    seenB.add(lb);
    labelsA.push(la);
    labelsB.push(lb);
  }

  const numsA = labelsA.map(labelNumber);
  const numsB = labelsB.map(labelNumber);
  assert.deepEqual(numsA, [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(numsB, [2, 3, 4, 5, 6, 7]); // per-space sequences are independent
  for (let i = 1; i < numsA.length; i += 1) assert.ok(numsA[i] > numsA[i - 1]);
});

test('nextLabel: an unknown space yields "p?" and mutates nothing', (t) => {
  const store = new Store(freshPath(t));
  store.create({ name: 'only' });
  const before = JSON.stringify(store.data);
  assert.equal(store.nextLabel(999), 'p?');
  assert.equal(store.nextLabel(999), 'p?');
  assert.equal(JSON.stringify(store.data), before);
  assert.equal(store.get(999), null);
});

test('property: nextLabel never reuses a label after a daemon restart', (t) => {
  const file = freshPath(t);
  const first = new Store(file);
  const sp = first.create({ name: 'restart' });
  const used = new Set(Object.keys(sp.pages));
  for (let i = 0; i < 4; i += 1) used.add(first.nextLabel(sp.id));

  const second = new Store(file);
  for (let i = 0; i < 4; i += 1) {
    const label = second.nextLabel(sp.id);
    assert.match(label, LABEL_RE);
    assert.equal(used.has(label), false, `label ${label} reused after restart`);
    used.add(label);
  }
});

test('setPage: no-op for unknown space or label and never fabricates a page', (t) => {
  const store = new Store(freshPath(t));
  const sp = store.create({ name: 's' });
  const before = JSON.stringify(store.data);

  store.setPage(4242, 'p1', { url: 'https://example.invalid/' });
  assert.equal(JSON.stringify(store.data), before);

  store.setPage(sp.id, 'p9', { url: 'https://example.invalid/' });
  assert.equal(JSON.stringify(store.data), before);
  assert.equal('p9' in store.get(sp.id).pages, false);

  store.removePage(sp.id, 'p1');
  store.setPage(sp.id, 'p1', { url: 'https://example.invalid/' });
  assert.equal('p1' in store.get(sp.id).pages, false);
});

test('bindPage/addPage: identical page shape, unknown space rejected, removePage idempotent', (t) => {
  const store = new Store(freshPath(t));
  const sp = store.create({ name: 's' });

  store.bindPage(sp.id, 'p2', 'target-2', 'human');
  store.addPage(sp.id, 'p3', 'target-3');
  assert.deepEqual(store.get(sp.id).pages.p2, { targetId: 'target-2', openedBy: 'human', title: '', url: '' });
  assert.deepEqual(store.get(sp.id).pages.p3, { targetId: 'target-3', openedBy: 'agent', title: '', url: '' });

  assert.throws(() => store.bindPage(999, 'p1', 't'), /unknown space 999/);
  assert.throws(() => store.addPage(999, 'p1', 't'), /unknown space 999/);

  store.removePage(sp.id, 'p2');
  store.removePage(sp.id, 'p2'); // idempotent
  assert.equal('p2' in store.get(sp.id).pages, false);
  store.removePage(999, 'p1'); // unknown space: no throw
});

test('deleteSpace: removes, persists, is idempotent and never reuses ids', (t) => {
  const file = freshPath(t);
  const store = new Store(file);
  const a = store.create({ name: 'A' });
  const b = store.create({ name: 'B' });

  store.deleteSpace(a.id);
  store.deleteSpace(a.id);
  assert.equal(store.get(a.id), null);
  assert.deepEqual(store.list().map((s) => s.id), [b.id]);

  const reloaded = new Store(file);
  assert.deepEqual(reloaded.list().map((s) => s.id), [b.id]);
  const c = reloaded.create({ name: 'C' });
  assert.equal(c.id > b.id, true);
  assert.notEqual(c.id, a.id);
});

test('persist: atomic, byte-for-byte idempotent, no tmp leftovers', (t) => {
  const file = freshPath(t);
  const store = new Store(file);
  store.create({ name: 'A' });

  const dir = dirname(file);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

  const first = readFileSync(file, 'utf8');
  store.persist();
  const second = readFileSync(file, 'utf8');
  assert.equal(second, first);
  assert.doesNotThrow(() => JSON.parse(second));
  assert.deepEqual(Object.keys(JSON.parse(second)).sort(), ['labelSeq', 'nextSpaceId', 'spaces']);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('property: any op sequence survives a persist/reload roundtrip unchanged', (t) => {
  for (const seed of [1, 7, 12345]) {
    const file = freshPath(t);
    const store = new Store(file);
    const rnd = mulberry32(seed);
    const live = [];

    for (let step = 0; step < 40; step += 1) {
      const roll = rnd();
      if (roll < 0.2 || live.length === 0) {
        live.push(store.create({ name: `space-${step}` }).id);
      } else if (roll < 0.45) {
        store.nextLabel(live[Math.floor(rnd() * live.length)]);
      } else if (roll < 0.65) {
        store.setPage(live[0], 'p1', { url: `https://example.invalid/${step}`, title: `t${step}` });
      } else if (roll < 0.75) {
        store.addPage(live[0], `x${step}`, `target-${step}`);
      } else if (roll < 0.85) {
        store.removePage(live[0], `x${step - 1}`);
      } else if (roll < 0.95) {
        store.bindPage(live[0], 'p1', `target-p1-${step}`);
      } else {
        store.deleteSpace(live.shift());
      }
    }

    const inMemory = JSON.parse(JSON.stringify(store.data));
    const reloaded = new Store(file);
    assert.deepEqual(reloaded.data, inMemory, `seed ${seed}`);
    assert.equal(reloaded.list().length, Object.keys(inMemory.spaces).length, `seed ${seed}`);
    assert.equal(reloaded.data.nextSpaceId, inMemory.nextSpaceId, `seed ${seed}`);
  }
});

test('load: corrupt ledger falls back to fresh defaults without throwing', (t) => {
  quietConsoleError(t);
  const file = freshPath(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"spaces": {1: broken json', 'utf8');

  const store = new Store(file);
  assert.deepEqual(store.data, { nextSpaceId: 1, labelSeq: {}, spaces: {} });

  const sp = store.create({ name: 'recovered' });
  assert.equal(sp.id, 1);
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
});
