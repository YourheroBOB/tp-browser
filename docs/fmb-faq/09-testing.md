# 09 · 測試（Testing）

## Q43. 怎麼跑 23/23 冒煙測試（smoke suite）？

- **問題**：想驗證安裝環境功能完整。
- **原因**：需要標準驗收流程。
- **解法**：

  ```bash
  node tests/serve.mjs &          # 起本機測試網頁伺服器
  tp-browser nodejs < tests/smoke.ego.js
  # 預期輸出：== smoke: 23/23 pass == 與 ALL_GREEN
  ```

  這會使用 repo 內的本機測試伺服器與 `tests/testpage.html`，不連任何正式服務。
- **相關檔案**：`tests/serve.mjs`、`tests/smoke.ego.js`、`tests/testpage.html`、`README.md`

## Q44. 冒煙測試失敗，怎麼判斷是環境問題還是功能問題？

- **問題**：smoke 不是 23/23，想知道先查什麼。
- **原因**：smoke 依賴 daemon＋Chrome＋本機測試伺服器三者都在線。
- **解法**：依序檢查：(1) `tp-browser status` 是否 `{"ok":true,"chrome":true}`；(2) `node tests/serve.mjs` 是否真的在跑、埠未被占；(3) 失敗項目訊息——CDP 逾時偏向環境（Chrome 版本/啟動參數），DOM 斷言失敗偏向功能。也可參考 `docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md` 的驗收環境矩陣比對你的 Node／Chrome 版本。
- **相關檔案**：`tests/smoke.ego.js`、`tests/serve.mjs`、`docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md`、`STATE.md`

## Q45. 有哪些單元／整合測試可以跑？會不會連外網？

- **問題**：想在 CI 或本地跑自動化測試。
- **原因**：釐清測試範圍與邊界。
- **解法**：repo 內含多組測試，皆為**零網路、零正式服務、零真實憑證**設計：
  - `node --test fmb_feature2/`（reaper 單元、store 整合、CLI 乾跑；暫存檔用 `mkdtempSync(tmpdir())` 並於 `after()` 清除）
  - `node --test tests/test_fmb_*.test.mjs`（CDP、keys、profile-init、store 等）
  - `tests/fmb_integration_cli.test.mjs`
  測試中如需憑證一律用 `FAKE_VALUE_FOR_TEST` 之類明顯假值；不得連正式網站、不得讀寫 repo 以外路徑（用 tmp_path/tempfile）。
- **相關檔案**：`fmb_feature2/*.test.js`、`tests/test_fmb_cdp.test.mjs`、`tests/test_fmb_keys.test.mjs`、`tests/test_fmb_profile_init.test.mjs`、`tests/test_fmb_store.test.mjs`、`tests/fmb_integration_cli.test.mjs`

## Q46. 想加自己的測試，有什麼邊界與慣例要遵守？

- **問題**：貢獻測試時怕踩到專案紅線。
- **原因**：本專案明文的安全與測試邊界。
- **解法**：
  1. 只用本機測試伺服器（仿 `tests/serve.mjs`）或 `file://` 頁面，不連正式服務。
  2. 暫存資料一律 `tmpdir()`／`mkdtempSync`，測試結束清理。
  3. 假憑證用 `FAKE_VALUE_FOR_TEST`，不得出現任何真實格式的 token 前綴。
  4. 不把真實 cookie、登入資料、客戶或案件內容放進 fixture。
  5. 維持零 npm 依賴：測試用 Node 內建 `node:test`／`node:assert` 即可（見 `fmb_feature2` 各測試）。
- **相關檔案**：`fmb_feature2/reaper.test.js`、`fmb_feature2/store-integration.test.js`、`fmb_feature2/cli.test.js`、`tests/serve.mjs`
