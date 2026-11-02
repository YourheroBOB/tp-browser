// Task-space ledger, persisted as JSON. Survives daemon restarts; targets are
// re-attached by targetId and dropped when the browser no longer knows them.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, copyFileSync, statSync, openSync, closeSync, constants } from 'node:fs';
import { dirname } from 'node:path';

// 舊版、手動編輯或半寫入的 ledger 可能沒有 nextSpaceId，或它的值落後於既有 space id。
// 若不修正就進 create()：`undefined++`／`'x'++` 會算出 NaN 並把新空間寫進 "NaN" 鍵；
// `nextSpaceId` 落後時則會直接覆蓋既有空間（id 重用）。因此在載入後把
// nextSpaceId 正規化成「大於所有既有 space id 的正整數」。
// 同樣地，ledger 也可能整塊缺少 labelSeq（舊版 schema），或它是 null／陣列／純量。
// nextLabel 已防禦性處理缺少 labelSeq（不是一般物件就補成 {}），
// 但 create() 直接 `this.data.labelSeq[id] = 1`：缺欄位時會在建立新空間的當下拋
// TypeError——daemon 雖然載入得到既有空間，卻再也開不了新 TaskSpace。labelSeq 為 null／
// 純量會直接拋錯，為陣列則寫出畸形資料。因此載入後一併把 labelSeq 正規化成一般物件。
// 註：刻意不新增 Store 的 prototype 方法，避免破壞 Store.prototype 的公開介面契約。
function isSafeDict(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v === Object.prototype) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function writeLedgerNoFollow(file, body) {
  // O_NOFOLLOW：路徑最後一段若是符號連結就失敗，避免 fallback 覆寫跟著連結寫進別的檔。
  // 平台沒有這個旗標、或回 EINVAL／ENOTSUP／EOPNOTSUPP 時，退回一般寫入。
  const noFollow = constants.O_NOFOLLOW || 0;
  if (!noFollow) {
    writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    return;
  }
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o600);
    try {
      writeFileSync(fd, body);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (!e || (e.code !== 'EINVAL' && e.code !== 'ENOTSUP' && e.code !== 'EOPNOTSUPP')) throw e;
    writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  }
}

