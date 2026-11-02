// tests/test_fmb_fuzz_reaper.test.mjs
// 隨機化（fuzz）測試：fmb_feature2/reaper.js 的純邏輯（分類、回收計畫、套用）。
//
// 目的：以固定亂數種子產生大量畸形／邊界 ledger，檢查「不崩潰」與安全不變量：
//   * 絕不關閉仍有存活分頁的空間、絕不關閉 pinned / protect 的空間。
//   * dropPages 只針對未關閉空間、且指向已失效 targetId 的分頁。
//   * 計畫具決定性；套用後再算一次不得再回收任何東西（冪等）。
// 只使用標準函式庫；不連網、不讀寫檔案（fake store 全在記憶體）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planReap, classifySpace, toTargetSet, pageEntries, applyReapPlan, DEFAULT_POLICY,
} from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const IDLE = DEFAULT_POLICY.idleSpaceMs;
const TARGETS = ['T1', 'T2', 'T3'];

function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// 產生隨機 ledger：含 null、缺 id、非物件分頁、數字 targetId、壞掉或缺失的 createdAt。
function genSpaces(rng) {
  const count = Math.floor(rng() * 9);
  const spaces = [];
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.08) { spaces.push(null); continue; }
    if (roll < 0.16) { spaces.push({ pages: {} }); continue; }
    const space = { id: i + 1 };
    const pages = {};
    const pageCount = Math.floor(rng() * 4);
    for (let k = 0; k < pageCount; k++) {
      const label = `p${k + 1}`;
      const r = rng();
      if (r < 0.12) { pages[label] = null; continue; }
      if (r < 0.2) { pages[label] = 'not-an-object'; continue; }
      const t = rng();
      if (t < 0.35) pages[label] = { targetId: pick(rng, TARGETS) };
      else if (t < 0.7) pages[label] = { targetId: `gone-${Math.floor(rng() * 4)}` };
      else if (t < 0.85) pages[label] = { targetId: null };
      else pages[label] = { targetId: 12345 };
    }
    space.pages = pages;
    const c = rng();
    if (c < 0.45) space.createdAt = new Date(NOW - Math.floor(rng() * 3 * IDLE)).toISOString();
    else if (c < 0.6) space.createdAt = 'not-a-date';
    else if (c < 0.7) space.createdAt = NOW - Math.floor(rng() * 3 * IDLE);
    if (rng() < 0.12) space.pinned = true;
    if (rng() < 0.3) space.activeTargetId = rng() < 0.5 ? pick(rng, TARGETS) : 'gone-active';
    spaces.push(space);
  }
  return spaces;
}

const isCandidate = (s) =>
  s !== null && typeof s === 'object' && !Array.isArray(s) && s.id !== null && s.id !== undefined;

// 記憶體版 Store（只實作 reaper 會呼叫的 deleteSpace / removePage / list）。
function makeFakeStore(spaces) {
  const map = new Map();
  for (const s of spaces.filter(isCandidate)) {
    const pages = {};
    if (s.pages && typeof s.pages === 'object') {
      for (const [k, v] of Object.entries(s.pages)) {
        pages[k] = v !== null && typeof v === 'object' ? { ...v } : v;
      }
    }
    map.set(String(s.id), { ...s, pages });
  }
  return {
    list: () => [...map.values()],
    deleteSpace(id) { map.delete(String(id)); },
    removePage(id, label) {
      const s = map.get(String(id));
      if (s && s.pages) delete s.pages[label];
    },
  };
}

function checkPlan(spaces, plan, liveIds, protectIds) {
  const live = new Set(liveIds);
  const protect = new Set(protectIds.map(String));
  const candidates = spaces.filter(isCandidate);
  const byId = new Map(candidates.map((s) => [String(s.id), s]));

  assert.ok(Array.isArray(plan.closeSpaces));
  assert.ok(Array.isArray(plan.dropPages));
  assert.ok(Array.isArray(plan.staleActiveTargets));
  assert.equal(plan.stats.examined, candidates.length);
  assert.equal(plan.stats.skipped, spaces.length - candidates.length);
  assert.equal(plan.stats.closed, plan.closeSpaces.length);
  assert.equal(plan.stats.pagesDropped, plan.dropPages.length);
  assert.equal(new Set(plan.closeSpaces.map(String)).size, plan.closeSpaces.length);

  const closeIds = new Set(plan.closeSpaces.map(String));

  for (const id of plan.closeSpaces) {
    const s = byId.get(String(id));
    assert.ok(s, `關閉了不存在的空間：${id}`);
    assert.notEqual(s.pinned, true, `pinned 空間被關閉：${id}`);
    assert.ok(!protect.has(String(id)), `受保護空間被關閉：${id}`);
    const alive = pageEntries(s).filter((e) => e.targetId !== null && live.has(e.targetId));
    assert.equal(alive.length, 0, `關閉了仍有存活分頁的空間：${id}`);
  }

  for (const d of plan.dropPages) {
    assert.ok(!closeIds.has(String(d.spaceId)), `已關閉空間仍有 dropPages：${d.spaceId}`);
    assert.ok(!protect.has(String(d.spaceId)), `受保護空間的分頁被丟棄：${d.spaceId}`);
    const s = byId.get(String(d.spaceId));
    assert.ok(s, `dropPages 指向不存在的空間：${d.spaceId}`);
    const page = s.pages?.[d.label];
    assert.ok(page && typeof page === 'object', `dropPages 指向不存在的分頁：${d.spaceId}/${d.label}`);
    assert.equal(page.targetId, d.targetId);
    assert.ok(!live.has(d.targetId), `丟棄了存活分頁：${d.targetId}`);
  }

  for (const st of plan.staleActiveTargets) {
    assert.ok(byId.has(String(st.spaceId)));
    assert.ok(!live.has(st.targetId));
  }
}

