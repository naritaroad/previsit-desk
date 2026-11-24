# 視覺方向：PreVisit Desk 診前助理

日期：2026-11-25。設計 token 的唯一來源是 `web/src/styles/tokens.css`；這份文件說明為什麼這樣定、怎麼用。改 token 後請重跑 `node docs/design/contrast-check.mjs`，並更新第 4 節的輸出。

相關檔案：

| 檔案 | 用途 |
|---|---|
| `web/src/styles/tokens.css` | CSS 自訂屬性：淺色 `:root`、深色 `[data-theme="dark"]`、系統深色 `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` |
| `web/src/styles/base.css` | reset、字體排印、焦點框、減少動態、`.visually-hidden`、少量工具類別與 `.btn` |
| `docs/design/contrast-check.mjs` | 讀 tokens.css，計算 116 組對比（兩個主題各 58 組），任何一組不及格就以 exit 1 結束；也檢查兩個深色區塊是否一致 |
| `docs/design/mockup.html` | 單一檔案設計稿（token 已內嵌），含主題切換 |
| `docs/design/logo.svg`、`web/public/favicon.svg` | 標誌 |
| `docs/design/shots/` | 390 與 1280 寬、淺色與深色截圖 |

---

## 1. 對象與氣氛

**病人**：看診前用手機或診間平板，可能身體不舒服、焦慮、看不清小字，也可能是長輩。要的是「這個東西很穩、知道自己在做什麼、不會亂給建議」。
**醫師**：在門診空檔掃一眼清單，要在三秒內看到誰最急、摘要缺了什麼。
**評審**：課堂展示，要一眼看懂安全界線與可稽核性。

氣氛：**冷靜、可信、不冷漠**。像一間採光好的診所櫃台，不像急診室也不像科技新創。

- 主色是偏深的藍綠（teal），在暖米白底上；不用純白、不用冷灰。
- **紅色只留給緊急狀況**（紅旗、119／1925、緊急轉交單）。表單錯誤、工具錯誤、額度用完一律用琥珀色，避免病人看到紅色就慌。
- 圓角適中（8–12px），陰影很淡，邊框細。不用漸層、不用插畫人物、不用聽診器圖示。
- 文字寫得像櫃台人員說話：直接、短、有禮貌，不說「親」、不加驚嘆號。

## 2. 色彩

### 2.1 色票

| 角色 | Token | 淺色 | 深色 | 說明 |
|---|---|---|---|---|
| 背景 | `--color-bg` | `#f6f4ef` | `#121615` | 暖米白／帶綠的近黑 |
| 表面 | `--color-surface` | `#fffdf9` | `#1a201f` | 卡片、標頭、面板 |
| 浮起表面 | `--color-surface-raised` | `#ffffff` | `#222a28` | AI 對話泡泡、輸入框、追蹤列 |
| 凹陷表面 | `--color-surface-sunken` | `#eeebe4` | `#0d1110` | 程式碼、骨架、hover |
| 裝飾分隔線 | `--color-border` | `#ddd8ce` | `#313b39` | 只做分隔，不當控制項外框 |
| 控制項外框 | `--color-border-strong` | `#857e72` | `#75827f` | 輸入框、次要按鈕、徽章外框（≥3:1） |
| 內文 | `--color-text` | `#1d2628` | `#e7ecea` | |
| 次要文字 | `--color-text-muted` | `#545e5e` | `#a8b3b0` | |
| 說明文字 | `--color-text-subtle` | `#66706f` | `#96a29f` | 時間戳記、提示（仍 ≥4.5:1） |
| 主色 | `--color-primary` | `#0e6b66` | `#5cc0b5` | 按鈕、連結、進度、選取中的分頁底線 |
| 主色 hover | `--color-primary-hover` | `#0a5551` | `#7dd0c6` | |
| 主色上的文字 | `--color-primary-contrast` | `#ffffff` | `#08201e` | 深色模式主色變亮，所以字改深色 |
| 主色淡底 | `--color-primary-soft` | `#dcefeb` | `#173532` | 病人泡泡、選取中的篩選、階段標籤 |
| 淡底上的主色字 | `--color-primary-strong` | `#0a4f4b` | `#9ee0d7` | |
| 輔助色（藍灰） | `--color-accent` | `#3b5a74` | `#9fbad3` | AI 揭露橫幅、「模型」來源、`consult` 結果 |
| 輔助色淡底 | `--color-accent-bg` | `#e5ecf2` | `#1d2a35` | |
| 成功 | `--color-success` / `-bg` | `#2b6a33` / `#e2efdf` | `#86cf8c` / `#172e1a` | 工具完成、`eligible` |
| 注意 | `--color-warning` / `-bg` | `#855400` / `#f9eed6` | `#e6b75a` / `#33280f` | 表單錯誤、工具錯誤、`too_early`、「盡快」 |
| 回診（梅紫） | `--color-revisit` / `-bg` | `#66468a` / `#efe8f6` | `#c9aceb` / `#2a2036` | `revisit` |
| **緊急** | `--color-danger` | `#b0241a` | `#ff8f84` | **只用於紅旗**：標題、圖示、緊急徽章文字 |
| 緊急淡底 | `--color-danger-bg` | `#fdebe8` | `#3a1512` | 緊急卡片底 |
| 緊急內文 | `--color-danger-strong` | `#8c1b13` | `#ffc2bb` | 緊急卡片內文 |
| 緊急實心 | `--color-danger-solid` | `#b0241a` | `#d33a2f` | 「撥打 119」按鈕、紅旗左側色條 |
| 緊急實心上的字 | `--color-danger-contrast` | `#ffffff` | `#ffffff` | |
| 焦點 | `--color-focus` | `#2554c7` | `#86b4ff` | 焦點框；刻意和主色不同色相 |

慢箋結果另有別名：`--outcome-{eligible|too-early|revisit|consult}-{fg|bg}`，元件請用別名，之後調色只改一處。

### 2.2 用色規則

