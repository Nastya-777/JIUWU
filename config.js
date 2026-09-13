/*
 * 久吾動物醫院排班表 — 設定檔
 *
 * storage:
 *   'local'    資料只保存在這台裝置的瀏覽器（預設）。
 *   'firebase' 所有開啟此網頁的人共用同一份資料（需先建立 Firebase Realtime Database，見 README）。
 */
window.JIUWU_CONFIG = window.JIUWU_CONFIG || {
  storage: 'local',
  firebase: {
    // 例如：'https://jiuwu-schedule-default-rtdb.asia-southeast1.firebasedatabase.app'
    databaseURL: '',
    // 資料在資料庫中的存放路徑，可自訂一段不易猜到的名稱
    path: 'jiuwu_schedule'
  }
};
