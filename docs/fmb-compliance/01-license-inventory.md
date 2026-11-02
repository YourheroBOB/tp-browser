# 01 — 相依套件授權相容性盤點

## 1. npm 相依：零

`package.json`（`"name": "tp-browser"`、`"version": "0.3.0"`）中不存在 `dependencies`、`devDependencies`、`optionalDependencies`、`peerDependencies` 任何欄位。結論：

- **無任何隨專案散布的第三方 npm 授權**，因此沒有 GPL／AGPL 等 copyleft 授權與 Apache-2.0 的相容性問題，也沒有 NOTICE 級聯義務。
- 未來若新增套件，應依 [`docs/fmb-ci/README.md`](../fmb-ci/README.md) 的原則「零相依是第一原則」逐案審查；建議在 PR 模板加「新增依賴需附授權相容性說明」。

## 2. 本專案自身授權義務（Apache-2.0）

- 本專案程式與文件採 Apache-2.0（`LICENSE`），`NOTICE` 載明創始作者與 EGo Browser 概念啟發致敬。
- 再散布（含 fork、打包進其他產品）時必須：
  1. 隨附 `LICENSE`（第 4(a) 條）；
  2. 修改過的檔案加註修改聲明（第 4(b) 條）；
  3. 保留 `NOTICE` 中的歸屬聲明（第 4(d) 條）——**這是本專案最容易在下游整合時被漏掉的義務**，建議在 README 的授權節加粗提示（屬文件修改，本輪不動）。
- `install.sh`／`install.ps1` 會把 `LICENSE` 與 `NOTICE` 一併複製到 `~/.local/share/ego-linux/app/`，符合自我散布時的義務，已驗證。
- 注意：Apache-2.0 是**程式碼授權，不是商標授權**（第 6 條）。`tp-browser`、`TooPower`、`EGo Browser`（Citro Labs）等名稱的商標權利不因開源而取得。

## 3. 外部執行環境（叫用、非散布）

以下軟體由終端使用者自備、由腳本偵測並叫用，本專案不複製、不散布其二進位檔，因此**不觸發其授權的散布義務**：

| 項目 | 授權類型 | 叫用位置 | 風險註記 |
|---|---|---|---|
| Node.js（≥22） | Node.js license（MIT 類） | 所有 wrapper | 純叫用，無義務 |
| Chromium 系瀏覽器（Chrome/Edge/Brave/Chromium） | Chrome/Edge：專有免費軟體＋服務條款；Chromium：BSD-3-clause 等 | `tp-start.sh`、`ego-start.ps1`、systemd unit | 若日後**打包散布**瀏覽器二進位，將觸發 Chrome 商標條款（不得散布帶 Chrome 商標的官方二進位）；應改散布 Chromium 並遵守 BSD-3-clause |
| git | GPLv2 | `install.sh`／`install.ps1`（remote pipe 安裝） | 僅叫用，GPL 無傳染 |
| curl、PowerShell、WMI、schtasks、systemd、icacls | 各 OS 內建／MIT 類 | 各腳本 | 無散布義務 |

**決策留給 BOB**：若規劃「離線安裝包」或「隨附瀏覽器」的發行型態，需重新做本表盤點。

## 4. 商標與命名風險（需法律覆核）

- 專案提供 `ego-browser`／`ego-browserd`／`ego-start` 等相容別名，README 明載概念啟發自 EGo Browser（Citro Labs）並聲明 clean-room 實作、未使用其程式碼或商標。**聲明本身合理，但「以他人產品名作為自己的可執行檔名」在商標法上有混淆誤認之虞的風險**，即使加了 clean-room 聲明也不必然免責。
- 保守建議：對外行銷文件（`docs/index.html`、README）避免把 `ego-*` 別名放在主要賣點位置；長期以 `tp-*` 為唯一正式名稱，`ego-*` 降級為 migration-only 的過渡別名並公告日落時間。

## 5. 安裝器供應鏈（與授權／完整性相關）

- `install.sh`／`install.ps1` 的 remote 安裝路徑為 `git clone --depth 1` 抓**預設分支最新版**，未固定 tag、未驗 checksum。這表示：
  1. 安裝到的程式碼授權內容（LICENSE／NOTICE）隨分支浮動，無法保證散布一致性；
  2. 若上游被入侵，遠端 pipe 安裝即以使用者身分執行任意程式碼。
- 建議（沿用 [`docs/fmb-upgrade/`](../fmb-upgrade/README.md) 結論）：安裝來源改為固定 release tag ＋ SHA256 驗證；本輪僅記錄，不修改安裝器。

## 6. 文件中的第三方內容

- `docs/` 下的驗收報告與 STATE 記錄含模型名稱、主機環境描述等作業中繼資料；若 repo 轉公開，這些屬於自家文件（Apache-2.0 或另註「文件僅供參考」），無授權問題，但**含個資面**議題見 `04-log-leak-fields.md` 第 5 節。

## 結論

| 項目 | 現況 | 評等 |
|---|---|---|
| npm 授權相容性 | 零相依，無衝突 | ✅ 無缺口 |
| Apache-2.0 散布義務 | LICENSE＋NOTICE 隨附 | ✅ 符合 |
| 商標（ego-* 別名） | clean-room 聲明＋同名執行檔 | ⚠️ 需 BOB 法律覆核 |
| 瀏覽器散布（未來） | 目前不散布 | ✅（維持不散布即無缺口） |
| 安裝來源固定版本 | 抓浮動分支 | ❌ 缺口（另案處理） |
