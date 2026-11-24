# 部署手冊（草稿）— PreVisit Desk 診前助理

> 狀態：草稿，2026-11-25。**文中每一段指令都標示 `[尚未執行]`**：主代理確認後才會在真實主機與 Cloudflare 上跑。
> 「本機已驗證」的項目與證據見最後一節；涉及主機、Cloudflare 帳號的步驟都沒有實際執行過。
> 這是展示用站台：只放虛構病人資料，介面已標示「請勿輸入真實病歷或個資」。

## 0. 先看這裡

| 項目 | 內容 |
| --- | --- |
| 目標主機 | AWS Lightsail、Ubuntu 24.04、x86_64，約 1.9 GiB 記憶體（可用約 1.0 GiB）、2 GiB 交換空間；同機已有另一個專案 `grex` |
| 做法 | 在**本機**建置映像檔，用 `docker save`、`scp`、`docker load` 送上主機；**主機上不編譯任何東西** |
| 本專案在主機上 | 一個獨立的 compose 專案 `previsit-desk`：`db`、`api`、`cloudflared` 三個容器，各有記憶體上限 |
| 對外 | 只經由**本專案自己的** Cloudflare Tunnel（新建，名稱 `previsit-desk`），網址 `https://previsit.naritaroad.com` |
| 主機不開任何新連接埠 | 只剩 SSH；API 只聽 `127.0.0.1:18088`，資料庫完全不對外 |
| 不碰 grex | 不動 `grex-grex-1`、不動主機上 cloudflared 的 systemd 服務、不動 20241 與 8080 |

### 這份文件用到的檔案

```
Dockerfile                   三階段映像檔（web、後端、執行階段）
.dockerignore                不讓 .env、金鑰、建置產物進入映像檔
compose.yaml                 本機開發：db；選用 profile app 可在本機試跑映像檔
deploy/compose.prod.yaml     正式環境：db + api + cloudflared（專案名 previsit-desk）
deploy/build-image.ps1       本機建置（linux/amd64）、標記、檢查
deploy/ship.ps1              送映像檔與部署檔到主機（支援 -WhatIf）
deploy/remote-up.sh          主機上：檢查 .env、啟動、等待健康（--check-only 只檢查）
deploy/rollback.sh           主機上：回復到前一個映像（預設只演練，--apply 才執行）
deploy/host-preflight.sh     主機上：唯讀盤點，挑出空的 HOST_PORT
deploy/backup-db.sh          主機上：pg_dump 備份
deploy/set-tunnel-token.sh   主機上：從標準輸入把 TUNNEL_TOKEN 寫進 .env（權杖不出現在指令列）
deploy/remote-common.sh      上述主機腳本共用的函式
deploy/cloudflare-tunnel.ps1 建立／檢查 Tunnel、入口規則、DNS（可重複執行）
deploy/smoke.ps1             部署後的 HTTPS 冒煙測試
.github/workflows/ci.yml     CI：後端、前端、Dockerfile／compose／shell 檢查（不部署）
```

## 1. 設計與理由（簡述）

1. **為什麼在本機建置**：主機只有約 1 GiB 可用記憶體，在上面編譯 Rust 會把 grex 一起拖垮。映像檔在本機（Docker Desktop，原生 `linux/amd64`，不需模擬）建好，壓縮後預估數十 MB（完整映像尚未建置，實際大小以 `ship.ps1` 印出的為準）再傳上去。
2. **為什麼不用 `docker save | gzip | ssh`**：Windows PowerShell 5.1 的管線會改壞二進位資料。`ship.ps1` 改成「存成檔、用 .NET 壓縮、`scp`、主機上驗證 SHA-256 再 `docker load`」，結果與管線版相同，多了驗證。GHCR 作為替代方案見 5.3，非必要。
3. **為什麼自己一條 Tunnel、一個 compose 專案**：主機上 grex 已有自己的 cloudflared（systemd）。本專案的 cloudflared 以容器形式跑在 `previsit-desk` 專案內，用**新 Tunnel 的權杖**，所以不共用網路、磁碟區、設定，也不需要動 grex 的任何東西。入口規則（`previsit.naritaroad.com` → `http://api:8088`）存在 Cloudflare 端，由 `cloudflare-tunnel.ps1` 以 API 設定。
4. **為什麼 API 不直接對外**：Tunnel 是**由容器主動連出去**，主機不需要任何入站連接埠。API 另外綁在 `127.0.0.1:18088` 只供主機本機冒煙測試；資料庫沒有 `ports`。
5. **健康檢查**：執行階段映像沒有 curl，`HEALTHCHECK` 與 compose 都呼叫 `/app/previsit-api healthcheck`（後端規格 §11）。
6. **容器加固**：非 root（uid 10001）、唯讀根檔案系統（`/tmp` 用 tmpfs，`noexec`）、`cap_drop: ALL`、`no-new-privileges`、記憶體與 pids 上限、日誌輪替（10 MB × 3）。資料庫容器因為官方映像啟動時需要切換使用者，所以只加 `no-new-privileges`，不丟掉所有 capability。
7. **機密**：`.env` 只存在主機（`chmod 600`），`remote-up.sh` 在檔案權限過寬時拒絕啟動；`.dockerignore` 排除所有 `.env`／金鑰；`build-image.ps1` 建完會掃描映像檔確認沒有這類檔案；api 容器內的 `TUNNEL_TOKEN` 被清空（即使它和 `cloudflared` 共用同一個 `.env`）。

