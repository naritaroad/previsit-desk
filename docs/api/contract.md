# HTTP API 合約（v1）

前綴 `/api/v1`。JSON、UTF-8。**後端與前端都以這份為準**；要改先改這份。錯誤格式：`{"error":{"code":"...","message":"..."}}`，`message` 依請求的 `Accept-Language`／visit locale 回 zh-TW 或 en。改變狀態的請求只收 `application/json`。

時間一律 ISO 8601（UTC，`2026-11-25T08:00:00Z`）；日期欄位 `YYYY-MM-DD`（以 Asia/Taipei 解讀）。

## 1. 型別

```ts
type Locale = 'zh-TW' | 'en'
type VisitStatus = 'active' | 'red_flag' | 'submitted' | 'reviewed'
type Stage = 'chief_complaint' | 'hpi' | 'background' | 'confirm' | 'done'
type Urgency = 'routine' | 'soon' | 'urgent'
type RedFlagCategory = 'chest_pain' | 'dyspnea' | 'stroke' | 'consciousness' | 'gi_bleeding'
                     | 'anaphylaxis' | 'seizure' | 'suicide'
type SpecialStatus = 'none' | 'going_abroad' | 'returning_island' | 'ocean_fishing_crew'
                   | 'international_crew' | 'rare_disease'
type RefillOutcome = 'eligible' | 'too_early' | 'revisit' | 'consult'
type TicketReason = 'red_flag' | 'prescription_request' | 'controlled_drug' | 'symptom_change'
                  | 'side_effects' | 'special_status' | 'out_of_scope_medical' | 'patient_request' | 'other'

interface Visit {
  id: string                 // UUID v4，也是病人端的存取憑證
  locale: Locale
  status: VisitStatus
  stage: Stage
  urgency: Urgency           // 該 visit 目前最高的轉交單緊急程度，沒有轉交單為 routine
  created_at: string
  updated_at: string
  submitted_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null // 醫師顯示名稱
  review_note: string | null
}

interface Message {
  id: string
  role: 'patient' | 'assistant'
  kind: 'opening' | 'chat' | 'red_flag' | 'refusal' | 'notice'   // opening=開場揭露；red_flag/refusal/notice=固定文字
  content: string
  created_at: string
  run_id: string | null
}

// 問診欄位。string 欄位 null＝尚未取得；'不適用'／'N/A' 表示不適用。
interface ListField { answered: boolean; items: string[] }   // answered=true 且 items=[] 代表「無」
interface IntakeState {
  chief_complaint: string | null
  hpi: {
    onset: string | null       // O 何時開始
    modifiers: string | null   // P 加重／緩解
    character: string | null   // Q 性質
    location: string | null    // R 部位／放射
    severity: number | 'n/a' | null  // S 0–10；'n/a'＝病人無法或不需評分（視為已取得）
    course: string | null      // T 病程變化／持續多久
    associated: string | null  // 伴隨症狀
  }
  past_history: ListField
  medications: ListField
  allergies: ListField
  patient_questions: string[]
}
interface IntakeView {
  state: IntakeState
  stage: Stage
  missing: string[]            // 欄位鍵，如 'hpi.onset'、'allergies'，依詢問順序
  progress: { done: number; total: number }
}

interface RedFlagHit { category: RedFlagCategory; label: string; matched_at: string /* ISO 時間戳，不是命中的文字 */; message_id: string }

interface ToolCall {          // 追蹤面板的一列
  id: string
  run_id: string | null
  step: number
  name: 'red_flag_precheck' | 'scope_precheck' | 'pii_filter' | 'output_guard' | 'record_intake'
      | 'search_health_education' | 'check_chronic_refill' | 'transfer_to_clinician' | 'save_previsit_summary'
  source: 'code' | 'model' | 'form'
  status: 'ok' | 'rejected' | 'error'
  arguments: unknown
  result: unknown              // 精簡後的結果（不含完整 RAG 內文；RAG 回 section 清單）
  duration_ms: number
  created_at: string
}

interface Run {
  id: string; model: string; fallback_used: boolean
  status: 'running' | 'completed' | 'failed' | 'skipped'   // skipped＝紅旗／越界規則直接回覆，未呼叫模型
  steps: number; usage: { input_tokens: number; output_tokens: number }
  error_code: string | null; duration_ms: number; created_at: string
}

interface RefillInput {
  prescription_date: string       // 慢箋開立日
  total_days: number              // 醫師開立的總給藥日數
  days_per_fill: number           // 每次調劑日數
  fills_done: number              // 已領幾次（1 或 2）
  last_fill_date: string          // 上次領藥日
  today?: string                  // 省略＝伺服器今天（展示用可覆寫）
  controlled: 'no' | 'yes' | 'unsure'   // 處方是否含第一、二級管制藥品
  special_status: SpecialStatus
  symptom_changed: boolean
  side_effects: boolean
}
interface RefillResult {
  outcome: RefillOutcome
  title: string                   // 已依 locale 在地化
  message: string
  today: string
  earliest_date: string | null    // 最早可領日（上次給藥屆滿日 − 10 天）
  latest_date: string | null      // 慢箋有效期限（開立日 + 總日數）
  next_fill_number: number | null
  reasons: { code: string; text: string }[]
  rules: { key: string; text: string; source_url: string }[]
  handoff: boolean                // true＝已建立轉交單
  ticket_no: string | null
}

interface PrevisitSummary {
  visit_id: string
  chief_complaint: string | null  // 提早送出且尚無主訴時為 null
  hpi: IntakeState['hpi']
  past_history: string[]; medications: string[]; allergies: string[]
  not_collected: string[]         // 病人未回答的欄位鍵
  red_flag_screen: { checked: boolean; triggered: { category: RedFlagCategory; label: string }[]; note: string }
  patient_questions: string[]
  narrative: string               // 給醫師看的一段摘要（≤ 300 字，不含診斷）
  refill: RefillResult | null     // 最近一次慢箋檢核
  generated_by: { kind: 'model' | 'code'; model: string | null; at: string }
  disclaimer: string
}

interface Ticket {
  id: string; ticket_no: string   // 'T-20261125-0001'
  visit_id: string
  reason: TicketReason; urgency: Urgency; summary: string
  status: 'open' | 'resolved'
  created_by: 'model' | 'code' | 'form'
  created_at: string
  resolved_at: string | null; resolved_by: string | null; resolution_note: string | null
}

interface VisitDetail {            // GET /visits/{id}（病人端與醫師端同形）
  visit: Visit
  messages: Message[]
  intake: IntakeView
  summary: PrevisitSummary | null
  red_flag: RedFlagHit | null
  tickets: Ticket[]
  tool_calls: ToolCall[]           // 時間順序
  runs: Run[]
  refill_checks: { id: string; input: RefillInput; result: RefillResult; created_at: string }[]
}
```