1. **紅色只代表「現在就要處理」**：紅旗緊急卡片、119／1925 按鈕、清單的「緊急」徽章與左側紅條、追蹤面板的「紅旗命中」列、手機分頁列的紅點。其他地方出現紅色就是錯。
2. 狀態永遠是「圖示＋文字」，顏色只是加強。色盲或黑白列印也看得懂。
3. 深色模式不是反相：主色變亮、主色按鈕上的字改深色；緊急實心按鈕維持白字（`#d33a2f` 上白字 4.76:1）。
4. 不用透明度做文字顏色（對比難算、疊在不同底上會變）。`--color-overlay` 只用在對話框遮罩。

## 3. 對比要求

- 內文、按鈕文字、徽章文字：≥ 4.5:1（不管字多大都照這個標準，省得判斷「大字」）。
- 控制項外框、焦點框、緊急按鈕邊緣：≥ 3:1。
- `--color-border` 是裝飾線，不承擔辨識任務，不列入 3:1；凡是「看不到就不知道這裡可以輸入」的邊框都要用 `--color-border-strong`。

## 4. 對比檢查結果

執行：`node docs/design/contrast-check.mjs`（Node 18 以上，無相依套件）。

**最低文字對比：淺色 4.65:1（`--color-text-subtle` 在 `--color-bg` 上），深色 4.76:1（白字在 `--color-danger-solid` 上）。116 組全部通過。**

