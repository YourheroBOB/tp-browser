# 相依套件與執行環境風險登錄

> 分級反映升級前需要處理或監測的程度，不代表已證實存在可直接利用的漏洞。風險評估只依本次提供的 source 與歷史文件，未連線 vulnerability database、套件 registry 或正式服務。

## 1. 評估方法

- **高**：可能造成廣泛無法啟動、供應鏈完整性破口、使用者資料不相容或難以回滾。
- **中**：影響特定平台、版本或部署流程，但不必然阻擋全部使用者。
- **低**：影響範圍有限，且已有明確、可低成本的驗證方式。
- 「無已知 npm CVE」只能描述目前 manifest 沒有第三方 npm dependency；不能推論 Node.js、瀏覽器或 OS 沒有漏洞。

## 2. 風險登錄表

| ID | 風險與證據 | 可能影響 | 等級 | 主要緩解／對應階段 |
|---|---|---|---|---|
| R-01 | Node.js 支援契約漂移：manifest 為 `>=22`，README 與歷史環境仍含 Node.js 20 | 使用者在 `engines` 只提示不阻擋的情況下安裝到不支援 runtime | 高 | 統一正式契約、明確遷移訊息、runtime guard；Phase 1 |
| R-02 | 沒有可靠的 Node.js 版本啟動檢查 | 錯誤症狀延後到 WebSocket 建立時才出現，除錯困難 | 高 | CLI、daemon、installer 與 systemd 啟動前檢查；Phase 1 |
| R-03 | 遠端 installer 以預設分支下載程式碼 | 同一版本標籤可能取得不同內容，且缺少 artifact integrity 驗證 | 高 | 固定 tag＋不可變 commit、checksum／簽章、離線 artifact；Phase 3 |
| R-04 | installer 先移除既有 runtime 再複製新檔 | 複製失敗可留下半套安裝，難以立即回復 | 高 | staging 目錄、健康檢查通過後原子切換；Phase 3 |
| R-05 | 沒有正式 browser support matrix | Edge、Brave、macOS 或較舊 Chromium 可能被誤認為與 Chrome 等價 | 高 | 定義 qualified／best-effort 狀態並分矩陣驗證；Phase 4 |
| R-06 | Chrome/Chromium Profile 格式會隨 major 改版 | Profile 啟動失敗、資料不可讀、復原複雜 | 高 | 升級前隔離備份、migration smoke、受控復原；Phase 4 |
| R-07 | CDP client 是自製 Node.js native WebSocket 實作 | Node.js major 或瀏覽器 CDP 行為改變時，可能出現 session、timeout、斷線或訊息解析差異 | 中高 | contract test、fault injection、Node major canary；Phase 2、5 |
| R-08 | package 與 CLI 版本不一致 | 升級、回滾與事故判讀可能針對錯誤 artifact | 中 | 單一版本來源，build/release gate 檢查；Phase 2 |
| R-09 | 無 package scripts、無 lockfile、未見可重現 CI 入口 | 測試入口依賴人工命令，新增工具後容易產生 dependency drift | 中 | 定義 npm scripts、lockfile、local CI matrix；Phase 2 |
| R-10 | `pkill -f` 與 PowerShell command-line matching 的終止範圍較寬 | 升級／回滾時可能終止非目標 Node.js、browser 或其他 profile 程序 | 高 | 以 release ID、exact PID／service unit 管理；Phase 3、6 |
| R-11 | ledger 沒有 schema version；載入失敗時會以空資料重新開始，寫入 fallback 也可能失去 atomic rename | 跨版本並行或異常重啟可能造成 ledger 遺失或狀態不一致 | 中高 | 先備份、加入 schema migration 與讀取失敗 fail-closed；Phase 2、3 |
| R-12 | 歷史環境含較新的 Node.js major，但非正式驗證矩陣 | 新 major 的行為差異可能只在部分 OS 發生 | 中 | Node.js 26 canary，保留 Node.js 22 fallback；Phase 5 |
| R-13 | wrappers 仍傳遞 `--experimental-websocket` | 未來 Node.js 若不再接受此 flag，所有 wrapper 可能同時失效 | 中 | Node.js 22+ 驗證後移除，保留單一啟動 helper；Phase 1、5 |
| R-14 | 瀏覽器、Node.js、OS shared libraries 都是高風險外部 runtime | 即使 npm tree 為空，仍可能有產品層漏洞 | 中高 | 供應商 advisory monitoring 與定期 patch；Phase 4、6 |
| R-15 | macOS、Edge、Brave 缺乏與 Chrome/Chromium 同等證據 | 跨平台 bug 可能在升級後才暴露 | 中高 | 補齊 qualification，不以單一 OS 結果類推；Phase 4 |
| R-16 | Windows／POSIX／WSL2 的安裝與 process lifecycle 不對稱 | 同一升級在不同平台可能有不同結果 | 中 | 平台專屬 test fixture 與相同 release gate；Phase 2、4 |
| R-17 | `tools/profile-init.js` 會處理可能含登入態與個人資料的瀏覽器資料 | 測試或備份若未隔離，可能造成敏感資料外洩 | 高 | 測試只用合成 Profile、暫存目錄、 restrictive permissions；全期門檻 |
| R-18 | 零 npm dependency 是優勢，但未形成正式維護政策 | 未來工程師可能任意加入套件，破壞可重現性 | 低 | 將零 runtime dependency 寫入 contributing／release gate；Phase 0、2 |

## 3. 已知過時或待確認項目

### 3.1 Node.js 20

