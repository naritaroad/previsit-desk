# HTTP API 合約 v2（前後端唯一依據；要改先改這份並通知另一端）

前綴 `/api/v2`（`GET /api/v1/health` 保留給既有健康檢查，與 `/api/v2/health` 同內容）。JSON、UTF-8、時間 ISO 8601 UTC、日期 `YYYY-MM-DD`（Asia/Taipei）。錯誤 `{"error":{"code","message","fields"?:{欄位:訊息},"current"?:任意}}`，語言依帳號 locale（未登入用 Accept-Language）。錯誤碼：`invalid_request`400/422、`unauthorized`401、`invalid_credentials`401、`forbidden`403、`not_found`404、`conflict`409（`revision` 不符時 `current` 帶伺服器版本）、`visit_closed`409、`invalid_state`409、`rate_limited`429(Retry-After)、`payload_too_large`413、`unsupported_media_type`415、`internal`500。

登入狀態：HttpOnly cookie `pv_session`（SameSite=Lax）。**除公開端點外都要登入。** 改變狀態的請求只收 JSON，且 `Origin` 存在時必須同站。樂觀鎖：回應物件有 `revision:number`，寫入時在 body 帶 `revision`，不符→409 conflict。建立類請求可帶標頭 `Idempotency-Key`（同帳號 24 小時內重送回同一結果）。清單一律 `{items:T[], next_cursor:string|null, total?:number}`，參數 `cursor`、`limit`(預設 30、上限 100)、`q`。

## 1. 共用型別

```ts
type Role='patient'|'physician'|'pharmacist'|'coordinator'|'admin'
type Locale='zh-TW'|'en'
type Permission='visit.own'|'rx.own'|'profile.own'|'appt.own'|'visit.read'|'visit.review'|'note.sign'|'thread.reply'|'ticket.handle'
 |'patient.read'|'patient.manage'|'appt.manage'|'rx.read'|'rx.decide'|'rx.dispense'|'account.manage'|'settings.manage'|'audit.read'|'oversight.read'|'rules.read'|'demo.reset'
// patient: *.own；physician: visit.read,visit.review,note.sign,thread.reply,ticket.handle,patient.read,patient.manage,appt.manage,rx.read,rx.decide,oversight.read,rules.read
// coordinator: physician 的權限去掉 note.sign、rx.decide；pharmacist: rx.read,rx.dispense,patient.read(限用藥與過敏視圖),thread.reply(限 rx),rules.read；admin: account.manage,settings.manage,audit.read,oversight.read,rules.read,demo.reset（不含讀病人內容）
interface Me{ id:string; username:string|null; display_name:string; role:Role; title:string|null; avatar:string|null /*photos.json 的 slot 或 null*/; is_guest:boolean; is_demo:boolean; locale:Locale; preferences:Record<string,unknown>; permissions:Permission[]; unread_notifications:number; must_change_password:boolean; expires_at:string|null /*訪客沙盒到期*/ }
interface PersonRef{ id:string; display_name:string; role:Role; title:string|null; avatar:string|null }
type Urgency='routine'|'soon'|'urgent'
```
沿用 v1 型別（`docs/api/contract.md` §1、§7 的 Stage、IntakeState、IntakeView、RedFlagHit、ToolCall、Run、RefillInput、RefillResult、PrevisitSummary、Ticket），下列有擴充：
```ts
type VisitStatus='active'|'red_flag'|'submitted'|'reviewed'
interface Visit{ id; title:string; locale; status:VisitStatus; stage; urgency; mode:'ai'|'human'; pinned:boolean; archived:boolean; patient:PersonRef; appointment:Appointment|null; assigned_to:PersonRef|null; chief_complaint:string|null; last_seq:number; created_at; updated_at; last_activity_at; submitted_at; reviewed_at; reviewed_by:PersonRef|null; has_unread:boolean }
interface Message{ id; client_id:string|null; seq:number; role:'patient'|'assistant'|'staff'; kind:'opening'|'chat'|'red_flag'|'refusal'|'notice'|'handoff'; author:PersonRef|null; content; created_at; run_id; status:'ok'|'interrupted' }
interface PrevisitSummary /* v1 + */ { revision:number; edited_by_patient:boolean; follow_up:string[] /*給醫師的可追問項目：未取得欄位與模型列出的澄清問題，不含診斷*/; evidence: Record<string,string[]> /* 欄位鍵 → message id */ }
interface VisitDetail{ visit; messages; intake; summary; red_flag; tickets; tool_calls; runs; refill_checks; note:ClinicalNote|null /*病人端只在簽署後給 patient_message*/ }
interface Run /* v1 + */ { status:'running'|'completed'|'failed'|'skipped'|'interrupted' }
```

