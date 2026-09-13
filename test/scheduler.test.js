/* 排班演算法測試：node test/scheduler.test.js */
'use strict';
const assert = require('assert');
const S = require('../js/scheduler.js');

function names(n) { return Array.from({ length: n }, (_, i) => 'e' + (i + 1)); }

function checkHard(res, opts, label) {
  const D = S.daysInMonth(opts.year, opts.month);
  const v = S.validate({ year: opts.year, month: opts.month, roster: opts.roster, cells: res.cells, perDay: opts.perDay, prev: opts.prev });
  const streak = v.issues.filter(i => i.type === 'streak' || i.type === 'fixedOff');
  assert.strictEqual(streak.length, 0, label + ': hard violations ' + JSON.stringify(streak.map(i => i.message)));
  // prefs respected
  for (const e of opts.roster) {
    const pr = (opts.prefs && opts.prefs[e]) || {};
    for (let d = 1; d <= D; d++) {
      if (pr[d] === 'R') assert.strictEqual(res.cells[e][d], 'R', label + ': pref R not respected ' + e + ' ' + d);
      if (pr[d] === 'S') assert.strictEqual(res.cells[e][d], 'S', label + ': pref S not respected ' + e + ' ' + d);
      if (S.isFixedOff(opts.year, opts.month, d)) assert.strictEqual(res.cells[e][d], 'R', label + ': wednesday not rest');
      assert.ok(['W', 'R', 'S'].includes(res.cells[e][d]), label + ': empty cell');
    }
  }
  return v;
}

let t0 = Date.now();

// 1. 三人、九月、無偏好 → 應完全滿足 2 人/日、無違規、上四休三
{
  const opts = { year: 2026, month: 9, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'sept-3');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'sept-3 shortages');
  const weekOver = v.issues.filter(i => i.type === 'weekOver');
  assert.strictEqual(weekOver.length, 0, 'sept-3 weekOver ' + JSON.stringify(weekOver.map(i => i.message)));
  const st = v.stats;
  const works = Object.values(st).map(s => s.W);
  assert.ok(Math.max(...works) - Math.min(...works) <= 1, 'sept-3 balance ' + works);
  console.log('sept-3 OK  work=', works, 'cost=', res.cost);
}

// 2. 跨月：九月底連續 4 天 → 十月 1 日不可排
{
  const sept = { year: 2026, month: 9, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null };
  // 手動造一個九月：e1 於 27,28,29,30 上班（27=日, 28=一, 29=二, 30=三 是週三…）
  // 2026-09-30 是週三，改用 24,25,26,27 + 28,29 ... 直接構造：e1 在 27,28,29 上班、30 週三全休，所以連續會被週三打斷。
  // 改用 2026-10 → 2026-11：10/31 是週六。e1 於 10/28(三)休、10/29,30,31 上班 + 11/1 → 4 天；讓 e1 從 10/28 起… 週三固定休，所以最多 10/29~10/31 = 3 天。
  // 用 2026-11 → 2026-12：11/30 是週一。e1 於 11/26(四)~11/30(一) 上班 5 天違規；構造 11/27~11/30 = 4 天，12/1 不可排 e1。
  const nov = { year: 2026, month: 11, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: null };
  const novRes = S.generate(nov);
  const D = S.daysInMonth(2026, 11);
  novRes.cells.e1[25] = 'R'; novRes.cells.e1[26] = 'R';
  for (let d = 27; d <= 30; d++) novRes.cells.e1[d] = 'W';
  const dec = { year: 2026, month: 12, roster: names(3), prefs: {}, balances: {}, perDay: 2, prev: { year: 2026, month: 11, cells: novRes.cells } };
  const decRes = S.generate(dec);
  checkHard(decRes, dec, 'dec-cross');
  assert.strictEqual(decRes.cells.e1[1], 'R', 'e1 must rest on 12/1 after 4-day streak');
  // validate 也要抓到跨月違規：把 12/1 硬改成 W
  decRes.cells.e1[1] = 'W';
  const v = S.validate({ year: 2026, month: 12, roster: names(3), cells: decRes.cells, perDay: 2, prev: dec.prev });
  assert.ok(v.issues.some(i => i.type === 'streak' && i.employee === 'e1'), 'cross-month streak detected');
  assert.ok(v.flagged['e1:1'], 'cross-month flagged');
  // 反向：十一月的驗證應看到延伸到十二月
  const v2 = S.validate({ year: 2026, month: 11, roster: names(3), cells: novRes.cells, perDay: 2, next: { year: 2026, month: 12, cells: decRes.cells } });
  assert.ok(v2.issues.some(i => i.type === 'streakNext' && i.employee === 'e1'), 'streakNext detected');
  console.log('cross-month OK');
  void sept; void D;
}

