// coride mode 推播必須更新空間 ownership/state，並把同一則事件寫給 SSE 客戶端。
// 直接 import daemon 會建立資料目錄並 listen，因此只抽出既有的 broadcastPush。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'ego-browserd.js');
const src = readFileSync(srcPath, 'utf8');
const start = src.indexOf('function broadcastPush');
const end = src.indexOf('const NEWTAB_HTML');
if (start < 0 || end < start) throw new Error('broadcastPush source slice not found');

function loadBroadcastPush(store, hub, sseClients) {
  const factory = new Function(
    'store',
    'hub',
    'sseClients',
    `${src.slice(start, end)}\nreturn broadcastPush;\n`,
  );
  return factory(store, hub, sseClients);
}

function harness(ownership = 'agent', stateName = 'active') {
  const space = {
    id: 1,
    name: 'task',
    ownership,
    state: stateName,
    pages: { p1: { targetId: 'TARGET-1', openedBy: 'agent', title: '', url: '' } },
    activeTargetId: 'TARGET-1',
  };
  const counters = { persists: 0 };
  const store = {
    list() { return [space]; },
    persist() { counters.persists += 1; },
  };
  const writes = [];
  const sseClients = new Set([
    { write(line) { writes.push(line); } },
  ]);
  return {
    space,
    counters,
    writes,
    broadcastPush: loadBroadcastPush(store, null, sseClients),
  };
}

function push(broadcastPush, targetId, payload) {
  try {
    broadcastPush(targetId, 'coride', payload);
  } catch {
    // 修正前會在寫入 ledger 與 SSE 之前丟錯；測試只斷言看得到的狀態。
  }
}

function pushEvent(line) {
  return JSON.parse(String(line).replace(/^data: /, '').trim());
}

test('coride mode=human 把對應空間改成 user/handed-off 並送出 SSE', () => {
  const { space, counters, writes, broadcastPush } = harness();
  push(broadcastPush, 'TARGET-1', { mode: 'human' });
  assert.equal(space.ownership, 'user');
  assert.equal(space.state, 'handed-off');
  assert.equal(counters.persists, 1);
  assert.equal(writes.length, 1);
  const evt = pushEvent(writes[0]);
  assert.equal(evt.type, 'push');
  assert.equal(evt.targetId, 'TARGET-1');
  assert.equal(evt.kind, 'coride');
  assert.deepEqual(evt.payload, { mode: 'human' });
});

test('coride mode=agent 還原空間；未知 target 不寫 ledger 但仍送出 SSE', () => {
  const { space, counters, writes, broadcastPush } = harness('user', 'handed-off');
  push(broadcastPush, 'TARGET-1', { mode: 'agent' });
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(counters.persists, 1);
  push(broadcastPush, 'TARGET-MISSING', { mode: 'human' });
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(counters.persists, 1);
  assert.equal(writes.length, 2);
  assert.equal(pushEvent(writes[0]).payload.mode, 'agent');
  assert.equal(pushEvent(writes[1]).targetId, 'TARGET-MISSING');
});
