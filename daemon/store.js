// Task-space ledger, persisted as JSON. Survives daemon restarts; targets are
// re-attached by targetId and dropped when the browser no longer knows them.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, copyFileSync, statSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// 舊版、手動編輯或半寫入的 ledger 可能沒有 nextSpaceId，或它的值落後於既有 space id。
// 若不修正就進 create()：`undefined++`／`'x'++` 會算出 NaN 並把新空間寫進 "NaN" 鍵；
// `nextSpaceId` 落後時則會直接覆蓋既有空間（id 重用）。因此在載入後把
// nextSpaceId 正規化成「大於所有既有 space id 的正整數」。
// 同樣地，ledger 也可能整塊缺少 labelSeq（舊版 schema），或它是 null／陣列／純量。
// nextLabel 已防禦性處理缺少 labelSeq（`this.data.labelSeq ?? (this.data.labelSeq = {})`），
// 但 create() 直接 `this.data.labelSeq[id] = 1`：缺欄位時會在建立新空間的當下拋
// TypeError——daemon 雖然載入得到既有空間，卻再也開不了新 TaskSpace。labelSeq 為 null／
// 純量會直接拋錯，為陣列則寫出畸形資料。因此載入後一併把 labelSeq 正規化成一般物件。
// 註：刻意不新增 Store 的 prototype 方法，避免破壞 Store.prototype 的公開介面契約。
function normalizeLedger(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
  // spaces 缺欄、null、陣列或純量時，list／get／create 會在 Object.hasOwn 或
  // 賦值當下丟 TypeError：ledger 載入得了，daemon 卻無法列出或再開空間。
  // 不是一般物件的項目無法當空間用，留著只會讓 list() 把 null 交出去。
  const spacesIn = data.spaces;
  if (spacesIn === null || typeof spacesIn !== 'object' || Array.isArray(spacesIn)) {
    data.spaces = {};
  } else {
    for (const key of Object.keys(spacesIn)) {
      const space = spacesIn[key];
      if (space === null || typeof space !== 'object' || Array.isArray(space)) {
        delete spacesIn[key];
        continue;
      }
      const pages = space.pages;
      if (pages === null || typeof pages !== 'object' || Array.isArray(pages)) space.pages = {};
    }
  }
  const spaces = data.spaces;
  const ids = spaces !== null && typeof spaces === 'object' && !Array.isArray(spaces)
    ? Object.keys(spaces).map((key) => Number(key)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const maxId = ids.length > 0 ? Math.max(...ids) : 0;
  const current = data.nextSpaceId;
  if (!Number.isInteger(current) || current < 1 || current <= maxId) data.nextSpaceId = maxId + 1;

  // labelSeq 只補成一般物件；各空間的序號內容交給 nextLabel 的既有邏輯維護。
  const seq = data.labelSeq;
  if (seq === null || typeof seq !== 'object' || Array.isArray(seq)) data.labelSeq = {};
}

// `__proto__` 是 Object.prototype 上的存取器：`obj['__proto__'] = page` 不會建立自有鍵，
// 而是把整個物件的原型換掉；JSON.stringify 只看自有可列舉鍵，於是那個分頁 persist 後直接消失。
// `constructor`、`toString`、`valueOf` 等則是從 Object.prototype 繼承來的名稱，`obj[label]`
// 會讀到非自有的資料（最糟是 Object.prototype 本身），一旦拿來當分頁 label 就會被誤判成
// 「分頁已存在」，並讓 setPage 的 Object.assign 直接污染全域原型。這些鍵一律視為非法 label。
// 註：同樣刻意不新增 Store 的 prototype 方法，維持 Store.prototype 的公開介面契約。
const RESERVED_PAGE_LABELS = new Set(Object.getOwnPropertyNames(Object.prototype));

function assertPageLabel(label) {
  const key = String(label);
  if (RESERVED_PAGE_LABELS.has(key)) {
    throw new Error(`invalid page label ${key}`);
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
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      // 根節點不是物件（null／陣列／純量）時無法當 ledger 用；視為損壞檔並降級，
      // 而不是把 null 或 [] 塞進 this.data 讓後續每個方法都炸 TypeError。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`ledger root is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`);
      }
      this.data = parsed;
      normalizeLedger(this.data);
    } catch (e) {
      // 降級成空 ledger 之前，先把無法解析或根節點不合法的原檔原樣複製成
      // `${file}.corrupt-<timestamp>`：否則下一個 persist() 會把原檔直接覆寫成空 ledger，
      // 原本還能手動救回的 space／page／targetId 就永久消失，且不留任何痕跡。
      // 刻意用「複製」而不是「改名」：原檔留在原路徑供 persist 覆寫，位元組完全相同的備份
      // 則留給人工修復。副檔名不使用 `.tmp` 結尾，才不會與 persist() 的
      // `${file}.${pid}.tmp` 暫存檔清理規則互相干擾。
      // 備份本身失敗（檔案已消失、權限不足、型別不是普通檔案等）不該讓 daemon 起不來：
      // 安靜放棄、照舊降級。
      try {
        if (existsSync(this.file) && statSync(this.file).isFile()) {
          const backup = `${this.file}.corrupt-${Date.now()}`;
          copyFileSync(this.file, backup);
          try { chmodSync(backup, 0o600); } catch { /* 備份權限鎖不上時仍保留檔案 */ }
        }
      } catch { /* 備份失敗不阻擋降級為空 ledger */ }
      console.error('[ego-browserd] store load failed, starting fresh:', e.message);
    }
  }
  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(this.data, null, 1);
    try {
      writeFileSync(tmp, body);
      // ledger 含分頁 URL 與標題。umask 022 時預設檔案會讓同機其他使用者可讀。
      // 與 token、cookies 一樣鎖成僅擁有者可讀寫；檔案系統不支援時不阻擋換名。
      try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
      renameSync(tmp, this.file);
    } catch {
      try {
        // rename 可能因 Windows 防毒／索引器鎖檔（EPERM）、跨裝置（EXDEV）
        // 或目標型別不符（EISDIR）而失敗：退回直接覆寫正本，資料仍會落地。
        writeFileSync(this.file, body);
        try { chmodSync(this.file, 0o600); } catch { /* best-effort */ }
      } finally {
        // 不論直接寫入成功或失敗（例外照樣往外丟），都不能把
        // `${file}.${pid}.tmp` 留在磁碟上。
        try { unlinkSync(tmp); } catch { /* 暫存檔不存在、已被 rename 搬走，或本身無法移除 */ }
      }
    }
  }
  list() {
    const spaces = this.data && this.data.spaces;
    if (spaces === null || typeof spaces !== 'object' || Array.isArray(spaces)) return [];
    return Object.values(spaces);
  }
  // 只認 `spaces` 的自有鍵：`spaces['__proto__']`／`spaces['constructor']` 會回傳原型上的
  // 東西（分別是 Object.prototype 與 Object 函式），若不擋就會被當成「存在的空間」。
  // spaces 缺欄或不是一般物件時回 null，而不是讓 Object.hasOwn 丟 TypeError。
  get(id) {
    const spaces = this.data && this.data.spaces;
    if (spaces === null || typeof spaces !== 'object' || Array.isArray(spaces)) return null;
    return Object.hasOwn(spaces, id) ? (spaces[id] ?? null) : null;
  }
  create({ name, profileId = 'agent' }) {
    normalizeLedger(this.data);
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
    // spaceId 來自 ledger 的鍵。seq['__proto__'] = n 會呼叫 Object.prototype 的
    // setter，污染全域原型，而不是在 labelSeq 上建立自有鍵。
    const seqKey = String(spaceId);
    if (seqKey === '__proto__' || seqKey === 'constructor' || seqKey === 'prototype') {
      throw new Error(`invalid space id ${seqKey}`);
    }
    // labelSeq 也只認自有鍵：繼承鍵（例如 'toString'）會讀到函式並寫出一筆孤兒序號，
    // 讓 ledger 只增不減。舊版／手編 ledger 也可能整塊缺少 labelSeq，此時補一個空
    // 物件，而不是讓 nextLabel 拋 TypeError。
    const seq = this.data.labelSeq ?? (this.data.labelSeq = {});
    const current = Object.hasOwn(seq, spaceId) ? seq[spaceId] : undefined;
    const parsed = typeof current === 'number' ? current : Number(current);
    // 只依 labelSeq 遞增會撞上已存在的分頁：addPage／bindPage／adopt 可能先用自訂
    // label 'p2' 佔用，此時若照舊回 'p2'，呼叫端 addPage 會直接覆蓋那個分頁的 targetId。
    // 因此從 labelSeq 續號後，逐一跳過 space 內「已存在」的 pN 標籤（只認 pages 自有鍵，
    // 避免繼承鍵誤判），並把 labelSeq 推進到實際發出的號碼；labelSeq 落後於實際 pN 標籤
    // 的舊 ledger 重載後也一樣不會再撞。
    let n = (Number.isInteger(parsed) && parsed >= 1 ? parsed : 1) + 1;
    const pages = s.pages !== null && typeof s.pages === 'object' && !Array.isArray(s.pages) ? s.pages : {};
    while (Object.hasOwn(pages, `p${n}`)) n += 1;
    seq[spaceId] = n;
    this.persist();
    return `p${n}`;
  }
  setPage(spaceId, label, patch) {
    const s = this.get(spaceId);
    // pages 不是一般物件時，Object.hasOwn 會直接丟 TypeError。
    if (!s || s.pages === null || typeof s.pages !== 'object' || Array.isArray(s.pages)) return;
    // 只認 `pages` 的自有鍵：`s.pages['__proto__']` 是 Object.prototype（truthy、非自有），
    // 若照舊 Object.assign 下去就是全域原型污染。
    if (!Object.hasOwn(s.pages, label)) return;
    const page = s.pages[label];
    if (!page || typeof page !== 'object') return;
    // JSON.parse('{"__proto__":...}') 會產生自有鍵 __proto__。Object.assign 會呼叫
    // Object.prototype 的 setter，污染全域原型。只複製一般自有鍵。
    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
      for (const key of Object.keys(patch)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        page[key] = patch[key];
      }
    } else {
      Object.assign(page, patch);
    }
    this.persist();
  }
  bindPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    // 非法 label 若照舊直接指派，會改掉整個 pages 物件的原型（分頁在 persist 後消失）；
    // 因此明確拒絕，而不是靜默寫入一份壞掉的 ledger。
    assertPageLabel(label);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  addPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    assertPageLabel(label);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  removePage(spaceId, label) {
    const s = this.get(spaceId);
    // pages 不是一般物件時 Object.hasOwn 會丟 TypeError，刪分頁不該弄垮 daemon。
    if (!s || s.pages === null || typeof s.pages !== 'object' || Array.isArray(s.pages)) return;
    // 非自有鍵一律視為不存在（避免把 Object.prototype 上的同名成員當成分頁）。
    if (!Object.hasOwn(s.pages, label)) return;
    const page = s.pages[label];
    delete s.pages[label];
    // 被移除的分頁若正好是作用中的 target，activeTargetId 必須一起清掉，
    // 否則 ledger 會一直指向已不存在的 targetId。
    if (page && page.targetId != null && page.targetId === s.activeTargetId) s.activeTargetId = null;
    this.persist();
  }
  deleteSpace(id) {
    // spaces 若是 null 或缺欄，直接 delete 會丟 TypeError。
    if (this.data.spaces !== null && typeof this.data.spaces === 'object') {
      delete this.data.spaces[id];
    }
    // labelSeq 是「每個空間各自」的標籤計數器，空間刪掉後必須一起清掉；
    // 否則 ledger 只增不減（回收器每次回收都留下一筆孤兒 labelSeq[id]）。
    // 陣列或純量沒有「每個空間一筆」的語意，delete 還可能丟 TypeError。
    if (this.data.labelSeq && typeof this.data.labelSeq === 'object' && !Array.isArray(this.data.labelSeq)) {
      delete this.data.labelSeq[id];
    }
    this.persist();
  }
}