## 2. 認證與帳號

| 端點 | 說明 |
|---|---|
| `POST /auth/guest` `{locale, persona?:string}` | 建立訪客沙盒並登入 → `201 {me}`；persona 預設 `lin`；每 IP 10 分鐘 10 次 |
| `GET /auth/personas` | 公開：`{items:[{id,display_name,age_band,summary_zh,summary_en}]}` |
| `POST /auth/login` `{username,password}` / `POST /auth/logout` / `GET /auth/me` | `{me}`；登入限速 |
| `POST /auth/claim` `{username,password,display_name}` | 訪客→正式帳號，資料保留 |
| `POST /auth/register` `{username,password,display_name,locale}` | 病人自助註冊（暱稱，不收真名與 email）|
| `POST /auth/password` `{current,next}` | |
| `GET /me/sessions`、`DELETE /me/sessions/{id}` | `{id, device, created_at, last_seen_at, current}` |
| `PATCH /me` `{display_name?,locale?,avatar?}`、`PUT /me/preferences` `{patch}` | |
| `GET /me/notifications`、`POST /me/notifications/read` `{ids?:string[]}` | `Notification{id,kind,title,body,link,read_at,created_at}`（title/body 已在地化）|
| `GET /me/drafts/{scope}`、`PUT /me/drafts/{scope}` `{payload,revision}`、`DELETE` | scope 如 `visit:<id>:composer`、`note:<visit>`、`rx:<id>`；payload ≤ 16 KB；沒有→404 |
| `GET /me/export`、`DELETE /me` `{confirm:"DELETE"}` | 病人資料匯出／刪除 |
| `GET /me/stream` (SSE) | 帳號層事件：`notification`、`visit.changed{id}`、`rx.changed{id}`、`queue.changed{name}`；`: keep-alive` 15 秒 |

## 3. 病人

| 端點 | 說明 |
|---|---|
| `GET /app/home` | `{next_appointment, active_visits:Visit[], medications:MedicationCard[], active_requests:RxRequestBrief[], unread:number, tasks:[{kind,title,link,due_at}]}` |
| `GET/PUT /app/profile` | `HealthProfile`（PUT 帶 revision）|
| `GET/POST /app/measurements`、`DELETE /app/measurements/{id}` | `{id,kind:'bp'|'glucose'|'weight'|'pulse'|'lab',values:{systolic?,diastolic?,value?,name?,unit?},taken_at,source:'patient'|'clinic'}` |
| `GET /app/access-log` | `{items:[{at, actor:PersonRef, action, resource}]}` |
| `GET/POST /app/consents` | `{doc:'terms'|'ai_disclosure'|'rx_review', version, granted}` |
| `GET /visits?status=&archived=` `POST /visits` `{locale?, appointment_id?}` | POST → `201 VisitDetail` |
| `GET /visits/{id}` `PATCH /visits/{id}` `{title?,pinned?,archived?}` `DELETE /visits/{id}` | 病人只見自己的；醫事人員需 `visit.read`（寫 access_log）|
| `POST /visits/{id}/messages` `{content, client_id}` | **立即回 `202 {message, run_id|null}`**；結果走串流。同 client_id 重送回 200 同物件。mode=human 時不啟動 AI |
| `GET /visits/{id}/stream?after=<seq>` (SSE) | 先重播 seq>after 的事件再接即時；事件同 v1 §4＋`message.created{Message}`、`mode.changed`、`note.signed`、`run.interrupted`；`id:` 欄＝seq（支援 Last-Event-ID）；`message.delta` 不持久化、無 seq |
| `POST /visits/{id}/runs/retry` | 重試最後一則被中斷或失敗的回合 |
| `PATCH /visits/{id}/summary` `{revision, changes}` | 病人修改摘要欄位（送出前）|
| `POST /visits/{id}/submit`、`POST /visits/{id}/handoff`、`POST /visits/{id}/refill-check` | 同 v1 語意 |
| `GET /appointments`、`GET /appointments/slots?from=&to=&department=&physician_id=`、`POST /appointments` `{slot_id,reason}`、`POST /appointments/{id}/cancel` | |
| `GET /pharmacies` | `{id,name,district,address,hours,services[]}` 虛構 |
| `GET /handbook`、`GET /handbook/search?q=` | 公開 |

