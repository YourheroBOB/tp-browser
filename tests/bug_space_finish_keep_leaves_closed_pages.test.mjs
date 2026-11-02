// space.finish({ keep }) 只留一部分時，未保留的分頁必須從 ledger 移除。
// 否則 syncSpaceTargets 會把已結束的佔位頁／已關閉 target 重開成空白頁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Store } from '../daemon/store.js';

const src = readFileSync(new URL('../daemon/ego-browserd.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  let i = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces: ${signature}`);
}

function loadDispatch(store, hub) {
  const sandbox = {
    store,
    hub,
    chromeReady: true,
    requireHub() { return hub; },
    resolveSpace() { throw new Error('unused'); },
    syncSpaceTargets: async () => {},
    waitSession: async () => {},
    downloadCall: async () => {},
    pageCall: async () => {},
    spaceView(id) {
      const sp = store.get(id);
      return { id: sp.id, pages: { ...sp.pages } };
    },
  };
  const code = `${extractFunction(src, 'async function dispatch(method, p)')}\ndispatch`;
  return vm.runInNewContext(code, sandbox);
}

test('space.finish keep 會把未保留分頁從 ledger 移除並關閉其 target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ego-finish-keep-'));
  const file = join(dir, 'spaces.json');
  try {
    const store = new Store(file);
    const sp = store.create({ name: 'keep-some' });
    store.addPage(sp.id, 'p2', 'target-2', 'agent');
    store.addPage(sp.id, 'p3', 'target-3', 'agent');
    sp.activeTargetId = 'target-2';
    store.persist();

    const closedTargets = [];
    const hub = {
      cdp: {
        async send(method, params) {
          closedTargets.push({ method, targetId: params.targetId });
          return {};
        },
      },
    };
    const dispatch = loadDispatch(store, hub);
    const result = await dispatch('space.finish', { id: sp.id, keep: ['p3'] });

    const live = store.get(sp.id);
    assert.ok(live);
    assert.deepEqual(Object.keys(live.pages), ['p3']);
    assert.equal(live.pages.p3.targetId, 'target-3');
    assert.equal(live.pages.p1, undefined);
    assert.equal(live.pages.p2, undefined);
    assert.equal(live.activeTargetId, null);

    const saved = new Store(file).get(sp.id);
    assert.ok(saved);
    assert.deepEqual(Object.keys(saved.pages), ['p3']);
    assert.equal(saved.pages.p3.targetId, 'target-3');
    assert.equal(saved.activeTargetId, null);

    // dispatch 在 vm 裡跑，回傳的陣列原型與測試情境不同，逐項比對字串。
    assert.equal(result.deleted, false);
    assert.equal(result.retained.length, 1);
    assert.equal(result.retained[0], 'p3');
    assert.equal(result.closed.length, 2);
    assert.equal(result.closed[0], 'p1');
    assert.equal(result.closed[1], 'p2');
    assert.equal(closedTargets.length, 1);
    assert.equal(closedTargets[0].method, 'Target.closeTarget');
    assert.equal(closedTargets[0].targetId, 'target-2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