### 記憶體預算

| 容器 | 上限 | 備註 |
| --- | --- | --- |
| db（PostgreSQL 18.6） | 256 MiB | `shared_buffers=48MB`、`max_connections=30`、`work_mem=4MB`、`effective_cache_size=128MB`、`maintenance_work_mem=32MB`（後端連線池最多 5 條） |
| api | 256 MiB | Rust 程式，閒置時約數 MiB |
| cloudflared | 128 MiB | |
| 合計 | 640 MiB | 主機可用約 1.0 GiB；`host-preflight.sh` 在可用記憶體低於 800 MiB 時警告 |

上限靠 Docker 的 `mem_limit`；超過會被 OOM 終止並由 `restart: unless-stopped` 重啟，不會吃掉 grex 的記憶體。

## 2. 前置條件

- 本機：Docker Desktop（含 buildx）、OpenSSH 用戶端（Windows 內建 `ssh`、`scp`）、PowerShell。
- 主機：Docker Engine 與 Compose 外掛已安裝（grex 已在用）；SSH 使用者的 docker 需要 `sudo`，腳本已自動處理（先試 `docker`，不行再用 `sudo -n docker`）。
- Cloudflare：網域 `naritaroad.com` 的區域（zone）、帳號 ID、區域 ID，以及一組**範圍受限**的 API 權杖（見 7.1）。
- 後端與前端原始碼完成：`backend/Cargo.toml`、`backend/Cargo.lock`、`backend/migrations/`、`web/package-lock.json`、`data/seed`。`build-image.ps1` 會先檢查這些檔案是否存在。

以下所有 PowerShell 指令都先設定這幾個變數（範例值；換主機時只改這裡）：

```powershell
# [尚未執行]
Set-Location C:\path\to\previsit-desk
$SshHost = 'ubuntu@<LIGHTSAIL_IP>'
$SshKey  = 'C:\Users\<you>\.ssh\<key>.pem'
$Remote  = 'previsit-desk'      # 主機上的部署目錄，相對於 ssh 使用者的家目錄
$SshOpt  = @('-i', $SshKey, '-o', 'IdentitiesOnly=yes')
```

## 3. 首次主機準備

### 3.1 把部署檔送上主機（不含映像檔）

```powershell
# [尚未執行] 先看會做什麼（不改任何東西）
.\deploy\ship.ps1 -SshHost $SshHost -SshKey $SshKey -RemoteDir $Remote -FilesOnly -WhatIf
# [尚未執行] 實際送出：建立目錄（700）並複製 compose.prod.yaml 與 *.sh；不會送 .env
.\deploy\ship.ps1 -SshHost $SshHost -SshKey $SshKey -RemoteDir $Remote -FilesOnly
```

### 3.2 唯讀盤點，挑出空的連接埠

```powershell
# [尚未執行] 唯讀：記憶體、磁碟、監聽埠、docker ps、空的 HOST_PORT
ssh @SshOpt $SshHost "cd $Remote && ./host-preflight.sh"
```

看輸出的三件事：`MemAvailable` 夠不夠（至少 800 MiB）、`grex-grex-1` 正在執行（記下它的狀態，之後比對）、最後一行 `SUGGESTED_HOST_PORT=…`（預設 18088；8080 是 grex、20241 是它的 cloudflared，本專案都不使用）。

## 4. 建置（在本機）

```powershell
# [尚未執行] 只檢查 Dockerfile（不建置）
.\deploy\build-image.ps1 -LintOnly
# [尚未執行] 建置 linux/amd64；標籤 = 年月日-時分-g<git 短碼>（有未提交變更會加 -dirty），同時打上 latest-local
.\deploy\build-image.ps1
```

腳本做的事：Dockerfile 檢查 → `docker buildx build --platform linux/amd64 --load` → 確認架構是 amd64 → 掃描映像檔內沒有 `.env`／金鑰檔 → 確認以 uid 10001 執行 → 試跑 `previsit-api check-data`（失敗只警告，請讀輸出）→ 把標籤寫進 `.tmp\last-image-tag.txt`。