```text
== light ==
ratio  min  result  foreground -> background  (use)
14.05  4.5  PASS    --color-text #1d2628 -> --color-bg #f6f4ef  (body text)
 6.09  4.5  PASS    --color-text-muted #545e5e -> --color-bg #f6f4ef  (secondary text)
15.20  4.5  PASS    --color-text #1d2628 -> --color-surface #fffdf9  (body text)
 6.58  4.5  PASS    --color-text-muted #545e5e -> --color-surface #fffdf9  (secondary text)
15.44  4.5  PASS    --color-text #1d2628 -> --color-surface-raised #ffffff  (body text)
 6.69  4.5  PASS    --color-text-muted #545e5e -> --color-surface-raised #ffffff  (secondary text)
12.97  4.5  PASS    --color-text #1d2628 -> --color-surface-sunken #eeebe4  (body text)
 5.62  4.5  PASS    --color-text-muted #545e5e -> --color-surface-sunken #eeebe4  (secondary text)
 4.65  4.5  PASS    --color-text-subtle #66706f -> --color-bg #f6f4ef  (captions)
 5.77  4.5  PASS    --color-primary #0e6b66 -> --color-bg #f6f4ef  (links / primary text)
 6.59  4.5  PASS    --color-accent #3b5a74 -> --color-bg #f6f4ef  (accent text)
 5.95  4.5  PASS    --color-success #2b6a33 -> --color-bg #f6f4ef  (status text)
 5.85  4.5  PASS    --color-warning #855400 -> --color-bg #f6f4ef  (status text)
 6.80  4.5  PASS    --color-revisit #66468a -> --color-bg #f6f4ef  (status text)
 6.14  4.5  PASS    --color-danger #b0241a -> --color-bg #f6f4ef  (red-flag text)
 3.66  3.0  PASS    --color-border-strong #857e72 -> --color-bg #f6f4ef  (control boundary)
 6.02  3.0  PASS    --color-focus #2554c7 -> --color-bg #f6f4ef  (focus ring)
 5.03  4.5  PASS    --color-text-subtle #66706f -> --color-surface #fffdf9  (captions)
 6.24  4.5  PASS    --color-primary #0e6b66 -> --color-surface #fffdf9  (links / primary text)
 7.13  4.5  PASS    --color-accent #3b5a74 -> --color-surface #fffdf9  (accent text)
 6.43  4.5  PASS    --color-success #2b6a33 -> --color-surface #fffdf9  (status text)
 6.33  4.5  PASS    --color-warning #855400 -> --color-surface #fffdf9  (status text)
 7.36  4.5  PASS    --color-revisit #66468a -> --color-surface #fffdf9  (status text)
 6.64  4.5  PASS    --color-danger #b0241a -> --color-surface #fffdf9  (red-flag text)
 3.96  3.0  PASS    --color-border-strong #857e72 -> --color-surface #fffdf9  (control boundary)
 6.52  3.0  PASS    --color-focus #2554c7 -> --color-surface #fffdf9  (focus ring)
 5.11  4.5  PASS    --color-text-subtle #66706f -> --color-surface-raised #ffffff  (captions)
 6.34  4.5  PASS    --color-primary #0e6b66 -> --color-surface-raised #ffffff  (links / primary text)
 7.24  4.5  PASS    --color-accent #3b5a74 -> --color-surface-raised #ffffff  (accent text)
 6.54  4.5  PASS    --color-success #2b6a33 -> --color-surface-raised #ffffff  (status text)
 6.43  4.5  PASS    --color-warning #855400 -> --color-surface-raised #ffffff  (status text)
 7.48  4.5  PASS    --color-revisit #66468a -> --color-surface-raised #ffffff  (status text)
 6.75  4.5  PASS    --color-danger #b0241a -> --color-surface-raised #ffffff  (red-flag text)
 4.02  3.0  PASS    --color-border-strong #857e72 -> --color-surface-raised #ffffff  (control boundary)
 6.62  3.0  PASS    --color-focus #2554c7 -> --color-surface-raised #ffffff  (focus ring)
 5.60  4.5  PASS    --color-text-muted #545e5e -> --color-primary-soft #dcefeb  (meta in patient bubble)
12.93  4.5  PASS    --color-text #1d2628 -> --color-primary-soft #dcefeb  (patient bubble text)
 6.34  4.5  PASS    --color-primary-contrast #ffffff -> --color-primary #0e6b66  (primary button)
 8.64  4.5  PASS    --color-primary-contrast #ffffff -> --color-primary-hover #0a5551  (primary button hover)
 7.88  4.5  PASS    --color-primary-strong #0a4f4b -> --color-primary-soft #dcefeb  (selected tab / chip)
 6.07  4.5  PASS    --color-accent #3b5a74 -> --color-accent-bg #e5ecf2  (consult card / info)
12.95  4.5  PASS    --color-text #1d2628 -> --color-accent-bg #e5ecf2  (text on info bg)
 5.49  4.5  PASS    --color-success #2b6a33 -> --color-success-bg #e2efdf  (eligible card)
12.97  4.5  PASS    --color-text #1d2628 -> --color-success-bg #e2efdf  (text on eligible card)
 5.58  4.5  PASS    --color-warning #855400 -> --color-warning-bg #f9eed6  (too_early card)
13.40  4.5  PASS    --color-text #1d2628 -> --color-warning-bg #f9eed6  (text on too_early card)
 6.25  4.5  PASS    --color-revisit #66468a -> --color-revisit-bg #efe8f6  (revisit card)
12.90  4.5  PASS    --color-text #1d2628 -> --color-revisit-bg #efe8f6  (text on revisit card)
 5.85  4.5  PASS    --color-danger #b0241a -> --color-danger-bg #fdebe8  (emergency title)
 7.99  4.5  PASS    --color-danger-strong #8c1b13 -> --color-danger-bg #fdebe8  (emergency body)
13.40  4.5  PASS    --color-text #1d2628 -> --color-danger-bg #fdebe8  (text on emergency bg)
 6.75  4.5  PASS    --color-danger-contrast #ffffff -> --color-danger-solid #b0241a  (call 119 button)
 5.85  3.0  PASS    --color-danger-solid #b0241a -> --color-danger-bg #fdebe8  (call button edge on emergency bg)
 6.64  3.0  PASS    --color-danger-solid #b0241a -> --color-surface #fffdf9  (call button edge on surface)
 6.24  3.0  PASS    --color-primary #0e6b66 -> --color-surface #fffdf9  (primary button edge)
 5.55  3.0  PASS    --color-focus #2554c7 -> --color-primary-soft #dcefeb  (focus ring on selected tab)
 5.75  3.0  PASS    --color-focus #2554c7 -> --color-danger-bg #fdebe8  (focus ring in emergency card)
 3.38  3.0  PASS    --color-border-strong #857e72 -> --color-surface-sunken #eeebe4  (input on sunken)

== dark ==
ratio  min  result  foreground -> background  (use)
15.27  4.5  PASS    --color-text #e7ecea -> --color-bg #121615  (body text)
 8.46  4.5  PASS    --color-text-muted #a8b3b0 -> --color-bg #121615  (secondary text)
13.84  4.5  PASS    --color-text #e7ecea -> --color-surface #1a201f  (body text)
 7.67  4.5  PASS    --color-text-muted #a8b3b0 -> --color-surface #1a201f  (secondary text)
12.30  4.5  PASS    --color-text #e7ecea -> --color-surface-raised #222a28  (body text)
 6.81  4.5  PASS    --color-text-muted #a8b3b0 -> --color-surface-raised #222a28  (secondary text)
15.92  4.5  PASS    --color-text #e7ecea -> --color-surface-sunken #0d1110  (body text)
 8.82  4.5  PASS    --color-text-muted #a8b3b0 -> --color-surface-sunken #0d1110  (secondary text)
 6.92  4.5  PASS    --color-text-subtle #96a29f -> --color-bg #121615  (captions)
 8.39  4.5  PASS    --color-primary #5cc0b5 -> --color-bg #121615  (links / primary text)
 9.07  4.5  PASS    --color-accent #9fbad3 -> --color-bg #121615  (accent text)
 9.83  4.5  PASS    --color-success #86cf8c -> --color-bg #121615  (status text)
 9.80  4.5  PASS    --color-warning #e6b75a -> --color-bg #121615  (status text)
 9.19  4.5  PASS    --color-revisit #c9aceb -> --color-bg #121615  (status text)
 8.26  4.5  PASS    --color-danger #ff8f84 -> --color-bg #121615  (red-flag text)
 4.57  3.0  PASS    --color-border-strong #75827f -> --color-bg #121615  (control boundary)
 8.67  3.0  PASS    --color-focus #86b4ff -> --color-bg #121615  (focus ring)
 6.27  4.5  PASS    --color-text-subtle #96a29f -> --color-surface #1a201f  (captions)
 7.61  4.5  PASS    --color-primary #5cc0b5 -> --color-surface #1a201f  (links / primary text)
 8.22  4.5  PASS    --color-accent #9fbad3 -> --color-surface #1a201f  (accent text)
 8.91  4.5  PASS    --color-success #86cf8c -> --color-surface #1a201f  (status text)
 8.88  4.5  PASS    --color-warning #e6b75a -> --color-surface #1a201f  (status text)
 8.33  4.5  PASS    --color-revisit #c9aceb -> --color-surface #1a201f  (status text)
 7.49  4.5  PASS    --color-danger #ff8f84 -> --color-surface #1a201f  (red-flag text)
 4.14  3.0  PASS    --color-border-strong #75827f -> --color-surface #1a201f  (control boundary)
 7.86  3.0  PASS    --color-focus #86b4ff -> --color-surface #1a201f  (focus ring)
 5.57  4.5  PASS    --color-text-subtle #96a29f -> --color-surface-raised #222a28  (captions)
 6.76  4.5  PASS    --color-primary #5cc0b5 -> --color-surface-raised #222a28  (links / primary text)
 7.30  4.5  PASS    --color-accent #9fbad3 -> --color-surface-raised #222a28  (accent text)
 7.92  4.5  PASS    --color-success #86cf8c -> --color-surface-raised #222a28  (status text)
 7.89  4.5  PASS    --color-warning #e6b75a -> --color-surface-raised #222a28  (status text)
 7.40  4.5  PASS    --color-revisit #c9aceb -> --color-surface-raised #222a28  (status text)
 6.65  4.5  PASS    --color-danger #ff8f84 -> --color-surface-raised #222a28  (red-flag text)
 3.68  3.0  PASS    --color-border-strong #75827f -> --color-surface-raised #222a28  (control boundary)
 6.98  3.0  PASS    --color-focus #86b4ff -> --color-surface-raised #222a28  (focus ring)
 6.12  4.5  PASS    --color-text-muted #a8b3b0 -> --color-primary-soft #173532  (meta in patient bubble)
11.05  4.5  PASS    --color-text #e7ecea -> --color-primary-soft #173532  (patient bubble text)
 7.82  4.5  PASS    --color-primary-contrast #08201e -> --color-primary #5cc0b5  (primary button)
 9.48  4.5  PASS    --color-primary-contrast #08201e -> --color-primary-hover #7dd0c6  (primary button hover)
 8.86  4.5  PASS    --color-primary-strong #9ee0d7 -> --color-primary-soft #173532  (selected tab / chip)
 7.27  4.5  PASS    --color-accent #9fbad3 -> --color-accent-bg #1d2a35  (consult card / info)
12.26  4.5  PASS    --color-text #e7ecea -> --color-accent-bg #1d2a35  (text on info bg)
 7.85  4.5  PASS    --color-success #86cf8c -> --color-success-bg #172e1a  (eligible card)
12.19  4.5  PASS    --color-text #e7ecea -> --color-success-bg #172e1a  (text on eligible card)
 7.78  4.5  PASS    --color-warning #e6b75a -> --color-warning-bg #33280f  (too_early card)
12.12  4.5  PASS    --color-text #e7ecea -> --color-warning-bg #33280f  (text on too_early card)
 7.79  4.5  PASS    --color-revisit #c9aceb -> --color-revisit-bg #2a2036  (revisit card)
12.95  4.5  PASS    --color-text #e7ecea -> --color-revisit-bg #2a2036  (text on revisit card)
 7.34  4.5  PASS    --color-danger #ff8f84 -> --color-danger-bg #3a1512  (emergency title)
10.56  4.5  PASS    --color-danger-strong #ffc2bb -> --color-danger-bg #3a1512  (emergency body)
13.57  4.5  PASS    --color-text #e7ecea -> --color-danger-bg #3a1512  (text on emergency bg)
 4.76  4.5  PASS    --color-danger-contrast #ffffff -> --color-danger-solid #d33a2f  (call 119 button)
 3.41  3.0  PASS    --color-danger-solid #d33a2f -> --color-danger-bg #3a1512  (call button edge on emergency bg)
 3.48  3.0  PASS    --color-danger-solid #d33a2f -> --color-surface #1a201f  (call button edge on surface)
 7.61  3.0  PASS    --color-primary #5cc0b5 -> --color-surface #1a201f  (primary button edge)
 6.27  3.0  PASS    --color-focus #86b4ff -> --color-primary-soft #173532  (focus ring on selected tab)
 7.71  3.0  PASS    --color-focus #86b4ff -> --color-danger-bg #3a1512  (focus ring in emergency card)
 4.76  3.0  PASS    --color-border-strong #75827f -> --color-surface-sunken #0d1110  (input on sunken)

Pairs checked: 116. Failures: 0.
Minimum text ratio: light 4.65, dark 4.76.
```

