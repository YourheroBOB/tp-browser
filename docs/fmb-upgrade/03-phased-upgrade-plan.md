# 03 — tp-browser 分階段升級計畫

> **文件狀態**：規劃文件（docs-only）。本文只描述升級計畫，**不實際升級**、不修改任何既有檔案、不新增 npm dependency、不建立 workflow、不連線任何正式服務。  
> **相依文件**：[`01-inventory.md`](./01-inventory.md)、[`02-risk-register.md`](./02-risk-register.md)、[`04-validation-and-rollback-runbook.md`](./04-validation-and-rollback-runbook.md)。  
> **安全邊界**：本文不含實際 token、金鑰、密碼、客戶個資、LINE 訊息內文或案件當事人資料；示例值一律使用 `FAKE_VALUE_FOR_TEST`。

---

## 1. 計畫目標與總原則

### 1.1 目標

1. 建立一致的語言／執行環境支援契約：Node.js、npm 相依模型、shell、PowerShell、systemd、瀏覽器與 OS。  
2. 在不破壞「零 npm runtime dependency」與「本機優先」原則下，讓升級可重現、可驗證、可回滾。  
3. 先處理文件與驗證基準落差，再處理安裝供應鏈，最後才提升最低執行環境版本。  
4. 所有驗證均可在離線或僅使用 loopback 本機服務的環境中完成。

### 1.2 總原則

| 原則 | 說明 |
|---|---|
| **不主動引入 npm runtime dependency** | 維持目前最大供應鏈優勢；若未來必須新增，需另案審查、鎖版、評估 SBOM 與安全掃描 |
| **先一致，再升級** | 先統一 `package.json`、README、STATE、安裝腳本之間的支援宣告，再動實際執行環境 |
| **每階段可回滾** | 程式、安裝 artifact、瀏覽器版本、Profile 資料分開回滾，避免只還原程式卻留下不相容資料 |
| **正式支援與 best effort 分離** | Chrome／Chromium 優先列正式支援；Edge／Brave／macOS 在驗收證據齊全前列 best effort |
| **不連接正式服務** | 測試僅使用 repo 內本機伺服器、假資料與 `tmp_path`／`tempfile` 隔離目錄 |
| **版本來源唯一** | 版本宣告、CLI 輸出發佈 tag、安裝來源必須對齊 |

---

## 2. 升級對象現況摘要

| 類別 | 現況 | 主要風險 | 處理階段 |
|---|---|---|---|
| npm direct／transitive dependencies | `0` | 幾乎無 npm 供應鏈風險，但需維持與驗證 | Phase 0 持續把關 |
| Node.js 支援宣告 | `package.json` 為 `node >=22`；README 仍提及 Node 20 + `--experimental-websocket`；STATE 有 Node 20／24／26 歷史節點 | 使用者誤解、執行行為分歧、CI 基準不一 | Phase 0、Phase 4 |
| 優先 Node.js 版本 | 建議最低 22、優先驗證 24、26 canary | 未制度化驗證矩陣 | Phase 0、Phase 4 |
| 瀏覽器支援 | STATE 有 Chrome 150–155 歷史記錄；Edge／Brave／macOS 缺可重現驗收 | 分支差異、anti-bot 行為、UA／Client Hints 偽裝失效 | Phase 3 |
| 安裝來源 | 遠端安裝可抓取浮動預設分支；安裝流程會先移除既有 runtime | 供應鏈不可重現、失敗後難回滾 | Phase 1 |
| 版本一致性 | `package.json` 為 `0.3.0`，CLI `version` 文件記錄為 `0.3.1` | 發佈與支援基準混淆 | Phase 0／Phase 1 |
| systemd／啟動腳本 | `ExecStart` 未帶 `--experimental-websocket`，而部分 wrapper 仍帶此旗標 | Node 22+ 行為與舊 wrapper 不一致、未來清理時機不明 | Phase 0、Phase 2 |
| 測試基準 | 已有零相依單元測試；真實瀏覽器冒煙依賴本機 Chrome | 無法作為新版本唯一驗收 | Phase 0、Phase 3 |

---

## 3. 分階段升級計畫總覽

