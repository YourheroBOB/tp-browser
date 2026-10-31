// tests/test_fmb_prop_store.test.mjs
// 性質／表格驅動測試：daemon/store.js（TaskSpace ledger）的核心不變量。
//
// 這裡不重跑既有 store 單元測試，而是只斷言「對任何合法操作序列都必須成立」的結構事實：
//   R1 往返一致：persist → 重新載入後資料結構完全相同；再 persist 是位元組不動點。
//   R2 冪等：重複 persist / setPage / removePage / deleteSpace 不改變結果。
//   R3 單調：space id、nextSpaceId、nextLabel 序列永不倒退，跨重啟亦然。
//   R4 邊界保持：未知 spaceId / label 一律安全 no-op 或明確拋錯，絕不留半套狀態；
//                損壞的 ledger 安全降級且不被覆寫。
//   R5 原子寫入：成功 persist 後不留 *.tmp，且目錄只在第一次寫入時建立。
//
// 邊界：只使用 node:test + node:assert + node:fs/os/path；不連網、不讀寫 repo 以外的路徑
// （所有檔案都在 mkdtempSync(tmpdir()) 內，after() 清除）。不使用任何真實憑證。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../daemon/store.js';

const roots = [];
function freshStorePath() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-prop-store-'));
  roots.push(dir);
  return join(dir, 'nested', 'ledger.json');
}

after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const read = (file) => readFileSync(file, 'utf8');

test('R1 往返一致：任意操作序列在 persist → reload 後結構完全相同', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const a = s.create({ name: 'alpha' });
  const b = s.create({ name: 'beta', profileId: 'agent-2' });

  s.addPage(a.id, s.nextLabel(a.id), 'T-2');
  s.setPage(a.id, 'p2', { title: '標題', url: 'http://127.0.0.1:0/page' });
  s.bindPage(b.id, 'p1', 'T-3', 'human');
  s.nextLabel(b.id);

  const reloaded = new Store(file);
  assert.deepEqual(reloaded.data, s.data);
  assert.deepEqual(reloaded.list(), s.list());
  // 再載入一次仍是同一個結構（載入本身無副作用）
  assert.deepEqual(new Store(file).data, s.data);
});

test('R2 冪等：連續 persist 產生相同位元組，且不留 *.tmp（原子寫入）', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const sp = s.create({ name: 'x' });
  s.bindPage(sp.id, 'p1', 'T-1');

  const first = read(file);
  s.persist();
  s.persist();
  assert.equal(read(file), first, 'persist 必須是冪等的');
  assert.deepEqual(JSON.parse(first), s.data, '檔案內容必須等於記憶體狀態');

  const leftovers = readdirSync(dirname(file)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `不應遺留暫存檔，實際：${leftovers.join(',')}`);
});

test('R2 冪等：同一 patch 套用多次後資料與檔案內容不變', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const sp = s.create({ name: 'idem' });
  const patch = { title: '同一個標題', url: 'http://127.0.0.1:0/x' };

  s.setPage(sp.id, 'p1', patch);
  const once = read(file);
  s.setPage(sp.id, 'p1', { ...patch });
  s.setPage(sp.id, 'p1', { ...patch });

  assert.equal(read(file), once);
  assert.deepEqual(new Store(file).get(sp.id).pages.p1, {
    targetId: null,
    openedBy: 'agent',
    title: '同一個標題',
    url: 'http://127.0.0.1:0/x',
  });
});

test('R3 單調：create 的 id 嚴格遞增、nextSpaceId 每次 +1、跨重啟不倒退', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const baseline = Date.now();
  const ids = [];
  let expectedNext = s.data.nextSpaceId;

  for (let i = 0; i < 15; i += 1) {
    const sp = s.create({ name: `s${i}` });
    assert.ok(Number.isInteger(sp.id) && sp.id > 0, `id 必須是正整數，實際 ${sp.id}`);
    if (i > 0) assert.ok(sp.id > ids[i - 1], 'space id 必須嚴格遞增');
    assert.equal(s.data.nextSpaceId, expectedNext + 1);
    expectedNext = s.data.nextSpaceId;
    assert.ok(Date.parse(sp.createdAt) >= baseline - 1, 'createdAt 必須可解析且不早於測試起點');
    ids.push(sp.id);
  }
  assert.equal(new Set(ids).size, ids.length, 'id 必須唯一');

  const reloaded = new Store(file);
  assert.equal(reloaded.data.nextSpaceId, expectedNext, '重啟後 nextSpaceId 不得倒退');
  assert.deepEqual(reloaded.list().map((x) => x.id), ids);

  const afterRestart = reloaded.create({ name: 'after' });
  assert.ok(afterRestart.id > ids.at(-1), '重啟後新 id 必須大於所有既有 id');
});

