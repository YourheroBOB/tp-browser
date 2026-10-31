# 03 — 測試與覆蓋率關卡

> 僅為提案與範本；本輪不建立 workflow 檔、不新增 npm 套件。

## 既有測試資產分類

| 類別 | 檔案 | 需要真實 Chrome？ | 網路 | 建議關卡 |
|---|---|---|---|---|
| 純單元 | `fmb_feature2/reaper.test.js` | 否 | 否 | **必要** |
| 整合（真實 Store＋tmpdir） | `fmb_feature2/store-integration.test.js` | 否 | 否 | **必要** |
| CLI（spawnSync＋stdin） | `fmb_feature2/cli.test.js` | 否 | 否 | **必要** |
| daemon/CDP 單元 | `tests/test_fmb_keys.test.mjs`、`tests/test_fmb_store.test.mjs`、`tests/test_fmb_cdp.test.mjs`、`tests/test_fmb_profile_init.test.mjs` | 否（`cdp` 測試以本機 loopback／mock 為準） | 僅 127.0.0.1 | **必要**（首次上 CI 時逐檔 triage） |
| CLI 整合 | `tests/fmb_integration_cli.test.mjs` | 視內容（多半為 spawn ＋本機 daemon） | 僅 127.0.0.1 | **必要**（同上 triage） |
| E2E 冒煙 | `tests/smoke.ego.js`（23/23）、`tests/bench/*` | **是**（headless Chrome） | 僅 `tests/serve.mjs` 的 127.0.0.1 | **advisory（Phase 2）** |

CI 原則（沿用 `docs/fmb-api/README.md` 的網路邊界）：

- 一切請求只打 `127.0.0.1`（repo 內 `tests/serve.mjs` 或 `tests/bench/bench-server.mjs`）。
- 暫存一律用 `mkdtempSync(tmpdir())` / `tmp_path`，不讀寫 repo 外的使用者真實資料。
- 測試憑證一律 `FAKE_VALUE_FOR_TEST`，不得使用任何真實格式的 token 前綴。

## Phase 0：必要關卡指令

```bash
# 單元＋整合測試（Node 內建 test runner，零依賴）
node --test tests/ fmb_feature2/

# 覆蓋率（Node 內建，Phase 0 僅報告、不設門檻）
node --test --experimental-test-coverage \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=coverage.lcov \
  tests/ fmb_feature2/
```

> Node 22 的 `--experimental-test-coverage` 屬實驗旗標，輸出格式可能隨版本變動；
> 因此覆蓋率在 Phase 0 只做「產生基準線＋PR 顯示 diff」，不當成 merge 阻擋條件。
> 若 BOB 之後同意 devDependency，可改用 `c8` 取得較穩定的 lcov 與 threshold 功能（另案決策）。

workflow 範本（**僅為範本，不建立檔案**）：

```yaml
# .github/workflows/ci-test.yml（範本）
name: test
on:
  pull_request:
  push: { branches: [main] }
jobs:
  unit:
    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]        # 基線 22 ＋優先驗證 24（沿用 docs/fmb-upgrade/ 結論）
        os: [ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}' }
      - name: Unit & integration tests
        run: node --test tests/ fmb_feature2/
      - name: Coverage (report only)
        run: |
          node --test --experimental-test-coverage \
            --test-reporter=lcov --test-reporter-destination=coverage.lcov \
            tests/ fmb_feature2/ || true
          ls -l coverage.lcov || true
        continue-on-error: true   # 覆蓋率不擋 PR（Phase 0 決策）

  canary:
    continue-on-error: true       # Node 26 canary：觀察用
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: node --test tests/ fmb_feature2/
```

## Phase 2：E2E 瀏覽器冒煙（advisory）

`tests/smoke.ego.js` 依賴 daemon＋headless Chrome；GitHub-hosted `ubuntu-latest` 預裝 Chrome
可滿足，且所有流量僅打本機 `tests/serve.mjs`，符合網路邊界。範本片段：

```yaml
  e2e-smoke:
    continue-on-error: true   # Phase 2 決策：先 advisory
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Start local test server
        run: node tests/serve.mjs & sleep 2
      - name: Start headless TP browser (CI sandbox profile in tmp)
        run: |
          export HOME="$PWD/.ci-home"   # 隔離家目錄，避免讀寫 runner 真實 $HOME
          mkdir -p "$HOME"
          sh scripts/tp-start.sh --alt-port || true
      - name: Run smoke suite (23 checks, loopback only)
        run: node bin/tp-browser.js nodejs < tests/smoke.ego.js
      - name: Teardown
        if: always()
        run: |
          pkill -f "tp-browserd.js" || true
          pkill -f "ego-browserd.js" || true
          pkill -f "profile-agent" || true
```

保守設計說明：

- `HOME` 重定向到 repo 內 `.ci-home`，避免 `tools/profile-init.js` 讀取 runner 真實瀏覽器 profile
  （該工具會掃描並複製使用者 Bookmarks／Login Data／Cookies，**絕不能在共用 runner 上跑真實家目錄**）。
- 全程不對外網發請求；`bench` 類（對外計時比較）**不入 CI**。
- 若日後升為必要關卡，需先處理 Chrome 版本釘選（runner 的 Chrome 會自動升級）。

## 決策點（本文件自行拍板的保守預設）

1. 必要關卡＝`node --test tests/ fmb_feature2/`；首次導入時若發現個別測試在 CI 環境不穩，
   以「逐檔移入 exclude 清單＋issue 追蹤」處理，而非整包降級。
2. 覆蓋率僅報告、不設門檻。
3. E2E 冒煙 advisory，且隔離 `HOME`；`bench` 不入 CI。
4. Node 矩陣：22＋24 必跑、26 canary。