| 階段 | 主題 | 主要變更 | 建議性質 | 進場條件 | 回滾方式 |
|---|---|---|---|---|---|
| **Phase 0** | 支援契約與測試基準一致化 | 文件與宣告對齊；建立 Node／瀏覽器測試矩陣；補版本一致性檢查 | 必要 | 不需要改執行環境，可先在 PR 完成文件與本地驗證 | 回復文件變更；不影響 runtime |
| **Phase 1** | 安裝與發佈供應鏈硬化 | 固定 tag／commit、checksum、版本化安裝目錄、原子切換、保留前一版 | 必要 | Phase 0 支援契約已定；第一個 `vX.Y.Z` tag 已規劃 | 切回上一版 runtime 目錄與 wrapper |
| **Phase 2** | 啟動器與服務生命週löschen? no Chinese: 週期清理 | 移除 Node 20 專用旗標、統一 Node 22 啟動路徑、修正 systemd unit、補重入與失敗清理 | 必要 | Phase 0 文件已公告 Node 22 基線；Phase 1 安裝可回滾 | 回復啟動腳本／systemd unit；runtime 可保留 |
| **Phase 3** | 瀏覽器與 OS 相容矩陣 | 建立 Chrome／Chromium 正式矩陣；Edge／Brave／macOS 先 best effort；處理 UA／Client Hints 與 Profile 相容 | 高價值 | Phase 0 矩陣可執行；Phase 1 發佈可控 | 回復 `TP_BROWSER_BIN` 或啟動設定；不動 Profile |
| **Phase 4** | Node.js 基線提升 | 正式將 Node 22 設為最低、24 為優先、26 canary；必要時移除 Node 20 相容語句 | 最後執行 | Phase 0–3 穩定，公告與遷移期已過 | 提高或恢復 `engines`；wrapper 仍可帶旗標過渡 |

---

## 4. Phase 0 — 支援契約與測試基準一致化

### 4.1 變更內容

| 項目 | 變更 | 目的 |
|---|---|---|
| `package.json` 支援宣告 | 維持或確認 `engines.node` 以 Node 22 為最低；不新增 dependencies | 建立單一語言版本契約 |
| README／安裝說明 | 移除或明確標示 Node 20 + `--experimental-websocket` 為舊世代相容路徑，不再列正式支援 | 消除文件與程式宣告不一致 |
| 版本宣告 | 統一 `package.json`、CLI `version` 輸出、發佈 tag 的版本號來源 | 避免 `0.3.0`／`0.3.1` 漂移影響驗收 |
| 測試矩陣文件 | 定義 Node 22 必測、Node 24 必測、Node 26 選擇性；Chrome／Chromium 優先 | 讓後續升級有可重現基準 |
| CI 基準文件 | 以 `node --check`、`node --test`、`node --test --experimental-test-coverage` 等零相依工具建立基準 | 不新增 devDependency 也能驗證 |
| 安全掃描基準 | 文件化 gitleaks、`npm audit`、osv-scanner 的最小可用策略 | 零相依不等於零供應鏈審查 |

### 4.2 相容性風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| Node 22 最低線宣布後，舊 Node 20 使用者啟動失敗 | 部分部署暫時不可用 | 公告遷移期；安裝器提供 Node 版本檢查與明確錯誤 |
| 版本號統一後，舊腳本或文件參考舊號 | 自動化或回滾指令混淆 | 發佈 tag 對照表；回滾 runbook 固定用 commit／tag |
| 測試矩陣加入 Node 26 canary 後不穩定 | CI 噪音 | Node 26 採選擇性／advisory，不擋必要關卡 |
| 文件宣稱與實際行為仍有落差 | 使用者信任受損 | 每次文件變更需附驗證命令與預期輸出 |

### 4.3 驗證方式

```bash
# 1. 語法基準：全量 JavaScript 模組
node --check bin/tp-browser.js
node --check daemon/tp-browserd.js
node --check daemon/ego-browserd.js
node --check daemon/store.js
node --check daemon/cdp.js
node --check daemon/keys.js
node --check lib/sdk.js

# 2. 零相依單元測試
node --test tests/
node --test fmb_feature2/

# 3. 覆蓋率報告（不設硬門檻）
node --test --experimental-test-coverage tests/ fmb_feature2/

# 4. 零 npm 相依檢查（預期無 dependency 欄位或全為空）
node -e "const p=require('./package.json'); console.log(JSON.stringify({dependencies:p.dependencies??null,devDependencies:p.devDependencies??null,optionalDependencies:p.optionalDependencies??null,peerDependencies:p.peerDependencies??null}))"
```

預期結果：所有 `node --check` 退出碼 `0`；`node --test` 全數通過；`package.json` 不出現非預期 dependency。