## 5. 字體排印

### 5.1 字型堆疊

```css
--font-sans: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial,
  "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif;
--font-mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, "Noto Sans Mono CJK TC", monospace;
```

- 拉丁字型放前面，讓英文、數字、藥名用拉丁字型；中文自動落到 Noto Sans TC／蘋方-繁／微軟正黑體。
- **刻意不用 `system-ui`**：在簡體中文或部分 Windows 環境會落到微軟雅黑，字形是大陸標準。
- 不載入網路字型（展示環境可能沒網路，也避免中文字型檔太大）。
- `<html lang="zh-Hant-TW">`；切換英文時改 `lang="en"`。

### 5.2 字級

| Token | 大小 | 行高 | 用途 |
|---|---|---|---|
| `--text-xs` | 12px | 1.5 | 時間戳記、追蹤列中繼資料、徽章 |
| `--text-sm` | 14px | 1.5 | 次要內容、表格、橫幅 |
| `--text-md` | 16px | 1.7 | 內文、對話（**手機輸入框不得小於 16px**，避免 iOS 自動放大） |
| `--text-lg` | 18px | 1.35 | 卡片標題、緊急卡片標題 |
| `--text-xl` | 20px | 1.35 | 區塊標題 |
| `--text-2xl` | 24px | 1.35 | 頁面標題、119／1925 號碼 |
| `--text-3xl` | 30px | 1.35 | 保留 |

字重只用 400／500／700。

### 5.3 中文排版

- 內文行高 1.7（`--leading-body`），標題 1.35。中文字面飽滿，行高低於 1.6 會擠。
- 字距：內文 `0.01em`、小標籤 `0.02em`；**不要負字距**。
- 標點全形：，。、；：？！「」。使用者輸入與 API 資料原樣顯示，不自動插入空格；介面文案中，中文與英文、數字之間加半形空格（如「AI 預問診」「3 天」）。
- 斷行：`line-break: strict`（避免句號、頓號跑到行首）、`overflow-wrap: anywhere`（長網址與藥名不撐破版面）。標題用 `text-wrap: balance`。
- 數字欄位、時間、計數一律 `font-variant-numeric: tabular-nums`（`.num` 或 `<time>`）。
- 日期顯示：病人端用「12 月 2 日」或 `2026-12-02`；醫師清單用 `09:42`／「昨天」；工具追蹤用 ISO。

## 6. 間距、圓角、陰影

| 間距 | 值 | | 圓角 | 值 | 用途 |
|---|---|---|---|---|---|
| `--space-1` | 4px | | `--radius-sm` | 4px | 徽章、程式碼 |
| `--space-2` | 8px | | `--radius-md` | 8px | 按鈕、輸入框、追蹤列 |
| `--space-3` | 12px | | `--radius-lg` | 12px | 卡片、對話泡泡、緊急卡片 |
| `--space-4` | 16px | | `--radius-xl` | 16px | 大框、手機外框 |
| `--space-5` | 24px | | `--radius-pill` | 999px | 篩選鈕、「模型」來源徽章 |
| `--space-6` | 32px | | | | |
| `--space-7` | 48px | | | | |
| `--space-8` | 64px | | | | |

手機左右留白 16px（`--space-4`）。陰影只有三層：`--shadow-1`（對話泡泡）、`--shadow-2`（卡片浮起、緊急卡片）、`--shadow-3`（對話框）。淺色用暖棕低透明度，深色用黑色。

## 7. 動態

| Token | 值 | 用在 |
|---|---|---|
| `--dur-instant` | 80ms | 按下按鈕縮到 0.98 |
| `--dur-fast` | 140ms | hover、分頁底線、緊急卡片淡入 |
| `--dur-base` | 200ms | 新訊息進場（淡入＋上移 6px） |
| `--dur-slow` | 280ms | 慢箋結果卡片進場（淡入＋上移 8px）、進度條寬度 |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | 進場 |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | 打字中的三個點 |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | 離場（少用） |

