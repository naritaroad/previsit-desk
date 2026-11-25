# 照片來源與授權

網站上的照片全部是真實攝影，取自 Unsplash 的免費素材（非 Unsplash+），沒有 AI 生成影像。逐張於 2026-11-25 檢查，每張的頁面都標示「Free to use under the Unsplash License」。

## 為什麼只用 Unsplash

Pexels 的使用條款（第 5 條）禁止把可辨識的人呈現為患有疾病或正在用藥、禁止暗示人物背書，也禁止把檔案單獨散布（公開 Git 儲存庫就屬於這種情況），所以本專案不使用任何 Pexels 素材。所有照片也避開可辨識的臉：只用場所、物件、手與手臂。

Wikimedia Commons 也查過。台灣醫院內部的檔案解析度過小（約 600 px），藥局與藥袋類檔案多半以特定機構名稱為主體，或帶有電話號碼，會暗示真實機構背書，因此沒有採用。

## Unsplash License 摘要

全文：<https://unsplash.com/license>

- 商用與非商用皆可，不需要取得許可，署名不是必須（本頁仍列出攝影師）。
- 不得把未經大幅修改的圖片拿去銷售。
- 不得把 Unsplash 圖片彙整成類似或競爭的圖庫服務。本專案只放 12 張、縮圖版本，並且做過裁切與調色，用途是網站內容，不構成圖庫。
- 授權頁面沒有談到人物肖像與商標，因此本專案不使用可辨識的臉，也避開可讀的商標與個資。

## 版位對照

| 版位 | 攝影師 | 出處 | 授權 | 原始頁面 |
| --- | --- | --- | --- | --- |
| hero | Ivan Konev | Unsplash | Unsplash License | <https://unsplash.com/photos/zCWrwoD5FdE> |
| pharmacy | Moritz Näf | Unsplash | Unsplash License | <https://unsplash.com/photos/Er_AaM8-BLo> |
| medicine_table | Laurynas Me | Unsplash | Unsplash License | <https://unsplash.com/photos/1TL8AoEDj_c> |
| bp_home | Mockup Graphics | Unsplash | Unsplash License | <https://unsplash.com/photos/i1iqQRLULlg> |
| clinic_corridor | Tasha Kostyuk | Unsplash | Unsplash License | <https://unsplash.com/photos/Pk-KuizxQv8> |
| waiting | Adhitya Sibikumar | Unsplash | Unsplash License | <https://unsplash.com/photos/2d3cHa8RMSY> |
| consultation | Olena Kholina | Unsplash | Unsplash License | <https://unsplash.com/photos/MhqUBTxQ3Hw> |
| notes_hand | Hannah Olinger | Unsplash | Unsplash License | <https://unsplash.com/photos/8eSrC43qdro> |
| doctor_desk | Vitaly Gariev | Unsplash | Unsplash License | <https://unsplash.com/photos/FQQoUPVb_1c> |
| herbarium_or_paper | Tasha Kostyuk | Unsplash | Unsplash License | <https://unsplash.com/photos/JV9lwBaS6_o> |
| nature_calm | Lesly Juarez | Unsplash | Unsplash License | <https://unsplash.com/photos/58-iZiXTwNA> |
| city_taiwan | Lennon Cheng | Unsplash | Unsplash License | <https://unsplash.com/photos/Qtg_zPrrB3A> |

## 處理方式

- 裁切：waiting、notes_hand、herbarium_or_paper、city_taiwan 原圖為直式或正方形，裁成橫式。
- 調色（12 張統一）：先做半強度的灰世界白平衡校正，再加上偏暖的中性偏移（紅 ×1.02、藍 ×0.97），飽和度降低 12%。目的是讓不同攝影師的照片看起來像同一組。
- 輸出：AVIF 與 WebP，寬度 640、1280、1920（hero 另有 2400），移除 EXIF；每張 1280 WebP 都在 160 KB 以內。
- 原檔保存在專案外，不進 Git。

## 已知限制

- pharmacy 是東京淺草寺的籤詩抽屜（御神籤），不是藥局，只當作藥櫃抽屜的質感圖；替代文字如實描述為舊木抽屜。
- consultation 的桌上有一份印好的英文表單，字小到無法閱讀；拍攝地為舊金山，不是診間。
- bp_home 是白底的去背風格照片，氛圍偏商品圖，不是居家場景。
- city_taiwan 看得到街邊招牌上的中文店名，都是一般店家，不是醫療機構。
- clinic_corridor 的牆上有小字房號（B305），不含個資。
- 台灣場景只有 city_taiwan 一張；其餘以不帶地域特徵的物件與室內為主。
