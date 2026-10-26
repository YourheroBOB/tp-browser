---
name: tp-browser
description: >-
  TooPower Browser（tp-browser / ego-browser）。When you need a browser, read this skill.
  Windows、TP Linux、macOS：開網頁、懶加載擷取、操作已登入網站、Cloudflare/2FA/OAuth 人機共騎（tp-headed / ego-headed）、單回合多步自動化（對照 Playwright MCP / Computer Use）。
  瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）。
---

# TP

何時使用：開站、擷取、點擊填表、人機共騎，或單回合批次操作。細節：[api.md](references/api.md)、[platforms.md](references/platforms.md)、[troubleshooting.md](references/troubleshooting.md)。

## 啟動

```bash
node bin/ego-browser.js nodejs < script.js
```

未啟動會自起無頭。要可見視窗自行跑 `tp-headed`（已開著則保留分頁）。勿叫人手動開 Chrome。

## 呼叫

- `taskSpace(name)`：取得或建立隔離工作區（預設分頁 `p1`）。
- `page(label)`：取該工作區的分頁。
- `snapshot()`：緊湊快照，互動元素為 `@N`。
- `click(sel)`：點 CSS、`@N`、`text=`、`loc=` 或 xpath。
- `fill(sel, value)`：清空並填入。
- `handOff()`：交給人；其後頁面操作丟 `HandedOffError`，代理停手。
- `waitForControl()`：真的等到人交還（預設最長 30 分鐘）。
- `takeOver()`：代理取回操控。
- `finish({ keep })`：結束工作區並關閉未保留的分頁。

## 安全

不登入，不匯入使用者 cookie。`handOff` 期間代理停手。用完在仍有操控時 `finish` 或 `close`／`closePage`。
