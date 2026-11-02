import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Load the real daemon functions without importing the module: import would
// mkdir under the home directory, bind a port, and poll Chromium.
function loadBroadcastPush(store, sseClients, hub) {
  const src = readFileSync(new URL('../daemon/tp-browserd.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const findTargetOwnerSrc = sliceFn(src, 'function findTargetOwner(targetId) {', '\nfunction resolveSpace(');
  const broadcastPushSrc = sliceFn(src, 'function broadcastPush(targetId, kind, payload) {', '\nconst NEWTAB_HTML');
  const body = [findTargetOwnerSrc, broadcastPushSrc, 'return broadcastPush;'].join('\n');
  return new Function('store', 'sseClients', 'hub', body)(store, sseClients, hub);
}

function sliceFn(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing ${endMarker}`);
  return src.slice(start, end);
}

function harness(targetId) {
  const space = {
    id: 1,
    name: 'research',
    ownership: 'agent',
    state: 'active',
    pages: { p1: { targetId, openedBy: 'agent', title: '', url: '' } },
  };
  const persisted = [];
  const writes = [];
  const store = {
    list() { return [space]; },
    persist() { persisted.push(1); },
  };
  const sseClients = new Set([{ write(line) { writes.push(line); } }]);
  const broadcastPush = loadBroadcastPush(store, sseClients, null);
  return { space, persisted, writes, broadcastPush };
}

function push(broadcastPush, targetId, mode) {
  try {
    broadcastPush(targetId, 'coride', { mode });
  } catch {
    // Handoff write and the SSE frame both sit after the target lookup.
  }
}

test('coride human mode records the user handoff and still pushes SSE', () => {
  const { space, persisted, writes, broadcastPush } = harness('TID-1');
  push(broadcastPush, 'TID-1', 'human');
  assert.equal(space.ownership, 'user');
  assert.equal(space.state, 'handed-off');
  assert.equal(persisted.length, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"targetId":"TID-1"/);
  assert.match(writes[0], /"mode":"human"/);
});

test('coride agent mode marks the owning space active again', () => {
  const { space, persisted, writes, broadcastPush } = harness('TID-9');
  space.ownership = 'user';
  space.state = 'handed-off';
  push(broadcastPush, 'TID-9', 'agent');
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(persisted.length, 1);
  assert.equal(writes.length, 1);
});

test('coride mode for an unknown target still pushes SSE and leaves other spaces unchanged', () => {
  const { space, persisted, writes, broadcastPush } = harness('TID-1');
  push(broadcastPush, 'TID-missing', 'human');
  assert.equal(writes.length, 1);
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(persisted.length, 0);
  assert.match(writes[0], /"targetId":"TID-missing"/);
});
