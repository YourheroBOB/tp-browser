// Task-space ledger, persisted as JSON. Survives daemon restarts; targets are
// re-attached by targetId and dropped when the browser no longer knows them.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
// writeFileSync/renameSync/rmSync used by persistJsonAtomic defaults.
import { dirname } from 'node:path';

export function persistJsonAtomic(file, body, fsOps = {}) {
  const writeFile = fsOps.writeFile ?? writeFileSync;
  const rename = fsOps.rename ?? renameSync;
  const remove = fsOps.remove ?? rmSync;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFile(tmp, body, { mode: 0o600 });
  try {
    rename(tmp, file);
  } catch (e) {
    console.error('[ego-browserd] store persist rename failed; keeping previous file:', e?.name || 'Error', e?.message || String(e));
    try { remove(tmp, { force: true }); } catch {}
  }
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { nextSpaceId: 1, labelSeq: {}, spaces: {} };
    this.load();
  }
  load() {
    try {
      if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) { console.error('[ego-browserd] store load failed, starting fresh:', e.message); }
  }
  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = JSON.stringify(this.data, null, 1);
    persistJsonAtomic(this.file, body);
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
    delete s.pages[label];
    this.persist();
  }
  deleteSpace(id) { delete this.data.spaces[id]; this.persist(); }
}