建置前若要把最新的評測結果放進映像檔：先跑 `cd backend; cargo run -- eval`，`data/eval/results/summary.json` 會被帶進映像檔（其餘評測原始輸出被 `.dockerignore` 排除）。

### 本機試跑映像檔（選用）

```powershell
# [尚未執行] 用開發資料庫在本機跑一次真實映像檔（profile app）；http://127.0.0.1:8088
docker compose up -d db
docker compose --profile app up --build api
```

## 5. 出貨

### 5.1 送映像檔與部署檔

```powershell
# [尚未執行] 先演練
.\deploy\ship.ps1 -SshHost $SshHost -SshKey $SshKey -RemoteDir $Remote -WhatIf
# [尚未執行] 實際送出：docker save → gzip → scp → 主機上驗證 SHA-256 → docker load → 刪除壓縮檔
.\deploy\ship.ps1 -SshHost $SshHost -SshKey $SshKey -RemoteDir $Remote
```

主機端只多了：部署目錄、複製進去的檔案、一個新的映像標籤。沒有啟動任何東西。

### 5.2 主機上的映像清理

只清本專案自己的舊標籤，例如：`ssh … "sudo docker image rm previsit-desk:<舊標籤>"`。**不要**用 `docker image prune` 或 `docker system prune`（會碰到其他專案的映像）。至少保留「目前」與「前一個」標籤，回復才有得用。

### 5.3 替代方案：GHCR（非必要）

不想經 SSH 傳檔時，可以改推到 GitHub Container Registry（映像檔不含機密，但倉庫可見性要自己決定）：

```powershell
# [尚未執行] 本機：登入並推送（需要有 write:packages 的 token，輸入時不要貼在對話裡）
docker login ghcr.io -u <github 帳號>
docker tag previsit-desk:<標籤> ghcr.io/<擁有者>/previsit-desk:<標籤>
docker push ghcr.io/<擁有者>/previsit-desk:<標籤>
```

主機的 `.env` 加上 `IMAGE_REPO=ghcr.io/<擁有者>/previsit-desk` 與 `PULL_POLICY=missing`，再在主機上 `docker login ghcr.io` 後 `docker pull`。`remote-up.sh` 目前檢查的是 `previsit-desk:<標籤>`；改走 GHCR 時需要把檢查改成 `${IMAGE_REPO}`（尚未實作，因為預設流程不需要）。

## 6. 主機上的 `.env`

只放在主機，權限 600，**不要**貼到對話或提交進 git。`remote-up.sh` 不印出任何值，只印出變數名稱與「有／沒有設定」。

必填：

| 變數 | 說明 |
| --- | --- |
| `POSTGRES_PASSWORD` | 資料庫密碼。用十六進位字串（`openssl rand -hex 24`），避免 `@ : / # %` 等字元弄壞 `DATABASE_URL`。**只在資料庫第一次初始化時生效**，之後改 `.env` 不會改資料庫裡的密碼 |
| `CLINICIAN_USERNAME`、`CLINICIAN_PASSWORD` | 醫師端唯一帳號 |
| `LLM_MODEL` | 展示站用真模型名稱；`mock` 只供離線測試 |
| `GEMINI_API_KEY` | `LLM_MODEL` 不是 `mock` 時必填 |
| `TUNNEL_TOKEN` | 由 `cloudflare-tunnel.ps1` 寫入（見 7.4），不要手打 |

其餘（有預設值，可省略）：`POSTGRES_DB`、`POSTGRES_USER`、`HOST_PORT`（預設 18088）、`LLM_MODEL_FALLBACK`、`AGENT_MAX_STEPS`、`LLM_TIMEOUT_SECS`、`DAILY_MODEL_CALL_LIMIT`、`RATE_MESSAGES_PER_10MIN`、`RATE_VISITS_PER_10MIN`、`MAX_MESSAGE_CHARS`、`CLINICIAN_DISPLAY_NAME`、`SESSION_DAYS`、`RETENTION_DAYS`、`CLIENT_IP_HEADER`（部署預設 `cf-connecting-ip`）、`COOKIE_SECURE`（部署預設 `true`；設成 `false` 時 `remote-up.sh` 會拒絕）、`IMAGE_REPO`、`PULL_POLICY`。

不需要（compose 會覆寫或用不到）：`DATABASE_URL`、`BIND_ADDR`、`WEB_DIR`、`DATA_DIR`、`POSTGRES_PORT`、`EVAL_DELAY_MS`。

```powershell
# [尚未執行] 登入主機建立 .env（互動式；密碼用 printf 產生，不會顯示在畫面上）
ssh @SshOpt $SshHost
```