## 2. 公開端點（病人）

| 方法與路徑 | 說明 |
|---|---|
| `GET /health` | `{ok:true, version, model_ready:boolean}`；供部署健康檢查，不呼叫模型 |
| `GET /meta` | `{app, version, models:{primary,fallback}, retention_days, max_message_chars, daily_limit_reached:boolean, eval: EvalSummary \| null}` |
| `POST /visits` | body `{locale}` → `201 {visit: Visit, messages: [Message /*opening*/]}`；每 IP 每 10 分鐘有上限（`rate_limited` 429） |
| `GET /visits/{id}` | `VisitDetail`。id 不存在或已過保留期限 → 404 `not_found` |
| `POST /visits/{id}/messages` | body `{content}`（1–`max_message_chars` 字）→ **SSE**（§4）。狀態 `submitted`／`reviewed` → 409 `visit_closed`。訊息有速率限制 |
| `POST /visits/{id}/refill-check` | body `RefillInput` → `200 {result: RefillResult}`；寫入追蹤（`source:'form'`）；`consult` 時自動開轉交單。欄位不合法 → 422 `invalid_request`（`error.fields` 列出欄位） |
| `POST /visits/{id}/submit` | 結束並送出：沒有摘要就由程式產生；→ `200 {visit, summary}`；狀態變 `submitted` |
| `POST /visits/{id}/handoff` | body `{reason?: TicketReason, note?: string(≤300)}` 病人主動「請醫師聯絡我」→ `201 {ticket}` |