test('R3 單調：nextLabel 嚴格遞增且格式固定，跨重啟續接，未知空間回 p?', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const sp = s.create({ name: 'labels' });

  const labels = [];
  for (let i = 0; i < 10; i += 1) labels.push(s.nextLabel(sp.id));

  const nums = labels.map((l) => {
    assert.match(l, /^p[1-9]\d*$/, `label 格式必須是 p<正整數>，實際為 ${l}`);
    return Number(l.slice(1));
  });
  assert.equal(new Set(labels).size, labels.length, 'label 不得重複');
  for (let i = 1; i < nums.length; i += 1) assert.ok(nums[i] > nums[i - 1], 'label 序號必須嚴格遞增');

  const reloaded = new Store(file);
  const next = reloaded.nextLabel(sp.id);
  assert.ok(Number(next.slice(1)) > nums.at(-1), '重啟後 label 序號必須續接');

  assert.equal(reloaded.nextLabel(987654), 'p?', '未知空間必須回 p? 而非崩潰');
  const beforeNoop = read(file);
  assert.equal(reloaded.nextLabel(987654), 'p?');
  assert.equal(read(file), beforeNoop, '未知空間的 nextLabel 不得寫檔');
});

test('R4 邊界：未知 spaceId / label 的寫入是安全 no-op 或明確拋錯，不留半套狀態', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const sp = s.create({ name: 'boundary' });
  const before = read(file);

  assert.doesNotThrow(() => s.setPage(987654, 'p1', { title: 'x' }));
  assert.doesNotThrow(() => s.setPage(sp.id, 'p999', { title: 'x' }));
  assert.doesNotThrow(() => s.removePage(987654, 'p1'));
  assert.equal(read(file), before, 'no-op 不得改寫 ledger 的語意內容');

  assert.throws(() => s.bindPage(987654, 'p1', 'T-1'), /unknown space/);
  assert.throws(() => s.addPage(987654, 'p1', 'T-1'), /unknown space/);
  assert.equal(read(file), before, '拋錯路徑不得寫檔');
  assert.equal(s.get(987654), null);
});

test('R2 冪等：removePage / deleteSpace 重複呼叫結果相同，list() 與 get() 永久一致', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const a = s.create({ name: 'a' });
  const b = s.create({ name: 'b' });
  s.addPage(a.id, 'p2', 'T-2');

  s.removePage(a.id, 'p2');
  const afterRemove = read(file);
  s.removePage(a.id, 'p2');
  s.removePage(a.id, 'p2');
  assert.equal(read(file), afterRemove, '重複 removePage 必須是冪等的');
  assert.equal(s.get(a.id).pages.p2, undefined);

  s.deleteSpace(b.id);
  const afterDelete = read(file);
  s.deleteSpace(b.id);
  assert.equal(read(file), afterDelete, '重複 deleteSpace 必須是冪等的');
  assert.equal(s.get(b.id), null);

  assert.deepEqual(s.list().map((x) => x.id), [a.id]);
  for (const listed of s.list()) assert.deepEqual(s.get(listed.id), listed, 'list() 與 get() 必須一致');

  assert.deepEqual(new Store(file).data, s.data, '刪除後重啟仍必須一致');
});

