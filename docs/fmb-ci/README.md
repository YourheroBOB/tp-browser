# tp-browser CI／品質關卡提案（總覽）

> **文件狀態**：提案。本文與本目錄其他文件**只提供設計與可直接採用的設定範本**（以 Markdown 程式碼區塊呈現），
> 依本輪任務規則**不建立任何 workflow 檔、不修改 `.github/`、不修改任何既有檔案**。
> **盤點基準**：預設分支內容快照；未連線任何正式服務、registry 或瀏覽器。
> **安全邊界**：本文不含任何實際 token、金鑰、密碼、客戶資料或案件內容；示例憑證一律使用 `FAKE_VALUE_FOR_TEST`。

## 一頁結論

1. **零 npm 相依是本專案最大賣點，CI 也應以此為第一原則**：第一階段（Phase 0）全部使用 Node.js 內建工具
   （`node --check`、`node --test`、`node --test --experimental-test-coverage`），**不新增任何 devDependency**。
2. **既有測試資產已可直接上 CI**：`fmb_feature2/`（`node --test fmb_feature2/`）與 `tests/*.test.mjs`
   皆為零依賴、零網路、暫存檔使用 `tmpdir()` 的設計，可直接作為 PR 必過關卡。
3. **需要真實 Chrome 的冒煙測試（`tests/smoke.ego.js` 23/23）不應在第一階段就設為必要關卡**：
   先以「advisory（建議性）」身分跑在 GitHub-hosted runner（預裝 Chrome）＋repo 內本機測試伺服器
   （`tests/serve.mjs`），穩定後再升級為必要關卡（需 BOB 決策）。
4. **秘密掃描（gitleaks）與相依掃描（osv-scanner／`npm audit`）成本極低、收益極高**，建議第一天就上，
   並設為必要關卡。
5. **建置／發佈關卡核心是「版本一致性」與「可重現安裝」**：目前 `package.json` 為 `0.3.0`、CLI `version`
   指令輸出 `0.3.1`，且 `install.sh` / `install.ps1` 會 `git clone` 預設分支（浮動來源）。發佈前必須先統一
   版本號並改為固定 tag 安裝（另見 `docs/fmb-upgrade/`）。

## CI 管線總覽

```
PR / push
  │
  ├─ [必要] L1 語法與靜態檢查      node --check 全量 .js/.mjs（零依賴）
  │             shellcheck *.sh（runner 內建或單一二進位，非 npm 套件）
  │
  ├─ [必要] L2 單元測試＋覆蓋率報告  node --test tests/ fmb_feature2/
  │             node --test --experimental-test-coverage（報告制，暫不設硬門檻）
  │
  ├─ [必要] L3 秘密掃描             gitleaks（含本 repo 專用 allowlist）
  │
  ├─ [必要] L4 相依掃描             npm audit（零相依 ⇒ 應為 trivial pass）
  │             osv-scanner（掃系統／非 npm 面向：Node 版本、安裝腳本引用）
  │
  ├─ [建議] L5 型別檢查             tsc --checkJs（Phase 1，選擇性 devDep，advisory 起步）
  │
  ├─ [建議] L6 E2E 瀏覽器冒煙       runner 預裝 Chrome + tests/serve.mjs，僅 127.0.0.1
  │
  └─ [tag 觸發] 發佈關卡            版本一致性檢查 → 打包 → SHA256 checksum → GitHub Release
```

## 文件地圖

| 文件 | 內容 |
|---|---|
| [`01-lint-and-style.md`](./01-lint-and-style.md) | 語法檢查、ESLint（選擇性）、shellcheck、PowerShell 檢查方針與 workflow 範本 |
| [`02-type-check.md`](./02-type-check.md) | `tsc --checkJs` 型別檢查提案、`jsconfig.json` 範本、階段導入策略 |
| [`03-tests-and-coverage.md`](./03-tests-and-coverage.md) | 測試分類、`node --test` 指令、覆蓋率策略與 workflow 範本 |
| [`04-security-scans.md`](./04-security-scans.md) | gitleaks 設定與範本、`npm audit`／osv-scanner、安裝腳本供應鏈檢查 |
| [`05-build-and-release.md`](./05-build-and-release.md) | 版本一致性 gate、tag 發佈、checksum 與 workflow 範本 |

## 分階段導入

| 階段 | 內容 | 新增 devDependency | 關卡性質 |
|---|---|---|---|
| **Phase 0（建議立即）** | L1＋L2＋L3＋L4 | **0**（全用 Node 內建與單一二進位掃描器） | 全部必要 |
| **Phase 1（穩定後）** | ＋L5 型別檢查、ESLint | `typescript`（僅 dev，advisory 起步） | advisory → 視情況升必要 |
| **Phase 2（需 BOB 同意）** | ＋L6 E2E 升必要、分支保護與 required checks 設定 | 0 | 需 repo 設定權限 |

## 與既有文件的關係

- 升級／支援矩陣（Node 22 基線、Node 24 優先、Node 26 canary）見 `docs/fmb-upgrade/`；本提案的 CI 矩陣
  直接沿用該結論（Node 22 必測、24 必測、26 選擇性）。
- 安全基準沿用 `docs/fmb-security/` 與 `docs/fmb-api/README.md` 的「文件示例一律用假值」原則，
  掃描器 allowlist 亦以此設計。

## 本次採用的保守決策（摘要，詳見各文件）

| 項目 | 保守預設 | 理由 |
|---|---|---|
| devDependency | Phase 0 為 **0** | 維持零相依賣點；`package.json` 目前無任何 dep 欄位 |
| 覆蓋率 | 報告制、不設硬門檻 | 內建 coverage 尚無穩定 threshold 機制；先建立基準線 |
| E2E 冒煙 | advisory，不擋 PR | 依賴 Chrome 環境，先觀察穩定性 |
| 型別檢查 | advisory 起步 | 約 2,000 行既有程式未帶 JSDoc 型別，一次開嚴會全面失敗 |
| 發佈 | 僅從 `vX.Y.Z` tag 觸發 | 避免誤發；版本一致性 gate 先修 `0.3.0`/`0.3.1` 漂移 |
| required checks／分支保護 | 不在本輪設定 | 涉及 repo 設定權限，需 BOB 親自操作 |
