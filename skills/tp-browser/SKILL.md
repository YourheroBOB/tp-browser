---
name: tp-browser
description: TooPower Browser (tp-browser / ego-browser) — 強到沒朋友 | Zero-dependency Human-Agent Shared Browser for Windows, Linux, and macOS. When you need a browser, read this Skill by default. Use it to open and operate websites, extract lazy-loaded pages, interact with logged-in web apps, handle Cloudflare/2FA/OAuth via Human-Agent Co-Riding (tp-headed / ego-headed), or run multi-step browser automation in a single LLM turn（瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018），對照 Playwright MCP / Computer Use）.
---

# TooPower Browser (`tp-browser` / `ego-browser`) — Agent Skill Guide

> **Slogan**: 「TooPower — 強到沒朋友」
> **Author**: 嚴柏顯律師（市井律師BOB-嚴律｜弘人法律事務所）— [YouTube @YourHeroBob](https://www.youtube.com/@YourHeroBob)
> **Repository**: https://github.com/YourheroBOB/tp-browser (Apache-2.0)

## 🔴 GOLDEN RULE FOR AI AGENTS: Launch the Browser Yourself!
1. **NEVER ask the human user to manually launch Chrome, `tp-headed`, or `ego-headed`!** You have direct shell commands to pop up the visible GUI browser window on any desktop yourself (even over Windows OpenSSH Session 0, which `tp-headed` automatically bridges to the interactive desktop Session 1).
2. **`tp-browser` and `ego-browser` are 100% interchangeable aliases** across macOS, Windows (`rog`, `pc`), and Linux (`abacus`, WSL2):
   - Need **background headless** browsing? Just run `tp-browser nodejs << 'EOF' ...` (it **auto-starts** headless mode if not running!) or explicitly run `tp-start` (`ego-start` / `tp-browser start`).
   - Need a **human-visible GUI Chrome window** on the screen (so the user can log in, pass 2FA/Captcha, or watch)? Run **`tp-headed`** (or `ego-headed` / `tp-browser headed` / `ego-browser headed`) yourself!
   - If the GUI browser window is **already open** on the user's desktop, calling `tp-headed` is a safe no-op that preserves all open tabs.

---

## 1. Quick Lifecycle & Cross-Node SSH Commands

| Command | Alias | Purpose |
|---|---|---|
| `tp-headed` | `ego-headed` / `tp-browser headed` | **Open human-visible GUI Chrome window** on the desktop using `profile-agent` (1:1 synced Bookmarks, Favicons & Cookies + bottom-right `⚡ TooPower` Co-Riding capsule). Automatically breaks out of Windows SSH Session 0 into desktop Session 1! |
| `tp-start` | `ego-start` / `tp-browser start` | Start background **headless** daemon + Chrome (`127.0.0.1:9772/9773`, zero focus stealing). |
| `tp-stop` | `ego-stop` / `tp-browser stop` | Stop the `tp-browser` daemon and attached `profile-agent` Chrome cleanly. |
| `tp-browser status` | `ego-browser status` | Check JSON health (`{"ok":true,"chrome":true}`). |
| `tp-browser doctor` | `ego-browser doctor` | Diagnose daemon & Chrome CDP readiness across Windows (`tp-win`), Linux (`tp-linux`), and macOS (`tp-mac`). |

### Launching & Controlling Across Nodes (Mac / ROG / PC / Abacus)
- **On current local machine (Mac / Windows / Linux)**:
  - Pop up visible GUI browser: `tp-headed`
  - Run script: `tp-browser nodejs << 'EOF' ... EOF`
- **From Mac/PC targeting `ROG` Windows Desktop (`ssh rog`)**:
  - Pop up visible GUI browser on ROG desktop: `ssh rog "tp-headed"`
  - Run script on ROG: `ssh rog "tp-browser nodejs -e \"...\""` (or pipe via `ssh rog "tp-browser nodejs" << 'EOF'`)
- **From Mac/ROG targeting `PC` (`ssh pc`)**:
  - Pop up visible GUI browser on PC Windows desktop: `ssh pc "tp-headed"`
  - Run script on PC: `ssh pc "tp-browser nodejs" << 'EOF'`
- **Targeting `Abacus` (`ssh abacus`)**:
  - Run script on Abacus: `ssh abacus "~/usage-browser/bin/abx.mjs nodejs" << 'EOF'`

---

## 2. Core Pattern: Single-Turn Batch JS (`tp-browser nodejs`)

Traditional Playwright MCP / Computer Use tools operate 1 action per LLM turn (`goto` → full DOM snapshot → `scroll` → full DOM snapshot), burning millions of tokens.
With **`tp-browser nodejs`**, you submit a **complete async JavaScript workflow in a single Turn** via stdin Heredoc (`goto` + scroll loop to defeat lazy-loading + DOM extraction + file write), returning only the final clean output to stdout（**瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）**）:

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
1. When a page requires human login, OAuth (`az login`, `microsoft.com/devicelogin`, Google OAuth), or 2FA, run `tp-headed` yourself so the browser window opens visibly on the user's desktop.
2. Every tab includes a bottom-right **`⚡ TooPower`** Co-Riding Control Bar with **`[🧑 我要接手操控]`**, **`[🔄 換帳號]`**, and **`[🤖 完成並交還 Agent]`** buttons.
3. **Switching Cached SSO Accounts (`await p.resetSiteAuth()`)**: If a login page (e.g., Microsoft Azure / Live / Outlook / Google OAuth) automatically logs in with a wrong cached account (like an old Hotmail cookie causing `AADSTS50020` Access Denied), call `await p.resetSiteAuth()` (or ask the user to click **`[🔄 換帳號]`** in the bottom-right capsule) to clear only that site's SSO cookies/storage and force `prompt=select_account`.
4. Cookie Sovereignty: Export/import local cookies (including `HttpOnly`) via:
   - `tp-browser nodejs tools/cookies-export.ego.js > cookies.json`
   - `tp-browser nodejs tools/cookies-import.ego.js < cookies.json`

[ego-browser:skill] end of guide
