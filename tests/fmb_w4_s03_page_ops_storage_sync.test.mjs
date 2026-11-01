// tests/fmb_w4_s03_page_ops_storage_sync.test.mjs
// 針對 daemon/page-ops.js 的 _handleStorageSync（頁面 syncStorage → storageVault 回寫）的回歸測試。
// 只以 BrowserHub.prototype 呼叫該方法並餵入假替身（fake hub），不建立 CDP 連線、不啟動計時器、
// 不讀寫 repo 以外的路徑、不連線任何網路服務；敏感示例值一律使用 FAKE_VALUE_FOR_TEST。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHub } from '../daemon/page-ops.js';

const CAP_ENTRIES = 500;
const CAP_KEY = 1024;
const CAP_VALUE = 65536;
const CAP_ORIGINS = 64;
const ORIGIN = 'https://mail.example.test';

function fakeHub() {
  return {
    storageVault: {},
    persistCalls: 0,
    _persistStorageVault() { this.persistCalls += 1; },
  };
}

function sync(hub, payload) {
  return BrowserHub.prototype._handleStorageSync.call(hub, payload);
}

const flatten = (pairs) => Object.fromEntries(pairs);

test('合併既有 vault：新鍵加入、既有鍵覆蓋、未提及的鍵保留，且只寫回一次', () => {
  const hub = fakeHub();
  sync(hub, {
    origin: ORIGIN,
    ls: [['token', 'FAKE_VALUE_FOR_TEST'], ['lang', 'zh-TW']],
    ss: [['draft', 'FAKE_VALUE_FOR_TEST']],
  });
  assert.deepEqual(flatten(hub.storageVault[ORIGIN].ls), { token: 'FAKE_VALUE_FOR_TEST', lang: 'zh-TW' });
  assert.deepEqual(flatten(hub.storageVault[ORIGIN].ss), { draft: 'FAKE_VALUE_FOR_TEST' });
  assert.equal(typeof hub.storageVault[ORIGIN].updatedAt, 'string');
  assert.equal(hub.persistCalls, 1);

  sync(hub, { origin: ORIGIN, ls: [['lang', 'en-US'], ['theme', 'dark']] });
  assert.deepEqual(flatten(hub.storageVault[ORIGIN].ls), {
    token: 'FAKE_VALUE_FOR_TEST',
    lang: 'en-US',
    theme: 'dark',
  });
  // 只送 ls 時不得清掉 ss
  assert.deepEqual(flatten(hub.storageVault[ORIGIN].ss), { draft: 'FAKE_VALUE_FOR_TEST' });
  assert.equal(hub.persistCalls, 2);
});

test('非 https 或非法 origin 一律不落地、也不寫檔', () => {
  const hub = fakeHub();
  const badOrigins = [
    'http://127.0.0.1.test',
    'javascript:alert(1)',
    'file:///tmp/x',
    '',
    '   ',
    'https://',
    'not a url',
    undefined,
    null,
  ];
  for (const origin of badOrigins) {
    sync(hub, { origin, ls: [['a', '1']] });
  }
  sync(hub, null);
  sync(hub, undefined);
  sync(hub, 'https://mail.example.test');
  assert.deepEqual(hub.storageVault, {});
  assert.equal(hub.persistCalls, 0);
});

test('單一畸形條目不得讓整批同步被靜默丟棄（回歸）', () => {
  const hub = fakeHub();
  sync(hub, {
    origin: 'https://bad.test',
    ls: [['keep-1', 'a'], 42, null, ['only-key'], ['bad-value', 123], ['', 'empty-key'], ['keep-2', 'b']],
    ss: 'not-an-array',
  });
  const entry = hub.storageVault['https://bad.test'];
  assert.ok(entry, '整批同步不可因單一畸形條目被丟棄');
  assert.deepEqual(flatten(entry.ls), { 'keep-1': 'a', 'keep-2': 'b' });
  assert.deepEqual(entry.ss, []);
  assert.equal(hub.persistCalls, 1);
});

test('每個 origin 每個 bucket 有筆數上限，超量時保留最新寫入的鍵', () => {
  const hub = fakeHub();
  const incoming = Array.from({ length: 5000 }, (_, i) => [`k${i}`, `v${i}`]);
  sync(hub, { origin: 'https://big.test', ls: incoming, ss: incoming });
  const entry = hub.storageVault['https://big.test'];
  assert.equal(entry.ls.length, CAP_ENTRIES);
  assert.equal(entry.ss.length, CAP_ENTRIES);
  const ls = new Map(entry.ls);
  assert.equal(ls.get('k4999'), 'v4999');
  assert.equal(ls.has('k0'), false);

  // 既有 vault 再被寫入時也不能無限膨脹
  sync(hub, { origin: 'https://big.test', ls: Array.from({ length: 500 }, (_, i) => [`n${i}`, 'x']) });
  const after = new Map(hub.storageVault['https://big.test'].ls);
  assert.equal(after.size, CAP_ENTRIES);
  assert.equal(after.get('n499'), 'x');
  assert.equal(after.has('k4999'), false);
});

test('超長 key／value 直接丟棄，等於上限的值仍保留', () => {
  const hub = fakeHub();
  const longKey = 'k'.repeat(CAP_KEY + 1);
  const longValue = 'v'.repeat(CAP_VALUE + 1);
  sync(hub, {
    origin: 'https://len.test',
    ls: [[longKey, 'x'], ['ok-key', longValue], ['ok', 'v']],
    ss: [['exact-edge', 'v'.repeat(CAP_VALUE)]],
  });
  const entry = hub.storageVault['https://len.test'];
  assert.deepEqual(flatten(entry.ls), { ok: 'v' });
  assert.equal(entry.ss.length, 1);
  assert.equal(entry.ss[0][0], 'exact-edge');
});

test('origin 會正規化成 location.origin 的形式', () => {
  const hub = fakeHub();
  sync(hub, { origin: 'HTTPS://Mail.Example.TEST/', ls: [['a', '1']] });
  assert.deepEqual(Object.keys(hub.storageVault), ['https://mail.example.test']);
  assert.deepEqual(flatten(hub.storageVault['https://mail.example.test'].ls), { a: '1' });
});

test('origin 總數有上限，最舊的 origin 會被淘汰', () => {
  const hub = fakeHub();
  for (let i = 0; i < 70; i++) {
    sync(hub, { origin: `https://s${i}.example.test`, ls: [['i', String(i)]] });
  }
  const keys = Object.keys(hub.storageVault);
  assert.equal(keys.length, CAP_ORIGINS);
  assert.ok(keys.includes('https://s69.example.test'));
  assert.ok(!keys.includes('https://s0.example.test'));
});
