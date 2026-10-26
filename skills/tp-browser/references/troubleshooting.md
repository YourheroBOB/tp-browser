# TP 疑難

回到 [SKILL.md](../SKILL.md)。命令表在 [platforms.md](platforms.md)。API 在 [api.md](api.md)。

## 健康檢查失敗

`status` 不是 `{"ok":true,"chrome":true}`、doctor 不過，或視窗不在人的桌面：命令、別名、Session 0 與跨節點寫法都在 [platforms.md](platforms.md)。

## `HandedOffError`

這個錯誤表示人還拿著操控，代理停手。下一步只用 [api.md](api.md) 的 `waitForControl`、`takeOver` 或 `finish`。

## `/flush-and-close` 被拒絕

`/flush-and-close` 需要 token，檢查方式與 `/rpc` 相同（標頭 `x-tp-token`）。沒帶 token 或 token 不對會拒絕，瀏覽器保持開著。不要為了收尾去讀 token 檔；一般腳本用完呼叫 `finish` 或 `close` 即可。

## 書籤在、登入狀態不在

登入資料不會跟著書籤一起進來。選用同步的開關在 [platforms.md](platforms.md) 的 `tp-headed` 列。

## 登入頁不見了

分頁被 `closePage` 關掉時，人無法在畫面上登入。留分頁、`handOff`，以及 `resetSiteAuth()`／右下角 `⚡ TooPower` 膠囊「換帳號」，見 [api.md](api.md)。
