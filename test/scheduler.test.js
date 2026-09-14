/* 排班演算法測試（28 天週期）：node test/scheduler.test.js */
'use strict';
const assert = require('assert');
const S = require('../js/scheduler.js');
const PD = S.PERIOD_DAYS;

function names(n) { return Array.from({ length: n }, (_, i) => 'e' + (i + 1)); }
function isWed(idx, d) { return S.periodDates(idx)[d].wd === 3; }
function blank(roster) { const c = {}; for (const e of roster) { c[e] = {}; for (let d = 1; d <= PD; d++) c[e][d] = 'R'; } return c; }

function checkHard(res, opts, label) {
  const v = S.validate({ period: opts.period, roster: opts.roster, cells: res.cells, perDay: opts.perDay, closedDays: opts.closedDays, prev: opts.prev });
  const hard = v.issues.filter(i => i.type === 'streak' || i.type === 'fixedOff' || i.type === 'hours');
  assert.strictEqual(hard.length, 0, label + ': hard violations ' + JSON.stringify(hard.map(i => i.message)));
  for (const e of opts.roster) {
    const pr = (opts.prefs && opts.prefs[e]) || {};
    for (let d = 1; d <= PD; d++) {
      if (pr[d]) assert.strictEqual(res.cells[e][d], pr[d], label + ': pref not respected ' + e + ' ' + d);
      if (isWed(opts.period, d) || (opts.closedDays || []).includes(d)) assert.strictEqual(res.cells[e][d], 'R', label + ': fixed-off not rest');
      assert.ok(['W', 'R', 'S', 'C'].includes(res.cells[e][d]), label + ': bad cell');
    }
  }
  return v;
}

let t0 = Date.now();

// 0. 週期定義
assert.strictEqual(S.periodLabel(0), '2026/9/1～9/28');
assert.strictEqual(S.periodLabel(1), '2026/9/29～10/26');
assert.strictEqual(S.periodLabel(2), '2026/10/27～11/23');
assert.strictEqual(S.periodKey(1), '2026-09-29');
assert.strictEqual(S.periodIndexOfKey('2026-10-26'), 1);
assert.strictEqual(S.periodIndexOfKey('2026-10-27'), 2);
assert.strictEqual(S.periodDates(0)[1].wd, 2);   // 2026-09-01 是週二
console.log('period definitions OK');

// 1. 三人、第 1 週期（9/29～10/26）→ 2 人/日、無違規、每人 16 天
{
  const opts = { period: 1, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'p1-3');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'p1-3 shortages ' + JSON.stringify(res.shortages));
  const works = Object.values(v.stats).map(s => s.W);
  assert.ok(works.every(w => w <= 16), 'period cap ' + works);
  assert.ok(Math.max(...works) - Math.min(...works) <= 1, 'balance ' + works);
  console.log('p1-3 OK work=', works, 'cost=', res.cost);
}

// 2. 跨週期連續上班：上一週期最後 4 天上班 → 下一週期第 1 天必休；驗證能抓到
{
  const roster = names(3);
  const prevCells = blank(roster);
  for (let d = PD - 3; d <= PD; d++) prevCells.e1[d] = 'W';     // 週期 0 最後 4 天（9/25~9/28）
  const opts = { period: 1, roster, prefs: {}, balances: {}, perDay: 2, prev: { period: 0, cells: prevCells } };
  const res = S.generate(opts);
  checkHard(res, opts, 'cross');
  assert.strictEqual(res.cells.e1[1], 'R', 'e1 must rest on first day after 4-day tail');
  res.cells.e1[1] = 'W';
  const v = S.validate({ period: 1, roster, cells: res.cells, perDay: 2, prev: { period: 0, cells: prevCells } });
  assert.ok(v.issues.some(i => i.type === 'streak' && i.employee === 'e1'), 'cross-period streak detected');
  assert.ok(v.flagged['e1:1'], 'flagged');
  const v2 = S.validate({ period: 0, roster, cells: prevCells, perDay: 2, next: { period: 1, cells: res.cells } });
  assert.ok(v2.issues.some(i => i.type === 'streakNext'), 'streakNext detected');
  console.log('cross-period OK');
}