`EvalSummary`：`{ran_at, model, total, passed, categories:[{key:'intake'|'red_flag'|'refill'|'out_of_scope'|'boundary', total, passed}]}`，來自 `data/eval/results/summary.json`。

## 3. 醫師端（需登入）

登入用 HttpOnly cookie `pv_session`（SameSite=Lax；`COOKIE_SECURE` 控制 Secure）。

| 方法與路徑 | 說明 |
|---|---|
| `POST /auth/login` | `{username, password}` → `{user:{username, display_name, role:'clinician'}}`；失敗 401 `invalid_credentials`；有登入嘗試限速 |
| `POST /auth/logout`、`GET /auth/me` | `me` 未登入 401 `unauthorized` |
| `GET /clinician/visits?status=&q=&limit=` | `{items: ClinicianVisitItem[]}`；排序：`urgent` 優先、再依最後活動時間新到舊 |
| `GET /clinician/visits/{id}` | `VisitDetail`（含完整對話與工具追蹤） |
| `POST /clinician/visits/{id}/review` | `{note?}` → `{visit}`，狀態 `reviewed`、記錄醫師與時間；只有 `submitted` 或 `red_flag` 的 visit 可審閱 |
| `GET /clinician/tickets?status=open\|resolved\|all` | `{items: (Ticket & {chief_complaint: string \| null})[]}`；`urgent` 優先 |
| `POST /clinician/tickets/{id}/resolve` | `{note?}` → `{ticket}` |

```ts
interface ClinicianVisitItem {
  visit: Visit
  chief_complaint: string | null
  red_flag: { category: RedFlagCategory; label: string } | null
  open_tickets: number
  has_summary: boolean
  message_count: number
  last_activity_at: string
}
```

## 4. 串流事件（SSE）

`POST /visits/{id}/messages` 回 `text/event-stream`；每個事件：

```
event: <type>
data: {"v":1,"seq":<n>,"type":"<type>","data":{...}}
```

`seq` 在同一串流內由 1 遞增。順序：`message.accepted` 最先；`run.completed`／`run.failed` 最後。用戶端斷線不取消處理，結果照常存檔，重新整理後用 `GET /visits/{id}` 取回。

| type | data |
|---|---|
| `message.accepted` | `{message_id, visit_id}` 病人訊息已存檔 |
| `precheck.completed` | `{red_flag: RedFlagHit \| null, scope: 'ok' \| 'prescription_request' \| 'injection' \| 'controlled_drug', duration_ms}` 程式前置檢查結果（每則訊息都會有） |
| `redflag.triggered` | `{category, label, message_id}` 之後緊接 `message.completed`（固定文字），然後 `run.completed`（`skipped`） |
| `run.started` | `{run_id, model}` 只有真的要呼叫模型時才有 |
| `tool.started` | `{call_id, step, name, source, arguments}` |
| `tool.completed` | `{call_id, step, name, status, result, duration_ms}` |
| `intake.updated` | `IntakeView` 任何欄位或階段改變時送 |
| `ticket.created` | `Ticket` |
| `summary.updated` | `PrevisitSummary`（`save_previsit_summary` 成功後） |
| `guard.rewrote` | `{kind:'diagnosis'\|'dosage'\|'prescribing'\|'other', action:'rewritten'\|'replaced'}` 輸出檢查改寫了回覆 |
| `message.delta` | `{text}` 回覆文字片段（首版可整段一次送） |
| `message.completed` | `{message_id, kind, content, run_id}` 助理訊息已存檔（`kind` 可能是 `chat`／`red_flag`／`refusal`／`notice`） |
| `visit.updated` | `Visit`（狀態或階段改變） |
| `run.completed` | `{run_id, status:'completed'\|'skipped', steps, usage, model}` |
| `run.failed` | `{run_id, code:'max_steps'\|'timeout'\|'model_error'\|'not_configured'\|'daily_budget_exceeded', message}` 失敗時仍會存一則 `notice` 助理訊息說明（固定文字） |