```ts
interface HealthProfile{ revision; display_name; birth_year:number|null; sex:'female'|'male'|'other'|null; height_cm:number|null; conditions:ProfileItem[]; medications:ProfileItem[]; allergies:ProfileItem[]; family_history:ProfileItem[]; lifestyle:{smoking,alcohol,exercise}; preferred_pharmacy_id; contact_preference:'in_app'; updated_at }
interface ProfileItem{ id; name; detail:string|null; since:string|null; source:'patient'|'clinic'; status:'active'|'inactive' }
interface Appointment{ id; physician:PersonRef; department:string; starts_at; minutes:number; mode:'in_person'|'video'; status:'booked'|'checked_in'|'completed'|'cancelled'; reason:string|null; visit_id:string|null; room:string|null }
interface MedicationCard{ prescription_id; drug:DrugRef; dose_text:string; source:'clinic'|'self_reported'; issued_on; total_days; days_per_fill; fills:Fill[]; fills_allowed:number; supply_ends_on; next_window:{from,to}|null; valid_until; state:'on_hand'|'window_open'|'window_soon'|'late'|'finished'|'expired'; renewal_scope:'in_scope'|'physician_only'|'excluded'; days_left:number; open_request_id:string|null; refill_preview:RefillResult|null }
interface DrugRef{ drug_id; name_zh; name_en; class_id; class_zh; class_en; controlled_level:number }
interface Fill{ n; filled_on; pharmacy_name }
```

## 4. 用藥與申請（rx）

```ts
type RxKind='refill'|'renewal'
type RxStatus='draft'|'submitted'|'in_review'|'more_info'|'approved'|'partially_approved'|'declined'|'visit_required'|'at_pharmacy'|'returned'|'ready'|'dispensed'|'cancelled'
type Disposition='ready'|'review'|'in_person'|'urgent'|'excluded'
interface RxRequest{ id; no:string /*RX-20261125-0001*/; kind; status; revision; patient:PersonRef; items:RxItem[]; step:string; answers:Record<string,unknown>; monitoring:Record<string,{value?:number,date?:string,source:'patient'|'clinic'}>; questions:ProtocolQuestion[] /*目前項目需要的題目（已合併一般題與藥類題）*/; engine:EngineResult|null; pharmacy:Pharmacy|null; pickup_window:{date,slot:'morning'|'afternoon'|'evening'}|null; assigned_to:PersonRef|null; priority:Urgency; sla_due_at; overdue:boolean; decision_note:string|null; created_at; submitted_at; updated_at; timeline:RxEvent[]; messages:RxMessage[]; allowed_actions:string[] /*目前登入者現在能做的動作，前端據此顯示按鈕*/ }
interface RxItem{ id; prescription_id; drug:DrugRef; dose_text; scope; scope_reason:string; engine:{disposition,fired:FiredRule[]}|null; refill:RefillResult|null; decision:{outcome:'approve'|'decline'|'visit_required'|'more_info', note, by:PersonRef, at}|null }
interface FiredRule{ question_id; label; answer:unknown; disposition; reason; source_url:string|null }
interface EngineResult{ protocol_version; disposition:Disposition; evaluated_at; summary:string; stale_monitoring:string[] }
interface ProtocolQuestion{ id; scope:'general'|'class'|'monitoring'; class_id:string|null; kind:'boolean'|'choice'|'number'|'text'|'date'; label; help; options:{value,label}[]; unit; min; max; required; max_age_days:number|null } // 已依 locale 在地化
interface RxEvent{ at; type:string; actor:PersonRef|null; text:string /*已在地化*/; visibility:'all'|'staff' }
interface RxMessage{ id; author:PersonRef; body; created_at; visibility:'all'|'staff' }
interface RxRequestBrief{ id; no; kind; status; priority; patient:PersonRef; drug_names:string[]; disposition:Disposition|null; assigned_to:PersonRef|null; submitted_at; sla_due_at; overdue; updated_at; unread:boolean }
interface Pharmacy{ id; name; district; address; hours:string; services:string[] } // 虛構
```

