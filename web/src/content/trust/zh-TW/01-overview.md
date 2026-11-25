---
title: 總覽
summary: PreVisit Desk 做什麼、不做什麼、由誰負責，以及發現問題時怎麼告訴我們。
version: "2.0"
effective: 2026-11-25
owner: naritaroad（專案作者）
reviewer: 未經外部臨床審查
next_review: 2027-02-25
---

PreVisit Desk 診前助理是一套課堂展示用的診所服務。病人在看診前用文字回答幾個問題，系統把回答整理成摘要；醫師讀過原始對話與摘要，自己寫評估與計畫。慢性病連續處方箋（慢箋）的領藥日期由程式計算，續開申請由醫師逐件決定。整個服務由一位作者開發維護，所有病人、醫事人員與藥局都是虛構的。

這裡的十二份文件說明它怎麼運作、哪裡可能出錯、出錯時誰要負責。我們參考的是英國 NHS 對健康資訊系統的兩份臨床風險管理標準：DCB0129 規範製造方，DCB0160 規範導入與使用方（[文獻 15][r15]、[文獻 16][r16]）。參考的意思是借用它的文件種類，例如危害紀錄。本專案沒有臨床安全官，沒有送審，也沒有主張符合其中任何一份。

## 它用來做什麼

這套系統在候診時或看診前幾天，先把主訴、病程、病史、用藥與過敏問一遍，讓醫師進診間前就有一份可以核對的紀錄。慢箋部分回答的是「今天能不能領」這個日期問題，並把需要人判斷的情況交給藥師或醫師。續開申請則把醫師續開前要看的資料備齊。<!-- verify: V-01 續開申請流程已上線且由醫師逐件決定（docs/v2/product.md §5） -->

## 它不做什麼

系統不診斷、不開藥、不給劑量、不建議換藥或停藥，也不判斷病名（C-01，依據：`backend/src/prompt.rs` 的限制段、`backend/src/guard.rs`、`docs/v2/product.md` §10）。它不取代看診，不取代 119，也沒有人在後台二十四小時看著。緊急情況請直接撥 119；有傷害自己的念頭，請撥 1925 安心專線。

系統也沒有連接健保快易通、健康存摺、雲端藥歷或任何醫院的病歷。它知道的只有病人自己輸入的內容，以及示範資料裡的虛構紀錄。

## 誰負責

文件、程式與資料的負責人是作者 naritaroad。沒有任何醫師、藥師或外部單位審查過這些內容（C-02，依據：本頁的審閱者欄位、`data/seed/renewal_protocols.json` 的 `approved_by_note`）。在展示環境裡，「醫師」「藥師」「個案管理師」由示範帳號扮演，按下核准不會產生任何真實的處方或調劑。

如果有人想把它用在真的病人身上，責任的安排會完全不同：要有醫療機構承接，要有具執業資格的人核對規則與協定，要換掉現在這個條款不允許臨床使用的模型方案，還要重做評測。這些條件寫在「預定用途」與「法規對應」兩頁。

## 怎麼提出疑慮

對內容、規則或用語有意見，請到專案的 [GitHub Issues](https://github.com/naritaroad/previsit-desk/issues) 開一則，並附上頁面名稱和主張編號（例如 C-05）。資安問題請依 [SECURITY.md](https://github.com/naritaroad/previsit-desk/blob/main/SECURITY.md) 私下通報。兩個管道都請不要貼真實的病歷、姓名或對話內容。處理時間見「事件通報與更正」。

## 怎麼讀這些文件

每頁開頭標出版本、生效日、負責人與下次檢視日。可以查證的句子後面有編號，從 C-01 排到 C-41，括號裡是檔案路徑或文獻；路徑都在公開的程式庫裡，文獻清單在「參考文獻與變更紀錄」。規則數、評測結果、模型名稱這類會變的數字，由伺服器即時填入：目前版本是 {{facts.app_version}}，紅旗規則 {{facts.red_flag_rules}} 條，評測 {{facts.eval_passed}}／{{facts.eval_total}}（{{facts.eval_date}}）。<!-- verify: V-02 /trust/facts 會回傳這些欄位（docs/v2/contract.md §7） -->

「沒做到」的事也寫在裡面。想先看弱點，可以直接讀「臨床安全」的已知漏網例、「資安」的已知缺口，以及「評測與證據」裡數字不能說明的部分。

[r15]: https://standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems
[r16]: https://standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-deployment-and-use-of-health-it-systems
