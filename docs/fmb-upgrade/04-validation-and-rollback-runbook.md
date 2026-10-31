# 驗證與回滾 Runbook

> 本 runbook 供未來真正的升級 PR 使用。本次任務只新增文件，未執行下列 runtime 升級或正式服務測試。

## 1. 測試安全規則

1. 測試 daemon 與瀏覽器只能綁定 `127.0.0.1`。
2. 功能測試只能使用 repository 內的本機測試頁／測試伺服器。
3. 不得連線正式網站、正式 daemon、正式 browser profile 或任何外部 API。
4. 所有暫存檔案、ledger、合成 Profile 與 test-only data root 必須位於 `tmp_path`／`tempfile` 建立的暫存目錄。
5. 測試完成後清除暫存目錄。
6. 測試若需要認證值，一律使用 `FAKE_VALUE_FOR_TEST`，不得使用真實格式前綴或正式值。
7. 測試輸出不得包含 URL query、title、頁面文字、cookie、headers、認證 header、畫面、輸入內容或瀏覽器 Profile。
8. 不得在 real user home、正式 service data root 或 repo 以外的持久路徑建立測試資料。

## 2. 建議測試層級

| 層級 | 內容 | 網路 | 瀏覽器 | Node.js 22 | Node.js 24 | Node.js 26 canary |
|---|---|---|---|---:|---:|---:|
| Static | JSON parse、版本一致性、JS syntax、shell／PowerShell parse | 無 | 無 | 必須 | 必須 | 必須 |
| Unit | ledger、CDP helper、key mapping、SDK pure behavior | 無 | 無 | 必須 | 必須 | 必須 |
| Local integration | daemon、HTTP/SSE、loopback CDP、故障注入 | 僅 loopback | 需要 | 必須 | 必須 | 必須 |
| Browser smoke | 本機頁面導覽、evaluate、分頁、browser restart | 僅 loopback | 需要 | 必須 | 必須 | canary |
| Installer | 全新安裝、升級、失敗、回滾 | 僅 artifact source 或離線 | 視情況 | 必須 | 必須 | canary |
| Profile migration | 合成 Profile 開啟、關閉、重啟 | 僅 loopback | 需要 | 必須 | 必須 | canary |
| Rollback drill | 候選版切換後立即回復前一版 | 僅 loopback | 需要 | 必須 | 必須 | canary |

## 3. 目前可採用的本機命令

下列命令不應連線正式服務。部分 browser integration 必須先提供隔離 data root 與合成 Profile。

### 3.1 文件與 manifest 靜態檢查

```bash
node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log('package-json-ok')"
node -p "JSON.stringify({node:process.version,modules:process.versions.modules,v8:process.versions.v8,uv:process.versions.uv}, null, 2)"
```

POSIX 環境可選擇性執行 JavaScript syntax check：

```bash
find . -type f \( -name '*.js' -o -name '*.mjs' \) \
  -not -path './node_modules/*' -print0 |
  xargs -0 -n1 node --check
```

Windows 與 POSIX 必須各自確認 shell／PowerShell 語法，不能只依賴 POSIX parser。

### 3.2 零外部依賴單元測試

```bash
node --test fmb_feature2/
```

此測試群使用暫存目錄，不需瀏覽器或網路。

### 3.3 Repository 測試群

```bash
node --test tests/
```

執行前必須確認：

- 測試只使用 loopback。
- 測試 runtime data root 指向暫存目錄。
- 不會載入 real user Profile。
- 不會使用正式服務。

### 3.4 未來標準化入口

Phase 2 完成後，應以固定入口取代人工判斷：

```bash
npm run test:unit
npm run test:integration
npm run test:smoke
npm run test:all
```

`npm test` 也應指向相同 unit suite，避免不同文件使用不同命令。

## 4. Node.js 驗證矩陣

### 4.1 最低版本 Node.js 22

必測項目：

- CLI `version`、`doctor`、`status` 的無副作用失敗路徑。
- daemon 啟動、loopback health、CDP attach。
- native WebSocket connect、send、timeout、close、pending rejection。
- HTTP/SSE 讀取與 daemon restart 後重連。
- CLI `nodejs` 暫存 script 的建立、執行、清除。
- POSIX launcher、Windows launcher、systemd unit。
- browser restart 後 target 重新綁定。
- ledger 正常寫入、重啟後載入與 malformed JSON fail-closed。
- 跨版本 release rollback。

### 4.2 優先版本 Node.js 24

執行與 Node.js 22 相同的完整 suite，另外檢查：

- `node:test` discovery 與 timeout 行為。
- child process detached／exit code。
- Windows drive-letter dynamic import。
- 移除 `--experimental-websocket` 後所有 wrapper。
- npm package manager／lockfile 行為。

### 4.3 Canary Node.js 26

- 不做自動 rollout。
- 記錄 warning 分類，不允許未分類的 process crash 或資料寫入錯誤。
- 若只影響 canary，維持 Node.js 22/24 正式路徑不變。

## 5. Browser 驗證矩陣

| Browser | 最低 qualification 建議 | 測試重點 |
|---|---|---|
| Chrome／Chromium stable | 目前 major 與前一 major | headless flags、CDP、Profile schema、local smoke |
| Chrome／Chromium canary | 可選 | 提前發現下一 major 行為變更，不作正式支援宣稱 |
| Edge stable | 完成獨立測試前 best effort | discovery、command-line flags、CDP、Profile |
| Brave stable | 完成獨立測試前 best effort | discovery、command-line flags、CDP、Profile、process cleanup |
| macOS browser | 完成獨立主機／VM 測試前 best effort | app path、PATH、background process、permission |

