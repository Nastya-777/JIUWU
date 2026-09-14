/*
 * JIUWU_animal_hospital_schedule — 排班核心演算法（第二版）
 *
 * 純函式、無 DOM 相依，瀏覽器（window.Scheduler）與 Node（module.exports）皆可使用。
 *
 * 規則摘要：
 *  - 每週三固定全員休息；另可指定「休診日」（國定假日休診）同樣全員休息。
 *  - 任何人連續上班不得超過 4 天（跨月連續計算）。
 *  - 每人每天出勤 10 小時；以 2026-10-05（週一）起每 28 天為一個週期，每週期出勤不得超過 16 天（160 小時），
 *    週期跨月時合併計算；2026-10-05 之前的排班不受此限。
 *  - 每日預設 2 人出勤（perDay 可調）；人力不足時，缺人優先落在週二、週四。
 *  - 一週（週一～週日）上班盡量不超過 4 天（軟性）。
 *  - 員工事先選定的「休息」「特休」「補休」必須尊重。
 *  - 特休、補休不計入上四休三：既不算上班，也不算一般休息。
 *  - 加班（O）視為出勤（時數、連續天數），但在休息公平性上視同休息（因已另給補休）。
 *  - 扣除特休、補休後，各員工的一般休息天數盡量相同；差額以「結餘」帶到下月補償。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Scheduler = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CODE = { WORK: 'W', REST: 'R', SPECIAL: 'S', OVERTIME: 'O', COMP: 'C', EMPTY: '' };
  var MAX_STREAK = 4;            // 連續上班上限
  var WEEK_MAX = 4;              // 一週上班上限（軟性）
  var HOURS_PER_DAY = 10;        // 每日出勤時數
  var CYCLE_DAYS = 28;           // 週期天數
  var CYCLE_MAX_WORK = 16;       // 每週期出勤天數上限（160 小時）
  var CYCLE_EPOCH = Math.floor(Date.UTC(2026, 9, 5) / 86400000);   // 週期起算日 2026-10-05（週一）
  var FIXED_OFF_WEEKDAY = 3;     // 週三（0 = 週日）
  var SHORTAGE_PREFERRED = { 2: true, 4: true };  // 缺人優先落在週二、週四
  var START_YEAR = 2026;
  var START_MONTH = 9;

  var COST = {
    shortage: 1000,        // 每日出勤不足 1 人（一般日）
    shortagePreferred: 600, // 每日出勤不足 1 人（週二、週四）
    over: 300,             // 一般上班人數超過需求 1 人
    streak: 500,           // 連續上班超過 4 天，每多 1 天
    cycle: 500,            // 週期內出勤超過 16 天，每多 1 天
    fixedOff: 500,         // 固定休息日有人上班
    weekOver: 40,          // 一週上班超過 4 天，每多 1 天
    deviation: 10,         // 與目標上班天數的差距，每 1 天
    isolated: 1            // 孤立的單日上班 / 單日休息（美觀）
  };

  /* ---------- 日期工具 ---------- */
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function weekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
  function weekIdOf(dn) { return Math.floor((dn + 3) / 7); }   // 以週一為一週開始
  function cycleOf(dn) { return dn < CYCLE_EPOCH ? -1 : Math.floor((dn - CYCLE_EPOCH) / CYCLE_DAYS); }
  function cycleRange(c) {
    var start = CYCLE_EPOCH + c * CYCLE_DAYS, end = start + CYCLE_DAYS - 1;
    var a = new Date(start * 86400000), b = new Date(end * 86400000);
    return { start: start, end: end, text: (a.getUTCMonth() + 1) + '/' + a.getUTCDate() + '～' + (b.getUTCMonth() + 1) + '/' + b.getUTCDate() };
  }
  function isFixedOff(y, m, d) { return weekday(y, m, d) === FIXED_OFF_WEEKDAY; }
  function prevMonthOf(y, m) { return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 }; }
  function nextMonthOf(y, m) { return m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 }; }
  function monthKey(y, m) { return y + '-' + (m < 10 ? '0' : '') + m; }
  function parseMonthKey(key) {
    var p = String(key).split('-');
    return { year: parseInt(p[0], 10), month: parseInt(p[1], 10) };
  }
  function compareMonthKey(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function isWork(c) { return c === CODE.WORK || c === CODE.OVERTIME; }

  /* ---------- 亂數（可重現） ---------- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 上下文 ---------- */
  function getCell(cells, e, d) {
    var row = cells && cells[e];
    return (row && row[d]) || CODE.EMPTY;
  }

  // 前一個月：月底連續上班天數、落在本月第一週的上班天數、落在本月第一個週期內的出勤天數
  function tailInfo(prev, roster, year, month) {
    var streak = {}, weekWork = {}, prevCycleWork = {};
    var firstWeek = weekIdOf(dayNumber(year, month, 1));
    var firstCycle = cycleOf(dayNumber(year, month, 1));
    var i, e;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      streak[e] = 0; weekWork[e] = 0; prevCycleWork[e] = 0;
    }
    if (!prev || !prev.cells) return { streak: streak, weekWork: weekWork, prevCycleWork: prevCycleWork };
    var pd = daysInMonth(prev.year, prev.month);
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var run = 0;
      for (var d = pd; d >= 1; d--) {
        if (isWork(getCell(prev.cells, e, d))) run++; else break;
      }
      streak[e] = run;
      var ww = 0;
      for (var k = pd; k >= 1 && k > pd - 7; k--) {
        if (weekIdOf(dayNumber(prev.year, prev.month, k)) === firstWeek && isWork(getCell(prev.cells, e, k))) ww++;
      }
      weekWork[e] = ww;
      var cw = 0;
      if (firstCycle >= 0) {
        for (var q = pd; q >= 1; q--) {
          if (cycleOf(dayNumber(prev.year, prev.month, q)) !== firstCycle) break;
          if (isWork(getCell(prev.cells, e, q))) cw++;
        }
      }
      prevCycleWork[e] = cw;
    }
    return { streak: streak, weekWork: weekWork, prevCycleWork: prevCycleWork };
  }

  function buildContext(opts) {
    var year = opts.year, month = opts.month;
    var D = daysInMonth(year, month);
    var roster = opts.roster.slice();
    var prefs = opts.prefs || {};
    var perDay = Math.max(1, parseInt(opts.perDay, 10) || 2);
    var closed = {};
    (opts.closedDays || []).forEach(function (d) { closed[d] = true; });
    var fixedOff = [null], weekIds = [null], weekdays = [null], need = [0], cycles = [null];
    var workableDays = 0;
    for (var d = 1; d <= D; d++) {
      var off = isFixedOff(year, month, d) || !!closed[d];
      fixedOff.push(off);
      weekIds.push(weekIdOf(dayNumber(year, month, d)));
      cycles.push(cycleOf(dayNumber(year, month, d)));
      weekdays.push(weekday(year, month, d));
      need.push(off ? 0 : perDay);
      if (!off) workableDays++;
    }
    var tail = tailInfo(opts.prev, roster, year, month);

    var pref = {}, avail = {}, availSuffix = {}, excluded = {};
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i];
      var pr = prefs[e] || {};
      pref[e] = [null];
      excluded[e] = 0;
      var suffix = new Array(D + 2).fill(0);
      var count = 0;
      for (var dd = 1; dd <= D; dd++) {
        var code = (pr[dd] === CODE.REST || pr[dd] === CODE.SPECIAL || pr[dd] === CODE.COMP) ? pr[dd] : CODE.EMPTY;
        if (fixedOff[dd]) code = CODE.REST;
        pref[e].push(code);
        if (code === CODE.SPECIAL || code === CODE.COMP) excluded[e]++;
        if (code === CODE.EMPTY) count++;
      }
      avail[e] = count;
      var acc = 0;
      for (var k = D; k >= 1; k--) {
        if (pref[e][k] === CODE.EMPTY) acc++;
        suffix[k] = acc;
      }
      availSuffix[e] = suffix;
    }

    return {
      year: year, month: month, D: D, roster: roster, perDay: perDay,
      fixedOff: fixedOff, weekIds: weekIds, weekdays: weekdays, need: need, cycles: cycles,
      workableDays: workableDays, totalSlots: perDay * workableDays,
      pref: pref, avail: avail, availSuffix: availSuffix, excluded: excluded,
      prevStreak: tail.streak, prevWeekWork: tail.weekWork, prevCycleWork: tail.prevCycleWork,
      balances: opts.balances || {}
    };
  }

  /* ---------- 週期計數 ---------- */
  function newCycleCounter(ctx, e) {
    var c = {};
    if (ctx.cycles[1] >= 0) c[ctx.cycles[1]] = ctx.prevCycleWork[e] || 0;
    return c;
  }
  function cycleFull(ctx, counter, d) {
    var c = ctx.cycles[d];
    return c >= 0 && (counter[c] || 0) >= CYCLE_MAX_WORK;
  }
  function cycleAdd(ctx, counter, d) {
    var c = ctx.cycles[d];
    if (c >= 0) counter[c] = (counter[c] || 0) + 1;
  }

  /* ---------- 結構上限：單獨看一個人，在連續 4 天與週期 16 天的限制下本月最多能上幾天 ---------- */
  function structuralCap(ctx, e) {
    var counter = newCycleCounter(ctx, e);
    var streak = ctx.prevStreak[e] || 0, n = 0;
    for (var d = 1; d <= ctx.D; d++) {
      if (ctx.pref[e][d] !== CODE.EMPTY || streak >= MAX_STREAK || cycleFull(ctx, counter, d)) { streak = 0; continue; }
      cycleAdd(ctx, counter, d); streak++; n++;
    }
    return n;
  }

  /* ---------- 目標上班天數（水位填充） ---------- */
  function computeTargets(ctx) {
    var roster = ctx.roster, D = ctx.D;
    var T = 0;
    for (var dd = 1; dd <= D; dd++) T += ctx.need[dd];
    var target = {}, capWeek = {}, capAvail = {};
    var i, e;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      target[e] = 0;
      capAvail[e] = Math.min(ctx.avail[e], structuralCap(ctx, e));
      var perWeek = {};
      for (var d = 1; d <= D; d++) {
        if (ctx.pref[e][d] === CODE.EMPTY) {
          var w = ctx.weekIds[d];
          perWeek[w] = (perWeek[w] || 0) + 1;
        }
      }
      var cap = 0;
      for (var wk in perWeek) {
        if (Object.prototype.hasOwnProperty.call(perWeek, wk)) {
          var already = (wk == ctx.weekIds[1]) ? (ctx.prevWeekWork[e] || 0) : 0;
          cap += Math.max(0, Math.min(perWeek[wk], WEEK_MAX - already));
        }
      }
      capWeek[e] = Math.min(cap, capAvail[e]);
    }
    function fill(remaining, caps) {
      while (remaining > 0) {
        var best = null, bestKey = -Infinity;
        for (var j = 0; j < roster.length; j++) {
          var emp = roster[j];
          if (target[emp] >= caps[emp]) continue;
          var restNow = (D - ctx.excluded[emp] - target[emp]) + (ctx.balances[emp] || 0);
          var key = restNow * 1000 - target[emp];
          if (key > bestKey) { bestKey = key; best = emp; }
        }
        if (best === null) break;
        target[best]++;
        remaining--;
      }
      return remaining;
    }
    var left = fill(T, capWeek);
    if (left > 0) left = fill(left, capAvail);
    return { target: target, unfillable: left, totalSlots: T };
  }

  /* ---------- 評分 ---------- */
  function evaluate(ctx, cells, target) {
    var D = ctx.D, roster = ctx.roster;
    var shortageCost = 0, shortage = 0, over = 0, streakViol = 0, fixedOffWork = 0, weekOver = 0, deviation = 0, isolated = 0, cycleViol = 0;
    var d, i, e;
    var cover = new Array(D + 1).fill(0);
    var coverW = new Array(D + 1).fill(0);
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var row = cells[e];
      var run = ctx.prevStreak[e] || 0;
      var week = {};
      var work = 0;
      var prevWorkFlag = (ctx.prevStreak[e] || 0) > 0;
      var counter = newCycleCounter(ctx, e);
      for (d = 1; d <= D; d++) {
        var c = row[d];
        var isW = isWork(c);
        if (isW) {
          cover[d]++;
          if (c === CODE.WORK) coverW[d]++;
          work++;
          run++;
          if (run > MAX_STREAK) streakViol++;
          if (ctx.fixedOff[d]) fixedOffWork++;
          var w = ctx.weekIds[d];
          if (week[w] === undefined) week[w] = (w === ctx.weekIds[1]) ? (ctx.prevWeekWork[e] || 0) : 0;
          week[w]++;
          if (week[w] > WEEK_MAX) weekOver++;
          if (cycleFull(ctx, counter, d)) cycleViol++;
          cycleAdd(ctx, counter, d);
        } else {
          run = 0;
        }
        if (d >= 2 && d <= D - 1) {
          var a = isWork(row[d - 1]), b = isWork(row[d + 1]);
          if (isW && !a && !b) isolated++;
          if (!isW && a && b && !ctx.fixedOff[d]) isolated++;
        } else if (d === 1 && isW && !prevWorkFlag && D >= 2 && !isWork(row[2])) {
          isolated++;
        }
      }
      deviation += Math.abs(work - (target[e] || 0));
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) continue;
      var need = ctx.need[d];
      if (cover[d] < need) {
        var miss = need - cover[d];
        shortage += miss;
        shortageCost += miss * (SHORTAGE_PREFERRED[ctx.weekdays[d]] ? COST.shortagePreferred : COST.shortage);
      }
      if (coverW[d] > need) over += coverW[d] - need;
    }
    var cost = shortageCost + COST.over * over + COST.streak * streakViol + COST.cycle * cycleViol +
      COST.fixedOff * fixedOffWork + COST.weekOver * weekOver + COST.deviation * deviation +
      COST.isolated * isolated;
    return { cost: cost, shortage: shortage, over: over, streakViol: streakViol, cycleViol: cycleViol,
      weekOver: weekOver, deviation: deviation, isolated: isolated, cover: cover };
  }

  /* ---------- 貪婪產生 ---------- */
  function greedy(ctx, rng, target) {
    var D = ctx.D, roster = ctx.roster;
    var cells = {}, work = {}, streak = {}, weekWork = {}, cyc = {};
    var i, e, d;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      cells[e] = new Array(D + 1).fill(CODE.EMPTY);
      cells[e][0] = null;
      work[e] = 0;
      streak[e] = ctx.prevStreak[e] || 0;
      weekWork[e] = {};
      weekWork[e][ctx.weekIds[1]] = ctx.prevWeekWork[e] || 0;
      cyc[e] = newCycleCounter(ctx, e);
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) {
        for (i = 0; i < roster.length; i++) { e = roster[i]; cells[e][d] = CODE.REST; streak[e] = 0; }
        continue;
      }
      var need = ctx.need[d];
      var w = ctx.weekIds[d];
      var scored = [];
      for (i = 0; i < roster.length; i++) {
        e = roster[i];
        var pc = ctx.pref[e][d];
        if (pc !== CODE.EMPTY) { cells[e][d] = pc; continue; }
        if (streak[e] >= MAX_STREAK) { cells[e][d] = CODE.REST; continue; }
        // 週期內已達 16 天則今日不可出勤
        if (cycleFull(ctx, cyc[e], d)) { cells[e][d] = CODE.REST; continue; }
        var deficit = (target[e] || 0) - work[e];
        var remain = ctx.availSuffix[e][d];
        var s;
        if (deficit <= 0) s = -1000 - work[e] * 10;
        else s = -(remain - deficit) * 4 - streak[e] * 1.5;
        s += rng() * 2;
        scored.push({ e: e, s: s, over: (weekWork[e][w] || 0) >= WEEK_MAX ? 1 : 0 });
      }
      scored.sort(function (a, b) { return a.over - b.over || b.s - a.s; });
      var picked = 0;
      for (i = 0; i < scored.length; i++) {
        e = scored[i].e;
        if (picked < need) {
          cells[e][d] = CODE.WORK; work[e]++; streak[e]++;
          weekWork[e][w] = (weekWork[e][w] || 0) + 1;
          cycleAdd(ctx, cyc[e], d);
          picked++;
        } else {
          cells[e][d] = CODE.REST; streak[e] = 0;
        }
      }
    }
    return cells;
  }

  /* ---------- 局部改善 ---------- */
  function isLocked(ctx, e, d) { return ctx.fixedOff[d] || ctx.pref[e][d] !== CODE.EMPTY; }

  function runIfWork(ctx, row, e, d) {
    var left = 0, k;
    for (k = d - 1; k >= 1 && isWork(row[k]); k--) left++;
    if (k === 0) left += (ctx.prevStreak[e] || 0);
    var right = 0;
    for (k = d + 1; k <= ctx.D && isWork(row[k]); k++) right++;
    return left + 1 + right;
  }
  function canWork(ctx, cells, e, d) {
    if (runIfWork(ctx, cells[e], e, d) > MAX_STREAK) return false;
    var c = ctx.cycles[d];
    if (c < 0) return true;
    var n = (c === ctx.cycles[1]) ? (ctx.prevCycleWork[e] || 0) : 0;
    for (var k = 1; k <= ctx.D; k++) if (k !== d && ctx.cycles[k] === c && isWork(cells[e][k])) n++;
    return n < CYCLE_MAX_WORK;
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function improve(ctx, cells, target, rng, maxPasses) {
    var D = ctx.D, roster = ctx.roster;
    var cur = evaluate(ctx, cells, target);
    var passes = 0;
    maxPasses = maxPasses || 40;
    while (passes++ < maxPasses) {
      var improved = false;
      var days = shuffle(Array.from({ length: D }, function (_, i) { return i + 1; }), rng);
      for (var di = 0; di < days.length; di++) {
        var d = days[di];
        if (ctx.fixedOff[d]) continue;
        var need = ctx.need[d];
        var workers = [], resters = [];
        for (var i = 0; i < roster.length; i++) {
          var e = roster[i];
          if (isLocked(ctx, e, d)) continue;
          if (cells[e][d] === CODE.WORK) workers.push(e); else if (cells[e][d] === CODE.REST) resters.push(e);
        }
        shuffle(workers, rng); shuffle(resters, rng);
        var cover = cur.cover[d];
        // A. 補足出勤不足
        if (cover < need) {
          for (var r = 0; r < resters.length; r++) {
            var f = resters[r];
            if (!canWork(ctx, cells, f, d)) continue;
            cells[f][d] = CODE.WORK;
            var ev = evaluate(ctx, cells, target);
            if (ev.cost < cur.cost) { cur = ev; improved = true; cover++; resters.splice(r, 1); r--; if (cover >= need) break; }
            else cells[f][d] = CODE.REST;
          }
        }
        // A2. 仍不足：把某人的其他上班日搬到今天（讓缺人落在較適合的日子）
        if (cover < need) {
          for (var r2 = 0; r2 < resters.length; r2++) {
            var g2 = resters[r2];
            if (!canWork(ctx, cells, g2, d)) continue;
            var moved = false;
            for (var d1 = 1; d1 <= D && !moved; d1++) {
              if (d1 === d || cells[g2][d1] !== CODE.WORK || isLocked(ctx, g2, d1)) continue;
              cells[g2][d1] = CODE.REST; cells[g2][d] = CODE.WORK;
              var evm = evaluate(ctx, cells, target);
              if (evm.cost < cur.cost) { cur = evm; improved = true; cover++; moved = true; }
              else { cells[g2][d1] = CODE.WORK; cells[g2][d] = CODE.REST; }
            }
            if (cover >= need) break;
          }
        }
        // B. 減少出勤過多
        if (cover > need) {
          for (var wq = 0; wq < workers.length; wq++) {
            var g = workers[wq];
            cells[g][d] = CODE.REST;
            var ev2 = evaluate(ctx, cells, target);
            if (ev2.cost < cur.cost) { cur = ev2; improved = true; cover--; workers.splice(wq, 1); wq--; if (cover <= need) break; }
            else cells[g][d] = CODE.WORK;
          }
        }
        // C. 同日交換
        for (var a = 0; a < workers.length; a++) {
          var ew = workers[a];
          for (var b = 0; b < resters.length; b++) {
            var er = resters[b];
            cells[ew][d] = CODE.REST;
            if (!canWork(ctx, cells, er, d)) { cells[ew][d] = CODE.WORK; continue; }
            cells[er][d] = CODE.WORK;
            var ev3 = evaluate(ctx, cells, target);
            if (ev3.cost < cur.cost) {
              cur = ev3; improved = true;
              workers[a] = er; resters[b] = ew;
              ew = er;
            } else {
              cells[ew][d] = CODE.WORK; cells[er][d] = CODE.REST;
            }
          }
        }
      }
      if (!improved) break;
    }
    return cur;
  }

  /* ---------- 主要 API ---------- */
  function toCellMap(ctx, cellsArr) {
    var out = {};
    for (var i = 0; i < ctx.roster.length; i++) {
      var e = ctx.roster[i];
      out[e] = {};
      for (var d = 1; d <= ctx.D; d++) out[e][d] = cellsArr[e][d];
    }
    return out;
  }
  function fromCellMap(ctx, cellMap) {
    var arr = {};
    for (var i = 0; i < ctx.roster.length; i++) {
      var e = ctx.roster[i];
      arr[e] = new Array(ctx.D + 1).fill(CODE.EMPTY);
      arr[e][0] = null;
      for (var d = 1; d <= ctx.D; d++) {
        var c = getCell(cellMap, e, d);
        if (ctx.fixedOff[d] && c === CODE.EMPTY) c = CODE.REST;
        arr[e][d] = c;
      }
    }
    return arr;
  }

  // 人力不足時，預先把缺額安排到週二、週四：先把週二、週四逐輪減到 0，才輪到其他日子
  function planReductions(ctx, K) {
    if (K <= 0) return;
    var pref = [], other = [];
    for (var d = 1; d <= ctx.D; d++) {
      if (ctx.fixedOff[d]) continue;
      (SHORTAGE_PREFERRED[ctx.weekdays[d]] ? pref : other).push(d);
    }
    [pref, other].forEach(function (group) {
      while (K > 0 && group.length) {
        var progressed = false;
        for (var i = 0; i < group.length && K > 0; i++) {
          if (ctx.need[group[i]] > 0) { ctx.need[group[i]]--; K--; progressed = true; }
        }
        if (!progressed) break;
      }
    });
  }

  /**
   * 產生排班表。
   * opts: { year, month, roster:[id], prefs:{id:{day:'R'|'S'|'C'}}, balances:{id:number},
   *         perDay, closedDays:[day], prev:{year,month,cells}|null, attempt, restarts }
   */
  function generate(opts) {
    var ctx = buildContext(opts);
    var targets = computeTargets(ctx);
    planReductions(ctx, targets.unfillable);
    var restarts = Math.max(1, opts.restarts || 24);
    var baseSeed = ((opts.year * 100 + opts.month) * 1000 + ((opts.attempt || 0) % 1000)) >>> 0;
    var best = null, bestEval = null;
    for (var k = 0; k < restarts; k++) {
      var rng = mulberry32(baseSeed * 7919 + k * 104729 + 12345);
      var cells = greedy(ctx, rng, targets.target);
      var ev = improve(ctx, cells, targets.target, rng, 30);
      if (!bestEval || ev.cost < bestEval.cost) { best = cells; bestEval = ev; }
      if (bestEval.cost === 0) break;
    }
    var shortages = {};
    for (var d = 1; d <= ctx.D; d++) {
      if (!ctx.fixedOff[d] && bestEval.cover[d] < ctx.perDay) shortages[d] = ctx.perDay - bestEval.cover[d];
    }
    return {
      cells: toCellMap(ctx, best),
      targets: targets.target,
      need: ctx.need.slice(),
      shortages: shortages,
      unfillable: targets.unfillable,
      totalSlots: ctx.totalSlots,
      cost: bestEval.cost,
      summary: bestEval
    };
  }

  /* ---------- 統計與驗證 ---------- */
  function countCodes(cells, roster, D) {
    var stats = {};
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i];
      var s = { W: 0, R: 0, S: 0, O: 0, C: 0, empty: 0 };
      for (var d = 1; d <= D; d++) {
        var c = getCell(cells, e, d);
        if (c === CODE.EMPTY) s.empty++; else s[c] = (s[c] || 0) + 1;
      }
      stats[e] = s;
    }
    return stats;
  }

  // 公平性用的「休息」：一般休息 + 加班（加班已另給補休，視同休息）
  function restDeltas(cells, roster, D) {
    var stats = countCodes(cells, roster, D);
    var sum = 0, n = 0, e;
    for (e in stats) { if (Object.prototype.hasOwnProperty.call(stats, e)) { sum += stats[e].R + stats[e].O; n++; } }
    var mean = n ? sum / n : 0;
    var out = {};
    for (e in stats) { if (Object.prototype.hasOwnProperty.call(stats, e)) out[e] = stats[e].R + stats[e].O - mean; }
    return { deltas: out, mean: mean, stats: stats };
  }

  var WD_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
  function fmtDate(m, d, wd) { return m + '/' + d + '（' + WD_NAMES[wd] + '）'; }
  function rangeText(opts, from, to) {
    var a;
    if (from < 1) {
      var pm = prevMonthOf(opts.year, opts.month);
      a = pm.month + '/' + (daysInMonth(pm.year, pm.month) + from);
    } else {
      a = opts.month + '/' + from;
    }
    return a + '～' + opts.month + '/' + to;
  }

  /**
   * 驗證排班表。
   * opts: { year, month, roster, cells, perDay, closedDays, prev, next, names:{id:name} }
   */
  function validate(opts) {
    var ctx = buildContext({ year: opts.year, month: opts.month, roster: opts.roster, prefs: {}, perDay: opts.perDay, closedDays: opts.closedDays, prev: opts.prev });
    var D = ctx.D, roster = ctx.roster;
    var names = opts.names || {};
    var nm = function (e) { return names[e] || e; };
    var issues = [];
    var flagged = {};
    var cover = new Array(D + 1).fill(0);
    var coverW = new Array(D + 1).fill(0);
    var i, e, d;

    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var row = [null];
      for (d = 1; d <= D; d++) row.push(getCell(opts.cells, e, d));
      var run = ctx.prevStreak[e] || 0;
      var runStart = run > 0 ? 1 - run : null;
      for (d = 1; d <= D; d++) {
        var c = row[d];
        if (isWork(c)) {
          cover[d]++;
          if (c === CODE.WORK) coverW[d]++;
          if (ctx.fixedOff[d]) {
            issues.push({ type: 'fixedOff', day: d, employee: e, message: nm(e) + '：' + fmtDate(opts.month, d, ctx.weekdays[d]) + ' 為固定全員休息日，卻排了上班' });
            flagged[e + ':' + d] = true;
          }
          if (run === 0) runStart = d;
          run++;
          if (run > MAX_STREAK) {
            for (var k = Math.max(1, runStart); k <= d; k++) flagged[e + ':' + k] = true;
          }
        } else {
          if (run > MAX_STREAK && d - 1 >= 1) {
            issues.push({ type: 'streak', employee: e, from: runStart, to: d - 1,
              message: nm(e) + '：' + rangeText(opts, runStart, d - 1) + ' 連續上班 ' + run + ' 天（超過 4 天上限）' });
          }
          run = 0;
        }
      }
      if (run > MAX_STREAK) {
        issues.push({ type: 'streak', employee: e, from: runStart, to: D,
          message: nm(e) + '：' + rangeText(opts, runStart, D) + ' 連續上班 ' + run + ' 天（超過 4 天上限）' });
      } else if (run > 0 && opts.next && opts.next.cells) {
        var lead = 0;
        var nd = daysInMonth(opts.next.year, opts.next.month);
        for (var q = 1; q <= nd; q++) { if (isWork(getCell(opts.next.cells, e, q))) lead++; else break; }
        if (run + lead > MAX_STREAK) {
          for (var k2 = Math.max(1, runStart); k2 <= D; k2++) flagged[e + ':' + k2] = true;
          issues.push({ type: 'streakNext', employee: e, from: runStart, to: D,
            message: nm(e) + '：' + rangeText(opts, runStart, D) + ' 起連續上班至 ' + opts.next.month + '/' + lead + '，共 ' + (run + lead) + ' 天（跨月超過 4 天上限）' });
        }
      }
      // 週期內出勤天數（含上月落在同一週期的部分）
      var counts = newCycleCounter(ctx, e);
      for (d = 1; d <= D; d++) if (isWork(row[d])) cycleAdd(ctx, counts, d);
      Object.keys(counts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (c) {
        if (counts[c] > CYCLE_MAX_WORK) {
          issues.push({ type: 'hours', employee: e, cycle: c,
            message: nm(e) + '：' + cycleRange(c).text + ' 這個 28 天週期出勤 ' + counts[c] + ' 天（' + (counts[c] * HOURS_PER_DAY) + ' 小時），超過 ' + CYCLE_MAX_WORK + ' 天（' + (CYCLE_MAX_WORK * HOURS_PER_DAY) + ' 小時）上限' });
        }
      });
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) continue;
      var need = ctx.need[d];
      if (cover[d] < need) {
        issues.push({ type: 'shortage', day: d, missing: need - cover[d],
          message: fmtDate(opts.month, d, ctx.weekdays[d]) + ' 出勤人數不足：' + cover[d] + ' 人（需 ' + need + ' 人）' });
      } else if (coverW[d] > need) {
        issues.push({ type: 'over', day: d, extra: coverW[d] - need,
          message: fmtDate(opts.month, d, ctx.weekdays[d]) + ' 上班人數 ' + coverW[d] + ' 人，超過需求 ' + need + ' 人' });
      }
    }
    var order = { fixedOff: 0, streak: 1, streakNext: 1, hours: 2, shortage: 3, over: 4 };
    issues.sort(function (a, b) { return (order[a.type] - order[b.type]) || ((a.day || a.from || 0) - (b.day || b.from || 0)); });
    return { issues: issues, flagged: flagged, cover: cover, stats: countCodes(opts.cells, roster, D) };
  }

  // 排班前檢視：每日可出勤人數
  function availability(opts) {
    var ctx = buildContext({ year: opts.year, month: opts.month, roster: opts.roster, prefs: opts.prefs, perDay: opts.perDay, closedDays: opts.closedDays });
    var perDayAvail = new Array(ctx.D + 1).fill(0);
    var total = 0;
    for (var d = 1; d <= ctx.D; d++) {
      if (ctx.fixedOff[d]) continue;
      for (var i = 0; i < ctx.roster.length; i++) {
        if (ctx.pref[ctx.roster[i]][d] === CODE.EMPTY) perDayAvail[d]++;
      }
      total += perDayAvail[d];
    }
    return { perDayAvail: perDayAvail, totalAvail: total, totalSlots: ctx.totalSlots, fixedOff: ctx.fixedOff, weekdays: ctx.weekdays, D: ctx.D, workableDays: ctx.workableDays };
  }

  return {
    CODE: CODE,
    MAX_STREAK: MAX_STREAK,
    WEEK_MAX: WEEK_MAX,
    HOURS_PER_DAY: HOURS_PER_DAY,
    CYCLE_DAYS: CYCLE_DAYS,
    CYCLE_MAX_WORK: CYCLE_MAX_WORK,
    CYCLE_EPOCH: CYCLE_EPOCH,
    cycleOf: cycleOf,
    cycleRange: cycleRange,
    dayNumber: dayNumber,
    FIXED_OFF_WEEKDAY: FIXED_OFF_WEEKDAY,
    START_YEAR: START_YEAR,
    START_MONTH: START_MONTH,
    isWork: isWork,
    daysInMonth: daysInMonth,
    weekday: weekday,
    isFixedOff: isFixedOff,
    prevMonthOf: prevMonthOf,
    nextMonthOf: nextMonthOf,
    monthKey: monthKey,
    parseMonthKey: parseMonthKey,
    compareMonthKey: compareMonthKey,
    generate: generate,
    validate: validate,
    availability: availability,
    countCodes: countCodes,
    restDeltas: restDeltas,
    computeTargets: function (opts) { return computeTargets(buildContext(opts)); },
    evaluate: function (opts) {
      var ctx = buildContext(opts);
      return evaluate(ctx, fromCellMap(ctx, opts.cells), opts.targets || {});
    }
  };
});