test('fuzz: planReap 對 800 份隨機 ledger 不崩潰、安全不變量成立且冪等', () => {
  const rng = makeRng(0x1a2b3c);
  let closedTotal = 0;
  let droppedTotal = 0;

  for (let i = 0; i < 800; i++) {
    const liveIds = TARGETS.filter(() => rng() < 0.6);
    const spaces = genSpaces(rng);
    const protect = spaces.filter((s) => isCandidate(s) && rng() < 0.1).map((s) => s.id);
    const args = { spaces, liveTargetIds: liveIds, now: NOW, protect };

    const plan = planReap(args);
    checkPlan(spaces, plan, liveIds, protect);

    // 決定性：同一份輸入永遠得到同一份計畫。
    assert.deepEqual(planReap(args), plan);

    // 安全閥：live 集合為空時完全不動作。
    if (liveIds.length === 0) {
      assert.equal(plan.reason, 'no-live-targets');
      assert.deepEqual(plan.closeSpaces, []);
      assert.deepEqual(plan.dropPages, []);
    }

    // 冪等：套用後再算一次，不得再回收任何東西。
    const store = makeFakeStore(spaces);
    const applied = applyReapPlan(store, plan);
    assert.deepEqual(applied.closedSpaces, plan.closeSpaces);
    assert.equal(applied.droppedPages.length, plan.dropPages.length);
    const again = planReap({ spaces: store.list(), liveTargetIds: liveIds, now: NOW, protect });
    assert.deepEqual(again.closeSpaces, [], '套用後仍產生關閉計畫');
    assert.deepEqual(again.dropPages, [], '套用後仍產生丟棄計畫');

    closedTotal += plan.closeSpaces.length;
    droppedTotal += plan.dropPages.length;
  }

  assert.ok(closedTotal > 0, '樣本從未回收任何空間（涵蓋率不足）');
  assert.ok(droppedTotal > 0, '樣本從未丟棄任何分頁（涵蓋率不足）');
});

test('fuzz: policy 變體（dropDeadPages=false、reapIdleWhenNoLiveTargets=true）仍守不變量', () => {
  const rng = makeRng(0x7c0ffee);
  for (let i = 0; i < 400; i++) {
    const liveIds = TARGETS.filter(() => rng() < 0.5);
    const spaces = genSpaces(rng);
    const protect = [];

    const noDrop = planReap({
      spaces, liveTargetIds: liveIds, now: NOW, protect, policy: { dropDeadPages: false },
    });
    checkPlan(spaces, noDrop, liveIds, protect);
    assert.deepEqual(noDrop.dropPages, [], 'dropDeadPages=false 仍丟棄分頁');

    const offline = planReap({
      spaces, liveTargetIds: [], now: NOW, protect, policy: { reapIdleWhenNoLiveTargets: true },
    });
    checkPlan(spaces, offline, [], protect);
  }
});

test('fuzz: classifySpace / toTargetSet / pageEntries 對隨機輸入為總函式', () => {
  const KINDS = new Set(['live', 'dead', 'unbound', 'mixed', 'empty']);
  const rng = makeRng(0x51ee7);

  for (let i = 0; i < 600; i++) {
    const liveIds = TARGETS.filter(() => rng() < 0.5);
    const spaces = genSpaces(rng);
    const live = toTargetSet(liveIds);
    assert.ok(live instanceof Set);
    for (const v of live) assert.ok(typeof v === 'string' && v !== '');

    for (const s of spaces) {
      const info = classifySpace(s, { liveTargets: liveIds, now: NOW });
      assert.ok(KINDS.has(info.kind), `未知分類：${info.kind}`);
      assert.equal(typeof info.idle, 'boolean');
      assert.equal(
        info.entries.length,
        info.livePages.length + info.deadPages.length + info.unboundPages.length,
      );
      assert.ok(info.ageMs === null || (Number.isFinite(info.ageMs) && info.ageMs >= 0));
      if (info.kind === 'live') assert.ok(info.livePages.length > 0);
      if (info.kind === 'dead') assert.equal(info.deadPages.length, info.entries.length);
      for (const e of pageEntries(s)) assert.equal(typeof e.label, 'string');
    }
  }

  // 非法 liveTargetIds 一律正規化成空集合；空字串與非字串會被濾除。
  assert.equal(toTargetSet(undefined).size, 0);
  assert.equal(toTargetSet('T1').size, 0);
  assert.deepEqual([...toTargetSet(new Set(['T1', '', null, 'T2']))], ['T1', 'T2']);
  assert.deepEqual([...toTargetSet(['T1', '', 42, null])], ['T1']);

  // 非陣列輸入：不做任何破壞性決定。
  const bad = planReap({ spaces: 'not-an-array', liveTargetIds: ['T1'], now: NOW });
  assert.equal(bad.reason, 'invalid-input');
  assert.deepEqual(bad.closeSpaces, []);
  assert.deepEqual(planReap().closeSpaces, []);
});
