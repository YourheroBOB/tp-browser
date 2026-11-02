import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function loadPageCallContext() {
  const srcPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'tp-browserd.js');
  const src = readFileSync(srcPath, 'utf8');
  const start = src.indexOf('async function pageCall(p) {');
  const end = src.indexOf('async function downloadCall(p) {', start);
  if (start < 0 || end < 0) throw new Error('pageCall source markers not found');
  const context = vm.createContext({
    requireHub() { throw new Error('requireHub not stubbed'); },
    store: { get() { return null; } },
    EgoError: class EgoError extends Error {
      constructor(name, message) {
        super(message);
        this.name = name;
      }
    },
  });
  vm.runInContext(`${src.slice(start, end)}\nglobalThis.__pageCall = pageCall;\n`, context);
  if (typeof context.__pageCall !== 'function') throw new Error('pageCall was not loaded');
  return context;
}

const context = loadPageCallContext();

async function reload(ledgerUrl, liveUrl, opts) {
  const calls = [];
  const space = {
    id: 7,
    name: 'task',
    ownership: 'agent',
    state: 'active',
    activeTargetId: null,
    pages: {
      p1: { targetId: 'TGT', url: ledgerUrl, title: '', openedBy: 'agent' },
    },
  };
  context.requireHub = () => ({
    sessions: new Map([['TGT', { url: 'http://127.0.0.1/session-cache', sessionId: 'sid' }]]),
    async info(tid) {
      calls.push({ op: 'info', tid });
      return { url: liveUrl, title: 'Live' };
    },
    async goto(tid, url, options) {
      calls.push({ op: 'goto', tid, url, options });
      return { url };
    },
  });
  context.store = {
    get(id) { return id === 7 ? space : null; },
  };
  const result = await context.__pageCall({
    spaceId: 7,
    label: 'p1',
    method: 'reload',
    args: [opts],
  });
  return { calls, result };
}

test('page.reload navigates to h.info URL when the ledger url is empty', async () => {
  const opts = { waitUntil: 'load' };
  const { calls, result } = await reload('', 'http://127.0.0.1/kept', opts);
  const goto = calls.filter((c) => c.op === 'goto');
  assert.equal(goto.length, 1);
  assert.equal(goto[0].tid, 'TGT');
  assert.equal(goto[0].url, 'http://127.0.0.1/kept');
  assert.deepEqual(goto[0].options, opts);
  assert.equal(result.url, 'http://127.0.0.1/kept');
});

test('page.reload prefers the live h.info URL over a stale ledger url', async () => {
  const opts = { timeout: 5000 };
  const { calls } = await reload('http://127.0.0.1/stale', 'http://127.0.0.1/live', opts);
  const goto = calls.filter((c) => c.op === 'goto');
  assert.equal(goto.length, 1);
  assert.equal(goto[0].url, 'http://127.0.0.1/live');
  assert.deepEqual(goto[0].options, opts);
});
