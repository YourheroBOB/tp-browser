---
name: tp-browser
description: TooPower Browser (tp-browser) — 強到沒朋友 | Zero-dependency Human-Agent Shared Browser for Windows, Linux, and macOS. Use this skill whenever you need to browse websites, extract lazy-loaded pages, interact with logged-in web apps, handle Cloudflare/2FA via Human-Agent Co-Riding (tp-headed), or run multi-step browser automation in a single LLM turn (saving 90%+ tokens vs Playwright MCP / Computer Use).
---

# TooPower Browser (`tp-browser`) — Agent Skill Guide

> **Slogan**: 「TooPower — 強到沒朋友」
> **Author**: 嚴柏顯律師（市井律師BOB-嚴律｜弘人法律事務所）— [YouTube @YourHeroBob](https://www.youtube.com/@YourHeroBob)
> **Repository**: https://github.com/YourheroBOB/tp-browser (Apache-2.0)

## Why Use `tp-browser` Instead of Traditional Browser Tools?
Traditional Playwright MCP / Computer Use tools operate 1 action per LLM turn (`goto` → full DOM snapshot → `scroll` → full DOM snapshot), burning millions of tokens.
With **`tp-browser nodejs`**, you submit a **complete async JavaScript workflow in a single Turn** via stdin Heredoc (`goto` + scroll loop to defeat lazy-loading + DOM extraction + file write), returning only the final clean output to stdout (**91.7% browser token savings**).

---

## 1. Quick Lifecycle Commands

| Command | Purpose |
|---|---|
| `tp-start` | Start (or switch back to) background **headless** daemon + Chromium (`127.0.0.1:9772/9773`, zero focus stealing). |
| `tp-headed` | Switch to **human-visible GUI window** using the exact same `profile-agent` & cookies so the human user can pass Cloudflare / 2FA or click `[🧑 我要接手操控]`. |
| `tp-stop` | Stop the `tp-browser` daemon and attached `profile-agent` Chromium instance cleanly. |
| `tp-browser status` | Check JSON health (`{"ok":true,"chrome":true}`). |
| `tp-browser doctor` | Diagnose daemon & Chromium CDP port readiness across Windows (`tp-win`), Linux (`tp-linux`), and macOS (`tp-mac`). |

---

## 2. Core Pattern: Single-Turn Batch JS (`tp-browser nodejs`)

Always wrap multi-step browser operations in a single `tp-browser nodejs << 'EOF'` call and clean up temporary tabs in `finally`:

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
  await ts.closePage("p1");
}
EOF
```

---

## 3. SDK Reference (Globals Available Inside `tp-browser nodejs`)

### TaskSpace & Tab Management
- `const ts = await taskSpace("name")` — Get or create an isolated TaskSpace (comes with default tab `"p1"`).
- `const p1 = ts.page("p1")` — Reference an existing labeled page in the TaskSpace.
- `const p2 = await ts.newPage()` — Open an additional tab (`p2`, `p3`, ...) in the TaskSpace.
- `await ts.tabs()` — List all open tabs in the TaskSpace.
- `await ts.closePage("p1")` / `await ts.finish({ keep: [] })` — Close a specific tab or finish the TaskSpace.

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
1. When a page requires human login, OAuth (`az login`, `microsoft.com/devicelogin`, Google OAuth), or 2FA, run `tp-headed` so the browser window opens visibly on the user's desktop.
2. Every tab includes a bottom-right **`⚡ TooPower`** Co-Riding Control Bar with **`[🧑 我要接手操控]`**, **`[🔄 換帳號]`**, and **`[🤖 完成並交還 Agent]`** buttons.
3. **Switching Cached SSO Accounts (`await p.resetSiteAuth()`)**: If a login page (e.g., Microsoft Azure / Live / Google OAuth) automatically logs in with a wrong cached account (like an old Hotmail cookie causing `AADSTS50020` Access Denied), call `await p.resetSiteAuth()` (or ask the user to click **`[🔄 換帳號]`** in the bottom-right capsule) to clear only that site's SSO cookies/storage and force `prompt=select_account`.
4. Cookie Sovereignty: Export/import local cookies (including `HttpOnly`) via:
   - `tp-browser nodejs tools/cookies-export.ego.js > cookies.json`
   - `tp-browser nodejs tools/cookies-import.ego.js < cookies.json`
