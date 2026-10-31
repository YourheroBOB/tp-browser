# TooPower Browser (`tp-browser` / `ego-browser`) — Agent Skill Guide

> **Slogan**: 「TooPower — 強到沒朋友」
> **Author**: 嚴柏顯律師（市井律師BOB-嚴律｜弘人法律事務所）— [YouTube @YourHeroBob](https://www.youtube.com/@YourHeroBob)
> **Repository**: https://github.com/YourheroBOB/tp-browser (Apache-2.0)

Zero-dependency Human-Agent Shared Browser for Windows, TP Linux, and macOS. When you need a browser, read this skill by default. Use it to open and operate websites, extract lazy-loaded pages, interact with logged-in web apps, handle Cloudflare/2FA/OAuth via Human-Agent Co-Riding (`tp-headed` / `ego-headed`), or run multi-step browser automation in a single LLM turn versus Playwright MCP / Computer Use. 節省數字只寫在 [SKILL.md](../SKILL.md) description。

對外產品名是 **TP**／**TP Linux**。`ego-browser`、`ego-headed`、`ego-start`、`ego-stop` 只是命令別名。

回到 [SKILL.md](../SKILL.md)。疑難見 [troubleshooting.md](troubleshooting.md)。API 見 [api.md](api.md)。

## GOLDEN RULE FOR AI AGENTS: Launch the Browser Yourself!

1. **NEVER ask the human user to manually launch Chrome, `tp-headed`, or `ego-headed`!** You have direct shell commands to pop up the visible GUI browser window on any desktop yourself (even over Windows OpenSSH Session 0, which `tp-headed` automatically bridges to the interactive desktop Session 1).
2. **`tp-browser` and `ego-browser` are 100% interchangeable aliases** across macOS, Windows (`rog`, `pc`), and Linux (`abacus`, WSL2):
   - Need **background headless** browsing? Just run `tp-browser nodejs << 'EOF' ...` (it **auto-starts** headless mode if not running!) or explicitly run `tp-start` (`ego-start` / `tp-browser start`). From a repo checkout without installing, the same entry is `node /path/to/tp-browser/bin/ego-browser.js nodejs < script.js` (bash/zsh). `<` stdin redirection is not valid in Windows PowerShell 5.1; there use `$OutputEncoding = [Text.UTF8Encoding]::new($false); Get-Content -Raw -Encoding UTF8 script.js | tp-browser nodejs` (or `cmd /c "tp-browser nodejs < script.js"`).
   - Need a **human-visible GUI Chrome window** on the screen (so the user can log in, pass 2FA/Captcha, or watch)? Run **`tp-headed`** (or `ego-headed` / `tp-browser headed` / `ego-browser headed`) yourself!
   - If the GUI browser window is **already open** on the user's desktop, calling `tp-headed` is a safe no-op that preserves all open tabs.

## Quick Lifecycle & Cross-Node SSH Commands

| Command | Alias | Purpose |
|---|---|---|
| `tp-headed` | `ego-headed` / `tp-browser headed` | **Open human-visible GUI Chrome window** on the desktop using `profile-agent` (1:1 synced Bookmarks & Favicons + bottom-right `⚡ TooPower` Co-Riding capsule). vault 與 profile 登入資料同步為選用（`TP_SESSION_VAULT=1` / `--sync-auth`）。Automatically breaks out of Windows SSH Session 0 into desktop Session 1! |
| `tp-start` | `ego-start` / `tp-browser start` | Start background **headless** daemon + Chrome (`127.0.0.1:9772/9773`, zero focus stealing). |
| `tp-stop` | `ego-stop` / `tp-browser stop` | Stop the `tp-browser` daemon and attached `profile-agent` Chrome cleanly. |
| `tp-browser status` | `ego-browser status` | Check JSON health (`{"ok":true,"chrome":true}`). |
| `tp-browser doctor` | `ego-browser doctor` | Diagnose daemon & Chrome CDP readiness across Windows (`tp-win`), TP Linux (`tp-linux`), and macOS (`tp-mac`). |

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
