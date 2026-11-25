# PreVisit Desk v2 設計方向與元件手冊

2026-11-25。取代 v1 的 `visual-direction.md`。數值的唯一來源是 `web/src/styles/tokens.css`，這份文件說明為什麼這樣定、頁面怎麼組。實際畫面在 `npm run dev` 後開 `/dev/kit`（元件）與 `/dev/kit/scene/<名稱>`（整頁），原始碼在 `web/src/kit-gallery/`，可以直接照抄版面。截圖在 `docs/design/v2-shots/`。

## 1. 主張

看診前後的文件，台灣病人早就看得懂：藥袋、處方箋、號碼燈、科別指標。v2 把那些東西的**結構**拿來用，不畫它們的樣子。

- **兩種墨水。** 印好的表格用一種色墨（線、欄名、按鈕），填進去的內容用黑墨。介面也一樣：`ink` 只印結構與動作，資料一律用 `fg`。看一眼就知道哪些是表格、哪些是病人的資料。
- **同一張表的四聯。** 病人、醫師、藥局、管理站是同一張處方的四聯：版式、字、線相同，色墨與外框不同。
- **三格領藥（RefillStrip）是招牌。** 格子照時間比例畫，蓋章＝已領，直線＝今天，斜線＝可以領藥的那幾天，灰段＝最後一次藥吃完到慢箋失效。病人、醫師、藥師看到的是同一條。
- **紅色只給緊急。** 119、1925、紅旗、緊急件數。表單錯誤是黃色貼紙，刪除是黑框按鈕。
- **黑體做事，明體閱讀。** 明體只出現在公開站與信任中心的標題與導言。

### 色彩

底是帶一點綠的冷白紙，不是米色；病人與公開站用印藥袋的深綠（`#0a6141`），醫師站用原子筆藍（`#1b4a82`），藥局站用藥瓶棕（`#6b4313`），管理站用石墨（`#2f3b45`）。綠色避開了健康產品慣用的亮藍與湖水綠，也是台灣公共印刷品的常用色；四個色墨的明度相近，所以換站台時層級不變。狀態色與色墨分開：完成（綠）、資訊（藍）、注意（黃底黑字，像藥袋上的警示貼紙）、退回／請看診（紫）、一般（灰）、緊急（紅）。深色主題不是反相：紙變暗、墨變亮、主按鈕改深字。`node web/scripts/contrast.mjs` 檢查 810 組，文字最低 5.26:1。

### 字

Noto Sans TC 變數字型（自架）是主角，400／500／600／700／800 五級字重做層級，數字用等寬 `num`。公開站另載 Noto Serif TC（只在 `PublicShell` 的 chunk 裡）做標題與導言：明體的直橫粗細差在大字時有紙本感，內文仍用黑體，長者在小螢幕上才讀得清。中文行高比西文鬆：16px 用 1.75，標題 1.25–1.45，不加字距。標題 `word-break: keep-all`，只在標點與 `<wbr>` 斷行；大標題用 `<Phrases text={t(…)} />`，整個詞組一起換行，最後兩個字和句號綁在一起（`PageHeader` 的字串標題已內建）。

### 氣氛

| 站台 | 調性 | 密度 | 外框 |
|---|---|---|---|
| 公開 `PublicShell` | 編輯、留白、照片、以文帶路 | comfortable | 頂端信頭＋雙線，深綠頁尾含預定用途與文件版本 |
| 病人 `PatientShell` | 安靜、一次一件事、字大 | comfortable | 左側白欄（導覽＋預問診清單），手機底部五個分頁，緊急協助永遠在 |
| 醫師 `ClinicShell` | 密、快、鍵盤 | compact | 實心藍側欄，頁面滿版、分窗 |
| 藥局 `PharmacyShell` | 像叫號櫃台 | compact | 上方調劑看板（階段＋大數字），窄棕側欄 |
| 管理 `AdminShell` | 像索引 | compact | 淺色文字索引，頂端路徑與系統狀態列 |

## 2. Token

Tailwind 預設色盤與字級已移除，只剩這些名字（`bg-*`、`text-*`、`border-*` 通用）：

