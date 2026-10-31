# 04 · Agent 腳本開發（`tp-browser nodejs`）

## Q17. Windows 上腳本拋 `ERR_UNSUPPORTED_ESM_URL_SCHEME (Received protocol 'c:')`？

- **問題**：在 Windows 執行 `tp-browser nodejs` 時出現 ESM URL scheme 錯誤。
- **原因**：Node.js 的動態 `import()` 在 Windows 上不接受 `C:\...` 這種路徑字串，必須先轉成 `file://` URL。
- **解法**：已修——CLI 把使用者腳本寫進暫存檔後以 `import(pathToFileURL(tmp).href)` 載入（見 `STATE.md` 工程突破第 1 點）。若你在自己的程式裡動態載入 Windows 路徑模組，請比照使用 `pathToFileURL`。
- **相關檔案**：`bin/ego-browser.js`、`bin/tp-browser.js`

## Q18. 從 PowerShell 管線餵腳本出現奇怪的第一行語法錯誤？

- **問題**：stdin 餵入的腳本第一行報 `Unexpected token` 之類錯誤。
- **原因**：PowerShell 管線輸出常帶 UTF-8 BOM（`\uFEFF`），ESM 解析器視之為非法字元。
- **解法**：CLI 已自動剝除開頭 BOM（`code.replace(/^\uFEFF/, '')`）。若仍發生，檢查你的腳本來源編碼，或改用 `-e 'code'` 直接傳字串。
- **相關檔案**：`bin/ego-browser.js`、`bin/tp-browser.js`

## Q19. 腳本跑完了，`tp-browser nodejs` 卻不結束？

- **問題**：最後一行都執行完了，程序還掛著。
- **原因**：SDK 的 SSE 事件串流（`waitPush`）會讓 Node 事件循環持續運作；CLI 程序必須顯式 `process.exit()`。
- **解法**：CLI 端已處理（執行完後 `process.exit(exitCode)`）。若你自己寫的長駐腳本掛在同樣的 client 上並希望結束，需自行管理（關閉串流或 `process.exit`）。
- **相關檔案**：`bin/ego-browser.js`、`lib/sdk.js`

## Q20. 操作逾時：`xxx timed out after 30000ms` 或 CDP 事件等待失敗？

- **問題**：`page.goto`、`evaluate` 或事件等待拋逾時錯誤。
- **原因**：CDP client 的每個 `send()` 預設 30 秒逾時、`once()` 事件等待也是 30 秒；連線建立則是 15 秒。頁面載入慢、目標元素遲不出現、或分頁已被關閉都會觸發。
- **解法**：
  - 在腳本內對長時間操作做分段等待／輪詢，而不是一次等到底。
  - 確認操作的分頁仍在（targetId 未失效，見 Q33）。
  - 開發者若直接使用 `daemon/cdp.js`，`send()` 與 `once()` 都可傳 `timeout` 選項調整。
- **相關檔案**：`daemon/cdp.js`、`lib/sdk.js`、`docs/fmb-api/README.md`

## Q21. `tp-browser nodejs` 直接執行（TTY）報錯要求 -e 或 heredoc？

- **問題**：在互動終端機直接打 `tp-browser nodejs` 被拒。
- **原因**：腳本**只**經由 `-e "code"` 或 stdin（heredoc／管線）傳入，刻意不從 argv 檔案路徑載入（安全設計）；偵測到 stdin 是 TTY 時會以退出碼 2 拒絕。
- **解法**：

  ```bash
  tp-browser nodejs -e 'const t = await taskSpace("demo"); ...'
  # 或
  tp-browser nodejs <<'EOF'
  ...完整腳本...
  EOF
  ```

- **相關檔案**：`bin/ego-browser.js`、`bin/tp-browser.js`

## Q22. `page.evaluate` 抓到的內容是空的／少了下半頁？

- **問題**：萃取出的 `innerText` 缺後段內容。
- **原因**：目標頁面使用懶加載（lazy loading），未捲動到位的內容根本沒載入。
- **解法**：在 `evaluate` 內先捲動再等待，這正是「單 Turn 批次 JS」的典型用法（README 範例）：

  ```js
  const data = await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 500));
    return { text: document.body.innerText };
  });
  ```

  需要更完整的破懶加載流程可參考 `tests/smoke.ego.js` 的實際做法。
- **相關檔案**：`README.md`、`tests/smoke.ego.js`、`skills/tp-browser/SKILL.md`
