// fmb_feature2/reaper.js
// TooPower Browser — TaskSpace ledger 回收器（純邏輯，不連網、不讀寫檔案）
//
// 背景問題（讀 `daemon/store.js` 得知）：
//   ledger 只提供「新增」API（create / addPage / bindPage / setPage），沒有任何自動回收機制。
//   在 `tp-start` 背景常駐、systemd user service 或長時間 agent 工作流下：
//     1. Chrome 重啟、或使用者手動關閉分頁後，ledger 內仍留著已不存在的 targetId；
//     2. Agent 每開一次 `taskSpace("...")` 就永久多一筆記錄（預設 `p1` 甚至從未綁定 target）。
//   ledger 只增不減 → `space.list` 回傳量、`store.persist()` 的寫檔成本與 JSON 體積都會膨脹。
//
// 本模組只負責「算出可以安全回收什麼」，不做任何刪除、不連 CDP、不碰檔案系統：
//   - planReap({ spaces, liveTargetIds, ... }) → { closeSpaces, dropPages, staleActiveTargets, stats }
//   - applyReapPlan(store, plan)               → 透過 store.deleteSpace / store.removePage 套用
//
// 保守安全預設：
//   * live target 集合為空時「完全不動作」（reason: 'no-live-targets'）。daemon 尚未接上
//     Chrome 時 `/json/list` 會是空的，此時若照常回收會把整個 ledger 清光。
//   * pinned 空間與呼叫端以 protect 指定的空間：不關閉、也不丟棄其分頁。
//   * 已失效分頁（targetId 不在 live 集合）才會被丟棄；未綁定（targetId === null）的佔位分頁不動。

export const DEFAULT_POLICY = Object.freeze({
  // 空間「完全沒有存活分頁」且閒置超過此毫秒數即可回收（預設 30 分鐘）。
  idleSpaceMs: 30 * 60 * 1000,
  // ledger 內最多保留幾個空間；超出時由最舊的「非存活、非受保護」空間開始回收。
  // 設為 null / NaN 表示不設上限。
  maxSpaces: 50,
  // 所有已綁定分頁都失效（例如 Chrome 重啟）的空間，是否立即回收（不看閒置時間）。
  reapDeadSpaces: true,
  // 是否丟棄「已失效但空間仍保留」的分頁記錄（含存活空間裡的死亡分頁）。
  dropDeadPages: true,
  // 進階：即使 live 集合為空也照閒置規則回收（不建議，僅供離線整理 ledger 使用）。
  reapIdleWhenNoLiveTargets: false,
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function resolvePolicy(policy) {
  const out = { ...DEFAULT_POLICY };
  if (isPlainObject(policy)) {
    for (const [k, v] of Object.entries(policy)) if (v !== undefined) out[k] = v;
  }
  return out;
}

function emptyStats() {
  return { examined: 0, skipped: 0, live: 0, protected: 0, closed: 0, pagesDropped: 0, staleActiveTargets: 0, overCap: 0 };
}

function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || value === '') return Number.NaN;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : Number.NaN;
}

function normalizeIdList(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => v !== null && v !== undefined).map((v) => String(v));
}

// 把 liveTargetIds（Set / Array / 其他）正規化成「只含非空字串」的 Set。
export function toTargetSet(liveTargetIds) {
  if (liveTargetIds instanceof Set) {
    return new Set([...liveTargetIds].filter((v) => typeof v === 'string' && v !== ''));
  }
  if (Array.isArray(liveTargetIds)) {
    return new Set(liveTargetIds.filter((v) => typeof v === 'string' && v !== ''));
  }
  return new Set();
}

// 把 space.pages 攤平成 [{ label, page, targetId }]，容忍 null / 非物件 / 缺 targetId。
export function pageEntries(space) {
  const pages = isPlainObject(space?.pages) ? space.pages : {};
  const out = [];
  for (const [label, page] of Object.entries(pages)) {
    if (!isPlainObject(page)) continue;
    const targetId = typeof page.targetId === 'string' && page.targetId !== '' ? page.targetId : null;
    out.push({ label, page, targetId });
  }
  return out;
}

// 單一空間的分類結果：kind = live | dead | unbound | mixed | empty
export function classifySpace(space, { liveTargets, now, policy } = {}) {
  const p = resolvePolicy(policy);
  const live = toTargetSet(liveTargets);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const entries = pageEntries(space);
  const livePages = entries.filter((e) => e.targetId !== null && live.has(e.targetId));
  const deadPages = entries.filter((e) => e.targetId !== null && !live.has(e.targetId));
  const unboundPages = entries.filter((e) => e.targetId === null);
  const created = parseTime(space?.createdAt);
  const ageMs = Number.isFinite(created) ? Math.max(0, nowMs - created) : null;
  const idle = ageMs !== null && Number.isFinite(p.idleSpaceMs) && ageMs >= p.idleSpaceMs;

  let kind;
  if (livePages.length > 0) kind = 'live';
  else if (entries.length === 0) kind = 'empty';
  else if (deadPages.length === entries.length) kind = 'dead';
  else if (unboundPages.length === entries.length) kind = 'unbound';
  else kind = 'mixed';

  return { kind, ageMs, idle, entries, livePages, deadPages, unboundPages };
}

