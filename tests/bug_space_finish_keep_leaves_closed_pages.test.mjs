import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

// dispatch 綁在 daemon 模組頂層；直接 import 會寫入 homedir、listen 並連線 CDP。
// 只編譯 dispatch 本體，且在測試同一個 realm 執行。
function loadDispatch(store, requireHub) {
  const src = readFileSync(new URL('../daemon/tp-browserd.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function dispatch(method, p) {');
  const end = src.indexOf('\n// A label is "taken"');
  if (start < 0 || end < start) throw new Error('dispatch source not found');
  class EgoError extends Error {
    constructor(name, message) {
      super(message);
      this.name = name;
    }
  }
  const load = new Function(
    'store',
    'requireHub',
    'EgoError',
    '"use strict";\n' + src.slice(start, end) + '\nreturn dispatch;\n',
  );
  return load(store, requireHub, EgoError);
}

function finishHarness(dir) {
  const ledger = join(dir, 'spaces.json');
  const store = new Store(ledger);
  const closedTargets = [];
  const hub = {
    cdp: {
      async send(method, params) {
        if (method === 'Target.closeTarget') closedTargets.push(params.targetId);
        return {};
      },
    },
  };
  return { ledger, store, closedTargets, dispatch: loadDispatch(store, () => hub) };
}

function savedSpace(ledger, id) {
  const data = JSON.parse(readFileSync(ledger, 'utf8'));
  return data.spaces[String(id)];
}

test('space.finish partial keep drops the closed page and clears a dangling active target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpb-space-finish-'));
  try {
    const { ledger, store, closedTargets, dispatch } = finishHarness(dir);
    const sp = store.create({ name: 'keep-one' });
    store.addPage(sp.id, 'p1', 'T-keep', 'agent');
    store.addPage(sp.id, 'p2', 'T-close', 'agent');
    sp.activeTargetId = 'T-close';
    store.persist();

    const result = await dispatch('space.finish', { id: sp.id, keep: ['p1'] });

    assert.equal(result.deleted, false);
    assert.equal(Array.from(result.retained).join(','), 'p1');
    assert.equal(Array.from(result.closed).join(','), 'p2');
    assert.equal(closedTargets.join(','), 'T-close');

    const space = savedSpace(ledger, sp.id);
    assert.ok(space);
    assert.equal(Object.keys(space.pages).join(','), 'p1');
    assert.equal(space.pages.p1.targetId, 'T-keep');
    assert.equal(space.activeTargetId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('space.finish partial keep leaves activeTargetId when the kept page is active', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpb-space-finish-active-'));
  try {
    const { ledger, store, closedTargets, dispatch } = finishHarness(dir);
    const sp = store.create({ name: 'keep-active' });
    store.addPage(sp.id, 'p1', 'T-keep', 'agent');
    store.addPage(sp.id, 'p2', 'T-close', 'agent');
    sp.activeTargetId = 'T-keep';
    store.persist();

    const result = await dispatch('space.finish', { id: sp.id, keep: ['p1'] });

    assert.equal(result.deleted, false);
    assert.equal(closedTargets.join(','), 'T-close');

    const space = savedSpace(ledger, sp.id);
    assert.ok(space);
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);
    assert.equal(space.pages.p1.targetId, 'T-keep');
    assert.equal(space.activeTargetId, 'T-keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