```bash
# [尚未執行] 以下在主機上執行
cd ~/previsit-desk
umask 077
cat > .env <<'EOF'
POSTGRES_DB=previsit
POSTGRES_USER=previsit
HOST_PORT=18088
LLM_MODEL=gemini-3.5-flash
LLM_MODEL_FALLBACK=gemini-3.1-flash-lite
GEMINI_API_KEY=
CLINICIAN_USERNAME=dr_demo
CLINICIAN_PASSWORD=
CLINICIAN_DISPLAY_NAME=Demo Clinician
DAILY_MODEL_CALL_LIMIT=800
RATE_MESSAGES_PER_10MIN=30
RATE_VISITS_PER_10MIN=10
MAX_MESSAGE_CHARS=800
SESSION_DAYS=7
RETENTION_DAYS=14
CLIENT_IP_HEADER=cf-connecting-ip
COOKIE_SECURE=true
EOF
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
nano .env            # 在編輯器裡填入 GEMINI_API_KEY 與 CLINICIAN_PASSWORD，存檔離開
chmod 600 .env
ls -l .env           # 應該是 -rw-------
```

## 7. Cloudflare Tunnel

### 7.1 建立 API 權杖（在 Cloudflare 儀表板，只做一次）

建立**自訂權杖**，範圍限制在本帳號與 `naritaroad.com` 這個區域：

- 帳號：Cloudflare Tunnel 編輯（Cloudflare Tunnel: Edit）
- 區域：DNS 編輯（DNS: Edit）、區域讀取（Zone: Read，用來檢查主機名稱是否屬於這個區域；沒有也能跑，只是會略過檢查）

完成後記下帳號 ID 與區域 ID（各為 32 位十六進位字串）。權杖只在這個 PowerShell 視窗的環境變數裡，**不要寫進檔案、不要貼到對話**。

```powershell
# [尚未執行] 互動輸入權杖（不回顯）
$sec = Read-Host 'Cloudflare API token' -AsSecureString
$env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$env:CF_ACCOUNT_ID = '<32 位十六進位>'
$env:CF_ZONE_ID    = '<32 位十六進位>'
```

### 7.2 先看它會做什麼

```powershell
# [尚未執行] 完全不連網，只印出會送出的請求（不需要權杖）
.\deploy\cloudflare-tunnel.ps1 -DryRun
# [尚未執行] 只做讀取（GET），所有寫入都略過
.\deploy\cloudflare-tunnel.ps1 -WhatIf
```

### 7.3 實際建立（可重複執行）

腳本依序：以**精確名稱** `previsit-desk` 找 Tunnel，沒有就建立（`config_src=cloudflare`）→ 設定入口規則 `previsit.naritaroad.com → http://api:8088` 加一條 404 預設規則 → 建立／確認 proxied CNAME `previsit → <tunnel-id>.cfargotunnel.com` → 取得權杖並儲存 → 印出狀態（不印任何機密）。

安全防護：已存在、指向別處的 CNAME **不會被覆蓋**（要 `-ReplaceDns`）；同名的 A／AAAA 等記錄會直接停止，不會刪除；所有衝突都在建立任何東西**之前**檢查；只動這一條 Tunnel 與這一個主機名稱。

### 7.4 把權杖交給主機（二選一）

```powershell
# [尚未執行] 方式一（建議）：權杖從標準輸入直接寫進主機的 .env，不落地、不出現在指令列。
# 前提：3.1 已把 set-tunnel-token.sh 送上主機，且 6 的 .env 已建立。
.\deploy\cloudflare-tunnel.ps1 -SaveTokenToHost -SshHost $SshHost -SshKey $SshKey -RemoteDir $Remote

# [尚未執行] 方式二：存成本機檔（.cloudflared\previsit-desk.token，僅目前使用者可讀，已被 .gitignore 排除）
.\deploy\cloudflare-tunnel.ps1
```

```powershell
# [尚未執行] 用完就清掉這個視窗裡的憑證
Remove-Item Env:CLOUDFLARE_API_TOKEN, Env:CF_ACCOUNT_ID, Env:CF_ZONE_ID
```

### 7.5 沒有網域時的備案：trycloudflare

`-Hostname` 可以改成同一區域內的其他名稱（例如 `-Hostname previsit-test.naritaroad.com`）。若暫時沒有可用網域，可在主機上開一條**臨時**快速通道，只用來確認應用程式活著：

```bash
# [尚未執行] 在主機上；用本專案自己的網路，Ctrl+C 結束（容器 --rm 會自動移除）
sudo docker run --rm --network previsit-desk_default cloudflare/cloudflared:2026.11.2 tunnel --no-autoupdate --url http://api:8088
```

輸出會有一個隨機的 `https://….trycloudflare.com` 網址。Cloudflare 文件列出的限制：**不支援 Server-Sent Events（SSE）**、同時最多 200 個進行中的請求、**不保證可用時間**、每次網址都不同。因此它**不適合**當展示站（對話串流可能失效），只當備案。

## 8. 啟動與驗證

### 8.1 啟動

