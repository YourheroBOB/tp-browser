import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const daemonSrc = readFileSync(fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url)), 'utf8');

function sliceBetween(src, startMark, endMark) {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark, start + startMark.length);
  if (start < 0 || end < 0) throw new Error(`cannot slice ${startMark}`);
  return src.slice(start, end);
}

// vm.runInNewContext returns arrays from another realm. node:assert/strict
// deepEqual is deepStrictEqual and rejects those even when the elements match,
// so copy the result back through JSON before asserting.
function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}

// Run the real attachChrome/rebindSpaces from the daemon source against a fake
// CDP hub. No browser, no sockets: fetch/listen are not the functions under test.
async function runAttach(sessionEntries, spaces) {
  const attachSrc = sliceBetween(daemonSrc, 'async function attachChrome()', '\nasync function rebindSpaces()');
  const rebindSrc = sliceBetween(daemonSrc, 'async function rebindSpaces()', '\nfunction requireHub()');
  if (!attachSrc.includes('Target.closeTarget') || !rebindSrc.includes('hub.sessions.has')) {
    throw new Error('sliced the wrong daemon functions');
  }
  const code = [
    '(async () => {',
    'const closed = [];',
    'const navigated = [];',
    'const deleted = [];',
    `const spaceData = ${JSON.stringify(spaces)};`,
    `const sessionEntries = ${JSON.stringify(sessionEntries)};`,
    'let persisted = 0;',
    'let hub = null;',
    'let chromeReady = false;',
    'const PORT = 9772;',
    'const CHROME_DEBUG_PORT = 9773;',
    "const CHROME_VERSION_URL = 'http://127.0.0.1:9773/json/version';",
    "const DOWNLOADS_DIR = '/tmp/tp-browser-bug-downloads';",
    'function log() {}',
    'function broadcastPush() {}',
    'const AbortSignal = { timeout() { return {}; } };',
    'let fetches = 0;',
    'let timers = 0;',
    'async function fetch() {',
    '  fetches += 1;',
    "  if (fetches > 2) throw new Error('attach loop');",
    "  return { async json() { return { webSocketDebuggerUrl: 'ws://127.0.0.1:9773/devtools/browser/FAKE' }; } };",
    '}',
    'function setTimeout(fn) {',
    '  timers += 1;',
    "  if (timers > 8) throw new Error('timer storm');",
    '  fn();',
    '  return timers;',
    '}',
    'const store = {',
    '  list() { return spaceData; },',
    '  deleteSpace(id) {',
    '    deleted.push(id);',
    '    const i = spaceData.findIndex((s) => s.id === id);',
    '    if (i >= 0) spaceData.splice(i, 1);',
    '  },',
    '  persist() { persisted += 1; },',
    '};',
    'class Cdp { async connect() {} onClose() {} }',
    'class BrowserHub {',
    '  constructor() {',
    '    this.sessions = new Map(sessionEntries);',
    '    this.cdp = {',
    '      async send(method, params, opts) {',
    "        if (method === 'Target.closeTarget') closed.push(params.targetId);",
    "        if (method === 'Page.navigate') navigated.push(opts && opts.sessionId);",
    '      },',
    '    };',
    '  }',
    '  _ensureCoRideBar() {}',
    '}',
    rebindSrc,
    attachSrc,
    'await attachChrome();',
    'return { closed, navigated, deleted, spaces: spaceData, chromeReady };',
    '})()',
  ].join('\n');
  return fromVm(await vm.runInNewContext(code));
}

test('reattach closes only unbound about:blank tabs when a real tab exists', async () => {
  const result = await runAttach(
    [
      ['REAL', { url: 'https://example.test/inbox', sessionId: 's-real' }],
      ['BLANK', { url: 'about:blank', sessionId: 's-blank' }],
      ['EXTRA', { url: 'about:blank', sessionId: 's-extra' }],
    ],
    [{ id: 1, pages: { p1: { targetId: 'BLANK', openedBy: 'agent', title: '', url: '' } } }],
  );
  assert.equal(result.chromeReady, true);
  assert.deepEqual(result.closed, ['EXTRA']);
  assert.equal(result.spaces[0].pages.p1.targetId, 'BLANK');
  assert.deepEqual(result.deleted, []);
});

test('newtab fallback keeps bound blanks and navigates an unbound one', async () => {
  const result = await runAttach(
    [
      ['BLANK1', { url: 'about:blank', sessionId: 's-blank1' }],
      ['BLANK2', { url: 'about:blank', sessionId: 's-blank2' }],
      ['EXTRA', { url: 'about:blank', sessionId: 's-extra' }],
    ],
    [{
      id: 1,
      pages: {
        p1: { targetId: 'BLANK1', openedBy: 'agent', title: '', url: '' },
        p2: { targetId: 'BLANK2', openedBy: 'agent', title: '', url: '' },
      },
    }],
  );
  assert.equal(result.chromeReady, true);
  assert.deepEqual(result.navigated, ['s-extra']);
  assert.deepEqual(result.closed, []);
  assert.equal(result.spaces[0].pages.p1.targetId, 'BLANK1');
  assert.equal(result.spaces[0].pages.p2.targetId, 'BLANK2');
});
