// page.call reload must navigate to the live page URL.
// ego-browserd.js listens and writes its data dir on import, so this loads pageCall
// from that file and runs it with a fake hub (no browser, no network, no extra paths).
// Column-0 boot between pageCall and downloadCall (server.listen / attachChrome())
// never returns and keeps node --test alive; trim it before eval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'ego-browserd.js'), 'utf8');

class EgoError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

function loadPageCall() {
  const start = source.indexOf('async function pageCall(p) {');
  const end = source.indexOf('\nasync function downloadCall(p) {');
  assert.ok(start >= 0 && end > start, 'pageCall source missing');
  let fnSrc = source.slice(start, end);
  const boot = fnSrc.search(/\n[ \t]*(?:await\s+|void\s+)?attachChrome\s*\(\s*\)\s*;|\n[ \t]*server\.listen\s*\(/);
  if (boot >= 0) fnSrc = fnSrc.slice(0, boot);
  assert.match(fnSrc, /case 'reload':/);
  assert.match(fnSrc, /h\.info\s*\(\s*tid\s*\)/);
  return new Function('requireHub', 'store', 'EgoError', `${fnSrc}\nreturn pageCall;\n`)(
    () => hub,
    store,
    EgoError,
  );
}

const LIVE_URL = 'http://127.0.0.1:8765/fixture';
const seen = [];
const sessions = new Map([
  ['TGT1', {
    url: LIVE_URL,
    title: 'fixture',
    sessionId: 'sid-1',
    loaded: true,
    readyState: 'complete',
    lifecycle: 'load',
  }],
]);
const hub = {
  sessions,
  async info(tid) {
    assert.equal(tid, 'TGT1');
    return { url: LIVE_URL, title: 'fixture' };
  },
  async goto(tid, url, opts) {
    seen.push({ tid, url, opts });
    const st = sessions.get(tid);
    if (st) st.url = url;
    return { url };
  },
};
const store = {
  get(id) {
    assert.equal(id, 1);
    return {
      id: 1,
      name: 'task',
      ownership: 'agent',
      state: 'active',
      activeTargetId: null,
      // addPage/bindPage initialize url to '' and the daemon never writes it back.
      pages: {
        p1: { targetId: 'TGT1', url: '', title: '', openedBy: 'agent' },
      },
    };
  },
};

test('page.reload goto uses h.info URL when the ledger url is still empty', async () => {
  const pageCall = loadPageCall();
  const result = await pageCall({
    spaceId: 1,
    label: 'p1',
    method: 'reload',
    args: [{ waitUntil: 'load' }],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tid, 'TGT1');
  assert.equal(seen[0].url, LIVE_URL);
  assert.deepEqual(seen[0].opts, { waitUntil: 'load' });
  assert.deepEqual(result, { url: LIVE_URL });
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  for (const handle of handles) {
    if (handle && handle.constructor && handle.constructor.name === 'Server') {
      try { handle.close(); } catch { /* ignore */ }
    }
  }
});
