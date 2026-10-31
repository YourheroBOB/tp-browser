# tp-browser 架構決策紀錄與開發者指南

本目錄記錄從專案現有程式碼與文件整理出的架構決策，並提供新進開發者的模組地圖與修改指引。這些紀錄描述現有設計，不代表本次有修改或驗證執行時行為。

## 文件索引

### 架構決策紀錄

- [ADR-0001：使用 Node.js 原生能力與 CDP](ADR-0001-native-node-and-cdp.md)
- [ADR-0002：以本機 daemon 作為 CLI、SDK 與瀏覽器之間的邊界](ADR-0002-local-daemon-boundary.md)
- [ADR-0003：以 TaskSpace 與頁面標籤管理工作狀態](ADR-0003-taskspace-ledger.md)
- [ADR-0004：共用本機瀏覽器 Profile 支援人機共乘](ADR-0004-shared-local-profile.md)
- [ADR-0005：跨平台啟動器與連接埠配對](ADR-0005-platform-launchers-and-ports.md)
- [ADR-0006：本機服務的安全邊界](ADR-0006-local-security-boundary.md)

### 上手指南

- [新進開發者上手指南](DEVELOPER_GUIDE.md)

## 閱讀範圍與依據

本文件以 repo 中可見的程式碼與文件為依據，主要包含 `package.json`、`README.md`、CLI、CDP 用戶端、TaskSpace 儲存模組、啟動腳本與 Skill 指南。部分 daemon、SDK、頁面操作模組的實作細節未在本次可讀內容中完整呈現；涉及這些模組的描述以介面使用方式或專案文件所述為準，應在修改前對照當前原始碼。