```powershell
# [尚未執行] 只檢查：.env 權限、必填變數、HOST_PORT 是否空閒、映像是否已載入、compose 是否有效；不改任何東西
$tag = (Get-Content .tmp\last-image-tag.txt -TotalCount 1).Trim()
ssh @SshOpt $SshHost "cd $Remote && ./remote-up.sh --check-only --tag $tag"
# [尚未執行] 先只啟動 db 與 api（不含 cloudflared），確認應用程式本身健康
ssh @SshOpt $SshHost "cd $Remote && ./remote-up.sh --no-tunnel --tag $tag"
# [尚未執行] 全部啟動（需要 .env 有 TUNNEL_TOKEN）
ssh @SshOpt $SshHost "cd $Remote && ./remote-up.sh --tag $tag"
```

`remote-up.sh` 會：拒絕 `.env` 不存在或群組／其他人可讀 → 檢查必填變數與 `COOKIE_SECURE` → 先記錄 `.deploy-state`（回復用）→ `docker compose -p previsit-desk up -d` → 等 db、api、cloudflared 健康 → 對 `127.0.0.1:<HOST_PORT>/api/v1/health` 要 200 → 印出狀態，並在前後各列一次「其他容器」（例如 grex）的名稱、狀態與啟動時間，證明沒被動到。

### 8.2 驗證

```powershell
# [尚未執行] 主機本機（loopback）冒煙測試
ssh @SshOpt $SshHost "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18088/api/v1/health"
# [尚未執行] 經 Cloudflare 的 HTTPS 冒煙測試：/api/v1/health 與 / 的狀態碼
.\deploy\smoke.ps1
```

手機驗證（請用**行動網路**，不要連 Wi-Fi，才確認真的從外網進得來）：

1. 開 `https://previsit.naritaroad.com/`，確認有鎖頭、頁面載入、有「請勿輸入真實病歷或個資」提示。
2. 建立一次虛構預問診，輸入「我最近睡不好」，確認收到回覆。
3. 輸入「我胸口悶痛」，確認立即出現 119／急診的固定提醒（紅旗規則，不呼叫模型）。
4. 醫師端登入（`CLINICIAN_USERNAME`），確認看得到剛才的紅旗轉交單。
5. 登入後重新整理仍保持登入（確認 `COOKIE_SECURE=true` 在 HTTPS 下運作）。

### 8.3 日誌與狀態

互動登入主機後定義一個縮寫（每個 compose 指令都限定在本專案）：

```bash
# [尚未執行] 在主機上
cd ~/previsit-desk
dc() { sudo docker compose -p previsit-desk --env-file .env --env-file .deploy-state -f compose.prod.yaml "$@"; }
dc ps
dc logs --tail 100 api
dc logs --tail 50 cloudflared
dc logs -f --tail 20 api            # Ctrl+C 離開
sudo docker stats --no-stream $(dc ps -q)   # 只看本專案三個容器的記憶體
```

日誌在 `info` 層級不含訊息內容（後端規格 §10）。每個容器日誌最多 10 MB × 3 份。

## 9. 回復

```powershell
# [尚未執行] 先備份資料庫（升級前的習慣；遷移只往前走）
ssh @SshOpt $SshHost "cd $Remote && ./backup-db.sh"
# [尚未執行] 演練：顯示會回到哪個標籤，不改任何東西
ssh @SshOpt $SshHost "cd $Remote && ./rollback.sh"
# [尚未執行] 執行：把 api 換回前一個映像，等健康、驗證 /api/v1/health
ssh @SshOpt $SshHost "cd $Remote && ./rollback.sh --apply"
```

只會重建 `api` 容器（`up -d --no-deps api`），db、cloudflared 與其他專案都不動。可用 `--to <標籤>` 指定其他已載入的標籤。若新版已套用資料庫遷移、舊版不認得，舊版可能拒絕啟動：這時要靠 `backup-db.sh` 的備份還原（`backups/` 目錄，權限 600）。

還原備份會**覆寫資料**，需要時先停下來確認，再在主機上執行：`gunzip -c backups/<檔名>.sql.gz | dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`（建議還原到全新的資料庫）。

## 10. 資料保留

- 後端每天與啟動時，刪除 `last_activity_at` 早於 `RETENTION_DAYS`（預設 14）天的 visit，連同訊息、工具記錄、轉交單等子表（`on delete cascade`）。不存 IP、不存姓名欄位。
- 改天數：編輯主機 `.env` 的 `RETENTION_DAYS`，再 `./remote-up.sh`（api 會因環境變更而重建）。
- 檢查：`dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*), min(last_activity_at) from visits"'`。
- 資料庫在具名磁碟區 `previsit-desk_pgdata`；容器重建不會清掉資料。備份檔放在 `~/previsit-desk/backups/`，**不會自動刪除**，空間緊時請手動清理。
- 這是展示站，只應有虛構資料；若不小心輸入了真實資料，請用 SQL 立即刪除該筆 visit，並調低 `RETENTION_DAYS`。