test('R4 邊界：ledger 不存在時是空狀態，第一次寫入才建立巢狀目錄', () => {
  const file = freshStorePath();
  assert.equal(existsSync(dirname(file)), false);

  const s = new Store(file);
  assert.deepEqual(s.list(), []);
  assert.equal(s.get(1), null);
  assert.equal(existsSync(dirname(file)), false, '載入不得建立目錄');

  const sp = s.create({ name: 'first' });
  assert.equal(existsSync(file), true, '第一次 persist 必須建立巢狀目錄與檔案');
  assert.deepEqual(readdirSync(dirname(file)), ['ledger.json'], '目錄內只能有 ledger 本體');
  assert.deepEqual(new Store(file).list().map((x) => x.id), [sp.id]);
});

test('R4 邊界：ledger 內容損壞時安全降級為空狀態，且不覆寫原檔', () => {
  const file = freshStorePath();
  mkdirSync(dirname(file), { recursive: true });
  const broken = '{ "nextSpaceId": 1, "spaces": { "1": ';
  writeFileSync(file, broken, 'utf8');

  const originalError = console.error;
  let errors = 0;
  console.error = () => { errors += 1; };
  let store;
  try {
    store = new Store(file);
  } finally {
    console.error = originalError;
  }

  assert.ok(errors >= 1, '損壞的 ledger 應留下診斷訊息');
  assert.deepEqual(store.list(), []);
  assert.equal(store.data.nextSpaceId, 1);
  assert.equal(read(file), broken, '建構子不得覆寫損壞的檔案（保留人工修復機會）');
});

test('R4 形狀不變量：create 產出的 space/page 欄位集合固定，且回傳值與 get() 同一物件', () => {
  const file = freshStorePath();
  const s = new Store(file);
  const sp = s.create({ name: 'shape' });

  assert.equal(s.get(sp.id), sp, 'create 必須回傳 ledger 內的同一物件');
  assert.deepEqual(Object.keys(sp).sort(), [
    'activeTargetId', 'createdAt', 'id', 'name', 'ownership', 'pages', 'profileId', 'state',
  ]);
  assert.deepEqual(Object.keys(sp.pages).sort(), ['p1']);
  assert.deepEqual(Object.keys(sp.pages.p1).sort(), ['openedBy', 'targetId', 'title', 'url']);
  assert.equal(sp.pages.p1.targetId, null);
  assert.equal(sp.pages.p1.openedBy, 'agent');
  assert.equal(sp.activeTargetId, null);
  assert.equal(sp.profileId, 'agent', 'profileId 預設值必須是 agent');
  assert.equal(sp.ownership, 'agent');
  assert.equal(sp.state, 'active');
  assert.ok(Number.isFinite(Date.parse(sp.createdAt)));

  // 覆寫同一個 label 時必須整筆替換，舊的 title/url 不得殘留
  s.setPage(sp.id, 'p1', { title: 't', url: 'u' });
  s.addPage(sp.id, 'p1', 'T-new', 'human');
  assert.deepEqual(s.get(sp.id).pages.p1, {
    targetId: 'T-new', openedBy: 'human', title: '', url: '',
  });
});

test('R1+R2 隨機操作序列：reload 後 deepEqual，再次 persist 是位元組不動點', () => {
  const file = freshStorePath();
  const s = new Store(file);

  // 決定性 32-bit LCG：可重現、不需外部套件、不依賴 Math.random
  let seed = 0x2f6e2b1;
  const nextInt = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };

  const ids = [];
  for (let i = 0; i < 80; i += 1) {
    if (ids.length === 0 || nextInt(5) === 0) {
      ids.push(s.create({ name: `space-${i}` }).id);
      continue;
    }
    const id = ids[nextInt(ids.length)];
    switch (nextInt(5)) {
      case 0: s.nextLabel(id); break;
      case 1: s.addPage(id, s.nextLabel(id), `T-${i}`); break;
      case 2: s.setPage(id, 'p1', { title: `t-${i}`, url: `http://127.0.0.1:0/${i}` }); break;
      case 3: s.removePage(id, s.nextLabel(id)); break;
      default: s.bindPage(id, 'p1', `T-b-${i}`, i % 2 === 0 ? 'agent' : 'human'); break;
    }
  }

  const snapshot = read(file);
  const reloaded = new Store(file);
  assert.deepEqual(reloaded.data, s.data, '往返後資料必須完全相同');
  reloaded.persist();
  assert.equal(read(file), snapshot, 'reload → persist 必須是位元組不動點');
});