### 5.1 瀏覽器功能測試

- Browser version 可被本機辨識。
- CDP endpoint 僅位於 loopback。
- 新分頁、關閉分頁、切換 target。
- `Runtime.evaluate` 成功與失敗回應。
- Network timeout。
- Browser restart 後 daemon 重新連線。
- Headless 與 headed 在支援平台各測一次。
- WSL2/Windows 同時存在時，port pair 與 process cleanup 不互相干擾。

### 5.2 Profile 測試

Profile fixture 必須是合成資料，只包含測試文字、空白目錄及假 metadata。驗證：

1. 舊 major 建立合成 Profile。
2. 升級至新 major。
3. 新 major 可開啟 Profile。
4. 基本本機 smoke 通過。
5. 關閉並重新開啟仍成功。
6. rollback 至舊 major；若舊 major 無法讀新格式，使用隔離備份復原。

## 6. 安裝與 artifact 驗證

### 6.1 全新安裝

- 將 HOME／data root 指到暫存目錄。
- 驗證必要檔案、權限、wrapper、PATH 與 service unit。
- 驗證 CLI／daemon 可啟動。
- 驗證不讀取 real user Profile。

### 6.2 升級

- 先安裝 release N。
- 收集非敏感的 version／health baseline。
- 安裝 release N+1 到 staging。
- 驗證 checksum、syntax、local self-check。
- 切換 current。
- 執行 smoke。
- 不切換前不得刪除 release N。

### 6.3 失敗注入

| 故障 | 預期結果 |
|---|---|
| artifact 不存在 | 舊 release 保持可啟動 |
| checksum 不符 | 在寫入 current 前中止 |
| staging 複製中斷 | current 不變 |
| 檔案缺少必要 entry point | 不切換 current |
| daemon 啟動失敗 | 自動或人工切回舊 release |
| browser 啟動失敗 | 程式可回滾；Profile 依實際不相容判定處理 |
| ledger 格式錯誤 | 不覆寫原資料，顯示明確錯誤 |
| rollback switch 失敗 | 保留兩個 release 與人工 recovery 說明 |

## 7. Release acceptance gate

候選 release 必須同時滿足：

- [ ] Node.js 22 與 24 正式 matrix 通過。
- [ ] Node.js 26 若為 canary，其結果已分類且不阻擋一般 release。
- [ ] 所有 unit／integration／smoke 測試通過。
- [ ] 測試沒有非 loopback 網路連線。
- [ ] 測試沒有 repo 外的非暫存寫入。
- [ ] package／CLI／release version 一致。
- [ ] artifact checksum 驗證成功。
- [ ] 全新安裝、升級與 rollback 都成功。
- [ ] 上一版 runtime 仍可用且未被覆寫。
- [ ] Chrome/Chromium qualified major 通過。
- [ ] Edge/Brave/macOS 的保證層級已明確揭露。
- [ ] 合成 Profile 升級與 rollback 通過。
- [ ] release notes 不含敏感資料。
- [ ] 沒有未分類的高風險失敗。

## 8. Rollback drill

### 8.1 演練目的

驗證候選 release 出錯時，可在不接觸正式服務、不破壞資料的情況下回復穩定 runtime。

### 8.2 步驟

1. 記錄目前穩定 release ID 與其 health 結果。
2. 在隔離環境安裝候選 release。
3. 執行至少一項刻意失敗，例如 daemon 啟動失敗或 browser attach 失敗。
4. 確認候選 failure 沒有覆寫穩定 release。
5. 停止候選程序；只停止候選 release 的 exact PID／service unit。
6. 將 current 指標切回穩定 release。
7. 執行 CLI version、daemon health 與本機 smoke。
8. 確認 ledger 可讀；若有變更，使用相容備份驗證，不先破壞現有資料。
9. 記錄：
   - 失敗階段。
   - 錯誤分類。
   - 回復耗時。
   - 是否需要資料復原。
   - 是否有敏感資訊被意外記錄；若有，立即停止 rollout 並清理。

### 8.3 Rollback 成功條件

- 穩定 release 再次可啟動。
- 沒有非目標程序被終止。
- 沒有使用真實或外部 Profile。
- 測試資料只存在暫存目錄並已清除。
- 失敗候選的資料没有被誤當成穩定資料。
- 觀察事件不包含敏感內容。

## 9. 升級證據紀錄模板

每次候選 release 應保存下列非敏感資料：

```text
release-id:
package-version:
cli-version:
node-version:
os-family:
os-release:
browser-family:
browser-version:
artifact-checksum:
test-matrix-result:
local-health-result:
rollback-result:
warnings-classification:
notes:
```

不得加入：

- 使用者名稱、主機名稱或可識別路徑。
- Token、金鑰、密碼、cookie、session、認證 header。
- LINE 訊息或案件內容。
- 客戶、當事人或瀏覽器內的任何資料。
- 正式服務 URL、query 或 response body。

## 10. 本次文件的驗證狀態

- 本次只新增 `docs/fmb-upgrade/` 下的 Markdown。
- 未修改 runtime、package manifest、installer、service unit 或 workflow。
- 未實際升級 Node.js、瀏覽器、OS 套件或 npm dependency。
- 未連線正式服務，未使用真實 Profile 或認證值。
- 既有測試結果應由套用本次文件的 CI 重新確認；本文不宣稱已執行測試。