### 4.4 回滾方式

- 文件與宣告變更：直接回復到前一 commit。  
- 版本號：若已發 tag，不可修改既有 tag；改以新 tag 修正。  
- 測試矩陣：移除或標記 advisory，不影響 runtime。

---

## 5. Phase 1 — 安裝與發佈供應鏈硬化

### 5.1 變更內容

| 項目 | 變更 | 目的 |
|---|---|---|
| 遠端安裝來源 | 從浮動預設分支改為固定 `vX.Y.Z` tag 或不可變 commit | 可重現安裝 |
| Artifact 驗證 | 提供 SHA256 checksum；安裝前驗證 | 降低傳輸層與來源竄改風險 |
| 安裝目錄 | 改版本化目錄，例如 `app/releases/<version>`，以 symlink 或原子 rename 切換 `current` | 保留前一版，失敗可回滾 |
| 安裝流程 | 不可在驗證通過前移除既有 runtime | 避免中斷後無可用版本 |
| 發佈流程 | 僅從 tag 觸發；先版本一致性 gate，再打包與發佈 | 防止誤發與版本漂移 |
| 本機 clone 安裝 | 保留既有本地安裝路徑 | 開發者與私有 clone 使用不受影響 |

### 5.2 相容性風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 舊安裝器仍抓預設分支 | 使用者拿到未驗證內容 | 新舊安裝器並存過渡；文件公告舊安裝器棄用 |
| 版本化目錄與舊 symlink 混用 | wrapper 指向錯誤版本 | 安裝完成後原子切換；失敗不動 `current` |
| Checksum 檔案遺失或格式錯誤 | 安裝失敗 | 明確錯誤碼與重試指引；保留前一版 |
| 固定 tag 後，分支修補無法立即送达 | 緊急修補延遲 | 以新 tag 發佈，不用浮動分支 |

### 5.3 驗證方式

```bash
# 1. 本地打包一致性：比較 release tag 與本地 clone 的檔案哈希
#    僅在本地隔離目錄操作，不連線正式服務

# 2. 安裝 dry-run／隔離安裝
HOME="$PWD/.tmp/fake-home" ./install.sh

# 3. 驗證 wrapper 指向與版本輸出
HOME="$PWD/.tmp/fake-home" "$HOME/.local/bin/tp-browser" version

# 4. 模擬 checksum 失敗應中止且不切換 current
```

預期結果：安裝只使用固定來源；checksum 不符時中止；`current` 仍指向前一版；版本輸出與 tag 一致。

### 5.4 回滾方式

- 重新將 `current` 指回上一版 release 目錄。  
- 還原 wrapper symlink。  
- 若安裝過程已替換 wrapper，使用前一版 wrapper 備份。  
- 不刪除使用者 Profile、token、logs。

---

## 6. Phase 2 — 啟動器與服務生命週期清理

### 6.1 變更內容

| 項目 | 變更 | 目的 |
|---|---|---|
| Node 旗標 | 統一 Node 22 路徑；評估移除 `--experimental-websocket` | 減少實驗旗標依賴 |
| `package.json` / wrapper | 讓 wrapper 與 `engines` 一致 | 避免 Node 20 專用路徑誤用 |
| systemd user units | 補 Node 版本檢查或使用明確 node 路徑；確認重啟策略 | 服務化部署可觀測 |
| 啟動重入 | 補 `flock` 或等價單一實例保護 | 避免重複 daemon |
| root／sandbox 處理 | 明確定義 root 下是否允許 `--no-sandbox`，預設拒絕並提供環境變數覆寫 | 兼顧安全與 WSL2 情境 |
| 停止流程 | 保留 flush-and-close，並確保失敗時仍能清理程序 | 降低殭屍程序與資料未落盤 |

### 6.2 相容性風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 移除 `--experimental-websocket` 後，Node 20 啟動失敗 | 舊部署中斷 | 先公告 Node 22 基線；遷移期內保留錯誤訊息與替代方案 |
| systemd unit 改動後行為不同 | 開機自啟失效 | 單元改動前後分別 `systemd-analyze verify` 與手動重啟 |
| root 拒絕啟動 | 部分容器／WSL2 流程失敗 | 提供 `TP_ALLOW_ROOT=1` 顯式覆寫，預設安全 |
| 重入保護過嚴 | 正當多實例部署受阻 | 文件化單一資料目錄僅允許單一 daemon |

### 6.3 驗證方式

