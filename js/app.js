/* JIUWU_animal_hospital_schedule — 介面與資料 */
(function () {
  'use strict';

  var S = window.Scheduler;
  var KEY = 'jiuwu_schedule_v1';
  var START_KEY = S.monthKey(S.START_YEAR, S.START_MONTH);
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  var SHORT = { W: '班', R: '休', S: '特', B: '病', P: '事', '': '' };
  var FULL = { W: '上班', R: '休假', S: '特休', B: '病假', P: '事假', '': '服從安排' };

  /* ---------- 資料 ---------- */
  function defaultDb() {
    return { version: 1, employees: [], settings: { perDay: 2 }, months: {}, ui: { currentMonth: START_KEY } };
  }
  function migrate(d) {
    var base = defaultDb();
    if (!d || typeof d !== 'object') return base;
    d.version = 1;
    d.employees = Array.isArray(d.employees) ? d.employees : [];
    d.settings = Object.assign(base.settings, d.settings || {});
    d.months = d.months && typeof d.months === 'object' ? d.months : {};
    d.ui = Object.assign(base.ui, d.ui || {});
    return d;
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return migrate(JSON.parse(raw));
    } catch (e) { /* 忽略損毀資料 */ }
    return defaultDb();
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('無法寫入瀏覽器儲存空間，資料可能不會保留'); }
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function freshDraft() {
    return { phase: 'draft', prefs: {}, cells: null, roster: null, targets: null, attempt: 0, perDay: null, generatedAt: null };
  }

  var db = load();
  var ui = { month: db.ui.currentMonth || START_KEY, brush: null };

  /* ---------- 員工 ---------- */
  function uid() { return 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function activeEmployees() { return db.employees.filter(function (e) { return !e.deleted; }); }
  function empById(id) { for (var i = 0; i < db.employees.length; i++) if (db.employees[i].id === id) return db.employees[i]; return null; }
  function empName(id) { var e = empById(id); return e ? e.name : '（未知）'; }
  function nameMap() { var m = {}; db.employees.forEach(function (e) { m[e.id] = e.name; }); return m; }

  function addEmployee(name) {
    name = String(name || '').trim();
    if (!name) { toast('請輸入員工姓名'); return false; }
    var dup = activeEmployees().some(function (e) { return e.name === name; });
    if (dup && !confirm('已有同名員工「' + name + '」，仍要新增嗎？')) return false;
    db.employees.push({ id: uid(), name: name, createdAt: Date.now(), deleted: false });
    persist();
    toast('已新增員工「' + name + '」');
    return true;
  }
  function removeEmployee(id) {
    var e = empById(id);
    if (!e) return;
    if (!confirm('確定刪除員工「' + e.name + '」？\n已生成的往期排班表仍會保留此員工的紀錄。')) return;
    e.deleted = true;
    e.deletedAt = Date.now();
    persist();
    toast('已刪除員工「' + e.name + '」');
  }
  function renameEmployee(id) {
    var e = empById(id);
    if (!e) return;
    var name = prompt('修改員工姓名', e.name);
    if (name == null) return;
    name = name.trim();
    if (!name) { toast('姓名不可空白'); return; }
    e.name = name;
    persist();
  }

  /* ---------- 月份 ---------- */
  function todayKey() { var t = new Date(); return S.monthKey(t.getFullYear(), t.getMonth() + 1); }
  function addMonths(key, n) {
    var p = S.parseMonthKey(key);
    var y = p.year, m = p.month;
    while (n-- > 0) { var nx = S.nextMonthOf(y, m); y = nx.year; m = nx.month; }
    return S.monthKey(y, m);
  }
  function monthList() {
    var last = START_KEY;
    Object.keys(db.months).forEach(function (k) { if (S.compareMonthKey(k, last) > 0) last = k; });
    var t = todayKey();
    if (S.compareMonthKey(t, last) > 0) last = t;
    if (S.compareMonthKey(ui.month, last) > 0) last = ui.month;
    last = addMonths(last, 1);
    var out = [], k = START_KEY;
    while (S.compareMonthKey(k, last) <= 0) { out.push(k); k = addMonths(k, 1); }
    return out;
  }
  function getMonth(key) {
    if (!db.months[key]) db.months[key] = { saved: null, working: freshDraft() };
    if (!db.months[key].working) db.months[key].working = freshDraft();
    return db.months[key];
  }
  function monthLabel(key) { var p = S.parseMonthKey(key); return p.year + ' 年 ' + p.month + ' 月'; }
  function rosterFor(ms) {
    if (ms.phase === 'generated' && ms.roster) return ms.roster.slice();
    return activeEmployees().map(function (e) { return e.id; });
  }
  function isDirty(key) {
    var m = getMonth(key);
    var base = m.saved || freshDraft();
    return JSON.stringify(m.working) !== JSON.stringify(base);
  }
  function monthState(key) {
    var m = db.months[key];
    if (!m || !m.working) return 'none';
    if (m.working.phase !== 'generated' && !m.saved && Object.keys(m.working.prefs || {}).every(function (e) { return !Object.keys(m.working.prefs[e] || {}).length; })) return 'none';
    return isDirty(key) ? 'dirty' : (m.saved ? 'saved' : 'dirty');
  }

  function generatedCells(key) {
    var m = db.months[key];
    if (m && m.working && m.working.phase === 'generated' && m.working.cells) {
      var p = S.parseMonthKey(key);
      return { year: p.year, month: p.month, cells: m.working.cells, roster: m.working.roster };
    }
    return null;
  }
  function prevData(key) { var p = S.parseMonthKey(key); var pm = S.prevMonthOf(p.year, p.month); return generatedCells(S.monthKey(pm.year, pm.month)); }
  function nextData(key) { var p = S.parseMonthKey(key); var nm = S.nextMonthOf(p.year, p.month); return generatedCells(S.monthKey(nm.year, nm.month)); }

  // 本月之前的累計休假結餘（正值 = 過去多休）
  function balancesBefore(key) {
    var out = {};
    Object.keys(db.months).sort().forEach(function (k) {
      if (S.compareMonthKey(k, key) >= 0) return;
      var g = generatedCells(k);
      if (!g) return;
      var D = S.daysInMonth(g.year, g.month);
      var rd = S.restDeltas(g.cells, g.roster || Object.keys(g.cells), D);
      Object.keys(rd.deltas).forEach(function (e) { out[e] = (out[e] || 0) + rd.deltas[e]; });
    });
    return out;
  }

  /* ---------- 生成 / 儲存 / 取消 ---------- */
  function generateMonth(key, attempt) {
    var p = S.parseMonthKey(key);
    var m = getMonth(key);
    var ms = m.working;
    var roster = activeEmployees().map(function (e) { return e.id; });
    if (!roster.length) { toast('請先新增員工，再生成排班表'); return; }
    var prefs = {};
    roster.forEach(function (e) {
      var pr = (ms.prefs && ms.prefs[e]) || {};
      prefs[e] = {};
      Object.keys(pr).forEach(function (d) {
        if (!S.isFixedOff(p.year, p.month, +d) && (pr[d] === 'R' || pr[d] === 'S')) prefs[e][d] = pr[d];
      });
    });
    var res = S.generate({
      year: p.year, month: p.month, roster: roster, prefs: prefs,
      balances: balancesBefore(key), perDay: db.settings.perDay,
      prev: prevData(key), attempt: attempt || 0
    });
    ms.phase = 'generated';
    ms.roster = roster;
    ms.cells = res.cells;
    ms.targets = res.targets;
    ms.attempt = attempt || 0;
    ms.perDay = db.settings.perDay;
    ms.generatedAt = Date.now();
    ui.brush = 'W';
    persist();
    render();
    var n = Object.keys(res.shortages).length;
    if (n) toast('已生成，但有 ' + n + ' 天出勤人數不足，請查看下方提醒');
    else toast('排班表已生成，可直接編輯後儲存');
  }
  function saveMonth(key) {
    var m = getMonth(key);
    m.saved = clone(m.working);
    m.savedAt = Date.now();
    persist();
    render();
    toast('已儲存 ' + monthLabel(key) + ' 的排班表');
  }
  function cancelMonth(key) {
    var m = getMonth(key);
    var msg = m.saved
      ? '取消將復原到上次儲存的狀態，之後的所有編輯都會遺失。確定？'
      : '本月尚未儲存過，取消將清空本月所有選擇與排班。確定？';
    if (!confirm(msg)) return;
    m.working = m.saved ? clone(m.saved) : freshDraft();
    ui.brush = null;
    persist();
    render();
    toast('已復原');
  }
  function backToDraft(key) {
    var m = getMonth(key);
    if (!confirm('回到「選擇休假」步驟會捨棄目前生成的排班內容（已儲存的版本仍可用「取消」復原）。確定？')) return;
    var ms = m.working;
    ms.phase = 'draft';
    ms.cells = null; ms.roster = null; ms.targets = null; ms.generatedAt = null;
    ui.brush = null;
    persist();
    render();
  }

  /* ---------- 儲存格操作 ---------- */
  function applyCell(key, e, d, code) {
    var p = S.parseMonthKey(key);
    if (S.isFixedOff(p.year, p.month, d)) return;
    var ms = getMonth(key).working;
    if (ms.phase === 'draft') {
      ms.prefs = ms.prefs || {};
      ms.prefs[e] = ms.prefs[e] || {};
      if (code === '' || ms.prefs[e][d] === code) delete ms.prefs[e][d]; else ms.prefs[e][d] = code;
      if (!Object.keys(ms.prefs[e]).length) delete ms.prefs[e];
    } else {
      if (!ms.cells[e]) return;
      ms.cells[e][d] = code;
    }
    persist();
    renderSchedule();
  }

  /* ---------- 渲染 ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt1(n) { var r = Math.round(n * 10) / 10; return (r > 0 ? '+' : '') + r.toFixed(1); }

  function render() { renderHeader(); renderEmployees(); renderSchedule(); }

  function renderHeader() {
    var sel = document.getElementById('month-select');
    var list = monthList();
    sel.innerHTML = list.map(function (k) {
      var st = monthState(k);
      var suffix = st === 'saved' ? '　✓ 已儲存' : st === 'dirty' ? '　● 未儲存' : '';
      return '<option value="' + k + '"' + (k === ui.month ? ' selected' : '') + '>' + monthLabel(k) + suffix + '</option>';
    }).join('');
    document.getElementById('per-day').value = db.settings.perDay;
  }

  function renderEmployees() {
    var list = document.getElementById('emp-list');
    var emps = activeEmployees();
    document.getElementById('emp-count').textContent = emps.length ? '共 ' + emps.length + ' 位' : '';
    if (!emps.length) {
      list.innerHTML = '<span class="emp-empty">尚未新增員工。輸入姓名後按「新增員工」。</span>';
      return;
    }
    list.innerHTML = emps.map(function (e) {
      return '<span class="emp-chip" data-id="' + e.id + '"><span class="name">' + esc(e.name) + '</span>' +
        '<button type="button" class="ren" title="修改姓名" aria-label="修改 ' + esc(e.name) + ' 的姓名">✎</button>' +
        '<button type="button" class="del" title="刪除員工" aria-label="刪除 ' + esc(e.name) + '">×</button></span>';
    }).join('');
  }

  function buildTable(key, opts) {
    opts = opts || {};
    var p = S.parseMonthKey(key), year = p.year, month = p.month;
    var D = S.daysInMonth(year, month);
    var m = getMonth(key), ms = m.working;
    var roster = rosterFor(ms);
    var names = nameMap();
    var generated = ms.phase === 'generated';
    var perDay = generated ? (ms.perDay || db.settings.perDay) : db.settings.perDay;
    var validation = null, avail = null;
    if (generated) {
      validation = S.validate({ year: year, month: month, roster: roster, cells: ms.cells, perDay: perDay, prev: prevData(key), next: nextData(key), names: names });
    } else {
      avail = S.availability({ year: year, month: month, roster: roster, prefs: ms.prefs || {}, perDay: perDay });
    }
    var balBefore = balancesBefore(key);
    var deltas = generated ? S.restDeltas(ms.cells, roster, D).deltas : {};
    var d, h = [];

    // 表頭
    h.push('<thead><tr><th class="name">員工</th>');
    for (d = 1; d <= D; d++) {
      var wd = S.weekday(year, month, d);
      var wed = S.isFixedOff(year, month, d);
      h.push('<th class="day' + (wed ? ' wed' : '') + '"><span class="dn">' + d + '</span><span class="dw">' + WD[wd] + '</span></th>');
    }
    if (generated) {
      h.push('<th class="stat">上班</th><th class="stat">休假</th><th class="stat">特休</th><th class="stat">病假</th><th class="stat">事假</th><th class="stat" title="累計休假結餘：正值代表至今多休，下月會少排休；負值則下月多排休">結餘</th>');
    } else {
      h.push('<th class="stat">預選休</th><th class="stat">特休</th><th class="stat" title="過去月份累計的休假結餘">結餘</th>');
    }
    h.push('</tr></thead><tbody>');

    if (!roster.length) {
      h.push('<tr class="empty-row"><td colspan="' + (D + 4) + '">尚未新增員工。請先在上方新增員工，再選擇休假並生成排班表。</td></tr>');
    }

    roster.forEach(function (e) {
      var emp = empById(e);
      var gone = emp && emp.deleted;
      h.push('<tr><td class="name" title="' + esc(names[e] || '') + '">' + esc(names[e] || '（未知）') + (gone ? '<span class="gone">已刪除</span>' : '') + '</td>');
      var cnt = { W: 0, R: 0, S: 0, B: 0, P: 0 };
      for (d = 1; d <= D; d++) {
        var wed = S.isFixedOff(year, month, d);
        var code;
        if (generated) code = (ms.cells[e] && ms.cells[e][d]) || '';
        else code = (ms.prefs && ms.prefs[e] && ms.prefs[e][d]) || '';
        if (wed) code = 'R';
        if (cnt[code] !== undefined) cnt[code]++;
        var cls = 'cell c-' + (code || 'E') + (wed ? ' wed' : '') + (validation && validation.flagged[e + ':' + d] ? ' flag' : '');
        var attrs = opts.forExport || wed ? '' : ' tabindex="0" role="button" data-e="' + e + '" data-d="' + d + '" aria-label="' + esc(names[e] || '') + ' ' + month + '/' + d + ' ' + FULL[code] + '"';
        h.push('<td class="' + cls + '"' + attrs + '>' + SHORT[code] + '</td>');
      }
      if (generated) {
        var bal = (balBefore[e] || 0) + (deltas[e] || 0);
        var tgt = ms.targets && ms.targets[e] != null ? ' title="目標上班 ' + ms.targets[e] + ' 天"' : '';
        h.push('<td class="stat"' + tgt + '>' + cnt.W + '</td><td class="stat">' + cnt.R + '</td><td class="stat">' + cnt.S + '</td><td class="stat">' + cnt.B + '</td><td class="stat">' + cnt.P + '</td>' +
          '<td class="stat bal ' + (bal > 0.05 ? 'pos' : bal < -0.05 ? 'neg' : '') + '">' + fmt1(bal) + '</td>');
      } else {
        var bb = balBefore[e] || 0;
        h.push('<td class="stat">' + cnt.R + '</td><td class="stat">' + cnt.S + '</td><td class="stat bal ' + (bb > 0.05 ? 'pos' : bb < -0.05 ? 'neg' : '') + '">' + fmt1(bb) + '</td>');
      }
      h.push('</tr>');
    });
    h.push('</tbody>');

    // 表尾：每日出勤 / 可出勤人數
    if (roster.length) {
      h.push('<tfoot><tr><th class="name">' + (generated ? '出勤人數' : '可出勤') + '</th>');
      for (d = 1; d <= D; d++) {
        var isWed = S.isFixedOff(year, month, d);
        if (isWed) { h.push('<td class="wed">–</td>'); continue; }
        var n = generated ? validation.cover[d] : avail.perDayAvail[d];
        var cls2 = n < perDay ? ' class="short"' : (generated && n > perDay ? ' class="over"' : '');
        h.push('<td' + cls2 + '>' + n + '</td>');
      }
      h.push('<td class="stat" colspan="' + (generated ? 6 : 3) + '"></td></tr></tfoot>');
    }
    return { html: h.join(''), validation: validation, avail: avail, roster: roster, perDay: perDay, D: D, generated: generated };
  }

  function renderSchedule() {
    var key = ui.month;
    var p = S.parseMonthKey(key);
    var m = getMonth(key), ms = m.working;
    var generated = ms.phase === 'generated';
    var dirty = isDirty(key);
    var t = buildTable(key);

    document.getElementById('sched-title').textContent = monthLabel(key);
    var wedCount = 0; for (var d = 1; d <= t.D; d++) if (S.isFixedOff(p.year, p.month, d)) wedCount++;
    document.getElementById('sched-meta').textContent = '每日 ' + t.perDay + ' 人出勤 · ' + (t.D - wedCount) + ' 個營業日 · ' + wedCount + ' 個週三全員休';

    var badge = document.getElementById('status-badge');
    if (!generated) { badge.className = 'badge draft'; badge.textContent = dirty ? '選擇休假中（未儲存）' : '步驟一：選擇休假'; }
    else if (dirty) { badge.className = 'badge dirty'; badge.textContent = '有未儲存的變更'; }
    else { badge.className = 'badge saved'; badge.textContent = '已儲存' + (m.savedAt ? ' · ' + new Date(m.savedAt).toLocaleString('zh-TW', { hour12: false }) : ''); }

    // 步驟說明與筆刷
    var step = document.getElementById('step-area');
    var brushes;
    if (!generated) {
      if (ui.brush == null || ui.brush === 'W' || ui.brush === 'B' || ui.brush === 'P') ui.brush = 'R';
      brushes = [['R', '休假'], ['S', '特休'], ['', '服從安排']];
      step.innerHTML = '<span class="step-label"><strong>步驟一</strong> 選擇要塗的種類，再點表格中的日期（可略過，直接生成）</span>';
    } else {
      if (ui.brush == null || ui.brush === '') ui.brush = 'W';
      brushes = [['W', '上班'], ['R', '休假'], ['S', '特休'], ['B', '病假'], ['P', '事假']];
      step.innerHTML = '<span class="step-label"><strong>步驟二</strong> 編輯：選擇種類後點表格即可修改，完成後按「儲存」</span>';
    }
    step.innerHTML += '<div class="brushes" role="group" aria-label="編輯種類">' + brushes.map(function (b) {
      return '<button type="button" class="brush" data-brush="' + b[0] + '" aria-pressed="' + (ui.brush === b[0]) + '"><span class="sw sw-' + (b[0] || 'E') + '"></span>' + b[1] + '</button>';
    }).join('') + '</div>';

    // 動作按鈕
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
        '<button type="button" class="btn btn-sm" data-act="pdf">匯出 PDF</button>' +
        '<button type="button" class="btn btn-sm" data-act="png">匯出 PNG</button>' +
        '<button type="button" class="btn btn-sm" data-act="xlsx">匯出 XLSX</button>';
    }

    document.getElementById('grid').innerHTML = t.html;

    // 圖例
    var lg = document.getElementById('legend');
    var items = generated
      ? [['W', '上班'], ['R', '休假'], ['S', '特休（不計入上四休三）'], ['B', '病假（不計入）'], ['P', '事假（不計入）']]
      : [['R', '休假'], ['S', '特休（不計入上四休三）'], ['E', '空白＝服從安排']];
    lg.innerHTML = items.map(function (i) { return '<span><span class="sw sw-' + i[0] + '"></span>' + i[1] + '</span>'; }).join('') +
      '<span><span class="sw sw-wed"></span>週三全員休息</span>' +
      (generated ? '<span><span class="sw" style="box-shadow:inset 0 0 0 2px var(--warn)"></span>連續上班超過 4 天</span>' : '');

    // 提醒
    var issues = document.getElementById('issues');
    var list = [];
    if (t.roster.length && !generated) {
      var a = t.avail;
      var shortDays = [];
      for (var dd = 1; dd <= t.D; dd++) if (!S.isFixedOff(p.year, p.month, dd) && a.perDayAvail[dd] < t.perDay) shortDays.push(p.month + '/' + dd);
      if (shortDays.length) list.push({ cls: 'warn', text: '以下日期可出勤人數少於 ' + t.perDay + ' 人：' + shortDays.join('、') + '。生成後這些日子會出勤不足。' });
      if (a.totalAvail < a.totalSlots) list.push({ cls: 'warn', text: '本月總可出勤人日 ' + a.totalAvail + ' 少於需求 ' + a.totalSlots + '（' + t.perDay + ' 人 × ' + (t.D - wedCount) + ' 天），部分日子將無法排滿。' });
      if (activeEmployees().length && activeEmployees().length * 4 < t.perDay * 6) list.push({ cls: 'warn', text: '員工人數不足以維持上四休三：每週需 ' + (t.perDay * 6) + ' 人日，' + activeEmployees().length + ' 人每週最多 ' + (activeEmployees().length * 4) + ' 人日。' });
      var pd = prevData(key);
      var pm = S.prevMonthOf(p.year, p.month);
      if (!pd && S.compareMonthKey(key, START_KEY) > 0 && db.months[S.monthKey(pm.year, pm.month)]) list.push({ cls: '', text: '上個月尚未生成排班表，跨月連續上班天數將無法檢查。' });
      if (!list.length) list.push({ cls: 'ok', text: '員工可在表格中點選本月想休的日子（休假或特休）；不選則服從安排。準備好後按「生成排班表」。' });
    }
    if (generated) {
      t.validation.issues.forEach(function (i) {
        var cls = (i.type === 'streak' || i.type === 'streakNext' || i.type === 'shortage' || i.type === 'fixedOff') ? 'err' : 'warn';
        list.push({ cls: cls, text: i.message });
      });
      if (!t.validation.issues.length) list.push({ cls: 'ok', text: '排班符合所有規則：每日 ' + t.perDay + ' 人出勤、無人連續上班超過 4 天、每週不超過 4 天。' });
    }
    issues.innerHTML = list.map(function (i) { return '<div class="issue ' + i.cls + '">' + esc(i.text) + '</div>'; }).join('');
    renderHeader();
  }

  /* ---------- 匯出 ---------- */
  // 檔名使用英數，避免部分瀏覽器忽略含中文的下載檔名
  function fileBase(key) { return 'JIUWU_schedule_' + key; }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function buildExportDom(key) {
    var root = document.getElementById('export-root');
    var t = buildTable(key, { forExport: true });
    var p = S.parseMonthKey(key);
    var m = getMonth(key);
    var stamp = new Date().toLocaleString('zh-TW', { hour12: false });
    root.innerHTML =
      '<p class="x-title">JIUWU 動物醫院 排班表　' + monthLabel(key) + '</p>' +
      '<p class="x-meta">每日 ' + t.perDay + ' 人出勤 · 週三全員休息 · 連續上班不超過 4 天 · 上四休三' + (m.savedAt ? ' · 儲存於 ' + new Date(m.savedAt).toLocaleString('zh-TW', { hour12: false }) : '') + '</p>' +
      '<table class="grid">' + t.html + '</table>' +
      '<div class="legend"><span><span class="sw sw-W"></span>班＝上班</span><span><span class="sw sw-R"></span>休＝休假</span><span><span class="sw sw-S"></span>特＝特休</span><span><span class="sw sw-B"></span>病＝病假</span><span><span class="sw sw-P"></span>事＝事假</span><span><span class="sw sw-wed"></span>週三全員休息</span></div>' +
      '<div class="x-foot"><span>列印時間 ' + stamp + '</span><span>© ' + p.year + ' KE FEI. All rights reserved.</span></div>';
    return root;
  }
  function renderCanvas(key) {
    var el = buildExportDom(key);
    return html2canvas(el, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true })
      .then(function (canvas) { el.innerHTML = ''; return canvas; }, function (err) { el.innerHTML = ''; throw err; });
  }
  function exportPNG(key) {
    toast('正在產生 PNG…');
    renderCanvas(key).then(function (canvas) {
      canvas.toBlob(function (blob) { downloadBlob(blob, fileBase(key) + '.png'); toast('PNG 已下載'); }, 'image/png');
    }).catch(function () { toast('PNG 產生失敗'); });
  }
  function exportPDF(key) {
    toast('正在產生 PDF…');
    renderCanvas(key).then(function (canvas) {
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      var pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      var margin = 8;
      var w = pw - margin * 2;
      var pageH = ph - margin * 2;
      var scale = w / canvas.width;
      var fullH = canvas.height * scale;
      if (fullH <= pageH) {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, w, fullH);
      } else {
        var slicePx = Math.floor(pageH / scale);
        var y = 0, first = true;
        while (y < canvas.height) {
          var hPx = Math.min(slicePx, canvas.height - y);
          var c = document.createElement('canvas');
          c.width = canvas.width; c.height = hPx;
          if (!first) pdf.addPage();
          var cx = c.getContext('2d');
          cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, c.width, c.height);
          cx.drawImage(canvas, 0, y, canvas.width, hPx, 0, 0, canvas.width, hPx);
          pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, w, hPx * scale);
          first = false;
          y += hPx;
        }
      }
      pdf.save(fileBase(key) + '.pdf');
      toast('PDF 已下載');
    }).catch(function () { toast('PDF 產生失敗'); });
  }
  function exportXLSX(key) {
    var p = S.parseMonthKey(key);
    var D = S.daysInMonth(p.year, p.month);
    var ms = getMonth(key).working;
    var roster = rosterFor(ms);
    var names = nameMap();
    var perDay = ms.perDay || db.settings.perDay;
    var aoa = [];
    aoa.push(['JIUWU 動物醫院 排班表 ' + monthLabel(key)]);
    var head = ['員工'];
    for (var d = 1; d <= D; d++) head.push(p.month + '/' + d + ' ' + WD[S.weekday(p.year, p.month, d)]);
    head.push('上班', '休假', '特休', '病假', '事假');
    aoa.push(head);
    var cover = new Array(D + 1).fill(0);
    roster.forEach(function (e) {
      var row = [names[e] || ''];
      var cnt = { W: 0, R: 0, S: 0, B: 0, P: 0 };
      for (var dd = 1; dd <= D; dd++) {
        var code = S.isFixedOff(p.year, p.month, dd) ? 'R' : ((ms.cells[e] && ms.cells[e][dd]) || '');
        if (cnt[code] !== undefined) cnt[code]++;
        if (code === 'W') cover[dd]++;
        row.push(SHORT[code]);
      }
      row.push(cnt.W, cnt.R, cnt.S, cnt.B, cnt.P);
      aoa.push(row);
    });
    var foot = ['出勤人數'];
    for (var d2 = 1; d2 <= D; d2++) foot.push(S.isFixedOff(p.year, p.month, d2) ? '–' : cover[d2]);
    aoa.push(foot);
    aoa.push([]);
    aoa.push(['說明：班＝上班、休＝休假、特＝特休、病＝病假、事＝事假；週三固定全員休息；每日 ' + perDay + ' 人出勤；連續上班不超過 4 天。']);
    aoa.push(['© ' + p.year + ' KE FEI. All rights reserved.']);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 14 }].concat(new Array(D).fill({ wch: 7 })).concat(new Array(5).fill({ wch: 6 }));
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(D + 5, 12) } }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, p.year + '年' + p.month + '月');
    XLSX.writeFile(wb, fileBase(key) + '.xlsx');
    toast('XLSX 已下載');
  }

  /* ---------- 備份 / 還原 ---------- */
  function backup() {
    var blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'JIUWU_backup_' + new Date().toISOString().slice(0, 10) + '.json');
    toast('備份檔已下載');
  }
  function restoreFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.employees) || typeof data.months !== 'object') throw new Error('bad');
        if (!confirm('還原將以備份檔內容取代這台裝置上的所有資料。確定？')) return;
        db = migrate(data);
        ui.month = db.ui.currentMonth || START_KEY;
        ui.brush = null;
        persist();
        render();
        toast('資料已還原');
      } catch (e) {
        toast('這不是有效的備份檔');
      }
    };
    reader.readAsText(file);
  }

  /* ---------- 提示 ---------- */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* ---------- 事件 ---------- */
  document.getElementById('month-select').addEventListener('change', function () {
    ui.month = this.value;
    ui.brush = null;
    db.ui.currentMonth = ui.month;
    persist();
    renderSchedule();
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
    var input = document.getElementById('emp-name');
    if (addEmployee(input.value)) { input.value = ''; render(); }
    input.focus();
  });
  document.getElementById('emp-list').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button');
    if (!btn) return;
    var id = btn.closest('.emp-chip').getAttribute('data-id');
    if (btn.classList.contains('del')) removeEmployee(id);
    else if (btn.classList.contains('ren')) renameEmployee(id);
    render();
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
    var act = b.getAttribute('data-act');
    var key = ui.month;
    var ms = getMonth(key).working;
    switch (act) {
      case 'generate': generateMonth(key, 0); break;
      case 'regenerate':
        if (confirm('重新生成會以目前的員工與休假選擇重新排班，覆蓋目前表格中的內容。確定？')) generateMonth(key, (ms.attempt || 0) + 1);
        break;
      case 'clear-prefs':
        if (Object.keys(ms.prefs || {}).length && confirm('清除本月所有已選的休假與特休？')) { ms.prefs = {}; persist(); renderSchedule(); }
        break;
      case 'save': saveMonth(key); break;
      case 'cancel': cancelMonth(key); break;
      case 'back': backToDraft(key); break;
      case 'pdf': exportPDF(key); break;
      case 'png': exportPNG(key); break;
      case 'xlsx': exportXLSX(key); break;
    }
  });
  var grid = document.getElementById('grid');
  function onCellActivate(td) {
    if (!td || !td.hasAttribute('data-e')) return;
    applyCell(ui.month, td.getAttribute('data-e'), parseInt(td.getAttribute('data-d'), 10), ui.brush || '');
    var again = grid.querySelector('td[data-e="' + td.getAttribute('data-e') + '"][data-d="' + td.getAttribute('data-d') + '"]');
    if (again) again.focus({ preventScroll: true });
  }
  grid.addEventListener('click', function (ev) { onCellActivate(ev.target.closest('td.cell')); });
  grid.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      var td = ev.target.closest('td.cell');
      if (td) { ev.preventDefault(); onCellActivate(td); }
    }
  });
  document.getElementById('btn-backup').addEventListener('click', backup);
  document.getElementById('btn-restore').addEventListener('click', function () { document.getElementById('restore-file').click(); });
  document.getElementById('restore-file').addEventListener('change', function () {
    if (this.files && this.files[0]) restoreFromFile(this.files[0]);
    this.value = '';
  });
  render();
})();
