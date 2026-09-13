# JIUWU_animal_hospital_schedule

久吾動物醫院自動排班表。純前端網頁程式，電腦與手機瀏覽器皆可直接開啟；搭配 Firebase 後所有人共用同一份資料。

## 一、放到網路上（GitHub Pages）

1. 到 GitHub 倉庫的 **Settings → Pages**。
2. **Source** 選「Deploy from a branch」，Branch 選要發布的分支（例如 `main`），資料夾選 `/ (root)`，按 Save。
3. 約一分鐘後，網址為 `https://<帳號>.github.io/JIUWU/`（例如 `https://nastya-777.github.io/JIUWU/`）。任何人用任何瀏覽器都能開啟。

也可以直接下載整個資料夾，雙擊 `index.html` 在本機使用。

## 二、讓所有人共用同一份資料（Firebase，約 5 分鐘）

未設定時，資料只保存在各自裝置的瀏覽器裡。設定後，所有開啟此網頁的人看到並修改的都是同一份資料，變更即時同步。

1. 用 Google 帳號登入 <https://console.firebase.google.com/>，建立專案（名稱隨意，Google Analytics 可關閉）。
2. 左側 **Build → Realtime Database → Create Database**，位置選 `asia-southeast1`（新加坡）或就近地區，安全規則先選 **Start in test mode**。
3. 建立後，頁面上方會顯示資料庫網址，形如
   `https://xxxx-default-rtdb.asia-southeast1.firebasedatabase.app`。
4. 到 **Rules** 分頁，把規則改成只開放排班資料的路徑（把 `jiuwu_schedule` 換成你自訂、不易猜到的名稱）：

   ```json
   {
     "rules": {
       "jiuwu_schedule": { ".read": true, ".write": true },
       "$other": { ".read": false, ".write": false }
     }
   }
   ```

5. 打開專案裡的 `config.js`，填入：

   ```js
   window.JIUWU_CONFIG = window.JIUWU_CONFIG || {
     storage: 'firebase',
     firebase: {
       databaseURL: 'https://xxxx-default-rtdb.asia-southeast1.firebasedatabase.app',
       path: 'jiuwu_schedule'
     }
   };
   ```

6. 存檔並推送到 GitHub，重新整理網頁。右上角顯示「共用資料庫：已連線」即完成。

注意：這種設定等於「知道網址的人都能讀寫」，適合內部小團隊使用；請不要把網址公開張貼。免費方案的用量對排班表綽綽有餘。

## 三、操作流程

1. **新增員工**：在「員工」區輸入姓名後按「新增員工」；點姓名旁的 ✎ 可改名，× 可刪除。刪除不會影響已生成的往期排班表。
2. **選擇月份**：右上角下拉選單，從 2026 年 9 月開始，每月排班一次。
3. **步驟一・選擇休假（可略過）**：選「休息」或「特休」後，點表格中的日期即可標記；再點一次取消。不選擇則視為服從安排。若某人選的休息天數比平均可休的天數多或少很多，下方會提示。
4. **生成排班表**：按「生成排班表」，程式依規則自動排出當月班表。
5. **步驟二・編輯**：選「上班／休息／特休」後點表格即可修改。
6. **儲存／取消**：「儲存」會永久保留；「取消」會復原到上次儲存的狀態（更早的儲存不受影響）。儲存後仍可再修改。「重新生成」會換一個排法；「重新選擇休假」回到步驟一。
7. **匯出**：用「匯出…」下拉選單選擇 PDF、PNG 或 XLSX。
8. **往期排班表**：用右上角下拉選單翻閱。

## 四、排班規則

| 規則 | 說明 |
| --- | --- |
| 週三固定全員休息 | 顯示為一般休息，計入上四休三。 |
| 每日出勤人數 | 預設 2 人，可在右上角調整。 |
| 連續上班上限 | 任何人在任何時間都不能連續上班超過 4 天，跨月一併計算（例如 9 月底連上 4 天，10 月 1 日就不會排班）。違規處以紅框標示。 |
| 上四休三 | 以週一～週日為一週，每人每週上班盡量不超過 4 天。 |
| 員工預選 | 生成前選好的「休息」與「特休」一定會被尊重。 |
| 特休 | 不計入上四休三：既不算上班，也不算一般休息。 |
| 休息平衡 | 扣除特休後，讓每位員工當月的一般休息天數盡量相同（因此上班天數也盡量相同）。若無法平衡，差額會記為「結餘」帶到下個月：少休的人下個月多排休，多休的人下個月少排休。 |

「結餘」欄：正值代表至今累計多休、下月會少排休；負值則相反。

若員工人數不足以維持上四休三（每日 2 人時至少需 3 位員工），程式仍會遵守「連續上班不超過 4 天」，並以紅字標示出勤不足的日子，供人工調整。

## 五、專案結構

```
index.html          頁面
config.js           設定（本機 / Firebase 共用）
css/style.css       樣式（天藍 + 白，其餘低飽和色）
js/scheduler.js     排班演算法（純函式，Node 也可執行）
js/storage.js       資料儲存層（localStorage / Firebase REST + 即時串流）
js/app.js           介面與匯出
vendor/             html2canvas、jsPDF、SheetJS（PNG / PDF / XLSX 匯出）
test/               演算法測試：npm test
```

---

© 2026 KE FEI. All rights reserved.
