// pageCall 的滑鼠座標：click 之後的 mouse.down 必須落在點擊點，
// mouse.move 的 steps 必須從該分頁上次座標內插，且不得沿用另一分頁的游標。
// 只抽出 pageCall 執行，不啟動 daemon、不連網、不寫 repo 以外的路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadPageCall(env) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'ego-browserd.js');
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('async function pageCall(');
  const end = src.indexOf('\nasync function downloadCall(');
  if (start < 0 || end < start) throw new Error('pageCall not found');
  const factory = new Function(
    'requireHub',
    'store',
    'EgoError',
    'dispatch',
    'safePath',
    'keyDescriptor',
    `${src.slice(start, end)}\nreturn pageCall;\n`,
  );
  return factory(
    () => env.hub,
    env.store,
    class EgoError extends Error {
      constructor(name, message) { super(message); this.name = name; }
    },
    async () => [],
    (p) => p,
    () => null,
  );
}

function harness() {
  const calls = [];
  const space = {
    id: 1,
    name: 'mouse-space',
    activeTargetId: null,
    pages: {
      p1: { targetId: 't1', openedBy: 'agent', title: '', url: 'https://example.test/a' },
      p2: { targetId: 't2', openedBy: 'agent', title: '', url: 'https://example.test/b' },
    },
  };
  const env = {
    hub: {
      sessions: new Map([['t1', { sessionId: 's1' }], ['t2', { sessionId: 's2' }]]),
      async mouseInput(tid, type, x, y, opts) { calls.push({ op: 'mouseInput', tid, type, x, y, opts }); },
      async rawMouse(tid, type, xy, opts) { calls.push({ op: 'rawMouse', tid, type, xy, opts }); },
    },
    store: { get() { return space; } },
  };
  return { calls, pageCall: loadPageCall(env) };
}

test('mouse.click 之後的 mouse.down 使用點擊座標，而不是 (0, 0)', async () => {
  const { calls, pageCall } = harness();
  await pageCall({ spaceId: 1, label: 'p1', method: 'mouse.click', args: [120, 80] });
  calls.length = 0;
  await pageCall({ spaceId: 1, label: 'p1', method: 'mouse.down', args: [] });
  assert.deepEqual(calls, [{ op: 'rawMouse', tid: 't1', type: 'down', xy: [120, 80], opts: {} }]);
});

test('mouse.move 的 steps 從該分頁上次座標內插，另一分頁的 mouse.down 保持自己的座標', async () => {
  const { calls, pageCall } = harness();
  await pageCall({ spaceId: 1, label: 'p1', method: 'mouse.move', args: [10, 20] });
  await pageCall({ spaceId: 1, label: 'p2', method: 'mouse.move', args: [300, 400] });
  calls.length = 0;
  await pageCall({ spaceId: 1, label: 'p1', method: 'mouse.move', args: [10, 120, { steps: 2 }] });
  assert.deepEqual(
    calls.filter((c) => c.op === 'mouseInput').map((c) => [c.tid, c.x, c.y]),
    [['t1', 10, 70], ['t1', 10, 120]],
  );
  calls.length = 0;
  await pageCall({ spaceId: 1, label: 'p2', method: 'mouse.down', args: [] });
  assert.deepEqual(calls, [{ op: 'rawMouse', tid: 't2', type: 'down', xy: [300, 400], opts: {} }]);
});