// 3. 週期上限 16 天：17 天 → hours；16 天不提醒
{
  const roster = names(4);
  const cells = blank(roster);
  let n = 0;
  for (let d = 1; d <= PD && n < 16; d++) { if (isWed(1, d) || d % 5 === 0) continue; cells.e1[d] = 'W'; n++; }
  let v = S.validate({ period: 1, roster, cells, perDay: 2 });
  assert.ok(!v.issues.some(i => i.type === 'hours'), '16 must pass');
  for (let d = 1; d <= PD; d++) if (cells.e1[d] === 'R' && !isWed(1, d)) { cells.e1[d] = 'W'; break; }
  v = S.validate({ period: 1, roster, cells, perDay: 2 });
  const h = v.issues.filter(i => i.type === 'hours' && i.employee === 'e1');
  assert.strictEqual(h.length, 1, 'hours issue expected');
  assert.ok(h[0].message.includes('17') && h[0].message.includes('170'), h[0].message);
  console.log('period cap OK');
}

// 4. 人手不足（2 人）→ 缺人優先週二、週四
{
  const opts = { period: 1, roster: names(2), prefs: {}, balances: {}, perDay: 2, prev: null };
  const res = S.generate(opts);
  checkHard(res, opts, 'short-2');
  const days = Object.keys(res.shortages).map(Number);
  assert.ok(days.length > 0, 'expected shortages with 2 staff');
  const onPref = days.filter(d => [2, 4].includes(S.periodDates(1)[d].wd)).length;
  console.log('short-2 shortage days =', days.length, 'on Tue/Thu =', onPref);
  assert.ok(onPref >= Math.ceil(days.length * 0.7), 'most shortages should be on Tue/Thu');
}

// 5. 休診日
{
  const opts = { period: 1, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null, closedDays: [12] };   // 10/10
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'closed');
  assert.ok(!v.issues.some(i => i.type === 'shortage' && i.day === 12), 'closed day must not be a shortage');
  console.log('closed day OK');
}

// 6. 偏好（休息、特休、補休）+ 結餘
{
  const roster = names(4);
  const prefs = { e1: { 1: 'R', 3: 'R', 5: 'R', 8: 'S', 10: 'C' }, e2: { 20: 'R' }, e3: { 6: 'S' } };
  const opts = { period: 1, roster, prefs, balances: { e4: 3 }, perDay: 2, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'prefs');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'prefs shortages ' + JSON.stringify(res.shortages));
  assert.strictEqual(v.stats.e1.C, 1, 'comp pref kept');
  console.log('prefs OK', Object.fromEntries(Object.entries(v.stats).map(([k, s]) => [k, `W${s.W} R${s.R} S${s.S} C${s.C}`])));
}

// 7. 多週期連續（結餘收斂）
{
  const roster = names(5);
  let prev = null;
  const balances = {};
  for (let idx = 0; idx < 6; idx++) {
    const prefs = {};
    const rng = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(idx + 7);
    for (const e of roster) {
      prefs[e] = {};
      for (let d = 1; d <= PD; d++) {
        if (isWed(idx, d)) continue;
        const r = rng();
        if (r < 0.06) prefs[e][d] = 'R'; else if (r < 0.08) prefs[e][d] = 'S';
      }
    }
    const opts = { period: idx, roster, prefs, balances: Object.assign({}, balances), perDay: 2, prev };
    const res = S.generate(opts);
    checkHard(res, opts, 'multi-' + idx);
    assert.strictEqual(Object.keys(res.shortages).length, 0, 'multi-' + idx + ' shortages ' + JSON.stringify(res.shortages));
    const rd = S.restDeltas(res.cells, roster, PD);
    for (const e of roster) balances[e] = (balances[e] || 0) + rd.deltas[e];
    prev = { period: idx, cells: res.cells };
  }
  const bal = Object.values(balances);
  assert.ok(Math.max(...bal) - Math.min(...bal) <= 2.5, 'balances should converge: ' + bal.map(b => b.toFixed(1)));
  console.log('multi OK balances', bal.map(b => b.toFixed(2)));
}

// 8. 加班視為出勤
{
  const roster = names(3);
  const cells = blank(roster);
  // 週期 1：9/29(二) 10/1(四) 10/2(五) 10/3(六) 10/4(日) 10/5(一)
  for (const d of [3, 4, 5, 6]) cells.e1[d] = 'W';   // 10/1~10/4
  cells.e1[7] = 'O';                                  // 10/5 加班 → 連 5 天
  const v = S.validate({ period: 1, roster, cells, perDay: 2 });
  assert.ok(v.issues.some(i => i.type === 'streak' && i.employee === 'e1'), 'overtime counts toward streak');
  console.log('overtime OK');
}

// 9. 決定性
{
  const opts = { period: 2, roster: names(5), prefs: {}, balances: {}, perDay: 2, prev: null, attempt: 0 };
  assert.deepStrictEqual(S.generate(opts).cells, S.generate(opts).cells, 'deterministic');
  console.log('deterministic OK');
}

console.log('ALL SCHEDULER TESTS PASSED in', Date.now() - t0, 'ms');
