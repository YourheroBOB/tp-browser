# TP SDK 與單回合腳本

回到 [SKILL.md](../SKILL.md)。啟動與跨節點命令見 [platforms.md](platforms.md)。交出操控後的錯誤見 [troubleshooting.md](troubleshooting.md)。

token 節省數字只以 SKILL.md description 那一句為準，這裡不另寫百分比。

## Core Pattern: Single-Turn Batch JS

Traditional Playwright MCP / Computer Use tools operate 1 action per LLM turn (`goto` → full DOM snapshot → `scroll` → full DOM snapshot), burning millions of tokens.
With **`tp-browser nodejs`**, you submit a **complete async JavaScript workflow in a single Turn** via stdin Heredoc (`goto` + scroll loop to defeat lazy-loading + DOM extraction + file write), returning only the final clean output to stdout.

檔案進入點見 [SKILL.md](../SKILL.md)。完整 heredoc：

```bash
tp-browser nodejs << 'EOF'
const ts = await taskSpace("my-task");
const p = ts.page("p1");
try {
  await p.goto("https://example.com");
  await sleep(1000);

  // Scroll loop to defeat virtual scrolling / lazy-loading
  for (let i = 0; i < 5; i++) {
    await p.evaluate(() => window.scrollBy(0, 1500));
    await sleep(400);
  }

  const data = await p.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 50000)
  }));
  console.log(JSON.stringify(data, null, 2));
} finally {
  // Close temporary tab when done (omit closePage if leaving login page open for human!)
  await ts.closePage("p1");
}
EOF
```

> **IMPORTANT when opening a login page for the human user**:
> 1. Run `tp-headed` (or `ssh rog "tp-headed"`) first so the GUI window is visible on the desktop.
> 2. In your `tp-browser nodejs` script, navigate `await p.goto("https://...")` and **do NOT call `ts.closePage("p1")`** in `finally` if you want the tab to stay open on screen for the human user to log in!
> 3. Then `await ts.handOff()` and stop. The human logs in on that window.

## SDK Reference (Globals Available Inside `tp-browser nodejs`)

### TaskSpace & Tab Management

- `const ts = await taskSpace("name")` — Get or create an isolated TaskSpace (comes with default tab `"p1"`).
- `const p1 = ts.page("p1")` — Reference an existing labeled page in the TaskSpace.
- `const p2 = await ts.newPage()` — Open an additional tab (`p2`, `p3`, ...) in the TaskSpace.
- `await ts.tabs()` — List all open tabs in the TaskSpace.
- `await ts.closePage("p1")` / `await ts.finish({ keep: [] })` — Close a specific tab or finish the TaskSpace. `page.close()` 與 `closePage` 相同，會真的關掉分頁。
- `await ts.handOff()` — 把這個工作區交給人（`ownership` 成為 user）。代理停手。
- `await ts.waitForControl({ timeout })` — **會真的等待**到人交還操控才返回。`timeout` 預設 30 分鐘。逾時丟 `TimeoutError`。重新 `taskSpace()` 同一個工作區不會把人的操控搶回來。
- `await ts.takeOver()` — 代理取回操控（`state` 回到 active）。

`handOff` 之後，驅動頁面或讀取頁面內容的操作丟 `HandedOffError`（含 `goto`、`snapshot`、`click`、`fill`、`close`／`closePage`）。仍可讀分頁中繼資料：`url`、`title`、`info`、`events`。要關分頁請先 `waitForControl` 或 `takeOver`，或直接 `finish`（工作區層級，不走頁面操作）。

### Page Navigation & Extraction

- `await p.goto(url, { waitUntil: "load", timeout: 30000 })` — Navigate to URL.
- `await p.text({ maxChars: 100000 })` — Extract visible `document.body.innerText`.
- `await p.evaluate((arg) => { ... }, arg)` — Execute arbitrary JS in page context and return serializable result.
- `await p.snapshot()` — Get compact accessibility/DOM snapshot with `@N` interactive element refs.
- `await p.screenshot({ path: "relative-name.png" })` — Save PNG screenshot inside workspace.

### Page Interactions

- `await p.click(selector)` — Supports CSS (`#id`, `.btn`), `@N` (`ref=N` from snapshot), `text=Submit`, `loc=role:button[name="Save"]`, `xpath=...`.
- `await p.fill(selector, value)` — Clear and fill an input/textarea.
- `await p.press(selector, "Enter")` / `await p.keyboard.press("Escape")` / `await p.keyboard.type("hello")`.
- `await p.mouse.click(x, y)` / `await p.mouse.wheel(0, 1200)`.
- `await p.setInputFiles("@N", ["relative/file.pdf"])` — Upload files to `<input type="file">`.
- `await p.cdp(method, params)` — Direct Chrome DevTools Protocol call on the page target.

### Human-Agent Co-Riding (Handling Captcha / 2FA / Login / Account Switching)

1. When a page requires human login, OAuth (`az login`, `microsoft.com/devicelogin`, Google OAuth), or 2FA, run `tp-headed` yourself so the browser window opens visibly on the user's desktop, call `handOff()`, and stop. The human finishes login on that window.
2. Every tab includes a bottom-right **`⚡ TooPower`** Co-Riding Control Bar with **`[🧑 我要接手操控]`**, **`[🔄 換帳號]`**, and **`[🤖 完成並交還 Agent]`** buttons.
3. **Switching Cached SSO Accounts (`await p.resetSiteAuth()`)**: If a login page (e.g., Microsoft Azure / Live / Outlook / Google OAuth) automatically logs in with a wrong cached account (like an old Hotmail cookie causing `AADSTS50020` Access Denied), call `await p.resetSiteAuth()` (or ask the user to click **`[🔄 換帳號]`** in the bottom-right capsule) to clear only that site's SSO cookies/storage and force `prompt=select_account`.
4. **Cookie Sovereignty**（可含 `HttpOnly`）。代理不登入、不匯入使用者 cookie，不執行下面兩條；路徑只留紀錄：
   - `tp-browser nodejs tools/cookies-export.ego.js > cookies.json`
   - `tp-browser nodejs tools/cookies-import.ego.js < cookies.json`

[ego-browser:skill] end of guide
