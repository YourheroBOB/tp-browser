// rebindSpaces 會刪掉已不在 hub.sessions 的分頁，但沒有清 activeTargetId。
// 不 import daemon/ego-browserd.js：該模組一載入就會寫入家目錄、聽埠並 fetch CDP。
// 這裡只抽出既有的 rebindSpaces，用真實 Store（ledger 在 tmpdir）驅動。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../daemon/store.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'ego-browserd.js');

function loadRebindSpaces(store, hub) {
  const src = readFileSync(SRC, 'utf8');
  const start = src.indexOf('async function rebindSpaces()');
  const end = src.indexOf('\nfunction requireHub(', start);
  if (start < 0 || end < 0) throw new Error('rebindSpaces source not found');
  const factory = new Function('store', 'hub', `${src.slice(start, end)}\nreturn rebindSpaces;`);
  return factory(store, hub);
}

test('rebindSpaces clears activeTargetId when the active page is dropped and keeps it when that page is still live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ego-rebind-active-'));
  try {
    const staleFile = join(dir, 'stale.json');
    const staleStore = new Store(staleFile);
    const stale = staleStore.create({ name: 'stale-active' });
    staleStore.bindPage(stale.id, 'p1', 'DEAD', 'agent');
    staleStore.addPage(stale.id, 'p2', 'LIVE', 'agent');
    stale.activeTargetId = 'DEAD';
    staleStore.persist();

    const rebindStale = loadRebindSpaces(staleStore, {
      sessions: new Map([['LIVE', { url: 'https://example.test/', title: 'live' }]]),
    });
    await rebindStale();

    assert.equal(stale.activeTargetId, null);
    assert.equal(Object.hasOwn(stale.pages, 'p1'), false);
    assert.equal(stale.pages.p2.targetId, 'LIVE');
    const staleSaved = new Store(staleFile).get(stale.id);
    assert.ok(staleSaved);
    assert.equal(staleSaved.activeTargetId, null);
    assert.deepEqual(Object.keys(staleSaved.pages), ['p2']);
    assert.equal(staleSaved.pages.p2.targetId, 'LIVE');

    const liveFile = join(dir, 'live.json');
    const liveStore = new Store(liveFile);
    const live = liveStore.create({ name: 'live-active' });
    liveStore.bindPage(live.id, 'gone', 'DEAD', 'agent');
    liveStore.addPage(live.id, 'stay', 'LIVE', 'agent');
    live.activeTargetId = 'LIVE';
    liveStore.persist();

    const rebindLive = loadRebindSpaces(liveStore, {
      sessions: new Map([['LIVE', { url: 'https://example.test/', title: 'live' }]]),
    });
    await rebindLive();

    assert.equal(live.activeTargetId, 'LIVE');
    assert.equal(Object.hasOwn(live.pages, 'gone'), false);
    assert.equal(live.pages.stay.targetId, 'LIVE');
    const liveSaved = new Store(liveFile).get(live.id);
    assert.ok(liveSaved);
    assert.equal(liveSaved.activeTargetId, 'LIVE');
    assert.equal(liveSaved.pages.stay.targetId, 'LIVE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
