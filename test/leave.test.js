/* 假別計算測試：node test/leave.test.js */
'use strict';
const assert = require('assert');
const L = require('../js/leave.js');

// 年資級距
assert.strictEqual(L.entitlementDays(0), 3);
assert.strictEqual(L.entitlementDays(1), 7);
assert.strictEqual(L.entitlementDays(2), 10);
assert.strictEqual(L.entitlementDays(3), 14);
assert.strictEqual(L.entitlementDays(4), 14);
assert.strictEqual(L.entitlementDays(5), 15);
assert.strictEqual(L.entitlementDays(9), 15);
assert.strictEqual(L.entitlementDays(10), 16);
assert.strictEqual(L.entitlementDays(24), 30);
assert.strictEqual(L.entitlementDays(40), 30);

// 期間
assert.strictEqual(L.periodAt('2026-03-01', '2026-08-31').days, 0);          // 未滿半年
assert.deepStrictEqual(L.periodAt('2026-03-01', '2026-09-01').days, 3);      // 剛滿半年
assert.strictEqual(L.periodAt('2026-03-01', '2027-02-28').days, 3);
assert.strictEqual(L.periodAt('2026-03-01', '2027-03-01').days, 7);
assert.strictEqual(L.periodAt('2020-01-15', '2026-09-13').k, 6);
assert.strictEqual(L.periodAt('2020-01-15', '2026-09-13').days, 15);
assert.strictEqual(L.periodAt('2015-06-30', '2026-09-13').days, 17);        // 11 年 → 15+2
assert.strictEqual(L.addMonths('2024-02-29', 12), '2025-02-28');
assert.strictEqual(L.periodAt('2023-12-31', '2024-06-30').days, 3);         // 加半年 → 2024-06-30

// 特休使用與剩餘
const st = L.specialStatus({ hireDate: '2025-01-01', specialDates: ['2026-02-10', '2026-03-05', '2026-09-20'], atDate: '2026-09-30' });
assert.strictEqual(st.days, 7);
assert.strictEqual(st.used, 3);       // 期間 2026-01-01～2026-12-31
assert.strictEqual(st.remaining, 4);
assert.strictEqual(L.specialAvailableOn({ hireDate: '2025-01-01', specialDates: ['2026-02-10', '2026-03-05', '2026-09-20'], date: '2026-09-20' }), 5);
assert.strictEqual(L.specialAvailableOn({ hireDate: '2026-06-01', specialDates: [], date: '2026-09-20' }), 0);
assert.strictEqual(L.specialStatus({ hireDate: 'bad', specialDates: [], atDate: '2026-09-30' }), null);

// 補休：假日 +1（入職前、啟用前不計）、加班 +1、使用 -1、不得預支
const base = { hireDate: '2026-09-15', holidayDates: ['2026-01-01', '2026-09-10', '2026-09-28', '2026-10-10'], overtimeDates: ['2026-10-03'], compDates: ['2026-10-05'] };
assert.strictEqual(L.compStatus(Object.assign({ atDate: '2026-09-30' }, base)).earned, 1);      // 只有 9/28
assert.strictEqual(L.compStatus(Object.assign({ atDate: '2026-10-31' }, base)).earned, 3);      // 9/28、10/3 加班、10/10
assert.strictEqual(L.compStatus(Object.assign({ atDate: '2026-10-31' }, base)).remaining, 2);
assert.strictEqual(L.compAvailableOn(Object.assign({ date: '2026-09-28' }, base)), 0);          // 假日當天不可用
assert.strictEqual(L.compAvailableOn(Object.assign({ date: '2026-09-29' }, base)), 1);
assert.strictEqual(L.compAvailableOn(Object.assign({ date: '2026-10-05' }, base)), 2);          // 9/28 + 10/3 加班
assert.strictEqual(L.compAvailableOn(Object.assign({ date: '2026-10-06' }, base)), 1);          // 10/5 用掉一天
// 未設入職日：假日仍計（啟用日起）
assert.strictEqual(L.compStatus({ hireDate: null, holidayDates: ['2026-08-01', '2026-09-28'], atDate: '2026-12-31' }).earned, 1);

console.log('ALL LEAVE TESTS PASSED');