| 端點 | 權限 | 說明 |
|---|---|---|
| `GET /app/medications` | rx.own | `{items:MedicationCard[]}` |
| `POST /app/medications` | rx.own | 自述用藥 `{name,dose_text}`（標 self_reported，不能走 refill） |
| `POST /rx` `{kind, prescription_ids[]}` | rx.own | 建草稿；excluded 的項目可加入但標示不可送出 |
| `GET /rx?status=&kind=`、`GET /rx/{id}` | rx.own 或 rx.read | 病人見自己的；醫事人員見全部（草稿除外；讀取寫 access_log） |
| `PATCH /rx/{id}` `{revision, step?, answers?, monitoring?, pharmacy_id?, pickup_window?}` | rx.own | 自動存檔（僅 draft／more_info）；回更新後物件 |
| `POST /rx/{id}/evaluate` | rx.own | 只預覽引擎，不送出 |
| `POST /rx/{id}/submit` `{revision, consent_version}` | rx.own | 跑引擎；urgent→紅旗文字＋緊急轉交單，status `in_review`、priority `urgent`；全部 excluded→422。refill 檢核不是 eligible→422 帶 RefillResult |
| `POST /rx/{id}/cancel` `{revision}`、`POST /rx/{id}/reply` `{revision, body, answers?}` | rx.own | more_info 的回覆 → in_review |
| `POST /rx/{id}/messages` `{body, visibility}` | 參與者 | 病人只能 all |
| `GET /queue/rx?bucket=mine\|unassigned\|urgent\|overdue\|more_info\|pharmacy\|done` | rx.read | `{items, counts:Record<bucket,number>}` |
| `POST /rx/{id}/assign` `{account_id:string\|null}` | rx.read | |
| `POST /rx/{id}/decide` `{revision, items:[{item_id,outcome,note}], note, patient_message}` | rx.decide | 每項都要有決定；核准項轉 `at_pharmacy` |
| `POST /rx/{id}/pharmacy` `{revision, action:'accept'\|'ready'\|'dispense'\|'return'\|'ask_physician', checks?:{identity,allergy,interaction,quantity}, note}` | rx.dispense | dispense 需四項核對皆 true；refill 的 dispense 會新增 fill；renewal 的 dispense 會建立下一張示範處方紀錄（標「示範」） |
| `GET /rx/protocols`、`GET /rx/formulary?q=&scope=` | 公開 | |

## 5. 醫師站與病人管理

| 端點 | 說明 |
|---|---|
| `GET /clinic/overview` | `{counts:{urgent,pending,rx_review,overdue,waiting_patient,tickets}, today:AppointmentRow[], activity:[{at,text,link}]}` |
| `GET /clinic/worklist?bucket=urgent\|pending\|mine\|waiting\|done&sort=` | `{items:WorkItem[], counts}`；`WorkItem{type:'visit'\|'rx'\|'ticket', id, patient:PersonRef, title, subtitle, urgency, status, assigned_to, due_at, updated_at, link}` |
| `POST /visits/{id}/assign` `{account_id\|null}`、`POST /visits/{id}/takeover`、`POST /visits/{id}/release`、`POST /visits/{id}/staff-messages` `{content,client_id}` | 接手／交回／回覆（thread.reply） |
| `GET/PUT /visits/{id}/note` | `ClinicalNote{revision,version,status:'draft'\|'signed',sections:{subjective,objective,assessment,plan,patient_message},ai_drafted:['subjective','objective'],author:PersonRef\|null,signed_by,signed_at,addenda:[{body,by,at}],history:[{version,by,at}]}`；PUT 需 visit.review；沒有筆記時 GET 回由摘要產生的草稿（revision 0） |
| `POST /visits/{id}/note/sign` `{revision}`、`POST /visits/{id}/note/addendum` `{body}` | note.sign；簽署→visit reviewed、通知病人 |
| `GET /clinic/tickets?status=`、`POST /clinic/tickets/{id}/resolve` `{note}` | |
| `GET /clinic/patients?q=&tag=&status=&assigned=` | `PatientRow{patient:PersonRef,age,sex,conditions:string[],tags:string[],care_status:'new'\|'active'\|'watch'\|'inactive',physician:PersonRef\|null,coordinator:PersonRef\|null,last_contact_at,open_items:number,next_appointment_at,flags:string[]}` |
| `GET /clinic/patients/{id}` | `{row, profile:HealthProfile, medications:MedicationCard[], measurements, visits:Visit[], rx:RxRequestBrief[], appointments, tickets, notes:StaffNote[], timeline:[{at,kind,title,link,actor}]}`（藥師只得用藥、過敏、rx，其餘為空）|
| `PATCH /clinic/patients/{id}` `{tags?,care_status?,physician_id?,coordinator_id?}`、`POST .../notes` `{body,pinned}`、`PATCH/DELETE /clinic/notes/{id}`、`POST .../contact` `{channel:'in_app'\|'phone_note',body}` | patient.manage。`StaffNote{id,author:PersonRef,body,pinned,created_at}` |
| `GET /clinic/schedule?date=` | 門診表：`{date, physicians:[{physician, slots:[{slot_id,starts_at,minutes,appointment:Appointment\|null,patient:PersonRef\|null,previsit:'none'\|'active'\|'submitted'\|'reviewed'\|'red_flag'}]}]}` |
| `GET /staff` | `{items:PersonRef[]}` 可指派人員 |