| 類 | 名稱 |
|---|---|
| 紙 | `bg`（頁底）`surface`（紙）`raised`（輸入框、彈出層）`sunken` `hover` `overlay` |
| 黑墨 | `fg` `fg-2`（次要）`fg-3`（說明、時間）`fg-disabled` |
| 線 | `rule`（分隔）`rule-strong`（控制項外框，3:1）`ink-line`（印刷線） |
| 色墨 | `ink` `ink-hover` `on-ink` `ink-soft`（淡底）`ink-text`（當文字用） |
| 側欄 | `rail` `rail-2` `rail-fg` `rail-fg-2` `rail-line` |
| 狀態 | `ok` `info` `warn` `hold` `mute` 各有 `-soft`、`-line` |
| 緊急 | `danger` `danger-soft` `danger-line` `danger-solid` `on-danger` |
| 字級 | `text-xs`13 `sm`14 `base`16 `md`18 `lg`20 `xl`24 `2xl`30 `3xl`38 `4xl`48 `5xl`60；`text-ctl` 跟著密度 |
| 圓角 | `rounded-cell`2 `control`4 `panel`6 `sheet`10 `full`（只有計數與開關） |
| 陰影 | `shadow-1` `2` `3`（只有彈出層用 3） |
| 動態 | `ease-out` `ease-in-out` `ease-drawer`；按壓 120ms、彈出 170ms、抽屜 280ms |
| 密度 | 間距 `h-ctl`、`min-h-ctl-sm`、`h-row`、`px-cell-x`、`py-cell-y`、`p-pane`、`mb-stack` 會跟著 `data-density` 變 |

- **密度**：外框設 `data-density`。`comfortable` 控制項 48px、列 56px；`compact` 36px、42px。觸控裝置上 compact 自動升到 44px 以上。同一頁要局部改密度，在容器加 `data-density="compact"` 即可。
- **跟著密度的字級**：`text-body`（內文）、`text-note`（說明、次要行）、`text-title`（區塊標題）。醫師、藥局、管理站的頁面用這三個，不要寫死 `text-sm`。醫事人員可在帳號選單切「列表密度」。
- **字級設定**：帳號選單的「標準／大／特大」寫到 `<html data-text="112|125">`，根字級 100／112.5／125%。所有尺寸用 rem，頁面請不要寫 px 字級。醫師、藥局、管理站同樣適用；版面寬度的斷點用 container query 或 rem，特大字時會自然換成窄版。
- **主題**：`<html data-theme="light|dark">` 永遠有值，由 `index.html` 的內嵌腳本在第一次繪製前決定。
- 不要在元件寫死色碼、`font-family`、`transition: all`。

## 3. 給頁面工程師

### 3.1 檔案

```
web/src/pages/<站台>/routes.ts     你的路由表（handle.title 是 shell.json 的鍵，會變成文件標題）
web/src/pages/<站台>/Shell.tsx     接資料的外框：把計數、快速搜尋結果傳給 <站台>Shell
web/src/pages/<站台>/*.tsx         頁面，預設匯出
web/src/i18n/locales/{zh-TW,en}/<站台>.json
```

新增頁面：在 `routes.ts` 加一行 `{ path, handle: { title: "page.<站台>.<鍵>" }, lazy: page(() => import("./X")) }`，標題加到 `shell.json` 的 `page`（兩種語言）。`shell.json`、`common.json` 可以加鍵，不要改既有鍵的意思。

```tsx
import { useTranslation } from "react-i18next";
import { Button, PageBody, PageHeader, Panel, DataTable, StatusTag } from "@/ui";
import { MeasurementChart } from "@/ui/measurement-chart"; // recharts 只在這裡載入

export default function Medications() {
  const { t } = useTranslation("patient");
  return (
    <PageBody>
      <PageHeader title={t("meds.title")} actions={<Button variant="primary">{t("meds.add")}</Button>} />
      …
    </PageBody>
  );
}
```

### 3.2 頁面骨架

- 一般頁：`PageBody`（`width="read"` 給表單與單一任務）＋`PageHeader`（h1 會在換頁後取得焦點，不要自己搶焦點；真的要聚焦欄位就用 `autoFocus`）。
- 滿版工作頁（醫師、藥局）：`FillPage head={…}`（在 `@/shells/StaffShell`），裡面放 `FilterBar`＋`DataTable`，或 `SplitPane`。
- 病人對話、精靈：呼叫 `useFullHeight()`（`@/shells/PatientShell`），用 `Transcript`＋`Composer`，或 `StepForm`。
- 病人左欄的預問診清單：在頁面渲染 `<PatientRail>…<ConversationLink/></PatientRail>`，會傳送到側欄。
- 公開頁：內容放 `<div className="site-wrap site-page">`；滿版照片直接放在外面。

### 3.3 公開站

每一屏一個想法。用散文與規線分段，不用卡片牆、不用「圖示＋標題＋一句話」三欄、不用大數字統計。標題左欄（4/12）、內容右欄（8/12）是預設格線（`.three-acts`、`.not-list`、`.strip-feature`）。照片只放地方、物品、手；首屏用 `.hero-photos`（`medicine_table` 大、`consultation` 小）。`pharmacy` 版位拍的是廟裡的籤詩櫃，不要當成藥櫃使用。用 `Photo slot="…" caption={…}`，圖說一行小字，讓照片像紀錄。信任中心：`DocLayout`＋`TableOfContents`＋`Prose`，開頭 `DocumentMeta`，每段 `ProseSection id no title`，邊註 `MarginNote`，證據 `EvidenceTable`，其他表 `RuledTable`，`Footnotes`、`Changelog`。章節號要固定，別人會引用。

