# fmb_feature2 — TaskSpace ledger 自動回收器（Reaper）

> 本目錄為**獨立新增**的改進提案，**未修改任何既有檔案**。所有程式碼可獨立執行測試，
> 不連線任何網路服務、不讀寫 repo 以外的路徑（測試僅使用 `mkdtempSync(tmpdir())`）。

## 1. 為什麼挑這一項（不是最顯眼的第一項）

`README.md` 提到的 cookie 匯出／匯入工具是「最顯眼的第一項」，已留給另一個 agent。
本輪改動選擇的是**次高價值、但沒有人提到、且長期一定會發生的運維債**：`daemon/store.js`
的 ledger 只增不減。

證據（純粹由既有程式碼推得，不需臆測）：

1. `Store` 只有 `create` / `addPage` / `bindPage` / `setPage` / `nextLabel`，**沒有任何自動清理路徑**；
   `deleteSpace` / `removePage` 雖然存在，但 repo 內沒有任何呼叫端會週期性使用它們。
2. `Store.create()` 每次呼叫 agent 的 `taskSpace("...")` 就永久新增一筆記錄，
   連一個從未導航過的 `p1`（`targetId: null`）也會被寫進 ledger。
3. Chrome 重啟、`tp-stop` / `tp-headed` 切換、使用者手動關掉分頁之後，
   ledger 裡的 `targetId` 已失效，但記錄仍留著，`title` / `url` 也停在舊值。
4. `persist()` 每次都把**整份** JSON 原子寫回檔案，ledger 越大，每次開分頁的寫檔成本越高。

換句話說：背景常駐（`tp-start`、systemd user service）跑一週後，`space.list` 會回傳大量
早已不存在的分頁。這是「單 Turn 批次 JS、省 Token」這個賣點的反向耗損。

## 2. 這個模組做什麼

`reaper.js` 提供兩個純函式與一個分類器：

| 匯出 | 用途 |
|---|---|
| `classifySpace(space, { liveTargets, now, policy })` | 把單一空間分類成 `live` / `dead` / `unbound` / `mixed` / `empty`，並算出 `ageMs` / `idle` 與分頁清單 |
| `planReap({ spaces, liveTargetIds, now, policy, protect })` | 算出回收計畫：`closeSpaces`、`dropPages`，加碼唯讀診斷 `staleActiveTargets` 與 `stats` |
| `applyReapPlan(store, plan)` | 透過既有的 `store.deleteSpace` / `store.removePage` 套用計畫；方法不存在時是安全 no-op |

**它不會自己做任何刪除**：決定與執行分離，所以可以先乾跑、先觀察、再開自動化。

### 回收規則

| 情境 | 動作 |
|---|---|
| 空間內至少一個分頁的 `targetId` 仍在 live 集合 | 視為 `live`，**永不關閉**；只清掉同期已失效的分頁記錄 |
| 空間所有已綁定分頁都失效（`dead`） | 立即關閉（`policy.reapDeadSpaces`，預設 `true`） |
| 空間沒有任何存活分頁且閒置 ≥ `policy.idleSpaceMs`（預設 30 分鐘） | 關閉 |
| 僅有未綁定佔位分頁（`p1: { targetId: null }`）且未閒置 | 保留（剛建立的空間） |
| `pinned: true` 或列入 `protect` 的空間 | **不關閉、也不丟棄任何分頁** |
| 空間數超過 `policy.maxSpaces`（預設 50） | 從最舊的「非存活、非受保護」空間開始回收；存活空間永不因上限被犧牲 |

### 兩道保守安全閥（刻意的設計決策）

1. **live 集合為空 → 完全不動作**（`reason: 'no-live-targets'`）。
   daemon 剛啟動、還沒接上 Chrome 時 `/json/list` 是空的；若照常回收，整份 ledger 會被誤清。
   真的要在離線狀態下整理 ledger，才顯式設 `policy.reapIdleWhenNoLiveTargets: true`。
2. **`createdAt` 無法解析 → 不判定閒置**（`ageMs: null`）。
   寧可漏收，不可誤刪。

## 3. 整合方式（不修改既有檔案也能先上線）

### 3.1 乾跑：先看計畫，什麼都不刪

```bash
node fmb_feature2/cli.js <<'JSON'
{
  "spaces": [
    { "id": 1, "createdAt": "2026-01-01T00:00:00.000Z", "pages": { "p1": { "targetId": "T-live" } } },
    { "id": 2, "createdAt": "2026-01-01T00:00:00.000Z", "pages": { "p1": { "targetId": "T-gone" } } }
  ],
  "liveTargetIds": ["T-live"]
}
JSON
# => { "closeSpaces": [2], "dropPages": [], "staleActiveTargets": [], "stats": { ... } }
```

要接真實環境的資料，把兩邊餵進來即可（皆為唯讀查詢）：