**會動的**：新訊息進場、串流游標閃爍、「正在輸入」三點、分頁切換的底線、慢箋結果卡片進場、進度條。
**不動的**：
- **緊急卡片不滑入、不彈跳、不震動**，只用 140ms 淡入，命中當下就要看得到。119 按鈕不做脈動。
- 頁面切換、分頁內容切換不做轉場（立即換）。
- 工具追蹤列逐筆出現時不動畫（避免串流時畫面一直跳）。
- 不做視差、不做數字滾動。

**減少動態**（`prefers-reduced-motion: reduce`）：base.css 把所有 animation／transition 縮到 0.01ms、只跑一次；串流游標改成靜止方塊；平滑捲動關閉。串流文字照常逐段出現（那是內容，不是裝飾）。

## 8. 圖示

- 一律**內嵌 SVG**（`<svg><use href="#i-xxx"/></svg>` 或直接寫 path），不用圖示字型、不用外部圖庫 CDN。
- 24×24 畫布、`stroke-width: 1.75`、圓端點圓接角、`fill: none`、顏色用 `currentColor`。
- 尺寸：16px（徽章內）、20px（預設 `.icon`）、24px（卡片主圖示、緊急卡片）。
- 圖示一律搭配文字；只有圖示的按鈕（送出、主題切換）要有 `aria-label`。裝飾圖示加 `aria-hidden="true"`。
- 設計稿已定義的圖示：`info`、`check-circle`、`check`、`clock`、`calendar`（回診）、`person-chat`（洽藥師或醫師）、`alert`、`phone`、`code`（程式）、`spark`（模型）、`form`（表單）、`slash`（已攔下）、`sun`、`moon`、`send`、`chat`、`list`、`doc`、`pill`、`shield`、`back`、`search`、`ticket`。路徑可直接從 `mockup.html` 的 `<symbol>` 複製。
- 不用聽診器、十字、心電圖等醫療陳腔濫調。

## 9. 標誌

對話泡泡＋勾選與清單線：代表「先談、再整理成清單」。泡泡尾巴在左下。

- `docs/design/logo.svg`：圖形＋字標「PreVisit Desk」＋「診前助理」（360×64）。
- `web/public/favicon.svg`：32×32 圖形，內含 `prefers-color-scheme` 切換深淺。
- 最小尺寸 16px；周圍留白至少等於泡泡圓角（約圖形寬度的 1/5）。
- 介面標頭用 28px 圖形＋粗體「PreVisit Desk」＋次要色「診前助理」；420px 以下只留英文字標。

## 10. 版面

### 10.1 斷點

以**容器寬度**判斷（設計稿用 container query；實作用 media query 也可以，數值相同）：

| 名稱 | 寬度 | 病人端 | 醫師端 |
|---|---|---|---|
| compact | < 900px | 單欄＋底部分頁列（對話／追蹤／摘要／慢箋） | 清單改卡片列；詳情單欄 |
| wide | 900–1179px | 左對話＋右面板 380px | 清單表格；詳情 960px 以上兩欄 |
| full | ≥ 1180px | 右面板 420px（`--panel-w`） | 同上 |

內容最大寬 1280px（`--content-max`）；對話泡泡最寬 36rem，對話欄最寬 42rem（`--chat-measure`）置中。

### 10.2 病人端・桌面

```
┌──────────────────────────────────────────────────────────────────────┐
│ [標誌] PreVisit Desk 診前助理                     English   ☾       │ 56px 標頭
├──────────────────────────────────────────────────────────────────────┤
│ ⓘ AI 預問診助理，不是醫師。不做診斷、不開藥。請勿輸入真實病歷或個資。 安全說明 │ 揭露橫幅（藍灰，不可關）
├───────────────────────────────────────────┬──────────────────────────┤
│ 預問診 [過去史・用藥]        8／11 ▓▓▓▓░ │ 工具追蹤(7)│摘要│慢箋檢核 │ ← role=tablist
│───────────────────────────────────────────│──────────────────────────│
│ ◯ ┌ 固定開場說明（虛線框）┐             │ 回合 #4 模型 … 用量 …    │
│   └──────────────────────┘             │ 1 [<>程式] red_flag… ✓完成│
│              ┌ 病人泡泡（主色淡底）┐ ◯  │ 2 [<>程式] scope_…   ✓完成│
│              └────────────────────┘    │ 3 (✦模型) record_…   ✓完成│
│ ◯ ┌ AI 泡泡（白底、細框）┐               │ 5 [<>程式] output_… ⊘已攔下│
│   └ 串流中… ▌          ┘               │   └ 展開：耗時／參數／結果 │
│───────────────────────────────────────────│ 7 (✦模型) transfer… ⚠錯誤 │
│ [ 請描述您的狀況            ] [➤]        │                          │
│ Enter 送出・0／1,000          結束並送出 │                          │
└───────────────────────────────────────────┴──────────────────────────┘
```

### 10.3 病人端・手機

```
┌────────────────────────┐
│ [標誌] PreVisit Desk ☾ │
│ ⓘ AI 預問診助理，不是…  │ 橫幅可折兩行，不截斷
│ 預問診 [階段] 8／11 ▓▓░ │
│                        │
│  （目前分頁的內容）      │ 只捲動這一區
│                        │
│ [ 請描述您的狀況 ] [➤]  │ 只在「對話」分頁出現
├────────────────────────┤
│ 對話 │ 追蹤• │ 摘要 │ 慢箋 │ 56px 分頁列；紅旗時「追蹤」有紅點
└────────────────────────┘
```

切到其他分頁時保留對話捲動位置與輸入中的草稿。分頁列 `role="tablist"`，每顆至少 44×56px。

### 10.4 AI 揭露橫幅

- 位置：標頭正下方，所有病人頁面都有，**不可關閉**；手機可折成兩行，不截斷文字。
- 樣式：`--color-accent-bg` 底、`info` 圖示、第一句粗體藍灰「AI 預問診助理，不是醫師。」，其後一般文字；右側「安全說明」連到安全界線頁（420px 以下隱藏連結，改放在選單）。
- `role="note"`，不用 `alert`（不需要每次朗讀）。

### 10.5 緊急卡片（紅旗命中）

