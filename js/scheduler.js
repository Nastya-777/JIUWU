/*
 * JIUWU_animal_hospital_schedule — 排班核心演算法（第三版：以 28 天週期為單位）
 *
 * 純函式、無 DOM 相依，瀏覽器（window.Scheduler）與 Node（module.exports）皆可使用。
 *
 * 週期：自 2026-09-01 起每 28 天為一個週期（第 1 週期 9/1～9/28，第 2 週期 9/29～10/26……）。
 * 規則摘要：
 *  - 每週三固定全員休息；另可指定「休診日」同樣全員休息。
 *  - 任何人連續上班不得超過 4 天（跨週期連續計算）。
 *  - 每人每天出勤 10 小時；每個週期出勤不得超過 16 天（160 小時）。
 *  - 每日預設 2 人出勤（perDay 可調）；人力不足時，缺人優先落在週二、週四。
 *  - 一週（週一～週日）上班盡量不超過 4 天（軟性）。
 *  - 員工事先選定的「休息」「特休」「補休」必須尊重。
 *  - 特休、補休不計入上四休三；加班視為出勤，但在休息公平性上視同休息（已另給補休）。
 *  - 扣除特休、補休後，各員工的一般休息天數盡量相同；差額以「結餘」帶到下個週期補償。
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
  var MAX_STREAK = 4;
  var WEEK_MAX = 4;
  var HOURS_PER_DAY = 10;
  var PERIOD_DAYS = 28;
  var PERIOD_MAX_WORK = 16;
  var FIXED_OFF_WEEKDAY = 3;
  var SHORTAGE_PREFERRED = { 2: true, 4: true };
  var START_YEAR = 2026, START_MONTH = 9, START_DAY = 1;

  var COST = {
    shortage: 1000, shortagePreferred: 600, over: 300, streak: 500, period: 500,
    fixedOff: 500, weekOver: 40, deviation: 10, isolated: 1
  };

  /* ---------- 日期工具 ---------- */
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
  function dnToDate(dn) {
    var t = new Date(dn * 86400000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(dn) { var t = dnToDate(dn); return t.y + '-' + pad(t.m) + '-' + pad(t.d); }
  function weekIdOf(dn) { return Math.floor((dn + 3) / 7); }
  var PERIOD_EPOCH = dayNumber(START_YEAR, START_MONTH, START_DAY);
  function periodIndexOf(dn) { return Math.floor((dn - PERIOD_EPOCH) / PERIOD_DAYS); }
  function periodStartDn(idx) { return PERIOD_EPOCH + idx * PERIOD_DAYS; }
  function periodKey(idx) { return isoOf(periodStartDn(idx)); }
  function periodIndexOfKey(key) {
    var p = String(key).split('-');
    return periodIndexOf(dayNumber(+p[0], +p[1], +p[2]));
  }
  // 週期內每一天的資訊：i 由 1 到 28
  function periodDates(idx) {
    var out = [null], s = periodStartDn(idx);
    for (var i = 0; i < PERIOD_DAYS; i++) {
      var t = dnToDate(s + i);
      t.dn = s + i; t.iso = isoOf(s + i); t.i = i + 1;
      out.push(t);
    }
    return out;
  }
  function periodLabel(idx) {
    var a = dnToDate(periodStartDn(idx)), b = dnToDate(periodStartDn(idx) + PERIOD_DAYS - 1);
    var tail = (a.y === b.y) ? (b.m + '/' + b.d) : (b.y + '/' + b.m + '/' + b.d);
    return a.y + '/' + a.m + '/' + a.d + '～' + tail;
  }
  function isWork(c) { return c === CODE.WORK || c === CODE.OVERTIME; }

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
  function getCell(cells, e, d) { var row = cells && cells[e]; return (row && row[d]) || CODE.EMPTY; }

  /* ---------- 上下文 ---------- */
  function tailInfo(prev, roster, firstWeek) {
    var streak = {}, weekWork = {};
    var i, e;
    for (i = 0; i < roster.length; i++) { streak[roster[i]] = 0; weekWork[roster[i]] = 0; }
    if (!prev || !prev.cells) return { streak: streak, weekWork: weekWork };
    var pdates = periodDates(prev.period);
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var run = 0;
      for (var d = PERIOD_DAYS; d >= 1; d--) { if (isWork(getCell(prev.cells, e, d))) run++; else break; }
      streak[e] = run;
      var ww = 0;
      for (var k = PERIOD_DAYS; k >= 1 && k > PERIOD_DAYS - 7; k--) {
        if (weekIdOf(pdates[k].dn) === firstWeek && isWork(getCell(prev.cells, e, k))) ww++;
      }
      weekWork[e] = ww;
    }
    return { streak: streak, weekWork: weekWork };
  }

  function buildContext(opts) {
    var idx = opts.period;
    var dates = periodDates(idx);
    var D = PERIOD_DAYS;
    var roster = opts.roster.slice();
    var prefs = opts.prefs || {};
    var perDay = Math.max(1, parseInt(opts.perDay, 10) || 2);
    var closed = {};
    (opts.closedDays || []).forEach(function (d) { closed[d] = true; });
    var fixedOff = [null], weekIds = [null], weekdays = [null], need = [0];
    var workableDays = 0;
    for (var d = 1; d <= D; d++) {
      var off = dates[d].wd === FIXED_OFF_WEEKDAY || !!closed[d];
      fixedOff.push(off);
      weekIds.push(weekIdOf(dates[d].dn));
      weekdays.push(dates[d].wd);
      need.push(off ? 0 : perDay);
      if (!off) workableDays++;
    }
    var tail = tailInfo(opts.prev, roster, weekIds[1]);
    var pref = {}, avail = {}, availSuffix = {}, excluded = {};
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i];
      var pr = prefs[e] || {};
      pref[e] = [null]; excluded[e] = 0;
      var suffix = new Array(D + 2).fill(0), count = 0;
      for (var dd = 1; dd <= D; dd++) {
        var code = (pr[dd] === CODE.REST || pr[dd] === CODE.SPECIAL || pr[dd] === CODE.COMP) ? pr[dd] : CODE.EMPTY;
        if (fixedOff[dd]) code = CODE.REST;
        pref[e].push(code);
        if (code === CODE.SPECIAL || code === CODE.COMP) excluded[e]++;
        if (code === CODE.EMPTY) count++;
      }
      avail[e] = count;
      var acc = 0;
      for (var k = D; k >= 1; k--) { if (pref[e][k] === CODE.EMPTY) acc++; suffix[k] = acc; }
      availSuffix[e] = suffix;
    }
    return {
      period: idx, dates: dates, D: D, roster: roster, perDay: perDay,
      fixedOff: fixedOff, weekIds: weekIds, weekdays: weekdays, need: need,
      workableDays: workableDays, totalSlots: perDay * workableDays,
      pref: pref, avail: avail, availSuffix: availSuffix, excluded: excluded,
      prevStreak: tail.streak, prevWeekWork: tail.weekWork,
      balances: opts.balances || {}
    };
  }

  /* ---------- 結構上限 ---------- */
  function structuralCap(ctx, e) {
    var streak = ctx.prevStreak[e] || 0, n = 0;
    for (var d = 1; d <= ctx.D; d++) {
      if (ctx.pref[e][d] !== CODE.EMPTY || streak >= MAX_STREAK || n >= PERIOD_MAX_WORK) { streak = 0; continue; }
      streak++; n++;
    }
    return n;
  }

  /* ---------- 目標上班天數 ---------- */
  function computeTargets(ctx) {
    var roster = ctx.roster, D = ctx.D;
    var T = 0;
    for (var dd = 1; dd <= D; dd++) T += ctx.need[dd];
    var target = {}, capWeek = {}, capAvail = {};
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i];
      target[e] = 0;
      capAvail[e] = Math.min(ctx.avail[e], structuralCap(ctx, e));
      var perWeek = {};
      for (var d = 1; d <= D; d++) {
        if (ctx.pref[e][d] === CODE.EMPTY) { var w = ctx.weekIds[d]; perWeek[w] = (perWeek[w] || 0) + 1; }
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
        target[best]++; remaining--;
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
    var shortageCost = 0, shortage = 0, over = 0, streakViol = 0, fixedOffWork = 0, weekOver = 0, deviation = 0, isolated = 0, periodViol = 0;
    var d, i, e;
    var cover = new Array(D + 1).fill(0), coverW = new Array(D + 1).fill(0);
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var row = cells[e];
      var run = ctx.prevStreak[e] || 0, week = {}, work = 0;
      var prevWorkFlag = (ctx.prevStreak[e] || 0) > 0;
      for (d = 1; d <= D; d++) {
        var c = row[d], isW = isWork(c);
        if (isW) {
          cover[d]++;
          if (c === CODE.WORK) coverW[d]++;
          work++; run++;
          if (run > MAX_STREAK) streakViol++;
          if (ctx.fixedOff[d]) fixedOffWork++;
          var w = ctx.weekIds[d];
          if (week[w] === undefined) week[w] = (w === ctx.weekIds[1]) ? (ctx.prevWeekWork[e] || 0) : 0;
          week[w]++;
          if (week[w] > WEEK_MAX) weekOver++;
          if (work > PERIOD_MAX_WORK) periodViol++;
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
    var cost = shortageCost + COST.over * over + COST.streak * streakViol + COST.period * periodViol +
      COST.fixedOff * fixedOffWork + COST.weekOver * weekOver + COST.deviation * deviation + COST.isolated * isolated;
    return { cost: cost, shortage: shortage, over: over, streakViol: streakViol, periodViol: periodViol,
      weekOver: weekOver, deviation: deviation, isolated: isolated, cover: cover };
  }

  /* ---------- 貪婪產生 ---------- */
  function greedy(ctx, rng, target) {
    var D = ctx.D, roster = ctx.roster;
    var cells = {}, work = {}, streak = {}, weekWork = {};
    var i, e, d;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      cells[e] = new Array(D + 1).fill(CODE.EMPTY); cells[e][0] = null;
      work[e] = 0; streak[e] = ctx.prevStreak[e] || 0;
      weekWork[e] = {}; weekWork[e][ctx.weekIds[1]] = ctx.prevWeekWork[e] || 0;
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) {
        for (i = 0; i < roster.length; i++) { e = roster[i]; cells[e][d] = CODE.REST; streak[e] = 0; }
        continue;
      }
      var need = ctx.need[d], w = ctx.weekIds[d], scored = [];
      for (i = 0; i < roster.length; i++) {
        e = roster[i];
        var pc = ctx.pref[e][d];
        if (pc !== CODE.EMPTY) { cells[e][d] = pc; continue; }
        if (streak[e] >= MAX_STREAK || work[e] >= PERIOD_MAX_WORK) { cells[e][d] = CODE.REST; continue; }
        var deficit = (target[e] || 0) - work[e];
        var remain = ctx.availSuffix[e][d];
        var s = deficit <= 0 ? -1000 - work[e] * 10 : -(remain - deficit) * 4 - streak[e] * 1.5;
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
          picked++;
        } else { cells[e][d] = CODE.REST; streak[e] = 0; }
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
    var n = 0;
    for (var k = 1; k <= ctx.D; k++) if (k !== d && isWork(cells[e][k])) n++;
    return n < PERIOD_MAX_WORK;
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
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
        var need = ctx.need[d], workers = [], resters = [];
        for (var i = 0; i < roster.length; i++) {
          var e = roster[i];
          if (isLocked(ctx, e, d)) continue;
          if (cells[e][d] === CODE.WORK) workers.push(e); else if (cells[e][d] === CODE.REST) resters.push(e);
        }
        shuffle(workers, rng); shuffle(resters, rng);
        var cover = cur.cover[d];
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
        if (cover > need) {
          for (var wq = 0; wq < workers.length; wq++) {
            var g = workers[wq];
            cells[g][d] = CODE.REST;
            var ev2 = evaluate(ctx, cells, target);
            if (ev2.cost < cur.cost) { cur = ev2; improved = true; cover--; workers.splice(wq, 1); wq--; if (cover <= need) break; }
            else cells[g][d] = CODE.WORK;
          }
        }
        for (var a = 0; a < workers.length; a++) {
          var ew = workers[a];
          for (var b = 0; b < resters.length; b++) {
            var er = resters[b];
            cells[ew][d] = CODE.REST;
            if (!canWork(ctx, cells, er, d)) { cells[ew][d] = CODE.WORK; continue; }
            cells[er][d] = CODE.WORK;
            var ev3 = evaluate(ctx, cells, target);
            if (ev3.cost < cur.cost) { cur = ev3; improved = true; workers[a] = er; resters[b] = ew; ew = er; }
            else { cells[ew][d] = CODE.WORK; cells[er][d] = CODE.REST; }
          }
        }
      }
      if (!improved) break;
    }
    return cur;
  }

  function toCellMap(ctx, arr) {
    var out = {};
    for (var i = 0; i < ctx.roster.length; i++) { var e = ctx.roster[i]; out[e] = {}; for (var d = 1; d <= ctx.D; d++) out[e][d] = arr[e][d]; }
    return out;
  }
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
   * 產生某週期的排班表。
   * opts: { period, roster, prefs:{id:{day:'R'|'S'|'C'}}, balances, perDay, closedDays:[day], prev:{period,cells}|null, attempt, restarts }
   */
  function generate(opts) {
    var ctx = buildContext(opts);
    var targets = computeTargets(ctx);
    planReductions(ctx, targets.unfillable);
    var restarts = Math.max(1, opts.restarts || 24);
    var baseSeed = ((opts.period + 1000) * 1000 + ((opts.attempt || 0) % 1000)) >>> 0;
    var best = null, bestEval = null;
    for (var k = 0; k < restarts; k++) {
      var rng = mulberry32(baseSeed * 7919 + k * 104729 + 12345);
      var cells = greedy(ctx, rng, targets.target);
      var ev = improve(ctx, cells, targets.target, rng, 30);
      if (!bestEval || ev.cost < bestEval.cost) { best = cells; bestEval = ev; }
      if (bestEval.cost === 0) break;
    }
    var shortages = {};
    for (var d = 1; d <= ctx.D; d++) if (!ctx.fixedOff[d] && bestEval.cover[d] < ctx.perDay) shortages[d] = ctx.perDay - bestEval.cover[d];
    return { cells: toCellMap(ctx, best), targets: targets.target, need: ctx.need.slice(), shortages: shortages,
      unfillable: targets.unfillable, totalSlots: ctx.totalSlots, cost: bestEval.cost, summary: bestEval };
  }

  /* ---------- 統計與驗證 ---------- */
  function countCodes(cells, roster, D) {
    var stats = {};
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i], s = { W: 0, R: 0, S: 0, O: 0, C: 0, empty: 0 };
      for (var d = 1; d <= D; d++) { var c = getCell(cells, e, d); if (c === CODE.EMPTY) s.empty++; else s[c] = (s[c] || 0) + 1; }
      stats[e] = s;
    }
    return stats;
  }
  function restDeltas(cells, roster, D) {
    var stats = countCodes(cells, roster, D), sum = 0, n = 0, e;
    for (e in stats) if (Object.prototype.hasOwnProperty.call(stats, e)) { sum += stats[e].R + stats[e].O; n++; }
    var mean = n ? sum / n : 0, out = {};
    for (e in stats) if (Object.prototype.hasOwnProperty.call(stats, e)) out[e] = stats[e].R + stats[e].O - mean;
    return { deltas: out, mean: mean, stats: stats };
  }

  var WD_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
  function fmtDay(ctx, d) { var t = ctx.dates[d]; return t.m + '/' + t.d + '（' + WD_NAMES[t.wd] + '）'; }
  function fmtMD(dn) { var t = dnToDate(dn); return t.m + '/' + t.d; }
  function rangeText(ctx, from, to) {
    var s = periodStartDn(ctx.period);
    return fmtMD(s + from - 1) + '～' + fmtMD(s + to - 1);
  }

  /**
   * 驗證。opts: { period, roster, cells, perDay, closedDays, prev:{period,cells}, next:{period,cells}, names }
   */
  function validate(opts) {
    var ctx = buildContext({ period: opts.period, roster: opts.roster, prefs: {}, perDay: opts.perDay, closedDays: opts.closedDays, prev: opts.prev });
    var D = ctx.D, roster = ctx.roster;
    var names = opts.names || {};
    var nm = function (e) { return names[e] || e; };
    var issues = [], flagged = {};
    var cover = new Array(D + 1).fill(0), coverW = new Array(D + 1).fill(0);
    var i, e, d;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var row = [null];
      for (d = 1; d <= D; d++) row.push(getCell(opts.cells, e, d));
      var run = ctx.prevStreak[e] || 0, runStart = run > 0 ? 1 - run : null, work = 0;
      for (d = 1; d <= D; d++) {
        var c = row[d];
        if (isWork(c)) {
          cover[d]++; work++;
          if (c === CODE.WORK) coverW[d]++;
          if (ctx.fixedOff[d]) {
            issues.push({ type: 'fixedOff', day: d, employee: e, message: nm(e) + '：' + fmtDay(ctx, d) + ' 為固定全員休息日，卻排了上班' });
            flagged[e + ':' + d] = true;
          }
          if (run === 0) runStart = d;
          run++;
          if (run > MAX_STREAK) for (var k = Math.max(1, runStart); k <= d; k++) flagged[e + ':' + k] = true;
        } else {
          if (run > MAX_STREAK && d - 1 >= 1) {
            issues.push({ type: 'streak', employee: e, from: runStart, to: d - 1,
              message: nm(e) + '：' + rangeText(ctx, runStart, d - 1) + ' 連續上班 ' + run + ' 天（超過 4 天上限）' });
          }
          run = 0;
        }
      }
      if (run > MAX_STREAK) {
        issues.push({ type: 'streak', employee: e, from: runStart, to: D,
          message: nm(e) + '：' + rangeText(ctx, runStart, D) + ' 連續上班 ' + run + ' 天（超過 4 天上限）' });
      } else if (run > 0 && opts.next && opts.next.cells) {
        var lead = 0;
        for (var q = 1; q <= PERIOD_DAYS; q++) { if (isWork(getCell(opts.next.cells, e, q))) lead++; else break; }
        if (run + lead > MAX_STREAK) {
          for (var k2 = Math.max(1, runStart); k2 <= D; k2++) flagged[e + ':' + k2] = true;
          var endDn = periodStartDn(ctx.period) + D - 1 + lead;
          issues.push({ type: 'streakNext', employee: e, from: runStart, to: D,
            message: nm(e) + '：' + rangeText(ctx, runStart, D) + ' 起連續上班至 ' + fmtMD(endDn) + '，共 ' + (run + lead) + ' 天（跨週期超過 4 天上限）' });
        }
      }
      if (work > PERIOD_MAX_WORK) {
        issues.push({ type: 'hours', employee: e,
          message: nm(e) + '：本週期出勤 ' + work + ' 天（' + (work * HOURS_PER_DAY) + ' 小時），超過 ' + PERIOD_MAX_WORK + ' 天（' + (PERIOD_MAX_WORK * HOURS_PER_DAY) + ' 小時）上限' });
      }
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) continue;
      var need = ctx.need[d];
      if (cover[d] < need) issues.push({ type: 'shortage', day: d, missing: need - cover[d], message: fmtDay(ctx, d) + ' 出勤人數不足：' + cover[d] + ' 人（需 ' + need + ' 人）' });
      else if (coverW[d] > need) issues.push({ type: 'over', day: d, extra: coverW[d] - need, message: fmtDay(ctx, d) + ' 上班人數 ' + coverW[d] + ' 人，超過需求 ' + need + ' 人' });
    }
    var order = { fixedOff: 0, streak: 1, streakNext: 1, hours: 2, shortage: 3, over: 4 };
    issues.sort(function (a, b) { return (order[a.type] - order[b.type]) || ((a.day || a.from || 0) - (b.day || b.from || 0)); });
    return { issues: issues, flagged: flagged, cover: cover, stats: countCodes(opts.cells, roster, D) };
  }

  function availability(opts) {
    var ctx = buildContext({ period: opts.period, roster: opts.roster, prefs: opts.prefs, perDay: opts.perDay, closedDays: opts.closedDays });
    var perDayAvail = new Array(ctx.D + 1).fill(0), total = 0;
    for (var d = 1; d <= ctx.D; d++) {
      if (ctx.fixedOff[d]) continue;
      for (var i = 0; i < ctx.roster.length; i++) if (ctx.pref[ctx.roster[i]][d] === CODE.EMPTY) perDayAvail[d]++;
      total += perDayAvail[d];
    }
    return { perDayAvail: perDayAvail, totalAvail: total, totalSlots: ctx.totalSlots, fixedOff: ctx.fixedOff, weekdays: ctx.weekdays, D: ctx.D, workableDays: ctx.workableDays };
  }

  return {
    CODE: CODE, MAX_STREAK: MAX_STREAK, WEEK_MAX: WEEK_MAX, HOURS_PER_DAY: HOURS_PER_DAY,
    PERIOD_DAYS: PERIOD_DAYS, PERIOD_MAX_WORK: PERIOD_MAX_WORK, PERIOD_EPOCH: PERIOD_EPOCH,
    FIXED_OFF_WEEKDAY: FIXED_OFF_WEEKDAY, START_YEAR: START_YEAR, START_MONTH: START_MONTH,
    isWork: isWork, daysInMonth: daysInMonth, dayNumber: dayNumber, dnToDate: dnToDate, isoOf: isoOf,
    periodIndexOf: periodIndexOf, periodIndexOfKey: periodIndexOfKey, periodStartDn: periodStartDn,
    periodKey: periodKey, periodDates: periodDates, periodLabel: periodLabel,
    generate: generate, validate: validate, availability: availability,
    countCodes: countCodes, restDeltas: restDeltas,
    computeTargets: function (opts) { return computeTargets(buildContext(opts)); }
  };
});
