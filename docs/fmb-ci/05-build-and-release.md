# 05 — 建置與發佈關卡

> 僅為提案與範本；本輪不建立 workflow 檔、不修改 `.github/`、不設定任何 secret 或憑證。

## 目標

1. **版本一致性 gate**：`package.json`（`0.3.0`）、CLI `version` 輸出（`0.3.1`）與 git tag
   三者必須一致後才允許發佈（`docs/fmb-api/README.md` 已記錄此漂移）。
2. **可重現發佈**：只從 `vX.Y.Z` tag 發佈，產物附 SHA256 checksum。
3. **安裝器來源鎖定**：發佈前檢查安裝腳本不得再 clone 浮動 `main`。

## 1) 版本一致性 gate 腳本（範本）

```js
// scripts/check-version.mjs（範本；不建立於本輪）
// 比對 package.json、CLI version 輸出與（若提供）git tag。
// 用法：node scripts/check-version.mjs [vX.Y.Z]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
const cliOut = execFileSync(
  process.execPath, ['bin/tp-browser.js', 'version'], { encoding: 'utf8' });
const cli = (cliOut.match(/(\d+\.\d+\.\d+)/) || [])[1];
const tag = process.argv[2]?.replace(/^v/, '');

const problems = [];
if (pkg !== cli) problems.push(`package.json=${pkg} but CLI prints ${cli}`);
if (tag && tag !== pkg) problems.push(`tag=v${tag} but package.json=${pkg}`);
if (tag && tag !== cli) problems.push(`tag=v${tag} but CLI prints ${cli}`);

if (problems.length) {
  console.error('VERSION MISMATCH:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`version ok: ${pkg}`);
```

> 現況會立刻失敗（`0.3.0` vs `0.3.1`）——這是預期行為：**統一版本號是啟用發佈關卡的前置作業**，
> 需 BOB 決定統一成哪個號碼（保守建議：下次 functional 變動時統一為 `0.3.1` 或直接跳 `0.4.0`）。

## 2) 發佈 workflow 範本（**僅為範本，不建立檔案**）

```yaml
# .github/workflows/ci-release.yml（範本）
name: release
on:
  push: { tags: ['v*.*.*'] }   # 只從 tag 發佈，絕不從分支自動發佈

jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Version consistency gate
        run: node scripts/check-version.mjs "${GITHUB_REF_NAME}"
      - name: Tests must pass on the tag
        run: node --test tests/ fmb_feature2/
      - name: Installer must pin a tag, not floating main
        run: |
          if grep -n "clone --depth 1 https://github.com/YourheroBOB/tp-browser.git" install.sh \
             | grep -v "refs/tags/"; then
            echo "::error file=install.sh::installer clones a floating ref; pin to the release tag"
            exit 1
          fi
          # install.ps1 同樣檢查（範本示意）
          if grep -n "YourheroBOB/tp-browser.git" install.ps1 | grep -v "refs/tags/"; then
            echo "::error file=install.ps1::installer clones a floating ref; pin to the release tag"
            exit 1
          fi

  package:
    needs: gates
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build source tarball (no build step needed — pure JS)
        run: |
          mkdir -p dist
          git archive --format=tar.gz --prefix="tp-browser-${GITHUB_REF_NAME#/v}/" \
            -o "dist/tp-browser-${GITHUB_REF_NAME#/v}.tar.gz" HEAD
      - name: SHA256 checksums
        run: |
          cd dist
          sha256sum *.tar.gz > SHA256SUMS.txt
          cat SHA256SUMS.txt
      - name: Upload release artifacts
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*
          generate_release_notes: true
```

## 3) 建置策略說明

本專案是**零建置步驟**的純 ESM JavaScript：`bin/`、`daemon/`、`lib/` 由安裝器直接 `cp` 到
`~/.local/share/ego-linux/app`。因此：

- 「建置」＝`git archive` 打包原始碼＋checksum，**不引入 bundler／transpiler**。
- 不產生 npm 發佈（`package.json` 無 `files`／`publishConfig`，且安裝路徑是家目錄 bin，非 global npm）；
  若 BOB 未來想發 npm，屬另案（需加回滾策略與 provenance）。

## 4) 發佈前置檢查清單（Runbook 形式，供 BOB 日後使用）

1. [ ] `package.json`／CLI `version`／`skills/tp-browser/SKILL.md` 中版本字串一致。
2. [ ] `install.sh`／`install.ps1`／`README.md` one-liner 已改抓 `refs/tags/vX.Y.Z`（含 checksum 驗證）。
3. [ ] tag 上 `node --test tests/ fmb_feature2/` 全綠。
4. [ ] gitleaks／`npm audit` 全綠。
5. [ ] `STATE.md`／`docs/fmb-upgrade/` 的支援矩陣與本次發佈內容一致。
6. [ ] Release notes 註明 NOTICE／Apache-2.0 4(d) 歸屬要求（散布 derivative 時）。

## 5) 分支保護與 required checks（Phase 2，需 BOB 操作）

本輪**不變更**任何 repo 設定。建議 Phase 2 由 BOB 在 GitHub 設定頁手動啟用：

- `main` 分支保護：要求 PR、要求 `lint`／`test`／`secret-scan` 通過。
- tag 保護規則（`v*.*.*`）：僅維護者可推送。
- `GITHUB_TOKEN` 權限設為最小（僅讀 repo＋寫 release）。

## 決策點（本文件自行拍板的保守預設）

1. 發佈僅由 tag 觸發；不從分支自動發佈。
2. 版本一致性 gate 允許現況「先失敗」——統一版本號是前置作業，不繞過 gate。
3. 產物＝原始碼 tarball＋SHA256SUMS，不發 npm、不做簽署（provenance 另案）。
4. 安裝器浮動 `main` clone 在發佈 gate 直接擋下，但不由本輪代為修改安裝器（屬程式變更，需另案）。
5. 分支保護與 required checks 保留給 BOB 手動設定，本提案只列步驟。