- repository 仍記載 Node.js 20.19.2 的歷史執行環境。
- manifest 已要求 Node.js 22，systemd 也不提供實驗 WebSocket flag，因此 Node.js 20 並非一致支援的環境。
- Node.js 20 已屬舊 major；在正式文件仍鼓勵使用時，會讓使用者以為可取得維護與相容性保證。

**建議**：正式支援終止 Node.js 20，但提供明確診斷與遷移說明；不提供隱式下載或自動安裝其他 Node.js 版本。

### 3.2 `--experimental-websocket`

Node.js 22+ 已提供正式 global `WebSocket`。保留實驗旗標會：

1. 混淆目前最低版本契約。
2. 讓 Node.js 20 看起來像正式支援。
3. 增加未來 Node.js major 不再接受該旗標時的共同故障點。

**建議**：先在 Node.js 22、24 與 canary matrix 驗證，再由單一 helper 產生 `node` 命令；不要在多份 script 中各自維護 flag。

### 3.3 Node.js 26

Node.js 26 是可用於測試的新 major，但不是當然取代 Node.js 22 的理由。應先確認：

- Node.js 生命週期與組織支援政策。
- global WebSocket、fetch、SSE、child process 與 Windows quoting 行為。
- installer、daemon restart 與 browser smoke。
- npm／lockfile 工具鏈在新版 npm 的相容性。

### 3.4 Chrome／Chromium／Edge／Brave

瀏覽器是本專案最重要的非 Node.js runtime。即使 npm 相依為零，瀏覽器仍可能包含：

- renderer／browser process 漏洞。
- CDP method 或事件行為變更。
- headless command-line flag 變更。
- Profile schema 與 cookie／local storage migration 變更。

目前歷史版本集中在 Chrome/Chromium 150–155，但這只能證明當時有紀錄，不能形成穩定的支援範圍。

### 3.5 npm vulnerability posture

目前 manifest 沒有第三方 npm package，因此沒有 npm dependency tree 可升級，也沒有一般 npm transitive dependency CVE 需要在此階段修正。這是正面結果，但下列項目不能被遺漏：

- Node.js 內建 `http`、`crypto`、`fs`、`net` 與 WebSocket 實作的 runtime advisory。
- Chromium-family browser advisory。
- OS 與其 shared libraries。
- installer 下載來源與 build artifact。
- 未來新增的 npm tooling。

## 4. 供應鏈風險細節

### 4.1 遠端安裝來源

目前 POSIX 與 PowerShell installer 在非 local checkout 情境可執行淺層 clone，沒有固定 commit、tag 或 artifact checksum。這會造成：

- 同一份 installer 在不同時間安裝不同內容。
- 無法以 checksum 驗證下載內容。
- 上游預設分支變更可能直接影響安裝者。
- 回滾時無法可靠指定原始 commit。

**建議**：local checkout、離線 artifact、遠端 release 三種模式都必須記錄 release ID、來源 commit 與 artifact checksum；不得把遠端預設分支當作可重現依賴。

### 4.2 非原子安裝

目前安裝器會先移除既有 runtime 目錄，再複製新檔。即使複製失敗，也可能無法回到前一版。應改成：

1. 複製到新的 staging 目錄。
2. 驗證檔案完整性、必要檔案與語法。
3. 在 staging runtime 啟動本機自我檢查。
4. 原子切換 current release。
5. 保留至少一版舊 runtime。

### 4.3 Profile 與程式分離

瀏覽器 Profile 必須獨立於版本化 runtime 保存。升級時：

- 不把 Profile 當成可由 npm reinstall 重建的 artifact。
- 不將 Profile 複製到 CI artifact、log 或 issue。
- 升級失敗時，程式可先回滾；只有 Profile 確實不相容時才使用受控備份復原。
- Profile 備份只能在同一台受控主機、限制權限的暫存／備份位置操作。

## 5. 相容性風險邊界

| 邊界 | 可能不相容項目 | 建議驗證 |
|---|---|---|
| Node.js 20 → 22 | global WebSocket、CLI 的 `engines` 行為、npm engine warning | 在隔離環境以 Node.js 22 執行全部 unit/integration test |
| Node.js 22 → 24／26 | WebSocket、fetch、child process、ESM、Windows path quoting | 同一 test matrix 與 daemon restart／SSE reconnect |
| Chrome/Chromium major | headless flags、CDP events、Profile schema | 本機 test page、23-case smoke、Profile restart test |
| Edge/Brave | binary discovery、launcher flags、CDP 細節 | 獨立 qualification，不直接沿用 Chrome 結果 |
| macOS | shell、browser path、PATH、background process | 獨立 host／VM 的 install/start/stop/rollback |
| installer | destination layout、PATH、service、wrapper quoting | 隔離 HOME／使用者資料目錄的全新安裝與升級 |
| ledger | JSON schema、跨版本並行讀寫 | migration、malformed JSON、concurrent restart test |

## 6. 風險接受門檻

下列任一情況出現時，不應進入下一階段：

- 新 runtime 無法在最低支援版本啟動。
- 任一既有 unit／integration test 失敗且原因未分類。
- 測試連線到非 loopback 位址或正式服務。
- 測試讀寫 repo 以外的非暫存路徑。
- 測試輸出含實際瀏覽器資料、認證值或個人資料。
- 升級後無法一鍵回到前一版 runtime。
- Chrome/Chromium 升級造成 Profile 無法重新開啟，且沒有隔離備份。
- installer 在複製失敗後留下不可啟用的 current release。
- release ID、package version、CLI version 或 checksum 無法互相對應。