```bash
# 1. 啟動腳本語法與基本流程
sh -n scripts/tp-start.sh
sh -n scripts/tp-stop.sh

# 2. 以假 HOME 與臨時 DATA_DIR 做隔離測試
HOME="$PWD/.tmp/fake-home" scripts/tp-start.sh
HOME="$PWD/.tmp/fake-home" scripts/tp-stop.sh

# 3. systemd unit 驗證（Linux）
systemd-analyze verify ./scripts/ego-linux-browserd.service
systemd-analyze verify ./scripts/ego-linux-chrome.service

# 4. 本機健康檢查
curl -fsS --max-time 3 http://127.0.0.1:9772/health
```

預期結果：啟動後 `/health` 回 `{"ok":true,"chrome":true}`；停止後無殘留 daemon；systemd unit 無驗證錯誤。

### 6.4 回滾方式

- 回復啟動腳本與 systemd unit 至前一版。  
- 保留既有 runtime，不刪 Profile。  
- 若新 wrapper 有問題，重新指向舊版 release。

---

## 7. Phase 3 — 瀏覽器與 OS 相容矩陣

### 7.1 變更內容

| 項目 | 變更 | 目的 |
|---|---|---|
| Chrome／Chromium | 建立正式支援矩陣，包含版本、平台、CDP 行為、無頭／有頭切換 | 確保主要路徑可重現 |
| Edge／Brave | 先列 best effort；補齊探測、UA／Client Hints、Profile 初始化驗證 | 避免宣稱跑在未驗證環境 |
| macOS | 補齊啟動、路徑、權限、瀏覽器探測驗證 | 驗證通過後再決定正式支援 |
| UA／Client Hints | 以本機假頁驗證無頭標記移除，不碰正式網站 | 降低 anti-bot 差異風險 |
| Profile 相容 | 文件化跨瀏覽器與跨版本 Profile 遷移限制 | 避免 Cookie／登入態異常 |
| 冒煙腳本 | 去除硬編 `/tmp`，改用 `os.tmpdir()` 或環境變數 | 讓三平台可用同一套驗收 |

### 7.2 相容性風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| Chromium 分支 Client Hints 行為不同 | 被識別為無頭或自動化 | 以本機 `tests/serve.mjs` 驗證 UA 與 brands；必要時分支特定處理 |
| Edge／Brave Profile 格式差異 | 登入態遷移失敗 | 文件化僅同家族遷移；不承諾跨瀏覽器相容 |
| macOS 權限或路徑不同 | 啟動或截圖失敗 | 補平台專屬驗證與錯誤訊息 |
| 新版 Chrome CDP 變更 | 部分指令或事件失效 | 固定最低／建議版本；新 major 先進 canary |
| 冒煙腳本改動 | 驗收基準本身失真 | 改動後在至少一台 Windows 與一台 Linux 重跑 |

### 7.3 驗證方式

```bash
# 1. 本機測試伺服器
node tests/serve.mjs &

# 2. 使用假資料與本機頁面的 Agent 批次腳本
tp-browser nodejs <<'EOF'
const task = await taskSpace("local-upgrade-validation");
const page = task.page("p1");
await page.goto("http://127.0.0.1:8899/", { waitUntil: "load" });
const ua = await page.evaluate(() => navigator.userAgent);
console.log("UA_OK", /HeadlessChrome/.test(ua) === false);
await task.finish({ keep: [] });
EOF

# 3. 冒煙測試（跨平台路徑後）
tp-browser nodejs < tests/smoke.ego.js
```

預期結果：本機頁面可導航、快照可取得；`UA_OK true`；冒煙測試在目標平台通過。

### 7.4 回滾方式

- 回復瀏覽器探測順序與啟動參數。  
- 以 `TP_BROWSER_BIN` 明確指定舊版瀏覽器。  
- 不覆寫使用者 Profile；必要時以備份 Profile 還原。

---

## 8. Phase 4 — Node.js 基線提升

### 8.1 變更內容

| 項目 | 變更 | 目的 |
|---|---|---|
| 最低 Node.js | 正式以 Node 22 為最低 | 與原生 WebSocket、`fetch`、`node:test` 行為對齊 |
| 優先 Node.js | Node 24 為主要驗證目標 | 與現有多數部署一致 |
| 較新 Node.js | Node 26 先 canary／advisory | 提前發現破壞性變更 |
| Node 20 | 不再列正式支援；文件標為舊世代 | 減少實驗旗標與分支行為 |
| wrapper／安裝器 | Node 版本閘與明確錯誤 | 避免不支援環境啟動後出現難解錯誤 |