```
┌─[2px 緊急實心框，緊急淡底]────────────────────┐
│ [▲] 請立即就醫                                │ 40px 實心紅方塊＋白色警示圖示
│     偵測到：胸痛／胸悶                         │
│ 您描述的症狀可能很危急。請馬上撥打 119，或請    │
│ 身邊的人陪您到最近的急診。不要自己開車。        │
│ ┌──────────────────┐ ┌──────────────────┐    │
│ │ ☎ 119  緊急救護   │ │ ☎ 1925 安心專線   │    │ 56px 高；119 實心紅，1925 白底紅框
│ └──────────────────┘ └──────────────────┘    │ 窄螢幕自動上下排
│ 已通知醫療團隊（轉交單 T-20261125-0007）。     │
└───────────────────────────────────────────────┘
```

- 固定（sticky）在對話區最上方，捲動時不會被推走；`role="alert"`，焦點**不自動移入**（避免打斷螢幕報讀），但 `alert` 會立即朗讀。
- 119、1925 是 `<a href="tel:119">`／`<a href="tel:1925">`。自傷類別時 1925 放前面、119 放後面，標題改「您不是一個人，現在就有人可以陪您談」。
- 輸入框換成「這次預問診已暫停，訊息不會再送給 AI。」＋「開始新的預問診」（次要按鈕）。
- 對話中那則固定回覆標示「規則回覆・未經 AI」。

### 10.6 慢箋結果卡片（四種）

不靠顏色也能分辨：**圖示＋文字標籤＋外框形狀**三重提示，顏色是第四重。

| 結果 | 標籤 | 圖示 | 外框形狀 | 圖示外形 | 色 |
|---|---|---|---|---|---|
| `eligible` | 可領 | check-circle | 2px **實線**全框 | 實心圓 | 綠 |
| `too_early` | 尚未到可領期間 | clock | 2px **虛線**全框 | 空心圓（描邊） | 琥珀 |
| `revisit` | 需回診 | calendar | 細框＋左側 8px **雙線** | 方形（描邊） | 梅紫 |
| `consult` | 請洽藥師或醫師 | person-chat | 細框＋上方 6px **粗色帶** | 圓角方形 | 藍灰 |

卡片結構（由上而下）：
```
[圖示] 標籤（12px 粗體，結果色）
       標題（18px，例：還不能領，12 月 2 日起可領）
訊息（14px，一到兩句）
┌ 最早可領日 ┐┌ 還要等 ┐       ← 兩格日期磚，數字 tabular-nums
│ 2026-12-02 ││ 7 天   │
└────────────┘└────────┘
• 理由（reasons，程式算出）
[consult 才有] 🎫 已通知醫療團隊，轉交單 T-…
▸ 規則依據（2 條）             ← <details>，展開顯示規則文字與來源連結
```

日期磚依結果顯示：`eligible` 可領期間＋慢箋到期；`too_early` 最早可領日＋還要等幾天；`revisit` 慢箋到期＋已領次數；`consult` 交給誰＋緊急程度。卡片 `aria-labelledby` 指向標題；結果出現時，把結果容器設 `aria-live="polite"`。

慢箋表單：日期用 `type="date"`；數字欄 `inputmode="numeric"`；「已領幾次」「是否含管制藥」用分段單選（`fieldset`＋`legend`，選中為主色淡底＋粗體）；勾選框 20px、整列 44px 可點。驗證錯誤用琥珀色：外框 2px＋`alert` 圖示＋文字，`aria-invalid` 與 `aria-describedby` 連到訊息。

### 10.7 工具追蹤列

```
[步驟] [來源徽章] 工具名稱（等寬字，過長截斷＋title）        [狀態]
  1    [<> 程式]  red_flag_precheck                         ✓ 完成
  4    (✦ 模型)   search_health_education                   ✓ 完成
  6    [▤ 表單]   check_chronic_refill                      ✓ 完成
  5    [<> 程式]  output_guard                              ⊘ 已攔下
  7    (✦ 模型)   transfer_to_clinician                     ⚠ 錯誤
  1    [<> 程式]  red_flag_precheck   ← 2px 緊急框           ▲ 紅旗命中
  └ 展開（<details>）：耗時 84 ms・模型呼叫／參數 JSON／結果 JSON
```

- 來源用**徽章外形**區分：程式＝直角框、模型＝膠囊形（藍灰）、表單＝直角虛線框；都帶圖示與文字。
- 狀態：`ok` 勾＋「完成」（綠）、`rejected` 斜線圓＋「已攔下」（次要灰）、`error` 三角形＋「錯誤」（琥珀，不用紅）。只有紅旗命中那列用紅色外框與「紅旗命中」。
- 每個回合上方一條灰底中繼列：回合編號、模型名稱（`skipped` 時寫「未呼叫（規則直接回覆）」）、是否用備援、token 用量。
- 列表用 `<ol>`；每列整列可點、高 ≥ 44px；JSON 用 `<pre>` 自動換行。

### 10.8 醫師端・清單

```
┌ 預問診清單  待處理 4 筆，其中 2 筆緊急 ───────────────────────────┐
│ (全部 6) (▲ 紅旗 2) (待審閱 2) (已審閱)              [搜尋主訴   ] │
├────────┬──────────────────────────────┬────────┬──────┬──────────┤
│緊急程度│主訴                          │狀態    │轉交單│最後活動  │
│▌[▲緊急]│胸口悶痛、左手麻，約 30 分鐘   │▲ 紅旗  │1 張  │09:42     │ ← 左側 4px 紅條
│        │紅旗：胸痛／胸悶・轉交單 1     │        │      │          │
│ [◷盡快]│Metformin 慢箋第 3 次…（截斷） │▤ 待審閱│1 張  │10:58     │
│ [≡一般]│— 尚未取得主訴                 │▢ 問診中│—     │14:10     │
└────────┴──────────────────────────────┴────────┴──────┴──────────┘
```