### 3.4 病人站

一個畫面一個主要動作（一顆 `primary`）。句子短、用「您」。時間寫完整：「11 月 28 日（六）」，不要只寫「3 天後」。不能做的事要說原因與找誰，不要只給灰按鈕。選項用 `RadioRows`（是／否用 `columns={2}`），數字用 `NumberField`（支援全形數字），日期用 `DateField`。每張慢箋都用 `RefillStrip med={card}`，可以直接傳 `MedicationCard`。

### 3.5 醫師站、藥局站、管理站

表格優先。`DataTable` 的鍵盤：↑↓ 或 J／K 移動、Enter 打開、X 或空白鍵勾選、Home／End。緊急列用 `isUrgent`。欄位用 `width` 固定、最多留一欄不設寬度；次要欄 `hideBelow="lg"`（看表格寬度，不是視窗）；手機卡片用 `card: "title" | "end" | "hide"`。審閱台用 `SplitPane`（≤64rem 自動變分頁）。AI 整理的 S／O 用 `EvidenceList`＋`EvidenceLine`（可點回原話；醫師改過的行會標出誰改、原文）。A／P 用 `NoteSheet`＋`NoteField`：一張連續的紙，是醫師的工作區，**不得**預填 AI 文字。藥師的調劑單用 `FormSheet`，四項核對用 `Checkbox`，全勾才能按「完成調劑」。

### 3.6 資料狀態

| 情況 | 用 |
|---|---|
| 第一次載入 | `DataTable loading`（骨架列）或 `SkeletonRows`；不要整頁轉圈 |
| 失敗 | `ErrorState onRetry`；`DataTable error onRetry` |
| 沒資料 | `EmptyState`：說這裡會有什麼＋一個動作 |
| 自動存檔 | `SaveState state="saved|saving|offline|conflict|error"`，放在頁首或精靈底列 |
| 409 衝突 | `DiffMergeDialog`，只列不同的欄位 |
| 離線 | 外框已有離線列；輸入框用 `Composer offline queued` |
| 成功 | `toast.ok`；可復原的動作給 `action: { label: 復原 }`，不要先跳確認框 |
| 不能復原 | `ConfirmDialog`：標題寫出對象，按鈕寫動作 |

### 3.7 文案

動詞開頭、說結果：「送出申請」「完成調劑」，不用「確定」「提交」。錯誤寫發生什麼、怎麼改。不道歉、不驚嘆、不用表情符號。狀態名稱只從 `StatusTag` 來。面向病人用「您」，對醫事人員用名詞句。

### 3.8 檢查

`npx tsc --noEmit`、`npm run i18n:check`（tsx 裡不能有中文）、`npm run build`；畫面用 `node scripts/shots.mjs --only /clinic/worklist`（會報水平溢出、按鈕裁字、主控台錯誤）。改 token 後跑 `node scripts/contrast.mjs`。

## 4. 元件清單

所有元件從 `@/ui` 匯入。屬性說明在原始碼註解。