## 5. 錯誤代碼

`invalid_request`(400/422)、`unauthorized`(401)、`invalid_credentials`(401)、`forbidden`(403)、`not_found`(404)、`visit_closed`(409)、`rate_limited`(429；含 `Retry-After`)、`payload_too_large`(413)、`internal`(500)。

## 6. 其他

- 靜態網站由同一個程序從 `WEB_DIR` 提供；未知路徑回 `index.html`（SPA）。`/api/*` 未知路徑回 404 JSON。
- 回應加 `x-content-type-options: nosniff`、`referrer-policy: same-origin`、`x-frame-options: DENY`；SSE 回應加 `cache-control: no-store`、`x-accel-buffering: no`。
- 日誌不得包含訊息內容、IP 原文、cookie、金鑰。IP 只以加鹽雜湊存於速率限制記憶體，不入資料庫。

## 7. 補充定案（2026-11-25 規格檢驗後；與前文衝突時**以本節為準**）

### 7.1 visit 狀態轉移

| 事件 | 從 | 到 | 備註 |
|---|---|---|---|
| 建立 | — | `active`，stage `chief_complaint` | |
| 紅旗命中 | `active`／`submitted`／`reviewed`／`red_flag` | `red_flag` | **任何狀態都先跑紅旗**。同一 visit 已有未結案的紅旗轉交單就不重複開單（但仍存 `red_flag_events` 並回固定文字）|
| `POST /submit` | `active`、`red_flag` | `active`→`submitted`；`red_flag` **維持** `red_flag`（仍寫入 `submitted_at` 與摘要）| `submitted`／`reviewed` 再 submit → 200 冪等回傳現有摘要 |
| 醫師 `review` | `submitted`、`red_flag` | `reviewed` | 其他狀態 → 409 `invalid_state` |
| 病人訊息（未命中紅旗）| `submitted`／`reviewed` | 不變，回 409 `visit_closed` | 命中紅旗則走紅旗流程並回到 `red_flag` |
| 病人訊息（未命中）| `red_flag` | 不變 | 回固定提醒（kind `notice`），不呼叫模型 |

前端：緊急卡片由 `VisitDetail.red_flag != null` 決定（取**最近一次**命中），不是由 status 推斷；已結束（closed）畫面也要保留 119／1925 卡片。`POST /visits/{id}/handoff` 的備註文字同樣先跑 PII 遮蔽與紅旗檢查。

### 7.2 紅旗事件的標準順序

`message.accepted` → `precheck.completed` → `redflag.triggered` → （`ticket.created`，若有新單）→ `message.completed`（kind `red_flag`）→ `visit.updated` → `run.completed`（status `skipped`）。其他順序：越界拒絕為 `message.accepted` → `precheck.completed` → （`ticket.created`）→ `message.completed`（kind `refusal`）→ `run.completed`(skipped)。一般回合：`message.accepted` → `precheck.completed` → `run.started` → `tool.*`／`intake.updated`／`ticket.created`／`summary.updated`（任意穿插）→ `guard.rewrote`（若有）→ `message.delta` → `message.completed` → `visit.updated`（階段或狀態改變時）→ `run.completed`。

### 7.3 病人端投影

病人持 UUID 呼叫 `GET /visits/{id}` 時，回傳形狀與 `VisitDetail` 相同，但**醫師私有欄位為 null**：`visit.review_note`、`visit.reviewed_by`、`tickets[].resolved_by`、`tickets[].resolution_note`。（追蹤面板的 `tool_calls`、`runs`、`refill_checks` 屬於病人可見功能，照給。）`GET /clinician/visits/{id}` 給完整內容。前端以 localStorage 保存 visit id；不用網址帶 id。

### 7.4 型別與命名補充

