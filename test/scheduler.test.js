/* 排班演算法測試：node test/scheduler.test.js */
'use strict';
const assert = require('assert');
const S = require('../js/scheduler.js');

function names(n) { return Array.from({ length: n }, (_, i) => 'e' + (i + 1)); }
function isWed(y, m, d) { return S.isFixedOff(y, m, d); }

function checkHard(res, opts, label) {
  const D = S.daysInMonth(opts.year, opts.month);
  const v = S.validate({ year: opts.year, month: opts.month, roster: opts.roster, cells: res.cells, perDay: opts.perDay, closedDays: opts.closedDays, prev: opts.prev });
  const hard = v.issues.filter(i => i.type === 'streak' || i.type === 'fixedOff' || i.type === 'hours');
  assert.strictEqual(hard.length, 0, label + ': hard violations ' + JSON.stringify(hard.map(i => i.message)));
  for (const e of opts.roster) {
    const pr = (opts.prefs && opts.prefs[e]) || {};
    for (let d = 1; d <= D; d++) {
      if (pr[d]) assert.strictEqual(res.cells[e][d], pr[d], label + ': pref not respected ' + e + ' ' + d);
      if (isWed(opts.year, opts.month, d) || (opts.closedDays || []).includes(d)) assert.strictEqual(res.cells[e][d], 'R', label + ': fixed-off not rest');
      assert.ok(['W', 'R', 'S', 'C'].includes(res.cells[e][d]), label + ': bad cell');
    }
  }
  return v;
}

let t0 = Date.now();

// 1. 三人、九月、無偏好 → 2 人/日、無違規、不超過 160 小時
{
  const opts = { year: 2026, month: 9, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'sept-3');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'sept-3 shortages ' + JSON.stringify(res.shortages));
  assert.ok(!v.issues.some(i => i.type === 'weekOver'), 'weekOver must not be reported');
  const works = Object.values(v.stats).map(s => s.W);
  assert.ok(Math.max(...works) - Math.min(...works) <= 1, 'sept-3 balance ' + works);
  console.log('sept-3 OK work=', works, 'cost=', res.cost);
}

// 2. 跨月連續上班
{
  const nov = { year: 2026, month: 11, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null };
  const novRes = S.generate(nov);
  novRes.cells.e1[25] = 'R'; novRes.cells.e1[26] = 'R';
  for (let d = 27; d <= 30; d++) novRes.cells.e1[d] = 'W';
  // 維持 e1 在 11 月出勤 ≤ 16 天（避免製造 160 小時違規）
  let wc = 0; for (let d = 1; d <= 30; d++) if (novRes.cells.e1[d] === 'W') wc++;
  for (let d = 1; d <= 24 && wc > 16; d++) if (novRes.cells.e1[d] === 'W') { novRes.cells.e1[d] = 'R'; wc--; }
  const dec = { year: 2026, month: 12, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: { year: 2026, month: 11, cells: novRes.cells } };
  const decRes = S.generate(dec);
  checkHard(decRes, dec, 'dec-cross');
  assert.strictEqual(decRes.cells.e1[1], 'R', 'e1 must rest on 12/1 after 4-day streak');
  decRes.cells.e1[1] = 'W';
  const v = S.validate({ year: 2026, month: 12, roster: names(3), cells: decRes.cells, perDay: 2, prev: dec.prev });
  assert.ok(v.issues.some(i => i.type === 'streak' && i.employee === 'e1'), 'cross-month streak detected');
  console.log('cross-month OK');
}

// 3. 週期（2026-10-05 起每 28 天）出勤上限 16 天：週期前的日子不計；跨月合併
{
  const roster = names(4);
  const blank = (D) => { const c = {}; for (const e of roster) { c[e] = {}; for (let d = 1; d <= D; d++) c[e][d] = 'R'; } return c; };
  // 10/1~10/4 上 4 天（週期前，不計）+ 週期 0（10/5~10/31）上 16 天 → 不違規
  let cells = blank(31), n = 0;
  for (let d = 1; d <= 4; d++) cells.e1[d] = 'W';
  for (let d = 5; d <= 31 && n < 16; d++) { if (isWed(2026, 10, d) || d % 5 === 0) continue; cells.e1[d] = 'W'; n++; }
  let v = S.validate({ year: 2026, month: 10, roster, cells, perDay: 2 });
  assert.ok(!v.issues.some(i => i.type === 'hours'), 'exactly 16 in cycle must pass: ' + JSON.stringify(v.issues.map(i => i.message)));
  // 再加 1 天 → 17 → 違規
  for (let d = 5; d <= 31; d++) if (cells.e1[d] === 'R' && !isWed(2026, 10, d)) { cells.e1[d] = 'W'; break; }
  v = S.validate({ year: 2026, month: 10, roster, cells, perDay: 2 });
  const h = v.issues.filter(i => i.type === 'hours' && i.employee === 'e1');
  assert.strictEqual(h.length, 1, 'cycle overflow expected');
  assert.ok(h[0].message.includes('10/5～11/1') && h[0].message.includes('170'), 'cycle message ' + h[0].message);
  // 跨月：10 月週期 0 上 16 天，11/1（仍屬週期 0）再上 1 天 → 11 月驗證回報
  cells = blank(31); n = 0;
  for (let d = 5; d <= 31 && n < 16; d++) { if (isWed(2026, 10, d) || d % 5 === 0) continue; cells.e1[d] = 'W'; n++; }
  const nov = blank(30); nov.e1[1] = 'W';
  const v2 = S.validate({ year: 2026, month: 11, roster, cells: nov, perDay: 2, prev: { year: 2026, month: 10, cells } });
  assert.ok(v2.issues.some(i => i.type === 'hours' && i.employee === 'e1'), 'cross-month cycle detected');
  // 11/2 屬週期 1，不受影響
  const nov2 = blank(30); nov2.e1[2] = 'W';
  const v3 = S.validate({ year: 2026, month: 11, roster, cells: nov2, perDay: 2, prev: { year: 2026, month: 10, cells } });
  assert.ok(!v3.issues.some(i => i.type === 'hours'), 'new cycle starts 11/2');
  // 生成器：10 月三人，週期 0 內每人 ≤ 16
  const g = S.generate({ year: 2026, month: 10, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null });
  const vg = S.validate({ year: 2026, month: 10, roster: names(3), cells: g.cells, perDay: 2 });
  assert.ok(!vg.issues.some(i => i.type === 'hours'), 'generator respects cycle cap');
  for (const e of names(3)) { let c = 0; for (let d = 5; d <= 31; d++) if (g.cells[e][d] === 'W') c++; assert.ok(c <= 16, e + ' cycle count ' + c); }
  console.log('cycle OK, october shortages', JSON.stringify(g.shortages));
}

