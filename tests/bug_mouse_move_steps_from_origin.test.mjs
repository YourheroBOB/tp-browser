import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const daemonSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'tp-browserd.js'),
  'utf8',
);

function loadPageCall(sandbox) {
  const start = daemonSrc.indexOf('async function pageCall(');
  const end = daemonSrc.indexOf('\nasync function downloadCall(');
  if (start < 0 || end < start) throw new Error('pageCall() not found in daemon/tp-browserd.js');
  const pageCallSrc = daemonSrc.slice(start, end).trim();
  return vm.runInNewContext(`(${pageCallSrc})`, sandbox, { filename: 'tp-browserd-pageCall.js' });
}

test('mouse.move steps travel from the current cursor to the target', async () => {
  const moves = [];
  const sandbox = {
    hub: {
      sessions: {
        has(id) { return id === 'T1'; },
      },
      _pos: { x: 20, y: 80 },
      async mouseInput(tid, type, x, y) {
        moves.push({ tid, type, x, y });
      },
    },
    space: {
      id: 1,
      name: 'task',
      activeTargetId: null,
      pages: {
        p1: { targetId: 'T1', url: 'https://example.test/', title: 'Example', openedBy: 'agent' },
      },
    },
    EgoError: class EgoError extends Error {
      constructor(name, message) {
        super(message);
        this.name = name;
      }
    },
  };
  sandbox.requireHub = () => sandbox.hub;
  sandbox.store = { get() { return sandbox.space; } };

  const pageCall = loadPageCall(sandbox);
  await pageCall({
    spaceId: 1,
    label: 'p1',
    method: 'mouse.move',
    args: [100, 80, { steps: 2 }],
  });

  assert.deepEqual(moves, [
    { tid: 'T1', type: 'mouseMoved', x: 60, y: 80 },
    { tid: 'T1', type: 'mouseMoved', x: 100, y: 80 },
  ]);
  // h._pos is allocated inside the vm realm; compare the numeric fields.
  assert.equal(sandbox.hub._pos.x, 100);
  assert.equal(sandbox.hub._pos.y, 80);
});