- `Stage` 不含 `opening`（開場訊息只是第一則 assistant 訊息，kind `opening`）。
- `IntakeState` 的「不適用」以**固定字串 `不適用`**儲存（後端會把 `N/A`／`n/a`／`not applicable`／`不適用` 正規化成它；`severity` 用 `'n/a'`）。en 介面由前端顯示成 "N/A"。
- 欄位鍵（`IntakeView.missing`、`PrevisitSummary.not_collected`）固定為：`chief_complaint, hpi.onset, hpi.course, hpi.location, hpi.character, hpi.severity, hpi.modifiers, hpi.associated, past_history, medications, allergies`（依此順序）。`stage` 只看核心欄位（`chief_complaint`、`hpi.onset`、`hpi.course`、`hpi.severity`、`hpi.associated`、三個 ListField）；`missing` 與 `progress`（total 11）列**全部**欄位，所以到 `confirm` 階段時 progress 可能是 8/11 並且 `missing` 仍列出 `hpi.location` 等非核心欄位，這是預期行為，前端顯示成「建議補充」。
- 新增錯誤碼：`conflict`(409，同一 visit 已有訊息在處理中)、`invalid_state`(409)、`unsupported_media_type`(415)。`error.fields` 的形狀為 `{ "<欄位名>": "<訊息>" }`。
- `POST /visits/{id}/refill-check` 的 `fills_done` 為 1–3（3＝已領完三次 → `revisit`）。
- `check_chronic_refill` 給模型的工具參數**沒有 `today`**；`today` 只在表單與評測路徑接受，一律以 Asia/Taipei 解讀。`GET /meta` 另回 `server_today`（`YYYY-MM-DD`，Asia/Taipei），供前端表單預設日期。
- `GET /clinician/visits?status=` 可為 `pending`（＝`submitted` 或 `red_flag`，預設）、`submitted`、`red_flag`、`reviewed`、`all`；`limit` 預設 50、最大 200。
- 速率限制涵蓋**所有** POST（visits、messages、refill-check、submit、handoff、login）與 `GET /visits/{id}`（防列舉）；超過回 429 `rate_limited`。

### 7.5 追蹤列的 `arguments`／`result` 形狀（前端以此渲染；未知的 `name` 也要能用通用方式顯示）

| name | arguments | result |
|---|---|---|
| `red_flag_precheck` | `{chars:number}` | `{hit:false}` 或 `{hit:true, category, label, rule_id}` |
| `scope_precheck` | `{chars:number}` | `{verdict:'ok'\|'prescription_request'\|'controlled_drug'\|'injection'}` |
| `pii_filter` | `{chars:number}` | `{masked:number, kinds:string[]}`（只在有遮蔽時才寫入）|
| `record_intake` | 模型送的 patch（部分 `IntakeState`）| `{applied:string[], rejected:{field:string, reason:string}[]}` |
| `search_health_education` | `{query, top_k}` | `{hits:[{section, title, source_type, source_name, source_url, verified_on, score}]}`（空陣列＝手冊沒有）|
| `check_chronic_refill` | `RefillInput`（模型路徑沒有 `today`）| `RefillResult` |
| `transfer_to_clinician` | `{reason, urgency, summary}` | `{ticket_no, deduped:boolean}` |
| `save_previsit_summary` | 模型送的摘要草稿 | `{saved:true, not_collected:string[]}` |
| `output_guard` | `{chars:number}` | `{passed:boolean, violations:('diagnosis'\|'dosage'\|'prescribing')[], action:'none'\|'rewritten'\|'replaced'}` |

### 7.6 串流規則

- `message.delta` 一律在 `output_guard` **之後**才送；用戶端收到 `message.completed` 時，以其 `content` **取代**氣泡內容（它才是權威文字）。
- 串流每 15 秒送一個 SSE 註解行 `: keep-alive`；整個 run 有總逾時（`LLM_TIMEOUT_SECS × 2`，上限 90 秒），到時 `run.failed(timeout)`。
- 同一 visit 同時只處理一則訊息（以資料庫 advisory lock 或程序內鎖），第二則 → 409 `conflict`。
- 前端用 `fetch` 讀串流（POST 不能用 `EventSource`）。
