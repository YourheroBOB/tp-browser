# 03 — 保存與刪除機制盤點

## 1. 保存現況（依資料類別）

| 資料 | 保存期間 | 上限／TTL | 輪替 | 備註 |
|---|---|---|---|---|
| Cookies／Login Data／Web Data／IndexedDB（profile-agent） | 永久（設計上刻意跨重啟保存，`Preferences.session.restore_on_startup = 1`） | 無 | — | 為核心功能，屬「有必要長期保存」的商業目的，但**無任何到期或提示機制** |
| store ledger（spaces／pages title／url） | 永久；`persist()` 每次整檔原子寫回，重啟後仍載入 | 無 | — | 只增不減（見下） |
| `logs/daemon.log`、`logs/chrome.log` | 永久 | 無大小上限 | 無輪替 | `spawn_detached` 以 append 模式開檔，長期常駐下無限成長 |
| `token`、`daemon.json` | 每次 daemon 啟動重寫 | — | — | 權限 0600 |
| `cookies.json` | 由使用者手動產生 | 無 | — | 匯出後**無任何到期／刪除提醒** |
| 跨機複製：`tp-start.sh` 在 WSL2 情境把 Windows 端 `token`／`daemon.json` 複製進 Linux 資料目錄 | 隨每次 headed 委派累積 | 無 | — | 產生**兩份並存的認證材料**，無同步清除 |

## 2. 刪除機制現況

- **存在的 API，沒有被用到**：`daemon/store.js` 提供 `deleteSpace()`／`removePage()`，但 repo 內沒有任何呼叫端會定期或自動使用；`fmb_feature2/reaper.js`（`planReap`／`applyReapPlan`）已實作保守的回收邏輯並附完整測試，**但未整合進 daemon**（該目錄 README 已說明整合位置建議）。
- **瀏覽器端分頁**：reaper 只清 ledger，不會 `Target.closeTarget`（該模組 README已載明）。
- **沒有「清除全部本機資料」的使用者指令**：`tp-stop`／`ego-stop` 只停程序；解除安裝需使用者手動 `rm -rf` 資料目錄；`install.sh`／`install.ps1` 的升級流程會 `rm -rf` 舊的 app 目錄，**但完全不動 profile-agent、logs、token、cookies.json**。
- **沒有銷毀紀錄**：本工具沒有任何資料銷毀方法或銷毀紀錄。
- **錯誤路徑的資料殘留**：`store.persist()` 先寫 `${file}.${pid}.tmp` 再 rename；rename 失敗時直接 `writeFileSync` 覆寫，**失敗時 tmp 檔不清理**，可能殘留含瀏覽軌跡的暫存檔（同時也是多程序併發風險，屆時多個 pid 的 tmp 檔並存）。

## 3. 缺口與建議（依優先序）

| # | 缺口 | 建議（最小改動優先） |
|---|---|---|
| 1 | ledger 無限成長且含 title／url | 將 `fmb_feature2/reaper.js` 依其 README 的整合點掛入 daemon（先乾跑統計一週再開自動回收，`pinned`／`protect` 語意已內建） |
| 2 | 日誌無輪替、無上限 | 啟動腳本輪替（如超過 N MB 即 rotate 保留 1 份）＋ 紅欄位（見 `04-log-leak-fields.md`） |
| 3 | 無一鍵清除 | 新增 `tp-purge`（或 `tp-browser purge`）指令：互動確認後刪 profile-agent／logs／token／daemon.json／ledger，並輸出清除摘要（銷毀紀錄的最低可行形式）；本輪僅提案 |
| 4 | 無保留期限政策 | 在 docs 明訂各類資料建議保留期（例：logs 30 天、ledger 依 reaper 政策、cookies 由使用者自理），並在 README 對使用者揭示 |
| 5 | `cookies.json` 無到期提醒 | 匯出工具加入「此檔為高機敏檔，建議於 N 天後刪除」提示（匯出工具本輪未見原始碼，標未驗證） |
| 6 | 升級不清舊資料 | 屬特性而非純缺口，但應在安裝器輸出中提示「profile／logs 保留於何處、如何清除」 |
| 7 | persist() 失敗殘留 tmp | `finally` 中清理 tmp；併發問題另案（多 daemon 共用 Store 已列在 security CHECKLIST 未驗證項） |

## 4. 決策點（本文件自行拍板的保守建議）

1. 建議的預設保留政策採「短」：logs 30 天、閒置空間 30 分鐘（沿用 reaper 預設）、`cookies.json` 建議即用即刪。
2. `tp-purge` 採「互動確認＋預設只清 agent 資料目錄、絕不碰使用者主瀏覽器 profile」的範圍界定。
3. 補救類建議一律以「不修改既有檔案」為前提先以文件記錄，實作另立任務。