// 決定性排序：id（可為數字）→ createdAt → name，確保同一份輸入永遠產生同一份計畫。
function compareSpaces(a, b) {
  const an = Number(a?.id);
  const bn = Number(b?.id);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  const at = parseTime(a?.createdAt);
  const bt = parseTime(b?.createdAt);
  const av = Number.isFinite(at) ? at : 0;
  const bv = Number.isFinite(bt) ? bt : 0;
  if (av !== bv) return av - bv;
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

export function planReap({ spaces, liveTargetIds, now, policy, protect } = {}) {
  const p = resolvePolicy(policy);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const protectSet = new Set(normalizeIdList(protect));
  const live = toTargetSet(liveTargetIds);

  if (!Array.isArray(spaces)) {
    return { closeSpaces: [], dropPages: [], staleActiveTargets: [], reason: 'invalid-input', stats: emptyStats() };
  }

  const candidates = spaces.filter((s) => isPlainObject(s) && s.id !== null && s.id !== undefined);
  const skipped = spaces.length - candidates.length;

  // 安全閥：沒有任何存活 target 時不做任何破壞性決定。
  if (live.size === 0 && p.reapIdleWhenNoLiveTargets !== true) {
    return {
      closeSpaces: [],
      dropPages: [],
      staleActiveTargets: [],
      reason: 'no-live-targets',
      stats: { ...emptyStats(), examined: candidates.length, skipped },
    };
  }

  const ordered = [...candidates].sort(compareSpaces);
  const infos = new Map();
  for (const space of ordered) {
    infos.set(String(space.id), classifySpace(space, { liveTargets: live, now: nowMs, policy: p }));
  }

  const closed = new Set();
  const dropPages = [];
  let liveCount = 0;
  let protectedCount = 0;

  for (const space of ordered) {
    const key = String(space.id);
    const info = infos.get(key);
    const isProtected = protectSet.has(key) || space.pinned === true;

    if (isProtected) { protectedCount++; continue; }

    if (info.kind === 'live') {
      liveCount++;
      if (p.dropDeadPages === true) {
        for (const e of info.deadPages) dropPages.push({ spaceId: space.id, label: e.label, targetId: e.targetId });
      }
      continue;
    }

    const reapByDeath = info.kind === 'dead' && p.reapDeadSpaces === true;
    const reapByIdle = info.idle === true;
    if (reapByDeath || reapByIdle) { closed.add(key); continue; }

    if (p.dropDeadPages === true) {
      for (const e of info.deadPages) dropPages.push({ spaceId: space.id, label: e.label, targetId: e.targetId });
    }
  }

  // 上限：只犧牲「非存活、非受保護」的空間，由最舊的開始；永不為滿足上限而關閉存活空間。
  let overCap = 0;
  const maxSpaces = Number(p.maxSpaces);
  if (Number.isFinite(maxSpaces) && maxSpaces >= 0) {
    const remaining = ordered.filter((s) => !closed.has(String(s.id)));
    const overflow = remaining.length - maxSpaces;
    if (overflow > 0) {
      const victims = remaining
        .filter((s) => !protectSet.has(String(s.id)) && s.pinned !== true)
        .filter((s) => infos.get(String(s.id))?.kind !== 'live')
        .slice(0, overflow);
      for (const v of victims) closed.add(String(v.id));
      overCap = victims.length;
    }
  }

  const closeSpaces = ordered.filter((s) => closed.has(String(s.id))).map((s) => s.id);
  const finalDropPages = dropPages.filter((d) => !closed.has(String(d.spaceId)));
  const staleActiveTargets = ordered
    .filter((s) => !closed.has(String(s.id)))
    .filter((s) => !protectSet.has(String(s.id)) && s.pinned !== true)
    .filter((s) => typeof s.activeTargetId === 'string' && s.activeTargetId !== '' && !live.has(s.activeTargetId))
    .map((s) => ({ spaceId: s.id, targetId: s.activeTargetId }));

  return {
    closeSpaces,
    dropPages: finalDropPages,
    staleActiveTargets,
    stats: {
      examined: candidates.length,
      skipped,
      live: liveCount,
      protected: protectedCount,
      closed: closeSpaces.length,
      pagesDropped: finalDropPages.length,
      staleActiveTargets: staleActiveTargets.length,
      overCap,
    },
  };
}

// 把計畫套用到 `daemon/store.js` 的 Store（或任何具備 deleteSpace / removePage 的物件）。
// 方法不存在時是安全的 no-op，方便先用假物件在測試或乾跑模式驗證。
export function applyReapPlan(store, plan) {
  const closeList = Array.isArray(plan?.closeSpaces) ? plan.closeSpaces : [];
  const dropList = Array.isArray(plan?.dropPages) ? plan.dropPages : [];
  const closeKeys = new Set(closeList.map((id) => String(id)));
  const closedSpaces = [];
  const droppedPages = [];

  if (typeof store?.deleteSpace === 'function') {
    for (const id of closeList) {
      store.deleteSpace(id);
      closedSpaces.push(id);
    }
  }

  if (typeof store?.removePage === 'function') {
    for (const d of dropList) {
      if (!isPlainObject(d) || d.label === undefined || d.label === null) continue;
      if (closeKeys.has(String(d.spaceId))) continue; // 整個空間已刪，不必再逐一刪分頁
      store.removePage(d.spaceId, d.label);
      droppedPages.push(d);
    }
  }

  return { closedSpaces, droppedPages };
}
