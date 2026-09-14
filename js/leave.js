/*
 * 久吾動物醫院排班表 — 假別計算（特休年資、補休帳）
 * 純函式，瀏覽器（window.Leave）與 Node 皆可使用。日期一律為 'YYYY-MM-DD' 字串。
 *
 * 特休（台灣勞基法第 38 條）：
 *   滿六個月未滿一年 3 天；一年以上未滿兩年 7 天；兩年以上未滿三年 10 天；
 *   三年以上未滿五年 14 天；五年以上未滿十年 15 天；十年以上每年加給 1 天，最多 30 天。
 *   每個年資期間（週年日到下一個週年日）重新給假，期間內未用完的不累計。
 *
 * 補休：
 *   每經過一個國定假日 +1 天（入職前、系統啟用前的假日不計）；每一天加班 +1 天。
 *   使用補休 -1 天；未使用的補休一直保留。補休只能在取得之後使用，不得預支。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Leave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var START_DATE = '2026-09-01';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { y: y, m: mo, d: d };
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function fmt(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function addMonths(s, n) {
    var p = parse(s);
    if (!p) return null;
    var total = p.y * 12 + (p.m - 1) + n;
    var y = Math.floor(total / 12), m = total - y * 12 + 1;
    var d = Math.min(p.d, daysInMonth(y, m));
    return fmt(y, m, d);
  }
  function isValid(s) { return !!parse(s); }

  function entitlementDays(k) {
    if (k < 0) return 0;
    if (k === 0) return 3;
    if (k === 1) return 7;
    if (k === 2) return 10;
    if (k <= 4) return 14;
    if (k <= 9) return 15;
    return Math.min(30, 15 + (k - 9));
  }

  // 某日所屬的特休年資期間
  function periodAt(hireDate, date) {
    if (!isValid(hireDate) || !isValid(date)) return null;
    var half = addMonths(hireDate, 6);
    if (date < half) return { k: -1, start: null, end: half, days: 0 };
    var one = addMonths(hireDate, 12);
    if (date < one) return { k: 0, start: half, end: one, days: entitlementDays(0) };
    var k = 1;
    while (addMonths(hireDate, 12 * (k + 1)) <= date) k++;
    return { k: k, start: addMonths(hireDate, 12 * k), end: addMonths(hireDate, 12 * (k + 1)), days: entitlementDays(k) };
  }

  // 截至 atDate（含）的特休狀態
  function specialStatus(o) {
    var p = periodAt(o.hireDate, o.atDate);
    if (!p) return null;
    var used = 0;
    (o.specialDates || []).forEach(function (s) {
      if (p.start && s >= p.start && s < p.end && s <= o.atDate) used++;
    });
    return { days: p.days, used: used, remaining: p.days - used, period: p };
  }
  // 在 date 這天請特休前，還剩幾天可用
  function specialAvailableOn(o) {
    var p = periodAt(o.hireDate, o.date);
    if (!p) return null;
    var used = 0;
    (o.specialDates || []).forEach(function (s) {
      if (p.start && s >= p.start && s < p.end && s < o.date) used++;
    });
    return p.days - used;
  }

  function compEarned(o, before, inclusive) {
    var hire = isValid(o.hireDate) ? o.hireDate : null;
    var n = 0;
    (o.holidayDates || []).forEach(function (h) {
      if (h < START_DATE) return;
      if (hire && h < hire) return;
      if (inclusive ? h <= before : h < before) n++;
    });
    (o.overtimeDates || []).forEach(function (d) {
      if (inclusive ? d <= before : d < before) n++;
    });
    return n;
  }
  function compUsed(o, before, inclusive) {
    var n = 0;
    (o.compDates || []).forEach(function (d) { if (inclusive ? d <= before : d < before) n++; });
    return n;
  }
  // 截至 atDate（含）的補休狀態
  function compStatus(o) {
    var earned = compEarned(o, o.atDate, true), used = compUsed(o, o.atDate, true);
    return { earned: earned, used: used, remaining: earned - used };
  }
  // 在 date 這天請補休前可用的天數（只算 date 之前取得的）
  function compAvailableOn(o) {
    return compEarned(o, o.date, false) - compUsed(o, o.date, false);
  }

  return {
    START_DATE: START_DATE,
    isValid: isValid,
    addMonths: addMonths,
    daysInMonth: daysInMonth,
    entitlementDays: entitlementDays,
    periodAt: periodAt,
    specialStatus: specialStatus,
    specialAvailableOn: specialAvailableOn,
    compStatus: compStatus,
    compAvailableOn: compAvailableOn
  };
});
