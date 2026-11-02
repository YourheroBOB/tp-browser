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
  if (data === null || typeof data !== 'object') return;
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

  // spaces 缺失或不是物件時，list／get／create 會在 Object.values／Object.hasOwn 上拋 TypeError，
  // daemon 載入後開不了任何空間。收成空物件。陣列維持原樣，避免把還能用索引讀到的資料直接丟掉。
  if (data.spaces == null || typeof data.spaces !== 'object') data.spaces = {};
  else {
    for (const key of Object.keys(data.spaces)) {
      const space = data.spaces[key];
      if (space == null || typeof space !== 'object' || Array.isArray(space)) continue;
      // pages 為 null／純量時，setPage／removePage 的 Object.hasOwn 會拋 TypeError。
      if (space.pages == null || typeof space.pages !== 'object') space.pages = {};
    }
  }
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
          copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        }
      } catch { /* 備份失敗不阻擋降級為空 ledger */ }
      console.error('[ego-browserd] store load failed, starting fresh:', e.message);
    }
  }
  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(this.data, null, 1);
    // ledger 含瀏覽 URL 與 title。writeFileSync 的 mode 仍會被 umask 放寬成 0644，
    // 因此寫入後再 chmod 0600，避免同機其他帳號讀到歷程。權限收緊失敗不阻擋落地。
    const tighten = (path) => { try { chmodSync(path, 0o600); } catch { /* 權限收緊失敗不阻擋資料落地 */ } };
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
      tighten(tmp);
      renameSync(tmp, this.file);
      tighten(this.file);
    } catch {
      try {
        // rename 可能因 Windows 防毒／索引器鎖檔（EPERM）、跨裝置（EXDEV）
        // 或目標型別不符（EISDIR）而失敗：退回直接覆寫正本，資料仍會落地。
        writeFileSync(this.file, body, { mode: 0o600 });
        tighten(this.file);
      } finally {
        // 不論直接寫入成功或失敗（例外照樣往外丟），都不能把
        // `${file}.${pid}.tmp` 留在磁碟上。
        try { unlinkSync(tmp); } catch { /* 暫存檔不存在、已被 rename 搬走，或本身無法移除 */ }
      }
    }
  }
  list() {
    const spaces = this.data.spaces;
    if (spaces == null || typeof spaces !== 'object') return [];
    return Object.values(spaces);
  }
  // 只認 `spaces` 的自有鍵：`spaces['__proto__']`／`spaces['constructor']` 會回傳原型上的
  // 東西（分別是 Object.prototype 與 Object 函式），若不擋就會被當成「存在的空間」。
  get(id) {
    const spaces = this.data.spaces;
    if (spaces == null || typeof spaces !== 'object') return null;
    return Object.hasOwn(spaces, id) ? (spaces[id] ?? null) : null;
  }
  create({ name, profileId = 'agent' }) {
    // 與 load() 同一條正規化：避免執行期 spaces／labelSeq 被改壞後，nextSpaceId++ 變成 NaN。
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
    // pages 為 null／純量時 Object.hasOwn 會拋 TypeError。
    if (!s || s.pages == null || typeof s.pages !== 'object') return;
    // 只認 `pages` 的自有鍵：`s.pages['__proto__']` 是 Object.prototype（truthy、非自有），
    // 若照舊 Object.assign 下去就是全域原型污染。
    if (!Object.hasOwn(s.pages, label)) return;
    const page = s.pages[label];
    if (page == null || typeof page !== 'object' || Array.isArray(page)) return;
    // 保留字 label 不更新（與 bindPage 拒絕寫入的理由相同）；setPage 維持不拋錯的契約。
    if (RESERVED_PAGE_LABELS.has(String(label))) return;
    // Object.assign 走 [[Set]]，patch Own 鍵 `__proto__` 會改掉 page 的原型。
    // defineProperty 只建立自有資料屬性，不觸發該 setter。
    if (patch != null && typeof patch === 'object' && !Array.isArray(patch)) {
      for (const key of Object.keys(patch)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        Object.defineProperty(page, key, {
          value: patch[key],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    this.persist();
  }
  bindPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    if (s.pages == null || typeof s.pages !== 'object') s.pages = {};
    // 非法 label 若照舊直接指派，會改掉整個 pages 物件的原型（分頁在 persist 後消失）；
    // 因此明確拒絕，而不是靜默寫入一份壞掉的 ledger。
    assertPageLabel(label);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  addPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    if (s.pages == null || typeof s.pages !== 'object') s.pages = {};
    assertPageLabel(label);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  removePage(spaceId, label) {
    const s = this.get(spaceId);
    if (!s || s.pages == null || typeof s.pages !== 'object') return;
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
    if (this.data.spaces != null && typeof this.data.spaces === 'object') delete this.data.spaces[id];
    // labelSeq 是「每個空間各自」的標籤計數器，空間刪掉後必須一起清掉；
    // 否則 ledger 只增不減（回收器每次回收都留下一筆孤兒 labelSeq[id]）。
    // 純量／陣列在 strict mode 下 delete 會拋 TypeError，這裡只對一般物件刪鍵。
    const seq = this.data.labelSeq;
    if (seq != null && typeof seq === 'object' && !Array.isArray(seq)) delete seq[id];
    this.persist();
  }
}