- 排序照 API：`urgent` → `soon` → `routine`，同級依最後活動新到舊。
- 緊急程度徽章：緊急＝紅底紅框＋警示圖示；盡快＝琥珀虛線框＋時鐘；一般＝灰框＋清單圖示。
- 主訴寬螢幕單行截斷（`title` 顯示全文），compact 兩行截斷。主訴是 null 時顯示「— 尚未取得主訴」。
- 整列是一個連結，高 ≥ 56px。compact 改成兩行卡片：主訴＋徽章／狀態＋時間。
- 200 筆以上：API 有 `limit`，前端一次顯示 50 筆＋「載入更多」，不做虛擬捲動（展示規模用不到）。

### 10.9 醫師端・詳情

```
‹ 回清單
[▲緊急] 胸口悶痛、左手麻   紅旗命中・09:42・訊息 3 則
┌ 預問診摘要 ─────────────┐ ┌ 完整對話 ──────────────┐
│ 一段摘要（≤300 字）       │ │ AI   您好，我是…         │
│ 何時開始  約 30 分鐘前    │ │ 病人 胸口很悶…           │
│ 嚴重度    — 尚未取得      │ │ 規則 請現在就撥打 119…   │
│ 由程式產生（未經 AI）     │ └─────────────────────────┘
└─────────────────────────┘ ┌ 工具追蹤 ──────────────┐
┌ 轉交單 ─────────────────┐ │ （同病人端追蹤列）       │
│ [▲緊急] T-…  原因 [標記已處理]│ └─────────────────────────┘
└─────────────────────────┘
┌ 審閱 ── 備註（選填）[……………………] [標記已審閱] ┐
```

- 960px 以上兩欄（左 1.1fr 摘要＋轉交單；右 1fr 對話＋追蹤），以下單欄、順序同上。
- 「標記已審閱」只在 `submitted`／`red_flag` 時可按；完成後按鈕換成「王醫師 已審閱・14:20」＋備註。
- 未取得欄位以「— 尚未取得」呈現（次要色），不留空白、不寫「null」。

### 10.10 安全界線頁

- 標題＋盾牌圖示；六張卡片（自動換欄，最小 260px）：編號方塊（主色淡底）＋標題＋一句說明＋「怎麼做到」小標籤（固定文字・不經模型／程式規則／輸出檢查／程式計算／追蹤紀錄／保留 14 天）。
- 評測結果卡：執行時間、模型、總題數；每類一列「名稱｜進度條｜18／20・90%」。進度條只用主色，**不因分數低變紅**；數字永遠以文字顯示。`EvalSummary` 為 null 時顯示「尚未執行評測」。
- 類別名稱：intake 問診完整度、red_flag 紅旗偵測、refill 慢箋檢核、out_of_scope 範圍外問題、boundary 越界指令。

## 11. 元件狀態

| 元件 | 空白 | 載入 | 串流／進行中 | 錯誤 | 極端資料 |
|---|---|---|---|---|---|
| 對話 | 只有固定開場訊息＋輸入框提示 | 建立 visit 時三行骨架 | AI 泡泡內文字逐段出現＋游標；`aria-busy="true"`；送出鈕停用 | `run.failed`：顯示固定 `notice` 訊息（琥珀提示框），輸入框保持可用；額度用完時說明紅旗與慢箋仍可用 | 1,000 字訊息：泡泡內換行，長網址 `overflow-wrap:anywhere`；字數計 `987／1,000`，超過時送出停用並說明 |
| 工具追蹤 | 「還沒有工具呼叫。開始對話後，每一步都會列在這裡。」 | 骨架三列 | 新列直接加在底部，不動畫；`tool.started` 未完成時狀態顯示「執行中…」 | `error` 列（琥珀）＋展開看原因 | 工具名稱單行截斷；JSON 換行；40 列以上照常捲動 |
| 摘要 | 「問診完成後，這裡會出現給醫師的摘要。目前已整理 3／11 項。」 | 骨架 | `summary.updated` 到達時整塊替換 | 產生失敗：提示框＋「改用目前內容送出」 | 每個未取得欄位顯示「— 尚未取得」；300 字摘要不截斷 |
| 慢箋 | 表單（無結果） | 「檢核」按鈕內顯示「檢核中…」並停用 | — | 422：逐欄琥珀錯誤；網路錯誤：提示框＋重試 | 日期磚數字不截斷；理由 5 條以上照常列出 |
| 醫師清單 | 「目前沒有預問診。」／篩選無結果：「沒有符合的資料，清除篩選」 | 5 列骨架 | — | 401 轉登入頁；其他錯誤提示框＋重試 | 200 筆：分頁載入；主訴 null；轉交單 0 顯示「—」；計數 1 時「1 張」（中文不用複數，英文要 `1 ticket`／`2 tickets`） |
| 登入 | — | 按鈕「登入中…」 | — | 帳密錯誤：「帳號或密碼不正確」（琥珀，欄位下方）；限速：「嘗試太多次，請 1 分鐘後再試」 | — |

**中英混排**：藥名、數值、單位原樣保留（`Metformin 500mg`、`HbA1c 7.9%`、`37.8°C`）；英文介面下中文資料仍以 `lang` 正確的字型顯示（訊息內容不翻譯）。英文介面字串平均比中文長 1.5–2 倍：按鈕寬度隨內容、不設固定寬；分頁列 12px 字在 390px 寬下仍放得下「Chat / Trace / Summary / Refill」。

## 12. 文案語氣

原則：像櫃台人員說話。先說結果，再說原因，再說下一步。用「您」（病人端）；醫師端用中性短句。不說「親愛的」「哦」「呢」，不加驚嘆號，不用 emoji。AI 不說「我認為您可能是…」。

