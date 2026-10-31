# 其他資料結構：按鍵映射、Benchmark JSON

## 1. 按鍵描述元（`daemon/keys.js`）

CLI／SDK 的按鍵名稱會被翻譯成 CDP `Input.dispatchKeyEvent` 欄位。Playwright 相容命名。

### 1.1 修飾鍵位元（`MODIFIERS`）

| 名稱 | 位元值 |
|---|---|
| `Alt` | 1 |
| `Control` | 2 |
| `ControlOrMeta` | 2（與 Control 同位元；平台慣例由呼叫端處理） |
| `Meta` | 4 |
| `Shift` | 8 |

`isModifier(name)`：名稱在表內即為修飾鍵。`modifierBit(name)`：未知名稱回 `0`。

### 1.2 具名鍵（`NAMED`）

每個具名鍵的描述元形狀：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `key` | string | DOM `key` 值（如 `"Enter"`、`" "`）；表內未指定時補上鍵名本身 |
| `code` | string | DOM `code` 值（如 `"Enter"`、`"KeyA"`）；未指定時補鍵名 |
| `vk` | integer | Windows virtual-key code |
| `text` | string \| undefined | 產生的文字（`Enter` → `"\r"`、`Space` → `" "`）；非文字鍵無此欄 |
| `modifier` | string \| undefined | 僅修飾鍵有；值為對應的 `MODIFIERS` 鍵名 |

已定義的具名鍵涵蓋：`Enter`、`Tab`、`Escape`、`Backspace`、`Delete`、`Insert`、`Home`、`End`、`PageUp`、`PageDown`、方向鍵 ×4、`Space`、`Alt`、`Control`／`Ctrl`、`Meta`／`Command`、`Shift`、`F1`–`F12`。

### 1.3 單一字元鍵（`keyDescriptor` 對長度 1 的名稱）

```json
{ "key": "a", "code": "KeyA", "vk": 65, "text": "a" }
```

規則：

- `code`：`A–Z` → `Key<大寫>`；`0–9` → `Digit<字元>`；其他單字元 → `null`。
- `vk`：`name.toUpperCase().charCodeAt(0)`。
- `text`：僅當字元落在可見 ASCII `[ -~]` 區間才設；否則 `undefined`。
- 查無（非具名且長度 ≠ 1）→ 回 `null`（呼叫端視為非法鍵）。

### 1.4 和弦解析（`parseChord`）

輸入字串格式 `"Modifier+...+Main"`（以 `+` 切分、trim、去空段）：

```json
{ "modifiers": ["ControlOrMeta"], "main": "a" }
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `modifiers` | Array&lt;string&gt; | 最後一段以外的所有段；每一個都必須在 `MODIFIERS`，否則丟 `unknown modifier "..." in chord "..."` |
| `main` | string | 最後一段；`keyDescriptor(main)` 須非 null，否則丟 `unknown key "..."` |

空字串／全空白 → `empty key chord`。

## 2. Benchmark 量測輸出（`tests/bench/bench-run.ego.js`）

Runner 對 10 個結構化測試頁各量測兩種觀測 payload，輸出到 stdout：

```json
{
  "rows": [
    {
      "page": "p1",
      "name": "FAKE_VALUE_FOR_TEST",
      "snapChars": 1234,
      "snapLines": 56,
      "pngBytes": 7890,
      "snapHead": "FAKE_VALUE_FOR_TEST"
    }
  ],
  "viewport": "1440x900",
  "date": "2026-01-01T00:00:00.000Z"
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `rows[].page` | string | 頁面鍵 `p1`…`p10` |
| `rows[].name` | string | 人類可讀頁面類型標籤 |
| `rows[].snapChars` | integer | 語意快照文字字元數（ego 路線每輪觀測量） |
| `rows[].snapLines` | integer | 快照行數 |
| `rows[].pngBytes` | integer | 視窗截圖 PNG 位元組數（computer-use 路線每輪觀測量） |
| `rows[].snapHead` | string | 快照首行前 80 字元（供人工檢查用） |
| `viewport` | string | 固定 `"1440x900"` |
| `date` | string (ISO 8601) | 量測時刻 |

快照參數：`snapshot({ scope: 'only_within_viewport' })`。截圖與快照文字另以 `/tmp/bench-<key>.png`／`.snap.txt` 暫存（僅量測位元組數用）。

> `docs/tp_win_ab_benchmark_results_1151018.json` 為此結構（或其延伸）的實測彙總；本文件**不**記載其內容，僅記載程式碼可推得的 schema。

## 3. Agent Skill 文件（`skills/tp-browser/SKILL.md`）

- 安裝器會原檔複製到多個 skill 根目錄（`~/.claude/skills`、`~/.agents/skills`、`~/.codex/skills`、`~/.gemini/config/skills`），並同時以 `tp-browser` 與 `ego-browser` 兩個名稱安裝。
- 格式為 Markdown，內容為 Agent 使用指南；非結構化資料，無 schema。

## 4. systemd user service 定義（`scripts/*.service`）

兩個 unit（chrome 與 browserd），資料上值得記載的固定參數：

| 參數 | 值 |
|---|---|
| Chrome flags | `--headless=new --no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=9773 --user-data-dir=%h/.local/share/ego-linux/profile-agent --window-size=1440,900 --noerrdialogs`，起始 URL `about:blank` |
| browserd | `node %h/.local/share/ego-linux/app/daemon/ego-browserd.js` |
| 重啟策略 | `Restart=on-failure`、`RestartSec=3` |
| 依賴順序 | browserd `After=ego-linux-chrome.service` |