| 元件 | 什麼時候用 | 注意 |
|---|---|---|
| `Button` `ButtonLink` `ButtonSlot` | 動作／看起來像按鈕的連結／包自訂元素 | 一頁一顆 `primary`；`destructive` 是黑框；`emergency` 只給 119／1925；`loading` 保留文字 |
| `IconButton` | 只有圖示 | `label` 必填，會變成提示 |
| `TextLink` `ExternalLink` `Kbd` | 站內／站外連結、按鍵 | 連結文字說去哪，不加箭頭 |
| `Field` `FieldGroup` | 標籤、說明、錯誤的接線 | 控制項放裡面就會自動接 id 與 aria |
| `Input` `Textarea` `PasswordInput` `SearchInput` `NumberField` `DateField` `NativeSelect` `Select` `Combobox` | 輸入 | 8 項以下用 `Select` 或 `RadioRows`，多的用 `Combobox`；手機長清單用 `NativeSelect` |
| `RadioRows` `Checkbox` `Switch` `Segmented` | 選擇 | `Switch` 立即生效才用；篩選分類用 `Segmented`，可帶 `count` |
| `Stepper` `StepForm` | 精靈 | 完成的步驟可回頭；底列：上一步、存檔狀態、下一步 |
| `Dialog` `ConfirmDialog` `Sheet` `Popover` `Menu` `Tooltip` | 彈出層 | 手機右側 `Sheet` 變底部抽屜；能就地展開就不要開對話框 |
| `Banner` `Callout` `toast` `EmptyState` `ErrorState` `Skeleton*` `Spinner` `Progress` `SaveState` | 回饋 | `tone="danger"` 只給緊急 |
| `Badge` `StatusTag` `CountBadge` | 標籤、狀態、數量 | `StatusTag family="rx|disposition|outcome|visit|previsit|urgency|appointment|med|scope|ticket|note|care|run|account|source"` |
| `Avatar` `Person` `PresenceLine` | 人 | 只有姓名首字，沒有照片 |
| `DataTable` `Pagination` `LoadMore` `FilterBar` `Toolbar` | 清單 | 游標分頁，沒有頁碼 |
| `DescriptionList` `Ledger` `FormSheet` | 明細／數字帳／處方式表格 | `FormSheet` 一頁一張 |
| `Timeline` | 事件 | 未發生的用 `pending` |
| `RefillStrip` | 慢箋 | `size="compact"` 放表格；不自己算資格 |
| `MeasurementChart` | 量測 | 目標範圍只畫醫師設定的；自述空心、診所實心 |
| `PatientBubble` `AssistantBubble` `AssistantThinking` `StaffBubble` `OpeningNote` `NoticeLine` `RefusalNote` `RedFlagNote` `DayDivider` `Transcript` `QuickReplies` `Composer` | 對話 | 真人訊息一定有姓名職稱；Enter 送出、注音選字的 Enter 不送、手機 Enter 換行 |
| `EmergencyPanel` `EmergencyButton` | 緊急 | 全站唯一紅面；`kind="crisis"` 讓 1925 在前 |
| `EvidenceList` `EvidenceLine` `NoteSheet` `NoteField` | 審閱台 | 見 3.5 |
| `DiffMergeDialog` | 草稿衝突 | 選完才存 |
| `NotificationBell` `NotificationList` `CommandPalette` | 通知、Ctrl+K | 外框已接；頁面工程師只要在 `Shell.tsx` 給 `commandGroups`、`onCommandQuery` |
| `SplitPane` `Panel` `Section` `PageHeader` `PageBody` `NavTabs` `Tabs` | 版面 | 沒東西要框就用 `Section`；分頁有網址用 `NavTabs` |
| `Photo` | 照片 | `caption` 一行小字；版位不存在時顯示橫線紙，不會壞；`priority` 給首屏。`.hero-photos` 是一大一小加圖說的組合 |
| `Phrases` | 大標題、導言 | 中文按詞組換行，不留孤立句號 |
| `Prose` 系列 | 信任中心、衛教 | 見 3.3 |

外框：`PublicShell` `PatientShell` `ClinicShell` `PharmacyShell` `AdminShell`。計數屬性：`PatientShell counts={{visits,medications,messages}}`、`ClinicShell counts={{worklist,urgent,rx,tickets}}`、`PharmacyShell counts={{check,prepare,ready,returned,done}}`（路徑 `/pharmacy/queue/<階段>`）、`AdminShell system={[{label,value}]}`。

## 5. 要與不要

| 要 | 不要 |
|---|---|
| 規線、表格、對齊 | 卡片牆、卡片裡放卡片、每段一張圓角白卡 |
| 標題自己站得住 | 標題上面的小標籤、全大寫追蹤字 |
| 方角、2–6px | 到處 `rounded-2xl`、膠囊按鈕 |
| 圖示＋文字＋顏色 | 只靠顏色、裝飾用的圓點與長條 |
| 大而清楚的數字與日期 | 假數據、「成長 128%」式統計磚 |
| 真實照片配圖說 | 微笑模特兒、插畫人物、吉祥物、表情符號 |
| 150–280ms 的狀態動畫 | 進場動畫、滾動動畫、彈跳 |
| 黃貼紙說錯在哪 | 紅色錯誤字 |
| 立即切換（Ctrl+K、分頁、列表鍵盤） | 鍵盤操作還要等動畫 |
| `hover` 只在滑鼠裝置 | 觸控後黏住的 hover（Tailwind 4 的 `hover:` 已處理；自寫 CSS 要包 `@media (hover:hover) and (pointer:fine)`） |

## 6. 無障礙與行動

跳過連結、換頁後焦點到 h1 並朗讀、所有彈出層可用 Esc 關閉並還原焦點、焦點框 2px 藍（深色淺藍）、觸控目標 ≥44px（compact 在觸控裝置自動放大）、表單錯誤以 `aria-describedby` 連結、即時區只用在對話與狀態、`prefers-reduced-motion` 關閉位移動畫、`forced-colors` 有邊框。手機：`viewport-fit=cover`、安全區、`100dvh`、輸入框 ≥16px、`interactive-widget=resizes-content`、`overscroll-behavior`。列印：`print.css` 會拿掉外框與捲動區，摘要、筆記、信任文件可直接列印。

每次發版前：axe（WCAG 2.2 AA＋best practice）在十個場景、兩種寬度、兩個主題都是 0 項。真機觸控、螢幕閱讀器實機仍需人工測。
