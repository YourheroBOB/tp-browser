# 01 — Lint／靜態檢查關卡

> 僅為提案與範本；本輪不建立 workflow 檔、不修改 `.github/`、不新增任何 npm 套件。

## 目標

1. 在 PR 早期擋下**語法錯誤與明顯壞檔**（最低成本、最高確定性的關卡）。
2. 對 shell 啟動腳本做靜態檢查（`install.sh`、`scripts/tp-start.sh`、`scripts/tp-stop.sh` 是供應鏈入口）。
3. ESLint 等「風格類」檢查列為 Phase 1 選項，不強制引入 devDependency。

## Phase 0：零依賴語法檢查（建議為必要關卡）

Node 內建即可完成，不含任何規則判斷，誤判率趨近於零：

```bash
# 1) 所有 .js / .mjs 通過 Node 剖析（不執行）
#    ESM 檔用 node --check；.mjs 天生是 ESM，.js 因 package.json "type": "module" 亦同。
for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f" || exit 1; done

# 2) JSON 檔可剖析（package.json、測試 fixture）
for f in $(git ls-files '*.json'); do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || exit 1; done
```

對應 workflow 範本（**僅為範本，不建立檔案**）：

```yaml
# .github/workflows/ci-lint.yml（範本）
name: lint
on:
  pull_request:
  push: { branches: [main] }
jobs:
  syntax:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: node --check all JS/MJS
        run: |
          set -eu
          status=0
          for f in $(git ls-files '*.js' '*.mjs'); do
            node --check "$f" || { echo "::error file=$f::syntax check failed"; status=1; }
          done
          exit $status
      - name: JSON parse all .json
        run: |
          set -eu
          for f in $(git ls-files '*.json'); do
            node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" \
              || { echo "::error file=$f::invalid JSON"; exit 1; }
          done

  shellcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: shellcheck shell scripts
        run: |
          sudo apt-get update && sudo apt-get install -y shellcheck
          # scripts/*.service 為 systemd 單元，不在此範圍
          files=$(git ls-files '*.sh')
          # install.sh 為 /bin/sh（dash）腳本
          shellcheck --severity=error $files
```

保守取捨：`shellcheck` 只取 `--severity=error`（風格類 warning 不擋 PR，避免既有腳本一次性全面失敗）。

## Phase 1（選擇性）：ESLint

引入 ESLint 需要新增 devDependency，與「零相依」賣點有張力，**預設不啟用**；若 BOB 同意，
建議以 flat config、僅規範錯誤類規則起步：

```js
// eslint.config.mjs（範本；需 npm i -D eslint，屬 Phase 1 決策）
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // bin/tp-browser.js runNodeJs() 注入的全域 SDK 名稱
        taskSpace: 'readonly', TaskSpace: 'readonly', Page: 'readonly',
      },
    },
    rules: {
      // 先只擋「確定是 bug」的規則，風格規則暫緩
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-redeclare': 'error',
    },
  },
  {
    ignores: ['**/node_modules/', 'docs/**'],
  },
];
```

## PowerShell 檢查方針（Phase 2）

`scripts/ego-start.ps1`、`scripts/ego-stop.ps1`、`install.ps1` 目前無自動檢查。保守做法：
在 Windows runner 上以 PowerShell 剖析器做「僅語法、不執行」的檢查（零額外依賴）：

```yaml
# 工作片段（範本）
  ps-syntax:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: PowerShell syntax check
        shell: pwsh
        run: |
          $files = git ls-files '*.ps1'
          $fail = 0
          foreach ($f in $files) {
            $errs = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile(
              (Join-Path $PWD $f), [ref]$null, [ref]$errs)
            if ($errs.Count -gt 0) {
              $errs | ForEach-Object { Write-Host "::error file=$f::$($_.Message)" }
              $fail = 1
            }
          }
          exit $fail
```

> 注意：`install.ps1` / `install.sh` **絕不在 CI 中真的執行**（它們會寫入使用者家目錄、
> 啟動服務、修改 PATH），只做語法層級檢查。

## 決策點（本文件自行拍板的保守預設）

1. `shellcheck` 只擋 `error` 等級。
2. ESLint 預設不啟用；啟用需 BOB 同意新增 devDependency。
3. PowerShell 檢查只做剖析、不執行安裝器。
4. `node --check` 對全量 JS 檔生效（含 `daemon/`、`bin/`、`tests/`、`fmb_feature2/`）。