## 11. 資源限制與監看

- compose 的 `mem_limit`：db 256 MiB、api 256 MiB、cloudflared 128 MiB；CPU 上限 db 0.5、api 1.0、cloudflared 0.5 顆；api 與 cloudflared 的 pids 上限 256。
- 看用量：`sudo docker stats --no-stream $(dc ps -q)`。
- 是否被 OOM 終止：`sudo docker inspect -f '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' $(dc ps -q)`。
- 主機層：`free -m`、`df -h`；`host-preflight.sh` 可隨時重跑（唯讀）。
- 與 grex 的相互影響：兩邊都有上限；若主機記憶體吃緊，先看 `free -m` 的交換空間使用量，再決定要不要調整 `DAILY_MODEL_CALL_LIMIT` 或資源上限。

## 12. 安全備忘

- **主機不開任何新連接埠**：Lightsail 防火牆不需要為本專案新增任何規則；不要為它開放 8088、18088、5432。
- Cloudflared 只有對外連線；API 綁 `127.0.0.1:18088`；資料庫沒有 `ports`，只在專案內部網路。
- 映像檔不含機密（`.dockerignore` + 建置後掃描）；`.env` 只在主機、權限 600；`remote-up.sh`、`rollback.sh`、`backup-db.sh` 都會檢查權限。
- Cloudflare API 權杖範圍只限本帳號的 Tunnel 與本區域的 DNS，用完清掉環境變數；不再需要時可到儀表板撤銷。
- 所有腳本預設安全：`ship.ps1`、`cloudflare-tunnel.ps1` 有 `-WhatIf`，`cloudflare-tunnel.ps1` 另有 `-DryRun`；`rollback.sh` 預設只演練；`remote-up.sh` 有 `--check-only`。
- 容器：非 root、唯讀根檔案系統、`cap_drop: ALL`、`no-new-privileges`。
- 可選強化：在 Cloudflare 對 `/api/v1/` 加速率限制規則，或對醫師端路徑加 Cloudflare Access（本文件未設定）。

### 絕對不要在主機上做的事（grex 保護）

- 不要停止、重啟、刪除 `grex-grex-1` 或任何不屬於 `previsit-desk` 專案的容器、磁碟區、網路。
- 不要執行 `docker compose down`（沒有 `-p previsit-desk -f compose.prod.yaml`）、`docker system prune`、`docker image prune`、`docker volume prune`、`docker network prune`、`docker rm`、`docker volume rm`（對象不是本專案）。
- 不要動主機上 cloudflared 的 systemd 服務（`systemctl stop/restart/disable cloudflared`）、不要改它的設定檔或權杖。
- 不要在主機上編譯（`cargo`、`npm run build`、`docker build`）。
- 所有 compose 指令都帶 `-p previsit-desk` 與 `-f compose.prod.yaml`（腳本與 `dc` 縮寫都已這樣做）。

## 13. 疑難排解

| 現象 | 可能原因與處理 |
| --- | --- |
| `remote-up.sh` 說 `.env has mode …` | `chmod 600 ~/previsit-desk/.env` |
| `remote-up.sh` 說 `HOST_PORT … in use` | 跑 `./host-preflight.sh`，把它建議的埠寫進 `.env` 的 `HOST_PORT` |
| `image previsit-desk:<標籤> is not loaded` | 還沒 `ship.ps1`，或標籤打錯：`sudo docker image ls previsit-desk` |
| db 一直不健康，日誌說密碼錯誤 | `POSTGRES_PASSWORD` 只在資料庫第一次初始化時生效。要改密碼請在資料庫內 `ALTER USER`，不要只改 `.env` |
| api 不健康 | `dc logs --tail 100 api`；用 `dc run --rm --no-deps api check-data` 檢查資料檔；`/api/v1/health` 回 503 代表連不上資料庫 |
| 網址顯示 Cloudflare 1033／502 | cloudflared 沒連上或入口規則不對：`dc logs cloudflared`；`TUNNEL_TOKEN` 是否寫入；重跑 `cloudflare-tunnel.ps1` 確認入口規則為 `http://api:8088` |
| 524 逾時 | Cloudflare 代理對單一請求等待約 100 秒；檢查模型呼叫是否卡住（`LLM_TIMEOUT_SECS` 預設 45） |
| 登入後馬上又被登出 | `COOKIE_SECURE=true` 只能在 HTTPS 下運作；用 `http://127.0.0.1:18088` 測登入會失敗，這是預期行為 |
| 所有人被當成同一個 IP 而被限速 | `CLIENT_IP_HEADER` 要是 `cf-connecting-ip` |
| `docker load` 空間不足 | `df -h`；只刪本專案的舊標籤（`sudo docker image rm previsit-desk:<舊標籤>`） |
| `ssh` 顯示 `Permission denied (publickey)` | 金鑰檔權限過寬：`icacls $SshKey /inheritance:r /grant:r "$($env:USERNAME):R"` |
| `cloudflare-tunnel.ps1` 說 CNAME 已指向別處 | 先確認那是不是別的服務；確定可以取代才加 `-ReplaceDns` |
| 建置時 `touch`／快取相關錯誤 | 加 `-NoCache` 重建；另見第 14 節的假設 |