| 情境 | zh-TW | en |
|---|---|---|
| 揭露橫幅 | AI 預問診助理，不是醫師。不做診斷、不開藥。請勿輸入真實病歷或個資。 | AI pre-visit assistant, not a doctor. No diagnosis, no prescriptions. Please don't enter real medical records or personal details. |
| 輸入框提示 | 請描述您的狀況 | Describe how you're feeling |
| 結束並送出 | 結束並送出 | Finish and send |
| 送出確認 | 送出後就不能再修改。要把目前的內容交給醫師嗎？ | You can't edit after sending. Send what you have to the doctor? |
| 送出完成 | 已交給醫師。看診時醫師會先看過這份摘要。 | Sent. Your doctor will read this summary before your visit. |
| 緊急標題 | 請立即就醫 | Get medical help now |
| 緊急內文 | 您描述的症狀可能很危急。請馬上撥打 119，或請身邊的人陪您到最近的急診。不要自己開車。 | Your symptoms may be serious. Call 119 now, or have someone take you to the nearest emergency room. Don't drive yourself. |
| 自傷 | 您不是一個人。現在就可以打 1925 安心專線，24 小時都有人接。 | You're not alone. Call the 1925 Hotline now — someone answers 24 hours a day. |
| 暫停後 | 這次預問診已暫停，訊息不會再送給 AI。 | This pre-visit check is paused. Messages won't be sent to the AI. |
| 慢箋 too_early | 還不能領，12 月 2 日起可領 | Not yet — you can refill from 2 December |
| 慢箋 consult | 這次需要藥師或醫師確認 | A pharmacist or doctor needs to check this |
| 慢箋 revisit | 慢箋已到期，請回診 | This prescription has expired. Please book a visit. |
| 越界請求 | 我不能開藥或建議劑量。我已經把您的需求記下來，看診時醫師會跟您討論。 | I can't prescribe or suggest doses. I've noted your request so your doctor can discuss it with you. |
| 範圍外 | 這個問題我沒辦法回答。我只負責整理看診前的資料和檢核慢箋，我們繼續剛才的問題好嗎？ | I can't help with that. I only collect pre-visit information and check refills. Shall we continue? |
| 額度用完 | AI 暫時無法回覆。紅旗檢查與慢箋檢核仍可使用，您也可以按「結束並送出」。 | The AI can't reply right now. Safety checks and refill checks still work, or you can finish and send. |
| 追蹤空白 | 還沒有工具呼叫。開始對話後，每一步都會列在這裡。 | No tool calls yet. Each step will appear here once you start. |
| 醫師清單空白 | 目前沒有預問診。 | No pre-visit checks yet. |
| 審閱完成 | 已標記為已審閱 | Marked as reviewed |
| 登入失敗 | 帳號或密碼不正確 | Incorrect username or password |

用詞表（固定譯法）：預問診 pre-visit check；慢箋（慢性病連續處方箋）refill／chronic prescription；轉交單 handoff ticket；紅旗 red flag；工具追蹤 tool trace；給醫師的摘要 summary for your doctor／clinician summary；已攔下 blocked；備援 fallback；健保卡 NHI card。

## 13. 無障礙

- **焦點**：`:focus-visible` 2px `--color-focus` 外框、外推 2px；輸入框改用雙層 box-shadow（內層表面色、外層焦點色），在主色淡底與緊急淡底上都 ≥3:1。不得 `outline: none` 而不補替代樣式。Windows 高對比模式改用 `CanvasText`。
- **對話 live region**：訊息列表 `role="log" aria-live="polite" aria-relevant="additions"`。串流時**不要**把每個 delta 塞進 live region——串流泡泡設 `aria-busy="true"`，`message.completed` 時才移除，讓報讀器一次念完整句。紅旗用緊急卡片的 `role="alert"`；工具追蹤不設 live region（太吵），只在分頁標籤上更新數字。
- **觸控目標**：所有可點元素 ≥ 44×44px（`--touch-min`）；分頁列 56px 高；緊急撥號 56px 高。篩選鈕 36px 高但左右間距 8px，整列命中區合計仍符合 WCAG 2.2 目標尺寸（24px 最低）。
- **鍵盤順序**：跳到主要內容 → 標頭（品牌、語言、主題）→ 橫幅連結 →（緊急卡片的 119、1925）→ 對話記錄 → 輸入框 → 送出 → 結束並送出 → 右側分頁（左右方向鍵切換，roving tabindex）→ 分頁內容。手機分頁列在 DOM 最後。Enter 送出、Shift+Enter 換行；輸入法選字中（`isComposing`）按 Enter **不可送出**。
- **分頁**：`role="tablist"`／`tab`／`tabpanel`，`aria-selected`、`aria-controls`；方向鍵切換、Home／End 到頭尾。
- **表單**：每個欄位有 `<label>`；分組用 `fieldset`＋`legend`；錯誤 `aria-invalid="true"`＋`aria-describedby`。
- **語言**：`<html lang>` 跟著介面切換；英文文案片段加 `lang="en"`。
- **縮放**：200% 縮放時版面不出現水平捲軸（已用 `minmax(0,1fr)`、`min-width:0`、`overflow-wrap:anywhere`）。
- **色彩之外的提示**：所有狀態都有圖示＋文字；慢箋四結果另有外框形狀。

## 14. 給前端工程師

- **引入順序**：`tokens.css` → `base.css` → 元件樣式。元件只用語意 token，不寫死 hex。
- **主題**：`<html data-theme="light|dark">`；沒有屬性時跟系統。使用者選擇存 `localStorage('pv-theme')`，包在 try/catch 裡。
- **類別命名**：設計稿用扁平 BEM（`.block__element--modifier`），例如 `.rcard--too-early`、`.trace-row__name`、`.call-btn--119`。用 CSS Modules 或其他方式都可以，但修飾詞沿用 API 的值（`eligible`／`too-early`／`revisit`／`consult`；`code`／`model`／`form`；`ok`／`rejected`／`error`；`urgent`／`soon`／`routine`），方便對照。
- **元件清單**：AppHeader、AiBanner、ThemeToggle、LangSwitch、ChatLog、MessageBubble（patient／assistant／opening／red_flag／refusal／notice）、StreamingCaret、Composer、IntakeProgress、EmergencyCard、PanelTabs／MobileTabBar、TraceList＋TraceRow＋SourceBadge＋StatusLabel＋RunHeader、SummaryView、RefillForm、RefillResultCard、TicketItem、UrgencyBadge、VisitStatus、ClinicianVisitRow、ReviewBox、SafetyBoundaryCard、EvalMeter、EmptyState、Skeleton、Notice。
- **斷點**：900px（單欄↔兩欄）、1180px（面板 380→420px）、960px（醫師詳情兩欄）、700px（醫師清單表格↔卡片）、420px（隱藏中文副標）。
- **所有介面文字**放 `web/src/i18n/locales/`（第 12 節可直接當初稿）。
- 設計稿的 JS 只是示範；分頁的鍵盤操作、`isComposing` 判斷、live region 時機請照第 13 節實作。
