// Task-space ledger, persisted as JSON. Survives daemon restarts; targets are
// re-attached by targetId and dropped when the browser no longer knows them.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// 舊版、手動編輯或半寫入的 ledger 可能沒有 nextSpaceId，或它的值落後於既有 space id。
// 若不修正就進 create()：`undefined++`／`'x'++` 會算出 NaN 並把新空間寫進 "NaN" 鍵；
// `nextSpaceId` 落後時則會直接覆蓋既有空間（id 重用）。因此在載入後把
// nextSpaceId 正規化成「大於所有既有 space id 的正整數」。
// 註：刻意不新增 Store 的 prototype 方法，避免破壞 Store.prototype 的公開介面契約。
function normalizeNextSpaceId(data) {
  if (data === null || typeof data !== 'object') return;
  const spaces = data.spaces;
  const ids = spaces !== null && typeof spaces === 'object' && !Array.isArray(spaces)
    ? Object.keys(spaces).map((key) => Number(key)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const maxId = ids.length > 0 ? Math.max(...ids) : 0;
  const current = data.nextSpaceId;
  if (!Number.isInteger(current) || current < 1 || current <= maxId) data.nextSpaceId = maxId + 1;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { nextSpaceId: 1, labelSeq: {}, spaces: {} };
    this.load();
  }
  load() {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      // 根節點不是物件（null／陣列／純量）時無法當 ledger 用；視為損壞檔並降級，
      // 而不是把 null 或 [] 塞進 this.data 讓後續每個方法都炸 TypeError。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`ledger root is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`);
      }
      this.data = parsed;
      normalizeNextSpaceId(this.data);
    } catch (e) { console.error('[ego-browserd] store load failed, starting fresh:', e.message); }
  }
  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(this.data, null, 1);
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, this.file);
    } catch {
      try {
        // rename 可能因 Windows 防毒／索引器鎖檔（EPERM）、跨裝置（EXDEV）
        // 或目標型別不符（EISDIR）而失敗：退回直接覆寫正本，資料仍會落地。
        writeFileSync(this.file, body);
      } finally {
        // 不論直接寫入成功或失敗（例外照樣往外丟），都不能把
        // `${file}.${pid}.tmp` 留在磁碟上。
        try { unlinkSync(tmp); } catch { /* 暫存檔不存在、已被 rename 搬走，或本身無法移除 */ }
      }
    }
  }
  list() { return Object.values(this.data.spaces); }
  get(id) { return this.data.spaces[id] ?? null; }
  create({ name, profileId = 'agent' }) {
    const id = this.data.nextSpaceId++;
    this.data.spaces[id] = {
      id, name, profileId, ownership: 'agent', state: 'active',
      createdAt: new Date().toISOString(),
      pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
      activeTargetId: null,
    };
    this.data.labelSeq[id] = 1;
    this.persist();
    return this.data.spaces[id];
  }
  nextLabel(spaceId) {
    const s = this.get(spaceId);
    if (!s) return 'p?';
    this.data.labelSeq[spaceId] = (this.data.labelSeq[spaceId] ?? 1) + 1;
    this.persist();
    return `p${this.data.labelSeq[spaceId]}`;
  }
  setPage(spaceId, label, patch) {
    const s = this.get(spaceId);
    if (!s?.pages[label]) return;
    Object.assign(s.pages[label], patch);
    this.persist();
  }
  bindPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  addPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  removePage(spaceId, label) {
    const s = this.get(spaceId);
    if (!s) return;
    const page = s.pages[label];
    delete s.pages[label];
    // 被移除的分頁若正好是作用中的 target，activeTargetId 必須一起清掉，
    // 否則 ledger 會一直指向已不存在的 targetId。
    if (page && page.targetId != null && page.targetId === s.activeTargetId) s.activeTargetId = null;
    this.persist();
  }
  deleteSpace(id) {
    delete this.data.spaces[id];
    // labelSeq 是「每個空間各自」的標籤計數器，空間刪掉後必須一起清掉；
    // 否則 ledger 只增不減（回收器每次回收都留下一筆孤兒 labelSeq[id]）。
    if (this.data.labelSeq) delete this.data.labelSeq[id];
    this.persist();
  }
}