## 14. 已知假設與限制

- Dockerfile 的相依快取層假設後端是**單一 crate**，二進位檔名為 `previsit-api`，`Cargo.toml` 沒有自訂 `[[bin]] path`、沒有 `build.rs`（有的話要調整那一層）。
- 映像建置使用 `cargo build --locked`：`backend/Cargo.lock` 必須與 `Cargo.toml` 同步（先在本機 `cargo build` 一次讓鎖檔更新，再提交）。SQL 假設都是執行期的靜態字串；若程式使用 `sqlx::query!` 這類編譯期檢查巨集，建置階段還需要 `.sqlx` 離線資料。
- 前端建置假設 `web/` 自給自足（`npm run build` 不讀 `web/` 以外的檔案）；映像檔只複製 `data/seed`、`data/rag`、`data/eval`。
- 執行階段的時區是 UTC（映像有 tzdata，但沒設定 `TZ`）；若慢箋日期用伺服器日期計算，台灣凌晨 0–8 點會差一天，這個決定屬於後端，不是部署。
- `previsit-api healthcheck` 與 `check-data` 子指令依後端規格 §11 假設已實作；後端完成前無法驗證。
- 完整映像尚未建置過（後端與前端原始碼仍在撰寫），所以建置腳本與 Dockerfile 的整合尚未實測；各階段與各腳本已分開驗證（第 16 節）。

## 15. 基底映像與元件版本（查證日 2026-11-25）

| 元件 | 採用 | 狀態與說明 | 來源 |
| --- | --- | --- | --- |
| Rust 建置映像 | `rust:1.99-slim-trixie`（內容與 `1.99.1-slim-trixie` 相同，digest `sha256:f6c4a35d…`） | 最新穩定版已是 1.100.0（2026-11-12）。Rust 只維護最新版，1.99 已不再更新。依後端規格與本機工具鏈（1.99.0）先固定 1.99；升級時映像、CI 的 `RUST_VERSION` 與本機一起改。`rust:1.100-slim-trixie` 已存在 | 登錄檔查詢（`docker buildx imagetools inspect`）；<https://endoflife.date/api/rust.json> |
| Node 建置映像 | `node:24-trixie-slim`（digest `sha256:4d00acb4…`） | Node 24：2025-10-28 進入 LTS，2026-10-20 起為維護階段，支援到 2028-04-30。Node 26 於 2026-10-28 成為 Active LTS，`node:26-trixie-slim` 存在。只用於建置階段，與 `web/package.json` 的 `engines`（>=24）相符；`npm ci`、`tsc 7.0.2`、`vite 8.3.8` 已在此映像實測可執行 | 登錄檔查詢；<https://endoflife.date/api/nodejs.json> |
| 執行階段 | `debian:trixie-slim`（digest `sha256:8aa5a7bf…`） | Debian 13（trixie），支援期限到 2030-06-30（依 endoflife.date 資料）；映像建立於 2026-11-23 | 登錄檔查詢；<https://endoflife.date/api/debian.json> |
| PostgreSQL | `postgres:18.6-trixie`（digest `sha256:e3d24f69…`） | 與開發用 `compose.yaml` 一致，標籤存在。**18.7 已於 2026-11-09 發布**（`postgres:18.7-trixie` 存在）；同一主版本內升級只需換標籤。PostgreSQL 19.0 於 2026-11-19 發布，未採用 | 登錄檔查詢；<https://endoflife.date/api/postgresql.json> |
| cloudflared | `cloudflare/cloudflared:2026.11.2` | GitHub 最新發行版，2026-11-23 發布；Docker Hub 有 `linux/amd64` 映像（tag 的 `latest` 也指向同版）。距今只有兩天，若想保守可退到 2026.10.7（2026-10-30）。映像以 uid 65532 執行、預設關閉自動更新；已在本機確認 `tunnel ready`、`--metrics`、`--token`、`--no-autoupdate` 旗標存在 | <https://github.com/cloudflare/cloudflared/releases/tag/2026.11.2>；<https://hub.docker.com/v2/repositories/cloudflare/cloudflared/tags>；<https://api.github.com/repos/cloudflare/cloudflared/releases/latest> |
| GitHub Actions | `actions/checkout` v7.0.1、`actions/setup-node` v7.1.0、`Swatinem/rust-cache` v2.9.3 | 以完整 commit SHA 固定（版本寫在註解） | <https://api.github.com/repos/actions/checkout/releases/latest> 等三個倉庫的 releases／tags API |
| Cloudflare API | `cfd_tunnel`（建立、設定、權杖）、`dns_records` | 呼叫方式依官方文件實作 | <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/>；<https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/>；快速通道限制：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/> |