// 4. 人手不足（2 人）→ 缺人必須優先落在週二、週四，且無硬性違規
{
  const opts = { year: 2026, month: 10, roster: names(2), prefs: {}, balances: {}, perDay: 2, prev: null };
  const res = S.generate(opts);
  checkHard(res, opts, 'short-2');
  const days = Object.keys(res.shortages).map(Number);
  assert.ok(days.length > 0, 'expected shortages with 2 staff');
  const onPref = days.filter(d => [2, 4].includes(S.weekday(2026, 10, d))).length;
  console.log('short-2 shortage days =', days.length, 'on Tue/Thu =', onPref);
  assert.ok(onPref >= Math.ceil(days.length * 0.7), 'most shortages should be on Tue/Thu');
}

// 5. 休診日（國定假日休診）→ 全員休息，不計出勤需求
{
  const opts = { year: 2026, month: 10, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null, closedDays: [10] };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'closed');
  assert.ok(!v.issues.some(i => i.type === 'shortage' && i.day === 10), 'closed day must not be a shortage');
  console.log('closed day OK');
}

// 6. 偏好（休息、特休、補休）+ 結餘
{
  const roster = names(4);
  const prefs = { e1: { 1: 'R', 3: 'R', 5: 'R', 8: 'S', 10: 'C' }, e2: { 20: 'R' }, e3: { 6: 'S' } };
  const opts = { year: 2026, month: 9, roster, prefs, balances: { e4: 3 }, perDay: 2, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'prefs');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'prefs shortages ' + JSON.stringify(res.shortages));
  assert.strictEqual(v.stats.e1.C, 1, 'comp pref kept');
  console.log('prefs OK', Object.fromEntries(Object.entries(v.stats).map(([k, s]) => [k, `W${s.W} R${s.R} S${s.S} C${s.C}`])));
}

// 7. 多月連續（結餘收斂、週期跨月）
{
  const roster = names(5);
  let prev = null;
  const balances = {};
  let y = 2026, m = 9;
  for (let k = 0; k < 6; k++) {
    const prefs = {};
    const rng = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(k + 7);
    for (const e of roster) {
      prefs[e] = {};
      for (let d = 1; d <= S.daysInMonth(y, m); d++) {
        if (isWed(y, m, d)) continue;
        const r = rng();
        if (r < 0.06) prefs[e][d] = 'R'; else if (r < 0.08) prefs[e][d] = 'S';
      }
    }
    const opts = { year: y, month: m, roster, prefs, balances: Object.assign({}, balances), perDay: 2, prev };
    const res = S.generate(opts);
    const v = checkHard(res, opts, 'multi-' + k);
    assert.strictEqual(Object.keys(res.shortages).length, 0, 'multi-' + k + ' shortages ' + JSON.stringify(res.shortages));
    const rd = S.restDeltas(res.cells, roster, S.daysInMonth(y, m));
    for (const e of roster) balances[e] = (balances[e] || 0) + rd.deltas[e];
    prev = { year: y, month: m, cells: res.cells };
    const nx = S.nextMonthOf(y, m); y = nx.year; m = nx.month;
  }
  const bal = Object.values(balances);
  assert.ok(Math.max(...bal) - Math.min(...bal) <= 2.5, 'balances should converge: ' + bal.map(b => b.toFixed(1)));
  console.log('multi OK balances', bal.map(b => b.toFixed(2)));
}

// 8. 加班視為出勤：連續與時數皆計入；上班人數超過需求只看一般上班
{
  const roster = names(3);
  const cells = {};
  for (const e of roster) { cells[e] = {}; for (let d = 1; d <= 30; d++) cells[e][d] = 'R'; }
  for (let d = 3; d <= 6; d++) cells.e1[d] = 'W';   // 四、五、六、日
  cells.e1[7] = 'O';                                // 週一加班 → 連 5 天
  const v = S.validate({ year: 2026, month: 9, roster, cells, perDay: 2 });
  assert.ok(v.issues.some(i => i.type === 'streak' && i.employee === 'e1'), 'overtime counts toward streak');
  console.log('overtime OK');
}

// 9. 決定性
{
  const opts = { year: 2026, month: 10, roster: names(5), prefs: {}, balances: {}, perDay: 2, prev: null, attempt: 0 };
  assert.deepStrictEqual(S.generate(opts).cells, S.generate(opts).cells, 'deterministic');
  console.log('deterministic OK');
}

console.log('ALL SCHEDULER TESTS PASSED in', Date.now() - t0, 'ms');