- `spaces`：`store.list()`（或 `tp-browser spaces` 的輸出）
- `liveTargetIds`：Chrome 的 `GET http://127.0.0.1:9773/json/list` 中 `type === "page"` 的 `id`，
  或既有 CDP client 的 `Target.getTargets` → `targetInfos`
- `now`：選填，蓋掉 `Date.now()` 以便重現測試

### 3.2 掛進 daemon（未來正式整合的建議位置）

在 `daemon/ego-browserd.js` 的 target 輪詢處（daemon 本來就會定期確認 Chrome 是否在線）
加一個低頻計時器即可；**本目錄不修改該檔，示範如下**：

```js
import { planReap, applyReapPlan } from '../fmb_feature2/reaper.js';

setInterval(async () => {
  let liveTargetIds = [];
  try {
    const r = await fetch('http://127.0.0.1:9773/json/list', { signal: AbortSignal.timeout(2000) });
    liveTargetIds = (await r.json()).filter((t) => t.type === 'page').map((t) => t.id);
  } catch {
    return; // Chrome 不在線：直接跳過，絕不在空集合下回收
  }
  const plan = planReap({
    spaces: store.list(),
    liveTargetIds,
    policy: { idleSpaceMs: 30 * 60 * 1000, maxSpaces: 50 },
  });
  if (plan.closeSpaces.length || plan.dropPages.length) {
    applyReapPlan(store, plan);
    console.error(`[reaper] ${JSON.stringify(plan.stats)}`);
  }
}, 60 * 1000);
```

建議上線節奏：先把 `policy` 設成 `{ idleSpaceMs: 6 * 60 * 60 * 1000, maxSpaces: 500 }` 只觀察
`stats` 一週，確認沒有誤收再放寬。

### 3.3 何時**不要**開自動回收

- 需要保留歷史紀錄做稽核（TaskSpace 的 `title` / `url` 是唯一的分頁軌跡）→ 關閉自動回收，
  或先把 ledger 歸檔。
- 同一台機器上多個 agent 共用 daemon，且以「空間存在」作為跨程序鎖 → 先加 `pinned: true`。

## 4. 測試

```bash
node --test fmb_feature2/
```

| 檔案 | 內容 |
|---|---|
| `reaper.test.js` | 純函式單元測試：分類、閒置判定、兩道安全閥、`maxSpaces` 上限、決定性排序、非法輸入、`applyReapPlan` 行為 |
| `store-integration.test.js` | 直接使用真實 `daemon/store.js` 的 `Store`（ledger 寫在 `mkdtempSync(tmpdir())` 內），驗證回收後檔案內容、存活空間資料完整、冪等性、空 live 集合時 ledger 原封不動 |
| `cli.test.js` | 以 `spawnSync(process.execPath, ...)` 餵 stdin，驗證乾跑 CLI 的輸出與退出碼 |

測試特性：**零外部依賴、零網路、零正式服務連線、零真實憑證**；所有暫存檔在 `after()` 清除。

## 5. 已知限制與後續

- `Store` 目前沒有 `lastUsedAt`。本模組用 `createdAt` 當閒置基準（保守且不改既有 schema）。
  未來若 `Store` 新增 `lastUsedAt` / `activeTargetId` 的更新，建議改以 `lastUsedAt` 為準。
- 本模組只處理 ledger，**不會主動關閉 Chrome 端仍在的分頁**。若需要「關閉分頁」，
  應由 daemon 以 CDP `Target.closeTarget` 處理，屬另一項改動。
- `staleActiveTargets` 只做診斷輸出，不會清掉 `space.currentTargetId`。
  原因是 `Store` 沒有對應的寫入 API；等 daemon 端補上 `clearActiveTarget()` 再一併接。
- 未處理「同名空間重複建立」與「同一 URL 多分頁去重」，避免語意過度擴張。

## 6. 決策點（本次自行拍板，留給 BOB 覆核）

1. **預設 30 分鐘閒置即回收**：偏向「常用 agent 工作流節奏」，而非「保留完整歷史」。
2. **`reapDeadSpaces` 預設開啟**：Chrome 重啟後，指向已消失 target 的空間直接回收（視為雜訊）。
   若 BOB 想保留跨重啟的分頁軌跡，把它設為 `false`。
3. **`maxSpaces` 預設 50**：只作為失控保護，正常使用不會觸發。
4. **live 集合為空時完全不動作**：以「安全閥優先於回收率」為原則。
5. **受保護空間連失效分頁都不清**：`pinned` / `protect` 是「完全不要碰」的語意，避免半套清理造成狀態不一致。
6. **實作放在獨立目錄而非改 `daemon/`**：依本次任務硬性規則（只能新增），
   整合方式以文件與可直接 import 的模組呈現，待 BOB 同意後再移入 `daemon/`。
