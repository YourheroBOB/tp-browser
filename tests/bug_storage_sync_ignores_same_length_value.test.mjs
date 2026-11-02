import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const home = mkdtempSync(join(tmpdir(), 'tp-storage-sig-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { BrowserHub } = await import('../daemon/page-ops.js');

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function createMemoryStorage(entries) {
  const data = new Map(entries);
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
  };
}

function createCdp() {
  const sources = [];
  let onEvent = () => {};
  const cdp = {
    onEvent(fn) {
      onEvent = fn;
      return () => {};
    },
    send(method, params = {}) {
      const source = params.source || params.expression;
      if (typeof source === 'string' && source.includes('__tpLastStorageSig')) sources.push(source);
      if (method === 'Browser.getVersion') {
        return Promise.resolve({ userAgent: 'Mozilla/5.0 Chrome/120.0.0.0', product: 'Chrome/120.0.0.0' });
      }
      if (method === 'Storage.getCookies') return Promise.resolve({ cookies: [] });
      return Promise.resolve({});
    },
  };
  return { cdp, sources, emit: (event) => onEvent(event) };
}

test('same-length localStorage overwrite is still reported by the co-ride sync script', async () => {
  const { cdp, sources, emit } = createCdp();
  const hub = new BrowserHub(cdp, { downloadsDir: home, onPush() {}, daemonPort: 9772 });
  try {
    await emit({
      sessionId: null,
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'sid-1',
        targetInfo: {
          type: 'page',
          targetId: 'tid-1',
          url: 'https://example.test/app',
          title: 'Example',
        },
      },
    });
    const script = sources.find((source) => source.includes('function syncTpStorage'));
    assert.ok(script, 'attached page must receive the co-ride storage sync script');

    const actions = [];
    const localStorage = createMemoryStorage([['token', 'aaaa']]);
    const sessionStorage = createMemoryStorage([]);
    let tick = () => {};
    const sandbox = {
      document: {
        readyState: 'complete',
        body: {},
        title: 'Example',
        getElementById() { return { id: '__tp_coride_host' }; },
        addEventListener() {},
      },
      location: {
        protocol: 'https:',
        href: 'https://example.test/app',
        origin: 'https://example.test',
      },
      localStorage,
      sessionStorage,
      setTimeout() { return 0; },
      setInterval(fn) { tick = fn; return 1; },
    };
    sandbox.window = sandbox;
    sandbox.top = sandbox;
    sandbox.__tpCoRideAction = (raw) => { actions.push(JSON.parse(raw)); };
    vm.runInContext(script, vm.createContext(sandbox));

    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].ls, [['token', 'aaaa']]);

    tick();
    assert.equal(actions.length, 1);

    localStorage.setItem('token', 'bbbb');
    tick();
    assert.equal(actions.length, 2);
    assert.deepEqual(actions[1].ls, [['token', 'bbbb']]);
    assert.equal(actions[1].action, 'syncStorage');
    assert.equal(actions[1].origin, 'https://example.test');
  } finally {
    clearInterval(hub._sweepTimer);
  }
});