## 6. 管理站

| 端點 | 說明 |
|---|---|
| `GET /admin/overview?days=14` | `{totals, series:[{day,visits,model_calls,input_tokens,output_tokens,cost_usd,red_flags,rx}], queues, system:{version,model_ready,uptime_s,db_ok,ai_enabled}}` |
| `GET /admin/accounts?role=&status=&q=`、`POST /admin/accounts` `{username,display_name,role,title?}`（回一次性密碼）、`GET/PATCH /admin/accounts/{id}` `{display_name?,role?,title?,status?}`、`POST .../reset-password`（回一次性密碼）、`POST .../revoke-sessions` | `AccountRow{id,username,display_name,role,title,status:'active'\|'disabled',is_guest,is_demo,created_at,last_login_at,sessions:number}`；不能停用或降權自己；最後一個 admin 不可移除 |
| `GET /admin/permissions` | `{roles:Role[], permissions:[{id,label,description}], matrix:Record<Role,Permission[]>}` |
| `GET/PUT /admin/settings` | `{revision, ai:{enabled,primary,fallback,thinking,temperature,max_steps,daily_call_limit,per_client_daily_limit,monthly_budget_usd,on_budget:'fallback'\|'stop',prices:Record<model,{in,out}>}, limits:{messages_per_10min,visits_per_10min,max_messages_per_visit}, rx:{sla_hours_routine,sla_hours_soon,oversight_phase:1 /*唯讀*/}, retention_days}`；即時生效，寫稽核 |
| `GET /admin/models` | `{items:string[]}`（env 白名單 `LLM_MODEL_CHOICES`） |
| `GET /admin/oversight?from=&to=` | `{phase, by_class:[{class_id,class,total,engine:Record<Disposition,number>,decisions:Record<outcome,number>,agreement_rate:number\|null,threshold_total:250}], turnaround:{median_h,p90_h}, returned_rate, red_flags:[{category,n}], guard:[{kind,n}]}`；agreement＝引擎 ready 且醫師 approve，或引擎 in_person/urgent 且醫師 visit_required/decline，佔有決定件數 |
| `GET /admin/runs?status=&model=`、`GET /admin/runs/{id}` | 內容只含工具名、狀態、用量，不含病人文字 |
| `GET /admin/audit?actor=&action=&from=&to=` | 合併 audit_log 與 access_log：`{at,actor:PersonRef,kind:'admin'\|'access'\|'rx'\|'auth',action,target,detail}` |
| `GET /admin/rules` | 紅旗、越界、慢箋、協定、藥品範圍（唯讀） |
| `GET /admin/eval` | `{latest:EvalSummary, history:[EvalSummary]}` |
| `POST /admin/demo/reset` `{confirm:"RESET"}` | 重建示範資料（不動非示範帳號） |

## 7. 公開

`GET /health`、`GET /meta`（v1 欄位＋`{oversight_phase, protocol_version, formulary_counts:Record<scope,number>, ai_enabled}`）、`GET /trust/facts`（信任中心引用的即時事實：紅旗規則數、越界規則數、慢箋規則、題庫數、評測摘要、協定版本、藥品範圍數、保留天數、監督階段、版本、模型）、`GET /auth/personas`、`GET /handbook`、`GET /handbook/search?q=`、`GET /rx/protocols`、`GET /rx/formulary`。

## 8. 通知種類

`visit.reviewed`、`visit.staff_message`、`rx.status`、`rx.more_info`、`rx.ready`、`rx.message`、`appt.reminder`、`refill.window_open`、`ticket.new`(staff)、`rx.new`(staff)、`rx.overdue`(staff)、`visit.submitted`(staff)、`red_flag`(staff)。

## 9. 前端連結（通知與 WorkItem 的 `link`）

`/app/visits/{id}`、`/app/medications`、`/app/rx/{id}`、`/app/appointments`、`/clinic/visits/{id}`、`/clinic/rx/{id}`、`/clinic/patients/{id}`、`/pharmacy/rx/{id}`、`/admin/accounts/{id}`。
