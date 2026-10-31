# 04 — 秘密掃描與相依掃描關卡

> 僅為提案與範本；本輪不建立 workflow 檔、不修改 `.github/`。兩項掃描建議第一天即設為**必要關卡**。

## 1) 秘密掃描（gitleaks）

### 為什麼必要

本專案的 daemon 設計會在本機產生 token（`~/.local/share/ego-linux/token`）、處理 Cookies 與
登入態；一旦有測試 fixture、文件範例或 log 範本帶入真實格式憑證，影響極大。gitleaks 是
單一二進位掃描器（非 npm 套件），不違反零相依原則。

### `.gitleaks.toml` 範本（**僅為範本，不建立檔案**）

```toml
# .gitleaks.toml（範本）
title = "tp-browser gitleaks policy"

[allowlist]
description = "Known-safe test fixtures and docs"
paths = [
  '''docs/fmb-ci/.*''',          # 本提案文件中的範例一律使用假值
]
regexes = [
  '''FAKE_VALUE_FOR_TEST''',     # 專案約定的顯式假值
]

# 常見真實格式一律擋下（示例為偵測規則，非真實憑證）
[[rules]]
id = "generic-api-key-looking"
description = "High-entropy token-like string"
regex = '''(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]'''
tags = ["key", "generic"]
```

workflow 範本（**僅為範本**）：

```yaml
# .github/workflows/ci-secrets.yml（範本）
name: secret-scan
on:
  pull_request:
  push: { branches: [main] }
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> `GITHUB_TOKEN` 是 GitHub Actions 自動注入的短期、僅限本 repo 的權杖，非長期秘密；
> 此為 Actions 標準用法。本文件不放置、也不要求任何其他 credential。

## 2) 相依掃描

### npm 面：`npm audit`

`package.json` 沒有任何 `dependencies`／`devDependencies`，`npm audit` 應恆為 trivial pass；
它的價值是**當未來有人新增套件時自動把關**，並可作為「零相依賣點」的持續驗證器：

```bash
npm audit --omit=dev   # 零相依時應輸出 "found 0 vulnerabilities"
npm audit              # 未來新增 devDependency 時連 dev 一起掃
```

### 非 npm 面：osv-scanner

真正的相依風險不在 npm，而在：Node 版本、系統 Chromium、以及**安裝腳本以浮動 `main` 分支
`git clone`**（`install.sh`／`install.ps1` 皆有）。osv-scanner 同為單一二進位、可掃
`package.json`／鎖檔／系統套件：

```yaml
# 工作片段（範本）
  osv:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install osv-scanner (single binary)
        run: |
          go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest 2>/dev/null || \
            curl -sSL https://github.com/google/osv-scanner/releases/latest/download/\
osv-scanner_linux_amd64 -o /usr/local/bin/osv-scanner && chmod +x /usr/local/bin/osv-scanner
      - name: Scan repo manifests
        run: osv-scanner scan --lockfile=package.json . || true   # 零相依 ⇒ 應無發現；發現即擋
```

> 保守取捨：osv-scanner 掃「未來新增的相依」用；目前零相依下不會有發現。
> 若 CI 環境無法取得二進位，可先以 `npm audit` 作為唯一必要項，osv 列 advisory。

## 3) 安裝腳本供應鏈檢查（發佈前 gate，詳見 `05-build-and-release.md`）

目前 `install.sh`／`install.ps1` 在非本地安裝時 `git clone --depth 1 ...main`：
- 來源是浮動分支（不可重現）；
- 沒有 checksum 驗證；
- 安裝時會先 `rm -rf` 既有 runtime（無回滾）。

CI 端的對應關卡：

1. **腳本靜態檢查**（見 `01-lint-and-style.md`），絕不在 CI 執行安裝器。
2. **發佈關卡檢查「tag 鎖定」**：發佈 tag 時自動 grep 安裝腳本，若仍 clone `main` 則擋下 release。
3. **文件宣稱一致性**：`README.md` 的 one-liner 安裝指令需同步指向 tag 版本（由 release gate 提醒）。

## 4) 秘密防護的額外建議（不涉本輪變更）

- 測試與文件中的 token 一律使用 `FAKE_VALUE_FOR_TEST`（本 repo 既有慣例）。
- 若未來 CI 需要真憑證（例如發佈簽署），一律存 GitHub Secrets、永不出現在 log；
  但 Phase 0–2 的所有關卡**均不需要任何額外 secret**。

## 決策點（本文件自行拍板的保守預設）

1. gitleaks 與 `npm audit` 設必要；osv-scoker 掃描列 advisory（取得二進位的方式由 BOB 拍板）。
2. `npm audit --omit=dev` 為必要；含 dev 的完整 audit 在 Phase 1 引入 devDependency 後才升必要。
3. allowlist 只放顯式假值 `FAKE_VALUE_FOR_TEST` 與本提案目錄，不放任何真實路徑或格式例外。
4. 安裝器永不於 CI 執行，只做靜態檢查與 tag 鎖定驗證。