## 16. 本機已驗證的項目（證據摘要）

這些是在開發機上、不碰主機與 Cloudflare 的驗證；**主機與 Cloudflare 端尚未驗證**。

- `docker compose config`（根目錄、`--profile app`、`deploy/compose.prod.yaml`）皆通過；缺少 `POSTGRES_PASSWORD` 時如預期報錯；api 容器內 `TUNNEL_TOKEN` 為空、`COOKIE_SECURE`／`CLIENT_IP_HEADER` 的預設值正確。
- `docker buildx build --check`：Dockerfile 無警告（負向對照會回傳非零，所以 CI 的檢查有意義）。
- 執行階段階段（用假的二進位檔）建置成功：uid 10001、`HEALTHCHECK`、標籤、映像內無 `.env`／金鑰檔。
- 正式 compose 的 `db` 與 `api` 在拋棄式專案中啟動並健康：PostgreSQL 18.6 套用 `shared_buffers=48MB` 等五個參數；`api` 唯讀根檔案系統（寫入 `/app` 失敗）、`/tmp` 可寫且 `noexec`、`CapEff=0`、`NoNewPrivs=1`、記憶體上限 256 MiB、僅綁 `127.0.0.1`；db 無對外連接埠。
- 主機腳本在 WSL Ubuntu 實測：拒絕缺少／權限過寬的 `.env`、占位密碼、`COOKIE_SECURE=false`、缺少 `TUNNEL_TOKEN`、未知映像標籤、被占用的 `HOST_PORT`；成功路徑（升級、回復演練與執行、前後其他容器不變）；`backup-db.sh`；`set-tunnel-token.sh`。`shellcheck` 通過。
- `cloudflare-tunnel.ps1` 對**本機模擬的 Cloudflare API**實測：`-DryRun`、`-WhatIf`、建立、重跑（皆為 unchanged）、CNAME 指向別處、同名 A 記錄、主機名稱不在區域內、權杖錯誤；都在寫入前停止。`smoke.ps1` 對本機模擬站台實測通過與失敗路徑。
- `npm ci` 與 `tsc`、`vite` 在 `node:24-trixie-slim`（linux/amd64）內執行成功。
- Rust 相依快取層（`Cargo.toml` + 假的 `main.rs`）在 `rust:1.99-slim-trixie` 內以不加 `--locked` 的方式編譯成功（含 `aws-lc-sys`、`sqlx`、`genai`，cargo 約 50 秒），代表 `build-essential cmake pkg-config` 足夠。加上 `--locked` 時目前會失敗：`backend/Cargo.lock` 還是舊的（仍含 `rmcp`），與新的 `Cargo.toml` 不同步，需要先在本機 `cargo build` 更新並提交鎖檔。真正的後端原始碼（`src/main.rs` 尚未存在）沒有編譯過。
- `actionlint` 對 `ci.yml` 無問題。

## 17. 部署檢查表

部署前
- [ ] CI 綠燈（後端、前端、Dockerfile／compose／shell 檢查）
- [ ] `build-image.ps1` 成功，標籤已記錄；`check-data` 沒有警告
- [ ] 主機 `host-preflight.sh`：可用記憶體 ≥ 800 MiB、有空的 `HOST_PORT`、grex 正常
- [ ] 主機 `.env` 權限 600、必填變數都有值；`COOKIE_SECURE` 不是 `false`
- [ ] 已有資料庫備份（`backup-db.sh`），回復計畫就是 `rollback.sh`
- [ ] Cloudflare：`cloudflare-tunnel.ps1 -DryRun`、`-WhatIf` 輸出符合預期

部署
- [ ] `ship.ps1 -WhatIf` → `ship.ps1`
- [ ] `remote-up.sh --check-only` → `--no-tunnel` → 完整啟動
- [ ] `smoke.ps1` 全部 PASS；手機（行動網路）走完第 8.2 節

部署後
- [ ] `dc ps` 三個容器健康；`docker stats` 在上限內；`grex-grex-1` 啟動時間沒變
- [ ] 觀察 15 分鐘：`dc logs --tail 100 api` 沒有錯誤迴圈
- [ ] 更新 `CHANGELOG.md`

回復條件
- `/api/v1/health` 連續失敗、對話或登入流程壞掉、紅旗訊息沒有立即回覆 119 → `./rollback.sh --apply`