function normalizeLedger(data) {
  if (!isSafeDict(data)) return;
  // 舊帳本可能把 spaces 寫成陣列。能辨識 id 的項目轉成 id 鍵物件，其餘換成 {}。
  // 這樣 create／list 不會在 null、純量或 Object.prototype 上 TypeError，也不會把
  // 可救回的空間直接丟掉。
  if (Array.isArray(data.spaces)) {
    const mapped = {};
    for (const space of data.spaces) {
      if (!isSafeDict(space)) continue;
      const idNum = typeof space.id === 'number' ? space.id : Number(space.id);
      if (!Number.isInteger(idNum) || idNum < 1) continue;
      if (!Object.hasOwn(mapped, String(idNum))) mapped[idNum] = space;
    }
    data.spaces = mapped;
  } else if (!isSafeDict(data.spaces)) {
    data.spaces = {};
  }
  for (const key of Object.keys(data.spaces)) {
    const space = data.spaces[key];
    if (!isSafeDict(space)) continue;
    const pages = space.pages;
    // 非空陣列可能還有分頁資料，留在原處，交給各方法拒絕寫入，避免載入時整表清空。
    if (pages == null || typeof pages !== 'object' || pages === Object.prototype || (Array.isArray(pages) && pages.length === 0)) {
      space.pages = {};
    }
  }
  const ids = Object.keys(data.spaces).map((key) => Number(key)).filter((n) => Number.isInteger(n) && n > 0);
  // 不用 Math.max(...ids)：空間一多，展開參數會 RangeError，daemon 載入直接失敗。
  let maxId = 0;
  for (const n of ids) if (n > maxId) maxId = n;
  const current = data.nextSpaceId;
  if (!Number.isInteger(current) || current < 1 || current <= maxId) data.nextSpaceId = maxId + 1;

  // labelSeq 只補成一般物件；各空間的序號內容交給 nextLabel 的既有邏輯維護。
  // Object.prototype 不能留：接下來的賦值會變成全域可列舉屬性。
  if (!isSafeDict(data.labelSeq)) data.labelSeq = {};
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
      // 正規化若丟錯，不可先把壞物件放進 this.data：catch 只記錄 starting fresh，
      // 賦值在前會讓 daemon 帶著壞帳本繼續跑。
      normalizeLedger(parsed);
      this.data = parsed;
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
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(this.data, null, 1);
    try {
      // wx：路徑已存在（含被換成符號連結）就失敗，不會跟著連結把內容寫進別的檔。
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.file);
    } catch {
      try {
        // rename 可能因 Windows 防毒／索引器鎖檔（EPERM）、跨裝置（EXDEV）
        // 或目標型別不符（EISDIR）而失敗：退回直接覆寫正本，資料仍會落地。
        // 不可 writeFileSync(路徑)：它會跟隨符號連結。
        writeLedgerNoFollow(this.file, body);
      } finally {
        // 不論直接寫入成功或失敗（例外照樣往外丟），都不能把
        // `${file}.${pid}.tmp` 留在磁碟上。unlink 移除的是連結本身。
        try { unlinkSync(tmp); } catch { /* 暫存檔不存在、已被 rename 搬走，或本身無法移除 */ }
      }
    }
  }
  list() { return isSafeDict(this.data.spaces) ? Object.values(this.data.spaces) : []; }
  // 只認 `spaces` 的自有鍵：`spaces['__proto__']`／`spaces['constructor']` 會回傳原型上的
  // 東西（分別是 Object.prototype 與 Object 函式），若不擋就會被當成「存在的空間」。
  get(id) {
    const spaces = this.data.spaces;
    if (!isSafeDict(spaces)) return null;
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
    if (!isSafeDict(s)) return 'p?';
    // labelSeq 也只認自有鍵：繼承鍵（例如 'toString'）會讀到函式並寫出一筆孤兒序號，
    // 讓 ledger 只增不減。舊版／手編 ledger 也可能整塊缺少 labelSeq，或它是數字／陣列／
    // Object.prototype，此時補一個空物件，而不是讓 nextLabel 拋 TypeError 或污染全域。
    if (!isSafeDict(this.data.labelSeq)) this.data.labelSeq = {};
    const seq = this.data.labelSeq;
    const current = Object.hasOwn(seq, spaceId) ? seq[spaceId] : undefined;
    const parsed = typeof current === 'number' ? current : Number(current);
    // 只依 labelSeq 遞增會撞上已存在的分頁：addPage／bindPage／adopt 可能先用自訂
    // label 'p2' 佔用，此時若照舊回 'p2'，呼叫端 addPage 會直接覆蓋那個分頁的 targetId。
    // 因此從 labelSeq 續號後，逐一跳過 space 內「已存在」的 pN 標籤（只認 pages 自有鍵，
    // 避免繼承鍵誤判），並把 labelSeq 推進到實際發出的號碼；labelSeq 落後於實際 pN 標籤
    // 的舊 ledger 重載後也一樣不會再撞。
    // 超過 MAX_SAFE_INTEGER 後 n += 1 不會再前進；若該鍵已存在，迴圈會永遠轉。
    let n = (Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1) + 1;
    const pages = isSafeDict(s.pages) ? s.pages : {};
    const labelLimit = Number.isSafeInteger(n) ? n + 1000000 : n;
    while (n < labelLimit && Number.isSafeInteger(n) && Object.hasOwn(pages, `p${n}`)) n += 1;
    if (!Number.isSafeInteger(n) || n >= labelLimit) throw new Error('page label space exhausted');
    // 一般賦值會觸發 Object.prototype 的 __proto__ setter。改以自有資料屬性寫入。
    if (String(spaceId) === '__proto__') {
      Object.defineProperty(seq, '__proto__', { value: n, writable: true, enumerable: true, configurable: true });
    } else {
      seq[spaceId] = n;
    }
    this.persist();
    return `p${n}`;
  }
  setPage(spaceId, label, patch) {
    const s = this.get(spaceId);
    // 只認 `pages` 的自有鍵：`s.pages['__proto__']` 是 Object.prototype（truthy、非自有），
    // 若照舊 Object.assign 下去就是全域原型污染。pages 為 null／陣列時 Object.hasOwn 會直接拋。
    if (!isSafeDict(s) || !isSafeDict(s.pages) || !Object.hasOwn(s.pages, label)) return;
    if (RESERVED_PAGE_LABELS.has(String(label))) return;
    const page = s.pages[label];
    if (!isSafeDict(page)) return;
    // Object.assign 會走 "__proto__" setter。只複製一般自有鍵。
    // null／undefined 與舊版一樣不複製欄位，仍會 persist。
    if (isSafeDict(patch)) {
      for (const key of Object.keys(patch)) {
        if (key === '__proto__') continue;
        page[key] = patch[key];
      }
    } else if (patch !== null && patch !== undefined) {
      Object.assign(page, patch);
    }
    this.persist();
  }
  bindPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!isSafeDict(s)) throw new Error(`unknown space ${spaceId}`);
    // 非法 label 若照舊直接指派，會改掉整個 pages 物件的原型（分頁在 persist 後消失）；
    // 因此明確拒絕，而不是靜默寫入一份壞掉的 ledger。
    if (!isSafeDict(s.pages)) {
      if (Array.isArray(s.pages) && s.pages.length > 0) throw new Error(`space ${spaceId} pages is not an object`);
      s.pages = {};
    }
    assertPageLabel(label);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  addPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!isSafeDict(s)) throw new Error(`unknown space ${spaceId}`);
    if (!isSafeDict(s.pages)) {
      if (Array.isArray(s.pages) && s.pages.length > 0) throw new Error(`space ${spaceId} pages is not an object`);
      s.pages = {};
    }
    assertPageLabel(label);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  removePage(spaceId, label) {
    const s = this.get(spaceId);
    if (!isSafeDict(s) || !isSafeDict(s.pages)) return;
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
    if (isSafeDict(this.data.spaces)) delete this.data.spaces[id];
    // labelSeq 是「每個空間各自」的標籤計數器，空間刪掉後必須一起清掉；
    // 否則 ledger 只增不減（回收器每次回收都留下一筆孤兒 labelSeq[id]）。
    if (isSafeDict(this.data.labelSeq)) delete this.data.labelSeq[id];
    this.persist();
  }
}
