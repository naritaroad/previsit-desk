# AGENTS.md — PreVisit Desk 診前助理

先讀 `.agent-context/INDEX.md`（狀態、讀取順序），再依需要讀 `docs/product/product-spec.md`、`docs/api/contract.md`、`docs/engineering/backend-spec.md`、`docs/design/visual-direction.md`。

## 規則

1. **產品界線**：AI 只做預問診與慢箋檢核，不診斷、不開藥、不給劑量。紅旗規則先於模型；慢箋判斷由 Rust 程式決定，不交給模型。
2. **語言**：介面與文件以繁體中文（台灣用語）為主，另有英文。不得出現簡體字與中國用語。介面文字一律放 `web/src/i18n/locales/`，元件不寫死文字；改完跑 `npm run i18n:check`。
3. **機密**：`.env`、金鑰、token、密碼不進 git、不進映像、不印在日誌或對話。新增環境變數時同步更新 `.env.example`。
4. **名稱**：本專案不得出現來源專案的角色或品牌字樣（驗收指令 `scripts/check-forbidden-names.ps1`，說明見 `docs/engineering/backend-spec.md` §12）。`NOTICE.md` 與 `CHANGELOG.md` 的來源說明除外。
5. **版本控制**：直接在 `main` 工作。commit 只用使用者本人身分，不加 `Co-Authored-By`、session 連結或 "Generated with"。子代理不要自行 `git commit`／`push`，由主代理整合。
6. **同一件事只有一個來源**：數字（慢箋日數、窗口天數）放 `data/seed/*.csv`，規則文字放 `data/rag/*.md`，紅旗規則放 `data/seed/red_flags.csv`；程式與文件引用，不重複寫。
7. **Rust**：不要頻繁編譯；完成一個工作單位再 `cargo test`。SQL 用靜態字串（SQLx 0.9 要求 `&'static str`）。不要讓模型送自由 SQL。
8. **展示資料**：只用虛構病人；介面標示「請勿輸入真實病歷或個資」。

## 指令

```powershell
docker compose up -d db                      # PostgreSQL（本機連接埠 5433）
cd backend; cargo run                        # API（讀專案根目錄 .env）
cd backend; cargo test
cd backend; cargo run -- eval                # 真模型評測，結果寫入 data/eval/results/
cd web; npm run dev                          # 前端，/api 代理到 127.0.0.1:8088
cd web; npm run build                        # i18n 檢查＋型別檢查＋建置
```
