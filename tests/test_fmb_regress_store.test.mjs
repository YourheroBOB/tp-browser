// tests/test_fmb_regress_store.test.mjs
// 回歸測試：daemon/store.js 的「壞檔不致命、原子寫入、防禦性 no-op、重啟不重用 id」。
//
// 這些行為對應的是過往會出現的故障痕跡（見 store.js 內的防禦性分支）：
//   - load() 以 try/catch 包住 JSON.parse，註解寫「store load failed, starting fresh」
//     → 曾經只要 ledger 檔半寫壞，daemon 就起不來。
//   - persist() 先寫 `${file}.${pid}.tmp` 再 renameSync，rename 失敗才退回直接覆寫
//     → 曾經在寫檔途中被中斷而留下半截 JSON。
//   - nextLabel() 對未知 space 回 'p?'、setPage()/removePage() 對未知目標直接 return
//     → 曾經因為競態（分頁已被關掉）而整條 RPC 拋錯。
//   - create() 的 id 來自 data.nextSpaceId 並持久化 → 重啟後不得重用 id（否則舊分頁會被新空間覆蓋）。
//
// 全部使用 mkdtempSync(tmpdir())，不讀寫 repo 以外的其他路徑、不連線任何服務。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

const dirs = [];
const makeDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-regress-store-'));
  dirs.push(d);
  return d;
};

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Store.load() 會用 console.error 回報載入失敗，測試中靜音以免污染輸出。
const quiet = (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
};

test('store：ledger JSON 損毀時回預設空 ledger，不得讓 daemon 起不來', () => {
  const dir = makeDir();
  const file = join(dir, 'store.json');
  writeFileSync(file, '{ "spaces": { 1: ', 'utf8');

  const store = quiet(() => new Store(file));

  assert.deepEqual(store.list(), []);
  assert.equal(store.data.nextSpaceId, 1);
  assert.deepEqual(store.data.labelSeq, {});
  assert.deepEqual(store.data.spaces, {});
});

test('store：ledger 路徑不可讀（例如被建成目錄）時仍能載入預設值', () => {
  const dir = makeDir();
  const file = join(dir, 'store.json');
  mkdirSync(file);

  const store = quiet(() => new Store(file));

  assert.deepEqual(store.list(), []);
  assert.equal(store.get(1), null);
});

test('store：首次 persist 會建立父目錄，採原子寫入且不留下 .tmp 暫存檔', () => {
  const dir = makeDir();
  const file = join(dir, 'nested', 'deeper', 'store.json');
  const store = new Store(file);

  const space = store.create({ name: 'first' });

  assert.ok(existsSync(file), 'persist 應建立父目錄並寫出 ledger');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), store.data);

  const leftovers = readdirSync(join(dir, 'nested', 'deeper')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子寫入後不得殘留 .tmp');

  assert.equal(space.id, 1);
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(Number.isNaN(Date.parse(space.createdAt)), false);
  assert.deepEqual(space.pages.p1, { targetId: null, openedBy: 'agent', title: '', url: '' });
});

test('store：重啟後不重用 space id，分頁標籤序號延續', () => {
  const dir = makeDir();
  const file = join(dir, 'store.json');

  const first = new Store(file);
  const s1 = first.create({ name: 'a' });
  assert.equal(s1.id, 1);
  assert.equal(first.nextLabel(s1.id), 'p2');

  const second = new Store(file);
  const s2 = second.create({ name: 'b' });
  assert.equal(s2.id, 2, '重啟後不得重用 id 1');
  assert.equal(second.nextLabel(s1.id), 'p3');
  assert.equal(second.nextLabel(s1.id), 'p4');
  assert.deepEqual(second.list().map((s) => s.id), [1, 2]);
});

test('store：對不存在的 space／分頁操作是安全 no-op（不拋、不改既有資料）', () => {
  const dir = makeDir();
  const store = new Store(join(dir, 'store.json'));
  const s = store.create({ name: 'keep' });
  store.setPage(s.id, 'p1', { title: 'T', url: 'http://127.0.0.1:0/x' });

  assert.equal(store.get(999), null);
  assert.equal(store.nextLabel(999), 'p?');
  assert.equal(store.data.labelSeq[999], undefined, '未知 space 不得寫入 labelSeq');

  assert.doesNotThrow(() => store.setPage(999, 'p1', { title: 'x' }));
  assert.doesNotThrow(() => store.setPage(s.id, 'no-such-page', { title: 'x' }));
  assert.doesNotThrow(() => store.removePage(999, 'p1'));
  assert.doesNotThrow(() => store.removePage(s.id, 'no-such-page'));
  assert.doesNotThrow(() => store.deleteSpace(999));

  assert.deepEqual(store.get(s.id).pages.p1, {
    targetId: null,
    openedBy: 'agent',
    title: 'T',
    url: 'http://127.0.0.1:0/x',
  });
});

test('store：重新綁定分頁會清空舊 title/url；未知 space 明確拋錯', () => {
  const dir = makeDir();
  const store = new Store(join(dir, 'store.json'));
  const s = store.create({ name: 'bind' });
  store.setPage(s.id, 'p1', { title: '舊標題', url: 'http://127.0.0.1:0/old' });

  store.bindPage(s.id, 'p1', 'TARGET-1');
  assert.deepEqual(store.get(s.id).pages.p1, {
    targetId: 'TARGET-1',
    openedBy: 'agent',
    title: '',
    url: '',
  });

  assert.throws(() => store.bindPage(4242, 'p1', 'T'), /unknown space 4242/);
  assert.throws(() => store.addPage(4242, 'p1', 'T'), /unknown space 4242/);
});

test('store：deleteSpace 會持久化刪除，重啟後不會復活且 id 不回收', () => {
  const dir = makeDir();
  const file = join(dir, 'store.json');
  const store = new Store(file);
  const keep = store.create({ name: 'keep' });
  const drop = store.create({ name: 'drop' });

  store.deleteSpace(drop.id);

  const reloaded = new Store(file);
  assert.deepEqual(reloaded.list().map((x) => x.id), [keep.id]);
  assert.equal(reloaded.get(drop.id), null);
  assert.equal(reloaded.data.nextSpaceId, 3, 'nextSpaceId 只增不減，避免 id 重用');
});
