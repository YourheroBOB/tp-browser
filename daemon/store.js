// Task-space ledger, persisted as JSON. Survives daemon restarts; targets are
// re-attached by targetId and dropped when the browser no longer knows them.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const emptyPage = () => ({ targetId: null, openedBy: 'agent', title: '', url: '' });

const defaultData = () => ({ nextSpaceId: 1, labelSeq: {}, spaces: {} });

// 修補單一 space：pages 必須是物件、每個分頁也必須是物件，否則 setPage()／
// bindPage()／findByTargetId() 會在使用時才拋 TypeError。合法的 space 一律原物件
// 回傳（不重建、不重排鍵序），persist() 才可能是位元組不動點。
function normalizeSpace(raw) {
  if (!isPlainObject(raw)) return null;
  if (!isPlainObject(raw.pages)) raw.pages = {};
  for (const label of Object.keys(raw.pages)) {
    if (!isPlainObject(raw.pages[label])) raw.pages[label] = emptyPage();
  }
  return raw;
}

// 把任意 JSON 內容（'null'、'{}'、[]、缺欄位的舊 ledger）修補成 Store 每個方法都能
// 安全操作的形狀。合法 ledger 原樣通過。
function normalizeData(raw) {
  if (!isPlainObject(raw)) return defaultData();
  const data = raw;

  if (!isPlainObject(data.labelSeq)) data.labelSeq = {};
  for (const key of Object.keys(data.labelSeq)) {
    const seq = data.labelSeq[key];
    if (!Number.isInteger(seq) || seq < 1) delete data.labelSeq[key];
  }

  if (!isPlainObject(data.spaces)) data.spaces = {};
  let maxSpaceId = 0;
  for (const key of Object.keys(data.spaces)) {
    const space = normalizeSpace(data.spaces[key]);
    if (!space) { delete data.spaces[key]; continue; }
    data.spaces[key] = space;
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1) continue;
    // 半寫入的 ledger 可能整個少了 space.id（或被寫成字串）。daemon 與 ledger 回收器
    // 都是用 space.id 去呼叫 deleteSpace()/removePage()，id 不是整數時那些呼叫會變成
    // 靜默 no-op（空間永遠清不掉）。鍵就是定址身分，缺 id 時以鍵回填。
    if (!Number.isInteger(space.id)) space.id = id;
    if (id > maxSpaceId) maxSpaceId = id;
  }

  // 缺 nextSpaceId 會讓 create() 產生 NaN id 並以字串鍵 "NaN" 寫回；nextSpaceId
  // 落後於既有 id 則會直接覆蓋既有空間。兩種情況都夾回 maxSpaceId + 1。
  if (!Number.isInteger(data.nextSpaceId) || data.nextSpaceId < 1) data.nextSpaceId = 1;
  if (data.nextSpaceId <= maxSpaceId) data.nextSpaceId = maxSpaceId + 1;

  return data;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = defaultData();
    this.load();
  }
  load() {
    try {
      if (!existsSync(this.file)) return;
      this.data = normalizeData(JSON.parse(readFileSync(this.file, 'utf8')));
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
      writeFileSync(this.file, body);
    }
  }
  list() { return Object.values(this.data.spaces); }
  get(id) { return this.data.spaces[id] ?? null; }
  // daemon 收到 kind === 'coride'（帶 payload.mode）的推播時，會以 targetId 反查是哪個
  // TaskSpace 的分頁，再更新 space.ownership / space.state。回傳的是 ledger 內的活參考
  // （改完由呼叫端 persist()）；找不到、或 targetId 為 null/undefined 時回傳 null。
  // targetId 一律是 CDP 給的字串，這裡嚴格比較，避免 null 命中未綁定的 p1 佔位分頁。
  findByTargetId(targetId) {
    if (targetId === null || targetId === undefined) return null;
    for (const space of Object.values(this.data.spaces ?? {})) {
      const pages = space?.pages ?? {};
      for (const [label, page] of Object.entries(pages)) {
        if (page && page.targetId === targetId) return { space, label, page };
      }
    }
    return null;
  }
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
    delete s.pages[label];
    this.persist();
  }
  deleteSpace(id) { delete this.data.spaces[id]; this.persist(); }
}