// 3. 偏好 + 特休 + 結餘
{
  const roster = names(4);
  const prefs = { e1: { 3: 'R', 4: 'R', 5: 'R', 10: 'S', 11: 'S' }, e2: { 20: 'R' }, e3: { 1: 'S' } };
  const opts = { year: 2026, month: 9, roster, prefs, balances: { e4: 3 }, perDay: 2, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'prefs');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'prefs shortages ' + JSON.stringify(res.shortages));
  const st = v.stats;
  console.log('prefs OK', Object.fromEntries(Object.entries(st).map(([k, s]) => [k, `W${s.W} R${s.R} S${s.S}`])), 'targets', res.targets);
  // e4 有 +3 結餘（過去多休）→ 本月應比其他人多上班
  assert.ok(st.e4.W >= st.e2.W, 'e4 should work at least as much as e2');
}

// 4. 人手不足（2 人）→ 不能有硬性違規，但允許缺人
{
  const opts = { year: 2026, month: 9, roster: names(2), prefs: {}, balances: {}, perDay: 2, prev: null };
  const res = S.generate(opts);
  checkHard(res, opts, 'short-2');
  assert.ok(Object.keys(res.shortages).length > 0, 'expected shortages with 2 staff');
  console.log('short-2 OK shortages days =', Object.keys(res.shortages).length);
}

// 5. 大量員工、隨機偏好、多月連續（結餘累積）
{
  const roster = names(8);
  let prev = null;
  const balances = {};
  let y = 2026, m = 9;
  for (let k = 0; k < 6; k++) {
    const prefs = {};
    const rng = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(k + 7);
    for (const e of roster) {
      prefs[e] = {};
      for (let d = 1; d <= S.daysInMonth(y, m); d++) {
        const r = rng();
        if (S.isFixedOff(y, m, d)) continue; // 週三固定全休，不可預選
        if (r < 0.06) prefs[e][d] = 'R'; else if (r < 0.08) prefs[e][d] = 'S';
      }
    }
    const opts = { year: y, month: m, roster, prefs, balances: Object.assign({}, balances), perDay: 2, prev };
    const res = S.generate(opts);
    const v = checkHard(res, opts, 'multi-' + k);
    assert.strictEqual(Object.keys(res.shortages).length, 0, 'multi-' + k + ' shortages');
    const rd = S.restDeltas(res.cells, roster, S.daysInMonth(y, m));
    for (const e of roster) balances[e] = (balances[e] || 0) + rd.deltas[e];
    prev = { year: y, month: m, cells: res.cells };
    const nx = S.nextMonthOf(y, m); y = nx.year; m = nx.month;
    console.log('multi-' + k, S.monthKey(opts.year, opts.month), 'cost', res.cost, 'weekOver', v.issues.filter(i => i.type === 'weekOver').length,
      'R=', roster.map(e => v.stats[e].R).join(','));
  }
  const bal = Object.values(balances);
  assert.ok(Math.max(...bal) - Math.min(...bal) <= 2.5, 'balances should converge: ' + bal.map(b => b.toFixed(1)));
  console.log('multi OK balances', bal.map(b => b.toFixed(2)));
}

// 6. 決定性：相同輸入 → 相同輸出；attempt 不同 → 可不同
{
  const opts = { year: 2026, month: 10, roster: names(5), prefs: {}, balances: {}, perDay: 2, prev: null, attempt: 0 };
  const a = S.generate(opts), b = S.generate(opts);
  assert.deepStrictEqual(a.cells, b.cells, 'deterministic');
  console.log('deterministic OK');
}

// 7. perDay = 3，六人
{
  const opts = { year: 2027, month: 2, roster: names(6), prefs: {}, balances: {}, perDay: 3, prev: null };
  const res = S.generate(opts);
  const v = checkHard(res, opts, 'perDay3');
  assert.strictEqual(Object.keys(res.shortages).length, 0, 'perDay3 shortages');
  console.log('perDay3 OK weekOver', v.issues.filter(i => i.type === 'weekOver').length);
}

console.log('ALL TESTS PASSED in', Date.now() - t0, 'ms');
