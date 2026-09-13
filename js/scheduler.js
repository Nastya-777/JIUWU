/*
 * JIUWU_animal_hospital_schedule — 排班核心演算法
 *
 * 純函式、無 DOM 相依，瀏覽器（window.Scheduler）與 Node（module.exports）皆可使用。
 *
 * 規則摘要：
 *  - 每週三固定全員休息（計入上四休三）。
 *  - 任何人連續上班不得超過 4 天（跨月連續計算）。
 *  - 每日預設 2 人出勤（perDay 可調）。
 *  - 一週（週一～週日）上班盡量不超過 4 天（上四休三，軟性限制）。
 *  - 員工事先選定的「休」與「特休」必須尊重。
 *  - 特休 / 病假 / 事假 不計入上四休三：既不算上班，也不算一般休假。
 *  - 扣除特休後，各員工的「休」天數盡量相同；無法平衡的差額以「結餘」帶到下個月補償。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Scheduler = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CODE = { WORK: 'W', REST: 'R', SPECIAL: 'S', SICK: 'B', PERSONAL: 'P', EMPTY: '' };
  var MAX_STREAK = 4;          // 連續上班上限
  var WEEK_MAX = 4;            // 一週上班上限（軟性）
  var FIXED_OFF_WEEKDAY = 3;   // 週三（0 = 週日）
  var START_YEAR = 2026;
  var START_MONTH = 9;

  var COST = {
    shortage: 1000,   // 每日出勤不足 1 人
    over: 300,        // 每日出勤超過需求 1 人
    streak: 500,      // 連續上班超過 4 天，每多 1 天
    fixedOff: 500,    // 週三有人上班
    weekOver: 40,     // 一週上班超過 4 天，每多 1 天
    deviation: 10,    // 與目標上班天數的差距，每 1 天
    isolated: 1       // 孤立的單日上班 / 單日休假（美觀）
  };

  /* ---------- 日期工具 ---------- */
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function weekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function dayNumber(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
  // 以週一為一週開始的週編號（1970-01-01 為週四，1969-12-29 為週一）
  function weekIdOf(dn) { return Math.floor((dn + 3) / 7); }
  function isFixedOff(y, m, d) { return weekday(y, m, d) === FIXED_OFF_WEEKDAY; }
  function prevMonthOf(y, m) { return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 }; }
  function nextMonthOf(y, m) { return m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 }; }
  function monthKey(y, m) { return y + '-' + (m < 10 ? '0' : '') + m; }
  function parseMonthKey(key) {
    var p = String(key).split('-');
    return { year: parseInt(p[0], 10), month: parseInt(p[1], 10) };
  }
  function compareMonthKey(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

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

  // 前一個月月底的連續上班天數，以及落在本月第一週內的前月上班天數
  function tailInfo(prev, roster, year, month) {
    var streak = {}, weekWork = {}, lastDayWasWork = {};
    var firstWeek = weekIdOf(dayNumber(year, month, 1));
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i];
      streak[e] = 0; weekWork[e] = 0; lastDayWasWork[e] = false;
    }
    if (!prev || !prev.cells) return { streak: streak, weekWork: weekWork, lastDayWasWork: lastDayWasWork };
    var pd = daysInMonth(prev.year, prev.month);
    for (var j = 0; j < roster.length; j++) {
      var emp = roster[j];
      var run = 0;
      for (var d = pd; d >= 1; d--) {
        if (getCell(prev.cells, emp, d) === CODE.WORK) run++; else break;
      }
      streak[emp] = run;
      lastDayWasWork[emp] = run > 0;
      var ww = 0;
      for (var k = pd; k >= 1 && k > pd - 7; k--) {
        if (weekIdOf(dayNumber(prev.year, prev.month, k)) === firstWeek &&
            getCell(prev.cells, emp, k) === CODE.WORK) ww++;
      }
      weekWork[emp] = ww;
    }
    return { streak: streak, weekWork: weekWork, lastDayWasWork: lastDayWasWork };
  }

  function buildContext(opts) {
    var year = opts.year, month = opts.month;
    var D = daysInMonth(year, month);
    var roster = opts.roster.slice();
    var prefs = opts.prefs || {};
    var perDay = Math.max(1, parseInt(opts.perDay, 10) || 2);
    var fixedOff = [null], weekIds = [null], weekdays = [null];
    var workableDays = 0;
    for (var d = 1; d <= D; d++) {
      var off = isFixedOff(year, month, d);
      fixedOff.push(off);
      weekIds.push(weekIdOf(dayNumber(year, month, d)));
      weekdays.push(weekday(year, month, d));
      if (!off) workableDays++;
    }
    var tail = tailInfo(opts.prev, roster, year, month);

    // 每位員工的偏好、可上班天數
    var pref = {}, avail = {}, availSuffix = {}, special = {};
    for (var i = 0; i < roster.length; i++) {
      var e = roster[i];
      var pr = prefs[e] || {};
      pref[e] = [null];
      special[e] = 0;
      var suffix = new Array(D + 2).fill(0);
      var count = 0;
      for (var dd = 1; dd <= D; dd++) {
        var code = pr[dd] === CODE.REST || pr[dd] === CODE.SPECIAL ? pr[dd] : CODE.EMPTY;
        if (fixedOff[dd]) code = CODE.REST;
        pref[e].push(code);
        if (code === CODE.SPECIAL) special[e]++;
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
      fixedOff: fixedOff, weekIds: weekIds, weekdays: weekdays,
      workableDays: workableDays, totalSlots: perDay * workableDays,
      pref: pref, avail: avail, availSuffix: availSuffix, special: special,
      prevStreak: tail.streak, prevWeekWork: tail.weekWork,
      balances: opts.balances || {}
    };
  }

  /* ---------- 目標上班天數（水位填充） ---------- */
  // 讓「本月一般休假天數 + 過去結餘」盡量相等：結餘高（過去多休）的人本月多上班。
  function computeTargets(ctx) {
    var roster = ctx.roster, D = ctx.D;
    var T = ctx.totalSlots;
    var target = {}, capWeek = {}, capAvail = {};
    var i, e;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      target[e] = 0;
      capAvail[e] = ctx.avail[e];
      // 結構上限：每週最多 4 天
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
          // 若現在停止，此人的「一般休假 + 結餘」
          var restNow = (D - ctx.special[emp] - target[emp]) + (ctx.balances[emp] || 0);
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
    return { target: target, unfillable: left, capWeek: capWeek, capAvail: capAvail };
  }

  /* ---------- 評分 ---------- */
  function evaluate(ctx, cells, target) {
    var D = ctx.D, roster = ctx.roster, need = ctx.perDay;
    var shortage = 0, over = 0, streakViol = 0, fixedOffWork = 0, weekOver = 0, deviation = 0, isolated = 0;
    var d, i, e;
    var cover = new Array(D + 1).fill(0);
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var row = cells[e];
      var run = ctx.prevStreak[e] || 0;
      var week = {};
      var work = 0;
      var prevWork = (ctx.prevStreak[e] || 0) > 0;
      for (d = 1; d <= D; d++) {
        var c = row[d];
        var isW = c === CODE.WORK;
        if (isW) {
          cover[d]++;
          work++;
          run++;
          if (run > MAX_STREAK) streakViol++;
          if (ctx.fixedOff[d]) fixedOffWork++;
          var w = ctx.weekIds[d];
          week[w] = (week[w] || 0) + (week[w] === undefined && w === ctx.weekIds[1] ? (ctx.prevWeekWork[e] || 0) : 0) + 1;
          if (week[w] > WEEK_MAX) weekOver++;
        } else {
          run = 0;
        }
        // 孤立判斷（僅考慮非週三的相鄰日）
        if (d >= 2 && d <= D - 1) {
          var a = row[d - 1] === CODE.WORK, b = row[d + 1] === CODE.WORK;
          if (isW && !a && !b) isolated++;
          if (!isW && a && b && !ctx.fixedOff[d]) isolated++;
        } else if (d === 1 && isW && !prevWork && D >= 2 && row[2] !== CODE.WORK) {
          isolated++;
        }
      }
      deviation += Math.abs(work - (target[e] || 0));
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) continue;
      if (cover[d] < need) shortage += need - cover[d];
      else if (cover[d] > need) over += cover[d] - need;
    }
    var cost = COST.shortage * shortage + COST.over * over + COST.streak * streakViol +
      COST.fixedOff * fixedOffWork + COST.weekOver * weekOver + COST.deviation * deviation +
      COST.isolated * isolated;
    return { cost: cost, shortage: shortage, over: over, streakViol: streakViol, weekOver: weekOver,
      deviation: deviation, isolated: isolated, cover: cover };
  }

  /* ---------- 貪婪產生 ---------- */
  function greedy(ctx, rng, target) {
    var D = ctx.D, roster = ctx.roster, need = ctx.perDay;
    var cells = {}, work = {}, streak = {}, weekWork = {};
    var i, e, d;
    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      cells[e] = new Array(D + 1).fill(CODE.EMPTY);
      cells[e][0] = null;
      work[e] = 0;
      streak[e] = ctx.prevStreak[e] || 0;
      weekWork[e] = {};
      weekWork[e][ctx.weekIds[1]] = ctx.prevWeekWork[e] || 0;
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) {
        for (i = 0; i < roster.length; i++) { e = roster[i]; cells[e][d] = CODE.REST; streak[e] = 0; }
        continue;
      }
      var w = ctx.weekIds[d];
      var scored = [];
      for (i = 0; i < roster.length; i++) {
        e = roster[i];
        var pc = ctx.pref[e][d];
        if (pc !== CODE.EMPTY) { cells[e][d] = pc; continue; }
        if (streak[e] >= MAX_STREAK) { cells[e][d] = CODE.REST; continue; }
        var deficit = (target[e] || 0) - work[e];
        var remain = ctx.availSuffix[e][d];
        var s;
        if (deficit <= 0) {
          s = -1000 - work[e] * 10;
        } else {
          var slack = remain - deficit;
          s = -slack * 4 - streak[e] * 1.5;
        }
        s += rng() * 2;
        var overWeek = (weekWork[e][w] || 0) >= WEEK_MAX ? 1 : 0;
        scored.push({ e: e, s: s, over: overWeek });
      }
      scored.sort(function (a, b) { return a.over - b.over || b.s - a.s; });
      var picked = 0;
      for (i = 0; i < scored.length; i++) {
        e = scored[i].e;
        if (picked < need) {
          cells[e][d] = CODE.WORK; work[e]++; streak[e]++;
          weekWork[e][w] = (weekWork[e][w] || 0) + 1;
          picked++;
        } else {
          cells[e][d] = CODE.REST; streak[e] = 0;
        }
      }
    }
    return cells;
  }

  /* ---------- 局部改善 ---------- */
  function isLocked(ctx, e, d) {
    return ctx.fixedOff[d] || ctx.pref[e][d] !== CODE.EMPTY;
  }

  // 若 e 在第 d 天上班，其連續上班天數是否仍 ≤ 上限
  function runIfWork(ctx, row, e, d) {
    var left = 0, k;
    for (k = d - 1; k >= 1 && row[k] === CODE.WORK; k--) left++;
    if (k === 0) left += (ctx.prevStreak[e] || 0);
    var right = 0;
    for (k = d + 1; k <= ctx.D && row[k] === CODE.WORK; k++) right++;
    return left + 1 + right;
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function improve(ctx, cells, target, rng, maxPasses) {
    var D = ctx.D, roster = ctx.roster, need = ctx.perDay;
    var cur = evaluate(ctx, cells, target);
    var passes = 0;
    maxPasses = maxPasses || 40;
    while (passes++ < maxPasses) {
      var improved = false;
      var days = shuffle(Array.from({ length: D }, function (_, i) { return i + 1; }), rng);
      for (var di = 0; di < days.length; di++) {
        var d = days[di];
        if (ctx.fixedOff[d]) continue;
        var workers = [], resters = [];
        for (var i = 0; i < roster.length; i++) {
          var e = roster[i];
          if (isLocked(ctx, e, d)) continue;
          if (cells[e][d] === CODE.WORK) workers.push(e); else resters.push(e);
        }
        shuffle(workers, rng); shuffle(resters, rng);
        var cover = cur.cover[d];
        // A. 補足出勤不足
        if (cover < need) {
          for (var r = 0; r < resters.length; r++) {
            var f = resters[r];
            if (runIfWork(ctx, cells[f], f, d) > MAX_STREAK) continue;
            cells[f][d] = CODE.WORK;
            var ev = evaluate(ctx, cells, target);
            if (ev.cost < cur.cost) { cur = ev; improved = true; cover++; resters.splice(r, 1); r--; if (cover >= need) break; }
            else cells[f][d] = CODE.REST;
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
        // C. 同日交換（平衡目標 / 一週上限 / 連續天數）
        for (var a = 0; a < workers.length; a++) {
          var ew = workers[a];
          for (var b = 0; b < resters.length; b++) {
            var er = resters[b];
            if (runIfWork(ctx, cells[er], er, d) > MAX_STREAK) continue;
            cells[ew][d] = CODE.REST; cells[er][d] = CODE.WORK;
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

  /**
   * 產生排班表。
   * opts: { year, month, roster:[id], prefs:{id:{day:'R'|'S'}}, balances:{id:number},
   *         perDay, prev:{year,month,cells}|null, attempt:number, restarts:number }
   */
  function generate(opts) {
    var ctx = buildContext(opts);
    var targets = computeTargets(ctx);
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
      var s = { W: 0, R: 0, S: 0, B: 0, P: 0, empty: 0 };
      for (var d = 1; d <= D; d++) {
        var c = getCell(cells, e, d);
        if (c === CODE.EMPTY) s.empty++; else s[c] = (s[c] || 0) + 1;
      }
      stats[e] = s;
    }
    return stats;
  }

  // 本月每人「一般休假 − 平均」；正值 = 多休
  function restDeltas(cells, roster, D) {
    var stats = countCodes(cells, roster, D);
    var sum = 0, n = 0;
    for (var e in stats) { if (Object.prototype.hasOwnProperty.call(stats, e)) { sum += stats[e].R; n++; } }
    var mean = n ? sum / n : 0;
    var out = {};
    for (var k in stats) { if (Object.prototype.hasOwnProperty.call(stats, k)) out[k] = stats[k].R - mean; }
    return { deltas: out, mean: mean, stats: stats };
  }

  function fmtDate(m, d, wd) {
    var names = ['日', '一', '二', '三', '四', '五', '六'];
    return m + '/' + d + '（' + names[wd] + '）';
  }

  /**
   * 驗證排班表，回傳 issues 與需標示的儲存格。
   * opts: { year, month, roster, cells, perDay, prev, next, names:{id:name} }
   */
  function validate(opts) {
    var ctx = buildContext({ year: opts.year, month: opts.month, roster: opts.roster, prefs: {}, perDay: opts.perDay, prev: opts.prev });
    var D = ctx.D, roster = ctx.roster, need = ctx.perDay;
    var names = opts.names || {};
    var nm = function (e) { return names[e] || e; };
    var issues = [];
    var flagged = {};   // "e:d" -> true
    var cover = new Array(D + 1).fill(0);
    var i, e, d;

    for (i = 0; i < roster.length; i++) {
      e = roster[i];
      var run = ctx.prevStreak[e] || 0;
      var runStart = run > 0 ? 1 - run : null;
      var week = {};
      var weekDays = {};
      for (d = 1; d <= D; d++) {
        var c = getCell(opts.cells, e, d);
        if (c === CODE.WORK) {
          cover[d]++;
          if (ctx.fixedOff[d]) {
            issues.push({ type: 'fixedOff', day: d, employee: e, message: nm(e) + '：' + fmtDate(opts.month, d, ctx.weekdays[d]) + ' 為固定全員休息日，卻排了上班' });
            flagged[e + ':' + d] = true;
          }
          if (run === 0) runStart = d;
          run++;
          if (run > MAX_STREAK) {
            for (var k = Math.max(1, runStart); k <= d; k++) flagged[e + ':' + k] = true;
          }
          var w = ctx.weekIds[d];
          if (week[w] === undefined) { week[w] = (w === ctx.weekIds[1]) ? (ctx.prevWeekWork[e] || 0) : 0; weekDays[w] = []; }
          week[w]++;
          weekDays[w].push(d);
        } else {
          if (run > MAX_STREAK) {
            issues.push({ type: 'streak', employee: e, from: runStart, to: d - 1,
              message: nm(e) + '：' + rangeText(opts, ctx, runStart, d - 1) + ' 連續上班 ' + run + ' 天（超過 4 天上限）' });
          }
          run = 0;
        }
      }
      if (run > MAX_STREAK) {
        issues.push({ type: 'streak', employee: e, from: runStart, to: D,
          message: nm(e) + '：' + rangeText(opts, ctx, runStart, D) + ' 連續上班 ' + run + ' 天（超過 4 天上限）' });
      } else if (run > 0 && opts.next && opts.next.cells) {
        // 跨到下個月
        var lead = 0;
        var nd = daysInMonth(opts.next.year, opts.next.month);
        for (var q = 1; q <= nd; q++) { if (getCell(opts.next.cells, e, q) === CODE.WORK) lead++; else break; }
        if (run + lead > MAX_STREAK) {
          for (var k2 = Math.max(1, runStart); k2 <= D; k2++) flagged[e + ':' + k2] = true;
          issues.push({ type: 'streakNext', employee: e, from: runStart, to: D,
            message: nm(e) + '：' + rangeText(opts, ctx, runStart, D) + ' 起連續上班至 ' + opts.next.month + '/' + lead + '，共 ' + (run + lead) + ' 天（跨月超過 4 天上限）' });
        }
      }
      for (var wk in week) {
        if (Object.prototype.hasOwnProperty.call(week, wk) && week[wk] > WEEK_MAX) {
          var ds = weekDays[wk];
          issues.push({ type: 'weekOver', employee: e, week: wk,
            message: nm(e) + '：' + opts.month + '/' + ds[0] + '～' + opts.month + '/' + ds[ds.length - 1] + ' 當週上班 ' + week[wk] + ' 天（超過上四休三）' });
        }
      }
    }
    for (d = 1; d <= D; d++) {
      if (ctx.fixedOff[d]) continue;
      if (cover[d] < need) {
        issues.push({ type: 'shortage', day: d, missing: need - cover[d],
          message: fmtDate(opts.month, d, ctx.weekdays[d]) + ' 出勤人數不足：' + cover[d] + ' 人（需 ' + need + ' 人）' });
      } else if (cover[d] > need) {
        issues.push({ type: 'over', day: d, extra: cover[d] - need,
          message: fmtDate(opts.month, d, ctx.weekdays[d]) + ' 出勤人數 ' + cover[d] + ' 人，超過需求 ' + need + ' 人' });
      }
    }
    var order = { fixedOff: 0, streak: 1, streakNext: 1, shortage: 2, over: 3, weekOver: 4 };
    issues.sort(function (a, b) { return (order[a.type] - order[b.type]) || ((a.day || a.from || 0) - (b.day || b.from || 0)); });
    return { issues: issues, flagged: flagged, cover: cover, stats: countCodes(opts.cells, roster, D) };
  }

  function rangeText(opts, ctx, from, to) {
    var a = from < 1 ? '上月' + (daysInMonth.apply(null, [prevMonthOf(opts.year, opts.month).year, prevMonthOf(opts.year, opts.month).month]) + from) : opts.month + '/' + from;
    return a + '～' + opts.month + '/' + to;
  }

  // 排班前檢視：每日可出勤人數
  function availability(opts) {
    var ctx = buildContext({ year: opts.year, month: opts.month, roster: opts.roster, prefs: opts.prefs, perDay: opts.perDay });
    var perDayAvail = new Array(ctx.D + 1).fill(0);
    var total = 0;
    for (var d = 1; d <= ctx.D; d++) {
      if (ctx.fixedOff[d]) continue;
      for (var i = 0; i < ctx.roster.length; i++) {
        if (ctx.pref[ctx.roster[i]][d] === CODE.EMPTY) perDayAvail[d]++;
      }
      total += perDayAvail[d];
    }
    return { perDayAvail: perDayAvail, totalAvail: total, totalSlots: ctx.totalSlots, fixedOff: ctx.fixedOff, weekdays: ctx.weekdays, D: ctx.D };
  }

  return {
    CODE: CODE,
    MAX_STREAK: MAX_STREAK,
    WEEK_MAX: WEEK_MAX,
    FIXED_OFF_WEEKDAY: FIXED_OFF_WEEKDAY,
    START_YEAR: START_YEAR,
    START_MONTH: START_MONTH,
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
