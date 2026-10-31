# 02 — 型別檢查關卡

> 僅為提案與範本；本輪不建立 workflow 檔、不新增 npm 套件。型別檢查列為 **Phase 1、advisory 起步**。

## 現況

- 純 JavaScript（ESM），`package.json` 宣告 `"type": "module"`、`engines.node >= 22`。
- 程式碼約 2,000 行，部分檔（如 `fmb_feature2/reaper.js`、`daemon/cdp.js`）已具備良好的 JSDoc 註解，
  但尚未系統化標注型別；**一次開嚴格 `checkJs` 會產生大量既有錯誤**。

## 提案：JSDoc ＋ `tsc --checkJs`，分區導入

策略：以 `jsconfig.json` 指定**目前可控的目錄**先開 `checkJs`，其餘目錄列入 `exclude`，
之後逐目錄移出 `exclude` 收斂：

```jsonc
// jsconfig.json（範本；需 npm i -D typescript，屬 Phase 1 決策）
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "checkJs": true,
    "noEmit": true,
    "strict": false,           // 先不 strict，避免既有未標注程式全面報錯
    "allowJs": true,
    "skipLibCheck": true
  },
  "include": [
    "fmb_feature2/**/*.js",
    "daemon/keys.js",
    "daemon/cdp.js",
    "daemon/store.js"
  ],
  "exclude": [
    "bin/**/*.js",             // 大量 DOM/CDP 動態行為，最後收斂
    "daemon/ego-browserd.js",
    "daemon/tp-browserd.js",
    "daemon/page-ops.js",
    "daemon/inpage.agent.js",
    "lib/sdk.js",
    "tools/**",
    "tests/**",
    "scripts/**",
    "install*"
  ]
}
```

執行指令（建議 CI 中 advisory 呈現，不擋 PR）：

```bash
npm i -D typescript   # Phase 1 決策；僅 devDependency，不影響零 runtime 相依
npx tsc --project jsconfig.json
```

workflow 範本片段（**僅為範本**）：

```yaml
  typecheck:
    runs-on: ubuntu-latest
    continue-on-error: true   # Phase 1 為 advisory：失敗只標記、不擋 PR
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install --no-save typescript
      - run: npx tsc --project jsconfig.json
```

## 不引入型別產生器／重寫為 TS 的理由

- 重寫為 TypeScript 會破壞「零建置步驟、`node` 直接執行」的部署模型（安裝器是直接 `cp` 原始 `.js`）。
- `tsc --checkJs` 可在不改副檔名、不加建置步驟的前提下取得大部分型別安全收益。

## 決策點（本文件自行拍板的保守預設）

1. 型別檢查 Phase 1 才啟用，且 `continue-on-error: true`（advisory）。
2. 先只對 `fmb_feature2/` 與三個 daemon 基礎模組開 `checkJs`。
3. `strict: false` 起步；收斂完成後再逐項打開（`strictNullChecks` 最後）。
4. 不把任何檔案重寫成 `.ts`。
