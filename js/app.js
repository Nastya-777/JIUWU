/* 久吾動物醫院排班表 — 介面（第三版：以 28 天週期為單位） */
(function () {
  'use strict';

  var S = window.Scheduler;
  var L = window.Leave;
  var Store = window.JiuwuStore;
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  var SHORT = { W: '班', R: '休', S: '特', O: '加', C: '補', '': '' };
  var FULL = { W: '上班', R: '休息', S: '特休', O: '加班', C: '補休', '': '未選擇' };
  var PD = S.PERIOD_DAYS;

  /* ---------- 資料 ---------- */
  function defaultDb() { return { version: 3, employees: [], settings: { perDay: 2 }, periods: {}, holidays: {} }; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function freshDraft() { return Store.freshDraft(); }
  function todayDn() { var t = new Date(); return S.dayNumber(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
  function todayStr() { return S.isoOf(todayDn()); }
  function todayPeriod() { return Math.max(0, S.periodIndexOf(todayDn())); }

  var db = defaultDb();
  var ui = { period: todayPeriod(), brush: null };
  var downloadsCap = null;
  var ready = false;

  function persist() { if (ready) Store.save(db); }

  /* ---------- 員工 ---------- */
  function uid() { return 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function activeEmployees() { return db.employees.filter(function (e) { return !e.deleted; }); }
  function empById(id) { for (var i = 0; i < db.employees.length; i++) if (db.employees[i].id === id) return db.employees[i]; return null; }
  function nameMap() { var m = {}; db.employees.forEach(function (e) { m[e.id] = e.name; }); return m; }

  function addEmployee(name, hireDate) {
    name = String(name || '').trim();
    if (!name) { toast('請輸入員工姓名'); return Promise.resolve(false); }
    if (hireDate && !L.isValid(hireDate)) { toast('入職日期格式不正確'); return Promise.resolve(false); }
    var dup = activeEmployees().some(function (e) { return e.name === name; });
    var go = dup ? ask({ title: '同名員工', message: '已有同名員工「' + name + '」，仍要新增嗎？', okText: '仍要新增' }) : Promise.resolve(true);
    return go.then(function (yes) {
      if (!yes) return false;
      db.employees.push({ id: uid(), name: name, hireDate: hireDate || null, createdAt: Date.now(), deleted: false, deletedAt: null });
      persist();
      toast('已新增員工「' + name + '」');
      return true;
    });
  }
  function removeEmployee(id) {
    var e = empById(id);
    if (!e) return Promise.resolve(false);
    return ask({ title: '刪除員工', message: '確定刪除員工「' + e.name + '」？\n已生成的往期排班表仍會保留此員工的紀錄。', okText: '刪除', danger: true })
      .then(function (yes) {
        if (!yes) return false;
        e.deleted = true; e.deletedAt = Date.now();
        persist();
        toast('已刪除員工「' + e.name + '」');
        return true;
      });
  }
  function editEmployee(id) {
    var e = empById(id);
    if (!e) return Promise.resolve(false);
    return ask({ title: '修改員工資料', okText: '儲存', fields: [
      { id: 'name', label: '姓名', type: 'text', value: e.name, maxlength: 20 },
      { id: 'hire', label: '入職日期（用於計算特休）', type: 'date', value: e.hireDate || '' }
    ] }).then(function (v) {
      if (!v) return false;
      var name = String(v.name || '').trim();
      if (!name) { toast('姓名不可空白'); return false; }
      if (v.hire && !L.isValid(v.hire)) { toast('入職日期格式不正確'); return false; }
      e.name = name; e.hireDate = v.hire || null;
      persist();
      return true;
    });
  }

  /* ---------- 國定假日 ---------- */
  function allHolidayDates() { return Object.keys(db.holidays || {}).sort(); }
  // 某週期內的國定假日：day index → {name, closed}
  function holidaysInPeriod(idx) {
    var dates = S.periodDates(idx), out = {};
    for (var i = 1; i <= PD; i++) { var h = db.holidays && db.holidays[dates[i].iso]; if (h) out[i] = h; }
    return out;
  }
  function closedDaysFor(idx) {
    var h = holidaysInPeriod(idx);
    return Object.keys(h).filter(function (d) { return h[d].closed; }).map(Number);
  }
  function isOffDay(idx, d) {
    var t = S.periodDates(idx)[d];
    if (t.wd === S.FIXED_OFF_WEEKDAY) return true;
    var h = db.holidays && db.holidays[t.iso];
    return !!(h && h.closed);
  }
  function addHoliday(date, name, closed) {
    if (!L.isValid(date)) { toast('請選擇正確的日期'); return false; }
    name = String(name || '').trim() || '國定假日';
    db.holidays = db.holidays || {};
    db.holidays[date] = { name: name, closed: !!closed };
    persist();
    toast('已新增國定假日 ' + date + ' ' + name);
    return true;
  }
  function removeHoliday(date) {
    var h = db.holidays[date];
    if (!h) return Promise.resolve(false);
    return ask({ title: '刪除國定假日', message: '刪除 ' + date + '「' + h.name + '」？員工因此假日獲得的補休也會一併消失。', okText: '刪除', danger: true })
      .then(function (yes) { if (!yes) return false; delete db.holidays[date]; persist(); return true; });
  }

  /* ---------- 週期 ---------- */
  function periodYear(idx) { return S.dnToDate(S.periodStartDn(idx)).y; }
  function maxPeriodIndex() {
    var mx = todayPeriod() + 1;
    Object.keys(db.periods).forEach(function (k) { mx = Math.max(mx, S.periodIndexOfKey(k) + 1); });
    return Math.max(mx, ui.period);
  }
  function yearList() {
    var lastYear = Math.max(periodYear(maxPeriodIndex()), new Date().getFullYear() + 1);
    var out = [];
    for (var y = S.START_YEAR; y <= lastYear; y++) out.push(y);
    return out;
  }
  function periodsOfYear(y) {
    var out = [], idx = 0;
    while (periodYear(idx) < y) idx++;
    while (periodYear(idx) === y) { out.push(idx); idx++; }
    return out;
  }
  function getPeriod(idx) {
    var key = S.periodKey(idx);
    if (!db.periods[key]) db.periods[key] = { saved: null, working: freshDraft(), savedAt: null };
    if (!db.periods[key].working) db.periods[key].working = freshDraft();
    return db.periods[key];
  }
  function periodTitle(idx) { return S.periodLabel(idx); }
  function rosterFor(ms) {
    if (ms.phase === 'generated' && ms.roster) return ms.roster.slice();
    return activeEmployees().map(function (e) { return e.id; });
  }
  function canon(ms) { return Store.stableStringify(Store.normMonthState(ms || freshDraft())); }
  function isDirty(idx) { var m = getPeriod(idx); return canon(m.working) !== canon(m.saved || freshDraft()); }
  function hasContent(ms) {
    if (!ms) return false;
    if (ms.phase === 'generated') return true;
    return Object.keys(ms.prefs || {}).some(function (e) { return Object.keys(ms.prefs[e] || {}).length > 0; });
  }
  function periodState(idx) {
    var m = db.periods[S.periodKey(idx)];
    if (!m) return 'none';
    if (!m.saved && !hasContent(m.working)) return 'none';
    return isDirty(idx) ? 'dirty' : (m.saved ? 'saved' : 'dirty');
  }
  function generatedCells(idx) {
    var m = db.periods[S.periodKey(idx)];
    if (m && m.working && m.working.phase === 'generated' && m.working.cells) return { period: idx, cells: m.working.cells, roster: m.working.roster };
    return null;
  }
  function prevData(idx) { return idx > 0 ? generatedCells(idx - 1) : null; }
  function nextData(idx) { return generatedCells(idx + 1); }
  function balancesBefore(idx) {
    var out = {};
    Object.keys(db.periods).forEach(function (k) {
      var i = S.periodIndexOfKey(k);
      if (i >= idx) return;
      var g = generatedCells(i);
      if (!g) return;
      var rd = S.restDeltas(g.cells, g.roster || Object.keys(g.cells), PD);
      Object.keys(rd.deltas).forEach(function (e) { out[e] = (out[e] || 0) + rd.deltas[e]; });
    });
    return out;
  }

  /* ---------- 假別帳（跨週期） ---------- */
  function leaveDates(e) {
    var out = { S: [], O: [], C: [] };
    Object.keys(db.periods).forEach(function (k) {
      var m = db.periods[k];
      if (!m || !m.working) return;
      var idx = S.periodIndexOfKey(k);
      var dates = S.periodDates(idx);
      var src = m.working.phase === 'generated' ? (m.working.cells && m.working.cells[e]) : (m.working.prefs && m.working.prefs[e]);
      if (!src) return;
      Object.keys(src).forEach(function (d) { var c = src[d]; if (out[c] && dates[+d]) out[c].push(dates[+d].iso); });
    });
    out.S.sort(); out.O.sort(); out.C.sort();
    return out;
  }
  function leaveInfo(e, atDate) {
    var emp = empById(e);
    var ld = leaveDates(e);
    var hire = emp && emp.hireDate ? emp.hireDate : null;
    var sp = hire ? L.specialStatus({ hireDate: hire, specialDates: ld.S, atDate: atDate }) : null;
    var cp = L.compStatus({ hireDate: hire, holidayDates: allHolidayDates(), overtimeDates: ld.O, compDates: ld.C, atDate: atDate });
    return { hire: hire, special: sp, comp: cp, dates: ld };
  }
  function leaveIssues(idx, roster, source, names) {
    var dates = S.periodDates(idx);
    var list = [];
    var hol = allHolidayDates();
    roster.forEach(function (e) {
      var emp = empById(e);
      var hire = emp && emp.hireDate ? emp.hireDate : null;
      var row = source[e] || {};
      var ld = leaveDates(e);
      var noHireWarned = false;
      Object.keys(row).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
        var c = row[d], t = dates[d];
        if (!t) return;
        var md = t.m + '/' + t.d;
        if (c === 'S') {
          if (!hire) {
            if (!noHireWarned) { list.push({ cls: 'warn', text: names[e] + '：尚未設定入職日期，無法計算特休天數（點姓名旁的 ✎ 設定）。' }); noHireWarned = true; }
            return;
          }
          var avail = L.specialAvailableOn({ hireDate: hire, specialDates: ld.S, date: t.iso });
          if (avail <= 0) list.push({ cls: 'err', text: names[e] + '：' + md + ' 特休超出剩餘天數（當時剩 ' + Math.max(0, avail) + ' 天）。' });
        } else if (c === 'C') {
          var ca = L.compAvailableOn({ hireDate: hire, holidayDates: hol, overtimeDates: ld.O, compDates: ld.C, date: t.iso });
          if (ca < 1) list.push({ cls: 'err', text: names[e] + '：' + md + ' 補休超出可用天數（當時可用 ' + Math.max(0, ca) + ' 天），補休不得早於發放日使用。' });
        }
      });
    });
    return list;
  }

  /* ---------- 生成 / 儲存 / 取消 ---------- */
  function generatePeriod(idx, attempt) {
    var ms = getPeriod(idx).working;
    var roster = activeEmployees().map(function (e) { return e.id; });
    if (!roster.length) { toast('請先新增員工，再生成排班表'); return; }
    var prefs = {};
    roster.forEach(function (e) {
      var pr = (ms.prefs && ms.prefs[e]) || {};
      prefs[e] = {};
      Object.keys(pr).forEach(function (d) { if (!isOffDay(idx, +d) && (pr[d] === 'R' || pr[d] === 'S' || pr[d] === 'C')) prefs[e][d] = pr[d]; });
    });
    var res = S.generate({ period: idx, roster: roster, prefs: prefs, balances: balancesBefore(idx), perDay: db.settings.perDay,
      closedDays: closedDaysFor(idx), prev: prevData(idx), attempt: attempt || 0 });
    ms.phase = 'generated'; ms.roster = roster; ms.cells = res.cells; ms.targets = res.targets;
    ms.attempt = attempt || 0; ms.perDay = db.settings.perDay; ms.generatedAt = Date.now();
    ui.brush = 'W';
    persist(); render();
    var n = Object.keys(res.shortages).length;
    if (n) toast('已生成，但有 ' + n + ' 天出勤人數不足，請查看下方提醒');
    else toast('排班表已生成，可直接編輯後儲存');
  }
  function savePeriod(idx) {
    var m = getPeriod(idx);
    m.saved = clone(m.working); m.savedAt = Date.now();
    persist(); render();
    toast('已儲存 ' + S.periodLabel(idx) + ' 的排班表');
  }
  function cancelPeriod(idx) {
    var m = getPeriod(idx);
    var msg = m.saved ? '將復原到上次儲存的狀態，之後的所有修改都會遺失。' : '本週期尚未儲存過，取消將清空本週期所有選擇與排班。';
    return ask({ title: '取消修改', message: msg, okText: '確定復原', danger: true }).then(function (yes) {
      if (!yes) return;
      m.working = m.saved ? clone(m.saved) : freshDraft();
      ui.brush = null;
      persist(); render();
      toast('已復原到上次儲存的狀態');
    });
  }
  function regeneratePeriod(idx) {
    var ms = getPeriod(idx).working;
    return ask({ title: '重新生成', message: '會以目前的員工與休假選擇重新排班，並覆蓋表格中的內容（可用「取消」復原到上次儲存）。', okText: '重新生成' })
      .then(function (yes) { if (yes) generatePeriod(idx, (ms.attempt || 0) + 1); });
  }
  function backToDraft(idx) {
    var m = getPeriod(idx);
    return ask({ title: '重新選擇休假', message: '會回到「選擇休假」步驟並捨棄目前生成的排班內容（已儲存的版本仍可用「取消」復原）。', okText: '回到選擇休假' })
      .then(function (yes) {
        if (!yes) return;
        var ms = m.working;
        ms.phase = 'draft'; ms.cells = null; ms.roster = null; ms.targets = null; ms.generatedAt = null;
        ui.brush = null;
        persist(); render();
      });
  }
  function clearPrefs(idx) {
    var ms = getPeriod(idx).working;
    if (!Object.keys(ms.prefs || {}).length) return;
    return ask({ title: '清除選擇', message: '清除本週期所有已選的休息、特休與補休？', okText: '清除' }).then(function (yes) {
      if (yes) { ms.prefs = {}; persist(); renderSchedule(); }
    });
  }

  /* ---------- 儲存格操作 ---------- */
  function applyCell(idx, e, d, code) {
    if (isOffDay(idx, d)) return;
    var ms = getPeriod(idx).working;
    if (ms.phase === 'draft') {
      ms.prefs = ms.prefs || {};
      ms.prefs[e] = ms.prefs[e] || {};
      if (code === '' || ms.prefs[e][d] === code) delete ms.prefs[e][d]; else ms.prefs[e][d] = code;
      if (!Object.keys(ms.prefs[e]).length) delete ms.prefs[e];
    } else {
      if (!ms.cells[e] || !code) return;
      ms.cells[e][d] = code;
    }
    persist();
    renderSchedule();
  }

  /* ---------- 渲染 ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function abs1(n) { return String(Math.round(Math.abs(n) * 10) / 10); }

  function render() { renderHeader(); renderEmployees(); renderHolidays(); renderSchedule(); }

  function renderHeader() {
    var y = periodYear(ui.period);
    var ys = document.getElementById('year-select');
    ys.innerHTML = yearList().map(function (yy) { return '<option value="' + yy + '"' + (yy === y ? ' selected' : '') + '>' + yy + ' 年</option>'; }).join('');
    var ps = document.getElementById('period-select');
    ps.innerHTML = periodsOfYear(y).map(function (idx) {
      var st = periodState(idx);
      var suffix = st === 'saved' ? ' ✓' : st === 'dirty' ? ' ●' : '';
      return '<option value="' + idx + '"' + (idx === ui.period ? ' selected' : '') + '>' + S.periodLabel(idx) + suffix + '</option>';
    }).join('');
    document.getElementById('per-day').value = db.settings.perDay;
  }

  function renderEmployees() {
    var list = document.getElementById('emp-list');
    var emps = activeEmployees();
    document.getElementById('emp-count').textContent = emps.length ? '共 ' + emps.length + ' 位' : '';
    if (!emps.length) { list.innerHTML = '<span class="emp-empty">尚未新增員工。輸入姓名與入職日期後按「新增員工」。</span>'; return; }
    list.innerHTML = emps.map(function (e) {
      var sub = e.hireDate ? '入職 ' + e.hireDate : '未設入職日';
      return '<span class="emp-chip' + (e.hireDate ? '' : ' nohire') + '" data-id="' + e.id + '" title="' + esc(sub) + '"><span class="name">' + esc(e.name) + '</span><span class="sub">' + esc(sub) + '</span>' +
        '<button type="button" class="ren" title="修改姓名與入職日期" aria-label="修改 ' + esc(e.name) + '">✎</button>' +
        '<button type="button" class="del" title="刪除員工" aria-label="刪除 ' + esc(e.name) + '">×</button></span>';
    }).join('');
  }

  function renderHolidays() {
    var year = periodYear(ui.period);
    document.getElementById('holiday-year').textContent = year + ' 年';
    var keys = allHolidayDates().filter(function (k) { return k.slice(0, 4) === String(year); });
    var list = document.getElementById('holiday-list');
    if (!keys.length) { list.innerHTML = '<span class="emp-empty">尚未設定 ' + year + ' 年的國定假日。</span>'; return; }
    list.innerHTML = keys.map(function (k) {
      var h = db.holidays[k];
      var p = k.split('-');
      var wd = WD[S.dnToDate(S.dayNumber(+p[0], +p[1], +p[2])).wd];
      return '<span class="hol-chip' + (h.closed ? ' closed' : '') + '" data-date="' + k + '"><span class="date">' + (+p[1]) + '/' + (+p[2]) + '（' + wd + '）</span><span class="name">' + esc(h.name) + '</span>' +
        (h.closed ? '<span class="tag">休診</span>' : '') +
        '<button type="button" class="del" title="刪除" aria-label="刪除 ' + k + '">×</button></span>';
    }).join('');
  }

  function buildTable(idx, opts) {
    opts = opts || {};
    var dates = S.periodDates(idx);
    var ms = getPeriod(idx).working;
    var roster = rosterFor(ms);
    var names = nameMap();
    var generated = ms.phase === 'generated';
    var perDay = generated ? (ms.perDay || db.settings.perDay) : db.settings.perDay;
    var hol = holidaysInPeriod(idx);
    var closed = closedDaysFor(idx);
    var validation = null, avail = null;
    if (generated) validation = S.validate({ period: idx, roster: roster, cells: ms.cells, perDay: perDay, closedDays: closed, prev: prevData(idx), next: nextData(idx), names: names });
    else avail = S.availability({ period: idx, roster: roster, prefs: ms.prefs || {}, perDay: perDay, closedDays: closed });
    var periodEnd = dates[PD].iso;
    var d, h = [], counts = {}, leave = {};

    h.push('<thead><tr><th class="name">員工</th>');
    for (d = 1; d <= PD; d++) {
      var t = dates[d], off = isOffDay(idx, d), hd = hol[d];
      var cls = 'day' + (hd ? ' holi' : '') + (off ? ' off' : '') + (t.d === 1 && d > 1 ? ' mstart' : '');
      var label = (d === 1 || t.d === 1) ? (t.m + '/' + t.d) : String(t.d);
      h.push('<th class="' + cls + '"' + (hd ? ' title="' + esc(hd.name) + (hd.closed ? '（休診）' : '') + '"' : '') + '><span class="dn">' + label + '</span><span class="dw">' + WD[t.wd] + '</span>' + (hd ? '<span class="hm">' + (hd.closed ? '休診' : '假') + '</span>' : '') + '</th>');
    }
    if (generated) h.push('<th class="stat">上班</th><th class="stat">休息</th><th class="stat">特休</th><th class="stat">補休</th><th class="stat">加班</th><th class="stat" title="依入職年資計算，至本週期結束的剩餘特休天數">剩餘特休</th><th class="stat" title="國定假日與加班取得的補休，扣除已使用後至本週期結束的剩餘天數">剩餘補休</th>');
    else h.push('<th class="stat">已選休息</th><th class="stat">特休</th><th class="stat">補休</th><th class="stat" title="依入職年資計算，至本週期結束的剩餘特休天數">剩餘特休</th><th class="stat" title="國定假日與加班取得的補休，扣除已使用後至本週期結束的剩餘天數">剩餘補休</th>');
    h.push('</tr></thead><tbody>');
    if (!roster.length) h.push('<tr class="empty-row"><td colspan="' + (PD + 6) + '">尚未新增員工。請先在上方新增員工，再選擇休假並生成排班表。</td></tr>');

    roster.forEach(function (e) {
      var emp = empById(e), gone = emp && emp.deleted;
      h.push('<tr><td class="name" title="' + esc(names[e] || '') + '">' + esc(names[e] || '（未知）') + (gone ? '<span class="gone">已刪除</span>' : '') + '</td>');
      var cnt = { W: 0, R: 0, S: 0, O: 0, C: 0, selR: 0 };
      for (d = 1; d <= PD; d++) {
        var offD = isOffDay(idx, d), t2 = dates[d];
        var code = generated ? ((ms.cells[e] && ms.cells[e][d]) || '') : ((ms.prefs && ms.prefs[e] && ms.prefs[e][d]) || '');
        if (offD) code = 'R';
        if (cnt[code] !== undefined) cnt[code]++;
        if (!offD && code === 'R') cnt.selR++;
        var cls2 = 'cell c-' + (code || 'E') + (offD ? ' wed' : '') + (hol[d] ? ' holi' : '') + (t2.d === 1 && d > 1 ? ' mstart' : '') + (validation && validation.flagged[e + ':' + d] ? ' flag' : '');
        var attrs = (opts.forExport || offD) ? '' : ' tabindex="0" role="button" data-e="' + e + '" data-d="' + d + '" aria-label="' + esc(names[e] || '') + ' ' + t2.m + '/' + t2.d + ' ' + FULL[code] + '"';
        h.push('<td class="' + cls2 + '"' + attrs + '>' + SHORT[code] + '</td>');
      }
      counts[e] = cnt;
      var li = leaveInfo(e, periodEnd);
      leave[e] = li;
      var spTxt = li.special ? String(li.special.remaining) : '<span class="dim" title="未設定入職日期">—</span>';
      var cpTxt = String(li.comp.remaining);
      if (generated) {
        h.push('<td class="stat">' + cnt.W + '</td><td class="stat">' + cnt.R + '</td><td class="stat">' + cnt.S + '</td><td class="stat">' + cnt.C + '</td><td class="stat">' + cnt.O + '</td>' +
          '<td class="stat bal' + (li.special && li.special.remaining < 0 ? ' neg' : '') + '">' + spTxt + '</td><td class="stat bal' + (li.comp.remaining < 0 ? ' neg' : '') + '">' + cpTxt + '</td>');
      } else {
        h.push('<td class="stat">' + cnt.selR + '</td><td class="stat">' + cnt.S + '</td><td class="stat">' + cnt.C + '</td>' +
          '<td class="stat bal' + (li.special && li.special.remaining < 0 ? ' neg' : '') + '">' + spTxt + '</td><td class="stat bal' + (li.comp.remaining < 0 ? ' neg' : '') + '">' + cpTxt + '</td>');
      }
      h.push('</tr>');
    });
    h.push('</tbody>');
    if (roster.length) {
      h.push('<tfoot><tr><th class="name">' + (generated ? '出勤人數' : '可出勤') + '</th>');
      for (d = 1; d <= PD; d++) {
        if (isOffDay(idx, d)) { h.push('<td class="wed">–</td>'); continue; }
        var n = generated ? validation.cover[d] : avail.perDayAvail[d];
        h.push('<td' + (n < perDay ? ' class="short"' : '') + '>' + n + '</td>');
      }
      h.push('<td class="stat" colspan="' + (generated ? 7 : 5) + '"></td></tr></tfoot>');
    }
    return { html: h.join(''), validation: validation, avail: avail, roster: roster, perDay: perDay, generated: generated, counts: counts, leave: leave, names: names, holidays: hol, dates: dates };
  }

  function renderSchedule() {
    var idx = ui.period;
    var m = getPeriod(idx), ms = m.working;
    var generated = ms.phase === 'generated';
    var dirty = isDirty(idx);
    var t = buildTable(idx);
    var offCount = 0; for (var d = 1; d <= PD; d++) if (isOffDay(idx, d)) offCount++;
    var workable = PD - offCount;

    document.getElementById('sched-title').textContent = periodTitle(idx);
    document.getElementById('sched-meta').textContent = workable + ' 個營業日';
    document.getElementById('pager-label').textContent = S.periodLabel(idx);
    document.getElementById('pager-prev').disabled = idx <= 0;

    var badge = document.getElementById('status-badge');
    if (!generated) { badge.className = 'badge draft'; badge.textContent = dirty ? '選擇休假中（未儲存）' : '步驟一：選擇休假'; }
    else if (dirty) { badge.className = 'badge dirty'; badge.textContent = '有未儲存的變更'; }
    else { badge.className = 'badge saved'; badge.textContent = '已儲存' + (m.savedAt ? ' · ' + new Date(m.savedAt).toLocaleString('zh-TW', { hour12: false }) : ''); }

    var step = document.getElementById('step-area'), brushes;
    if (!generated) {
      if (['R', 'S', 'C'].indexOf(ui.brush) < 0) ui.brush = 'R';
      brushes = [['R', '休息'], ['S', '特休'], ['C', '補休']];
      step.innerHTML = '<span class="step-label"><strong>步驟一</strong> 選擇種類後點表格中的日期，再點一次可取消；不選擇則視為服從安排</span>';
    } else {
      if (['W', 'R', 'S', 'C', 'O'].indexOf(ui.brush) < 0) ui.brush = 'W';
      brushes = [['W', '上班'], ['R', '休息'], ['S', '特休'], ['C', '補休'], ['O', '加班']];
      step.innerHTML = '<span class="step-label"><strong>步驟二</strong> 選擇種類後點表格即可修改，完成後按「儲存」</span>';
    }
    step.innerHTML += '<div class="brushes" role="group" aria-label="編輯種類">' + brushes.map(function (b) {
      return '<button type="button" class="brush" data-brush="' + b[0] + '" aria-pressed="' + (ui.brush === b[0]) + '"><span class="sw sw-' + b[0] + '"></span>' + b[1] + '</button>';
    }).join('') + '</div>';

    var act = document.getElementById('action-area');
    if (!generated) {
      act.innerHTML =
        '<button type="button" class="btn btn-primary" data-act="generate">生成排班表</button>' +
        '<button type="button" class="btn" data-act="clear-prefs">清除所有選擇</button>' +
        '<button type="button" class="btn" data-act="save"' + (dirty ? '' : ' disabled') + '>儲存選擇</button>' +
        '<button type="button" class="btn btn-ghost" data-act="cancel"' + (dirty ? '' : ' disabled') + '>取消</button>';
    } else {
      act.innerHTML =
        '<button type="button" class="btn btn-primary" data-act="save"' + (dirty ? '' : ' disabled') + '>儲存</button>' +
        '<button type="button" class="btn" data-act="cancel"' + (dirty ? '' : ' disabled') + '>取消</button>' +
        '<button type="button" class="btn" data-act="regenerate">重新生成</button>' +
        '<button type="button" class="btn btn-ghost" data-act="back">重新選擇休假</button>' +
        '<span class="sep"></span>' +
        '<select class="select-btn" id="export-select" aria-label="匯出格式"' + (dirty || !m.saved ? ' title="請先儲存後再匯出"' : '') + '>' +
        '<option value="">匯出…</option><option value="pdf">匯出 PDF</option><option value="png">匯出 PNG</option><option value="xlsx">匯出 XLSX</option></select>';
    }

    document.getElementById('grid').innerHTML = t.html;
    document.getElementById('legend').innerHTML =
      '<span><span class="sw sw-W"></span>上班</span><span><span class="sw sw-R"></span>休息</span><span><span class="sw sw-S"></span>特休</span>' +
      '<span><span class="sw sw-C"></span>補休</span><span><span class="sw sw-O"></span>加班</span><span><span class="hm-legend">假</span>國定假日</span>';

    var list = [];
    var N = t.roster.length;
    var holKeys = Object.keys(t.holidays).map(Number).sort(function (a, b) { return a - b; });
    if (holKeys.length) list.push({ cls: '', text: '本週期國定假日：' + holKeys.map(function (dd) { var tt = t.dates[dd]; return tt.m + '/' + tt.d + ' ' + t.holidays[dd].name + (t.holidays[dd].closed ? '（休診）' : ''); }).join('、') + '。' });
    if (N && !generated) {
      var a = t.avail, shortDays = [];
      for (var dd = 1; dd <= PD; dd++) if (!isOffDay(idx, dd) && a.perDayAvail[dd] < t.perDay) shortDays.push(t.dates[dd].m + '/' + t.dates[dd].d);
      if (shortDays.length) list.push({ cls: 'warn', text: '以下日期可出勤人數少於 ' + t.perDay + ' 人：' + shortDays.join('、') + '。生成後這些日子會出勤不足。' });
      if (a.totalAvail < a.totalSlots) list.push({ cls: 'warn', text: '本週期總可出勤人日 ' + a.totalAvail + ' 少於需求 ' + a.totalSlots + '（' + t.perDay + ' 人 × ' + workable + ' 天），部分日子將無法排滿，缺人會優先安排在週二、週四。' });
      if (N * 4 < t.perDay * 6) list.push({ cls: 'warn', text: '員工人數不足以維持上四休三與每週期 16 天上限：每週需 ' + (t.perDay * 6) + ' 人日，' + N + ' 人每週最多 ' + (N * 4) + ' 人日。缺人會優先安排在週二、週四。' });
      var fairRest = workable - (t.perDay * workable) / N;
      if (fairRest > 0) {
        var fr = Math.round(fairRest);
        t.roster.forEach(function (e) {
          var sel = t.counts[e].selR;
          if (!sel) return;
          if (sel > fairRest + 1) list.push({ cls: 'warn', text: t.names[e] + '：已選 ' + sel + ' 天休息，超過本週期每人平均可休的約 ' + fr + ' 天（固定休息日除外），其他人將需多上班。' });
          else if (sel < fairRest - 1) list.push({ cls: '', text: t.names[e] + '：只選了 ' + sel + ' 天休息，少於每人平均約 ' + fr + ' 天，其餘由系統安排。' });
        });
      }
      list = list.concat(leaveIssues(idx, t.roster, ms.prefs || {}, t.names));
      if (idx > 0 && !prevData(idx) && db.periods[S.periodKey(idx - 1)]) list.push({ cls: '', text: '上一週期尚未生成排班表，跨週期的連續上班天數將無法檢查。' });
      if (!list.some(function (i) { return i.cls; })) list.push({ cls: 'ok', text: '員工可在表格中點選本週期想休的日子（休息、特休或補休），不選擇則視為服從安排。準備好後按「生成排班表」。' });
    }
    if (generated) {
      t.validation.issues.forEach(function (i) { list.push({ cls: (i.type === 'over') ? 'warn' : 'err', text: i.message }); });
      list = list.concat(leaveIssues(idx, t.roster, ms.cells || {}, t.names));
      if (N >= 2) {
        var rd = S.restDeltas(ms.cells, t.roster, PD).deltas;
        t.roster.forEach(function (e) {
          var dl = rd[e] || 0;
          if (dl >= 2) list.push({ cls: 'warn', text: t.names[e] + '：本週期休息 ' + t.counts[e].R + ' 天，比平均多 ' + abs1(dl) + ' 天（下週期會少排休）。' });
          else if (dl <= -2) list.push({ cls: 'warn', text: t.names[e] + '：本週期休息 ' + t.counts[e].R + ' 天，比平均少 ' + abs1(dl) + ' 天（下週期會多排休）。' });
        });
      }
    }
    document.getElementById('issues').innerHTML = list.map(function (i) { return '<div class="issue ' + i.cls + '">' + esc(i.text) + '</div>'; }).join('');
    renderHeader();
    renderHolidays();
  }

  /* ---------- 匯出 ---------- */
  function fileBase(idx) { var dts = S.periodDates(idx); return 'JIUWU_schedule_' + dts[1].iso + '_' + dts[PD].iso; }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function saveFile(blob, filename) {
    if (downloadsCap) {
      return downloadsCap.save({ filename: filename, data: blob }).then(function () { return true; }, function (err) {
        if (err && err.code === 'declined') return false;
        throw err;
      });
    }
    downloadBlob(blob, filename);
    return Promise.resolve(true);
  }
  function buildExportDom(idx) {
    var root = document.getElementById('export-root');
    var t = buildTable(idx, { forExport: true });
    var m = getPeriod(idx);
    var offCount = 0; for (var d = 1; d <= PD; d++) if (isOffDay(idx, d)) offCount++;
    var stamp = new Date().toLocaleString('zh-TW', { hour12: false });
    var year = periodYear(idx);
    root.innerHTML =
      '<p class="x-title">久吾動物醫院 排班表　' + S.periodLabel(idx) + '</p>' +
      '<p class="x-meta">' + (PD - offCount) + ' 個營業日 · 每日 ' + t.perDay + ' 人出勤' + (m.savedAt ? ' · 儲存於 ' + new Date(m.savedAt).toLocaleString('zh-TW', { hour12: false }) : '') + '</p>' +
      '<table class="grid">' + t.html + '</table>' +
      '<div class="legend"><span><span class="sw sw-W"></span>班＝上班</span><span><span class="sw sw-R"></span>休＝休息</span><span><span class="sw sw-S"></span>特＝特休</span><span><span class="sw sw-C"></span>補＝補休</span><span><span class="sw sw-O"></span>加＝加班</span><span><span class="hm-legend">假</span>國定假日</span></div>' +
      '<div class="x-foot"><span>列印時間 ' + stamp + '</span><span>© ' + year + ' KE FEI. All rights reserved.</span></div>';
    return root;
  }
  function renderCanvas(idx) {
    var el = buildExportDom(idx);
    return html2canvas(el, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true })
      .then(function (canvas) { el.innerHTML = ''; return canvas; }, function (err) { el.innerHTML = ''; throw err; });
  }
  function canvasBlob(canvas, type, q) {
    return new Promise(function (resolve, reject) { canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('toBlob')); }, type, q); });
  }
  function exportPNG(idx) {
    toast('正在產生 PNG…');
    return renderCanvas(idx).then(function (canvas) { return canvasBlob(canvas, 'image/png'); })
      .then(function (blob) { return saveFile(blob, fileBase(idx) + '.png'); })
      .then(function (ok) { toast(ok ? 'PNG 已儲存' : '已取消'); })
      .catch(function () { toast('PNG 產生失敗'); });
  }
  function exportPDF(idx) {
    toast('正在產生 PDF…');
    return renderCanvas(idx).then(function (canvas) {
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      var pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      var margin = 8, w = pw - margin * 2, pageH = ph - margin * 2;
      var scale = w / canvas.width, fullH = canvas.height * scale;
      if (fullH <= pageH) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, w, fullH);
      } else {
        var slicePx = Math.floor(pageH / scale), y = 0, first = true;
        while (y < canvas.height) {
          var hPx = Math.min(slicePx, canvas.height - y);
          var c = document.createElement('canvas');
          c.width = canvas.width; c.height = hPx;
          var cx = c.getContext('2d');
          cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, c.width, c.height);
          cx.drawImage(canvas, 0, y, canvas.width, hPx, 0, 0, canvas.width, hPx);
          if (!first) pdf.addPage();
          pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, w, hPx * scale);
          first = false; y += hPx;
        }
      }
      return saveFile(pdf.output('blob'), fileBase(idx) + '.pdf');
    }).then(function (ok) { toast(ok ? 'PDF 已儲存' : '已取消'); })
      .catch(function () { toast('PDF 產生失敗'); });
  }
  function exportXLSX(idx) {
    var t = buildTable(idx, { forExport: true });
    var ms = getPeriod(idx).working;
    var perDay = ms.perDay || db.settings.perDay;
    var aoa = [];
    aoa.push(['久吾動物醫院 排班表 ' + S.periodLabel(idx)]);
    var head = ['員工'];
    for (var d = 1; d <= PD; d++) head.push(t.dates[d].m + '/' + t.dates[d].d + ' ' + WD[t.dates[d].wd] + (t.holidays[d] ? ' 假' : ''));
    head.push('上班', '休息', '特休', '補休', '加班', '剩餘特休', '剩餘補休');
    aoa.push(head);
    var cover = new Array(PD + 1).fill(0);
    t.roster.forEach(function (e) {
      var row = [t.names[e] || ''];
      for (var dd = 1; dd <= PD; dd++) {
        var code = isOffDay(idx, dd) ? 'R' : ((ms.cells[e] && ms.cells[e][dd]) || '');
        if (S.isWork(code)) cover[dd]++;
        row.push(SHORT[code]);
      }
      var c = t.counts[e], li = t.leave[e];
      row.push(c.W, c.R, c.S, c.C, c.O, li.special ? li.special.remaining : '未設入職日', li.comp.remaining);
      aoa.push(row);
    });
    var foot = ['出勤人數'];
    for (var d2 = 1; d2 <= PD; d2++) foot.push(isOffDay(idx, d2) ? '–' : cover[d2]);
    aoa.push(foot);
    aoa.push([]);
    aoa.push(['說明：班＝上班、休＝休息、特＝特休、補＝補休、加＝加班；每日 ' + perDay + ' 人出勤；連續上班不超過 4 天；每個 28 天週期出勤不超過 16 天。']);
    aoa.push(['© ' + periodYear(idx) + ' KE FEI. All rights reserved.']);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 14 }].concat(new Array(PD).fill({ wch: 8 })).concat(new Array(7).fill({ wch: 8 }));
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 12 } }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, S.periodDates(idx)[1].iso + '～' + S.periodDates(idx)[PD].iso);
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return saveFile(blob, fileBase(idx) + '.xlsx')
      .then(function (ok) { toast(ok ? 'XLSX 已儲存' : '已取消'); })
      .catch(function () { toast('XLSX 產生失敗'); });
  }
  function exportGate(idx) {
    var m = getPeriod(idx);
    if (m.working.phase !== 'generated') { toast('請先生成排班表'); return false; }
    if (!m.saved || isDirty(idx)) { toast('請先儲存排班表，再進行匯出'); return false; }
    return true;
  }

  /* ---------- 備份 / 還原 ---------- */
  function backup() {
    var blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    saveFile(blob, 'JIUWU_backup_' + new Date().toISOString().slice(0, 10) + '.json')
      .then(function (ok) { if (ok) toast('備份檔已儲存'); })
      .catch(function () { toast('備份失敗'); });
  }
  function restoreFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.employees) || (typeof data.periods !== 'object' && typeof data.months !== 'object')) throw new Error('bad');
      } catch (e) { toast('這不是有效的備份檔'); return; }
      ask({ title: '還原資料', message: '還原將以備份檔內容取代目前的所有資料。', okText: '還原', danger: true }).then(function (yes) {
        if (!yes) return;
        db = Store.normalize(data);
        delete db.migratedFromMonths;
        ui.brush = null;
        persist(); render();
        toast('資料已還原');
      });
    };
    reader.readAsText(file);
  }

  /* ---------- 對話框 / 提示 ---------- */
  function ask(opts) {
    return new Promise(function (resolve) {
      var m = document.getElementById('modal');
      var title = document.getElementById('modal-title'), msg = document.getElementById('modal-msg');
      var fieldsEl = document.getElementById('modal-fields');
      var ok = document.getElementById('modal-ok'), cancel = document.getElementById('modal-cancel');
      title.textContent = opts.title || '';
      msg.textContent = opts.message || '';
      msg.hidden = !opts.message;
      var fields = opts.fields || [];
      fieldsEl.innerHTML = fields.map(function (f) {
        return '<label class="modal-field"><span>' + esc(f.label) + '</span><input id="mf-' + f.id + '" type="' + (f.type || 'text') + '" value="' + esc(f.value || '') + '"' + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '></label>';
      }).join('');
      fieldsEl.hidden = !fields.length;
      ok.textContent = opts.okText || '確定';
      cancel.textContent = opts.cancelText || '取消';
      ok.className = 'btn ' + (opts.danger ? 'btn-danger-solid' : 'btn-primary');
      m.hidden = false;
      var collect = function () {
        if (!fields.length) return true;
        var out = {};
        fields.forEach(function (f) { out[f.id] = document.getElementById('mf-' + f.id).value; });
        return out;
      };
      var done = function (val) { m.hidden = true; ok.onclick = cancel.onclick = m.onclick = m.onkeydown = null; resolve(val); };
      ok.onclick = function () { done(collect()); };
      cancel.onclick = function () { done(fields.length ? null : false); };
      m.onclick = function (ev) { if (ev.target === m) cancel.onclick(); };
      m.onkeydown = function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); cancel.onclick(); }
        else if (ev.key === 'Enter' && fields.length && ev.target.tagName === 'INPUT') { ev.preventDefault(); ok.onclick(); }
      };
      setTimeout(function () { var first = fieldsEl.querySelector('input'); (first || ok).focus(); }, 0);
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  function renderSyncStatus(st) {
    var el = document.getElementById('sync-status');
    var note = document.getElementById('data-note');
    if (st.mode === 'firebase') {
      el.className = 'sync ' + (st.connected ? 'on' : 'off');
      el.textContent = st.connected ? '共用資料庫：已連線' : '共用資料庫：連線中斷，暫存於此裝置';
      el.title = st.error || '所有開啟此網頁的人共用同一份資料';
      if (note) note.textContent = '資料保存在共用資料庫，所有開啟此網頁的人都會看到同一份內容並可修改。備份檔可在需要時用來還原。';
    } else {
      el.className = 'sync';
      el.textContent = '資料僅保存在此裝置';
      el.title = '若要多人共用，請設定 config.js 的 Firebase';
    }
  }

  /* ---------- 事件 ---------- */
  function setPeriod(idx) {
    if (idx < 0) { idx = 0; toast('排班從 2026/9/1 開始'); }
    ui.period = idx;
    ui.brush = null;
    renderSchedule();
  }
  document.getElementById('year-select').addEventListener('change', function () {
    var y = parseInt(this.value, 10);
    var list = periodsOfYear(y);
    setPeriod(list.length ? list[0] : ui.period);
  });
  document.getElementById('period-select').addEventListener('change', function () { setPeriod(parseInt(this.value, 10)); });
  document.getElementById('pager').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-nav]');
    if (!b) return;
    setPeriod(ui.period + parseInt(b.getAttribute('data-nav'), 10));
  });
  document.getElementById('per-day').addEventListener('change', function () {
    var v = parseInt(this.value, 10);
    if (!(v >= 1 && v <= 20)) { v = 2; this.value = 2; }
    db.settings.perDay = v;
    persist();
    renderSchedule();
  });
  document.getElementById('emp-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = document.getElementById('emp-name'), hire = document.getElementById('emp-hire');
    addEmployee(input.value, hire.value).then(function (added) {
      if (added) { input.value = ''; hire.value = ''; render(); }
      input.focus();
    });
  });
  document.getElementById('emp-list').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    var id = btn.closest('.emp-chip').getAttribute('data-id');
    var p = btn.classList.contains('del') ? removeEmployee(id) : btn.classList.contains('ren') ? editEmployee(id) : Promise.resolve(false);
    p.then(function (changed) { if (changed) render(); });
  });
  document.getElementById('holiday-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var date = document.getElementById('holiday-date'), name = document.getElementById('holiday-name'), closed = document.getElementById('holiday-closed');
    if (addHoliday(date.value, name.value, closed.checked)) { name.value = ''; closed.checked = false; render(); }
  });
  document.getElementById('holiday-list').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button.del');
    if (!btn) return;
    removeHoliday(btn.closest('.hol-chip').getAttribute('data-date')).then(function (changed) { if (changed) render(); });
  });
  document.getElementById('step-area').addEventListener('click', function (ev) {
    var b = ev.target.closest('.brush');
    if (!b) return;
    ui.brush = b.getAttribute('data-brush');
    this.querySelectorAll('.brush').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });
  document.getElementById('action-area').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b) return;
    var idx = ui.period;
    switch (b.getAttribute('data-act')) {
      case 'generate': generatePeriod(idx, 0); break;
      case 'regenerate': regeneratePeriod(idx); break;
      case 'clear-prefs': clearPrefs(idx); break;
      case 'save': savePeriod(idx); break;
      case 'cancel': cancelPeriod(idx); break;
      case 'back': backToDraft(idx); break;
    }
  });
  document.getElementById('action-area').addEventListener('change', function (ev) {
    var sel = ev.target.closest('#export-select');
    if (!sel) return;
    var fmt = sel.value;
    sel.value = '';
    if (!fmt) return;
    if (!exportGate(ui.period)) return;
    if (fmt === 'pdf') exportPDF(ui.period);
    else if (fmt === 'png') exportPNG(ui.period);
    else if (fmt === 'xlsx') exportXLSX(ui.period);
  });
  var grid = document.getElementById('grid');
  function onCellActivate(td) {
    if (!td || !td.hasAttribute('data-e')) return;
    var e = td.getAttribute('data-e'), d = td.getAttribute('data-d');
    applyCell(ui.period, e, parseInt(d, 10), ui.brush || '');
    var again = grid.querySelector('td[data-e="' + e + '"][data-d="' + d + '"]');
    if (again) again.focus({ preventScroll: true });
  }
  grid.addEventListener('click', function (ev) { onCellActivate(ev.target.closest('td.cell')); });
  grid.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { var td = ev.target.closest('td.cell'); if (td) { ev.preventDefault(); onCellActivate(td); } }
  });
  document.getElementById('btn-backup').addEventListener('click', backup);
  document.getElementById('btn-restore').addEventListener('click', function () { document.getElementById('restore-file').click(); });
  document.getElementById('restore-file').addEventListener('change', function () {
    if (this.files && this.files[0]) restoreFromFile(this.files[0]);
    this.value = '';
  });

  /* ---------- 啟動 ---------- */
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then(function (d) { downloadsCap = d || null; }, function () { downloadsCap = null; });
  }
  document.getElementById('holiday-date').value = todayStr();
  Store.onStatus(renderSyncStatus);
  Store.onRemoteChange(function (data) { db = data; delete db.migratedFromMonths; render(); toast('資料已由其他裝置更新'); });
  Store.init(window.JIUWU_CONFIG || {}).then(function (res) {
    db = res.data || defaultDb();
    if (!db.holidays) db.holidays = {};
    if (!db.periods) db.periods = {};
    delete db.migratedFromMonths;
    ready = true;
    if (res.offline) toast('無法連線共用資料庫，目前顯示此裝置暫存的資料');
    render();
  });
})();
