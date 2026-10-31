# 07 · TaskSpace ledger 膨脹與回收（Ledger & Reaper）

## Q33. Chrome 重啟後，`tp-browser spaces` 列出一堆不存在的分頁？

- **問題**：TaskSpace 清單裡的 `title`／`url` 停在舊值、`targetId` 指向已消失的分頁。
- **原因**：`daemon/store.js` 的 ledger（JSON 檔）只提供新增／更新 API，沒有自動清理；Chrome 重啟或分頁被關後 ledger 記錄仍留著。daemon 設計上會在 target 消失時丟棄綁定，但 ledger 檔本身長期只增不減。
- **解法**：短期可無視（查詢時以 daemon 端 live 狀態為準）；長期使用 `fmb_feature2/` 的 reaper 工具乾跑檢查並回收（見 Q34–Q36）。
- **相關檔案**：`daemon/store.js`、`fmb_feature2/README.md`

## Q34. ledger 檔越長越大、`space.list` 回傳一大堆舊空間，怎麼安全清理？

- **問題**：長期常駐（`tp-start`／systemd）後 ledger 累積大量逾期記錄。
- **原因**：每次 `taskSpace("...")` 都永久新增一筆空間記錄（連從未導航的 `p1` 佔位也會）；`persist()` 每次整檔原子寫回，ledger 越大寫檔越貴。
- **解法**：使用 reaper **先乾跑、再套用**：

  ```bash
  # 1) 乾跑：只讀 stdin、只印計畫，不刪任何東西
  node fmb_feature2/cli.js <<'JSON'
  {
    "spaces": [ ...由 store.list() 或 tp-browser spaces 提供... ],
    "liveTargetIds": [ ...由 http://127.0.0.1:9773/json/list 取 type=="page" 的 id... ]
  }
  JSON
  ```

  確認計畫合理後，再以 `applyReapPlan(store, plan)` 套用。預設策略：全失效空間立即回收、無存活分頁且閒置 ≥30 分鐘回收、上限 50 個空間、`pinned`／`protect` 完全不碰。
- **相關檔案**：`fmb_feature2/reaper.js`、`fmb_feature2/cli.js`、`fmb_feature2/README.md`、`daemon/store.js`

## Q35. reaper 什麼都沒回收，回 `reason: "no-live-targets"`？

- **問題**：乾跑結果 `closeSpaces`／`dropPages` 全空。
- **原因**：**這是安全閥**。餵入的 `liveTargetIds` 是空集合（例如 daemon 剛啟動還沒接上 Chrome、或 `/json/list` 查詢失敗）時，reaper 刻意完全不動作，避免把整份 ledger 誤清。
- **解法**：先確認 Chrome 在線且 `liveTargetIds` 有值再跑。只有在確定要離線整理 ledger 時，才顯式設 `policy.reapIdleWhenNoLiveTargets: true`。
- **相關檔案**：`fmb_feature2/reaper.js`、`fmb_feature2/README.md`

## Q36. 想把 reaper 掛進 daemon 自動化，該注意什麼？

- **問題**：希望 ledger 自動回收而非手動乾跑。
- **原因**：reaper 目前是獨立模組，**尚未**整合進 `daemon/ego-browserd.js`（刻意不改既有檔案）。
- **解法**：依 `fmb_feature2/README.md` §3.2 的建議：在 daemon 的 target 輪詢處加低頻計時器（如每 60 秒），查詢失敗就跳過。上線節奏建議先以 `{ idleSpaceMs: 6小時, maxSpaces: 500 }` 只觀察 `stats` 一週再放寬。以下情況**不要**開自動回收：需要 ledger 當歷史稽核軌跡；多 agent 以「空間存在」當跨程序鎖（先把那些空間設 `pinned: true`）。
- **相關檔案**：`fmb_feature2/README.md`、`fmb_feature2/reaper.js`、`daemon/ego-browserd.js`

## Q37. reaper 會不會把 Chrome 端還開著的分頁關掉？

- **問題**：擔心回收誤刪實際開啟的分頁。
- **原因**：reaper 的範圍僅限 **ledger 檔內的記錄**，不對 Chrome 下任何 CDP 指令。
- **解法**：不用擔心——它只透過 `store.deleteSpace`／`store.removePage` 動 ledger。且只要空間內**任一**分頁 targetId 仍在 live 集合，整個空間即視為 `live` 永不關閉。若未來要真正關閉 Chrome 分頁，屬另一項改動（CDP `Target.closeTarget`），目前未實作。
- **相關檔案**：`fmb_feature2/reaper.js`、`fmb_feature2/README.md`