### 8.2 相容性風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| Node 新 major 移除或變更 API | CDP、`fetch`、stream 行為異常 | canary 先跑完整測試；正式支援前觀察 |
| `--experimental-websocket` 移除 | Node 20 無法啟動 | 公告遷移期；錯誤訊息指引升級 |
| `engines` 提高但安裝器未檢查 | 使用者安裝後才失敗 | 安裝器與 wrapper 一併檢查 |
| 不同 Node 版本 JSON／WebSocket 細節差異 | 罕見競態或逾時 | 以本機測試伺服器與假頁重現，不用正式網站 |

### 8.3 驗證方式

```bash
# 在每個目標 Node 版本分別執行
node --version
node --check bin/tp-browser.js
node --test tests/
node --test fmb_feature2/

# 本機整合驗證
node tests/serve.mjs &
tp-browser nodejs < tests/smoke.ego.js
```

預期結果：Node 22、24 全數通過；Node 26 canary 若有失败僅列 advisory，並記錄為已知相容性問題。

### 8.4 回滾方式

- 調整 `engines` 與文件支援矩陣。  
- wrapper 可臨時恢復實驗旗標以支援 Node 20，但需列為暫時相容。  
- 不回退使用者 Profile 或瀏覽器版本。

---

## 9. 分階段依賴關係

```text
Phase 0 支援契約
   ├─> Phase 1 安裝供應鏈
   │        └─> Phase 2 啟動器清理
   │                 └─> Phase 3 瀏覽器矩陣
   │                          └─> Phase 4 Node 基線提升
   └─> 文件與測試矩陣可獨立先行
```

說明：Phase 0 是地基；Phase 1 讓升級可回滾；Phase 2 減少啟動歧義；Phase 3 擴大環境驗證；Phase 4 最後提高語言版本線。

---

## 10. 驗收門檻建議

| 階段 | 最小驗收門檻 |
|---|---|
| Phase 0 | 版本宣告一致；Node 22／24 測試通過；文件不再把 Node 20 列正式支援 |
| Phase 1 | 固定來源安裝成功；checksum 驗證生效；版本化切換可回滾 |
| Phase 2 | 啟動／停止腳本在隔離 HOME 通過；systemd unit 驗證通過；無重複 daemon |
| Phase 3 | Chrome／Chromium 矩陣通過；UA 無頭標記移除；冒煙腳本可在 Linux 與 Windows 執行 |
| Phase 4 | Node 22 最低線生效；Node 24 全綠；Node 26 已知問題文件化 |

---

## 11. 明確不做事項

- 不實際升級 Node.js、npm、Chrome、Edge、Brave、macOS、OS 套件。  
- 不修改 `package.json`、既有程式、安裝腳本、systemd unit、`.github/workflows`、secrets、git remote。  
- 不新增 npm runtime 或 dev dependency。  
- 不連接正式網站、套件 registry、瀏覽器正式服務或遠端 daemon。  
- 不讀寫 repo 以外的真實使用者資料；測試僅使用 `tmp_path`／`tempfile` 類型隔離目錄。  
- 不輸出或保存任何真實認證值；示例僅使用 `FAKE_VALUE_FOR_TEST`。

---

## 12. 需要 BOB 決策的事

1. **Node.js 最低線**：是否同意以 Node 22 為最低正式支援、Node 24 為優先、Node 26 僅 canary？  
2. **Node 20 棄用時程**：何時公告、遷移期多長、何時從 README 與安裝說明移除？  
3. **第一個正式 tag**：何時凍結 0.3.x 並建立第一個 `vX.Y.Z` tag，作為固定安裝來源？  
4. **版本號來源**：`package.json`、CLI `version`、發佈 tag 以哪一個為單一來源？  
5. **安裝回滾策略**：是否同意版本化目錄＋原子切換＋保留前一版為預設？  
6. **root／sandbox**：是否維持預設拒絕 root 下啟動 Chrome，並以顯式環境變數覆寫？  
7. **瀏覽器矩陣**：Chrome／Chromium 是否列正式支援；Edge／Brave／macOS 是否先列 best effort？  
8. **CI 必要關卡**：Node 測試、秘密掃描、相依掃描是否列為必要；E2E 冒煙何時從 advisory 升為必要？
