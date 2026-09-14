/*
 * 久吾動物醫院排班表 — 資料儲存層
 *
 * 兩種模式：
 *  - local    ：localStorage，只在這台裝置。
 *  - firebase ：Firebase Realtime Database REST + 即時串流（EventSource），所有人共用。
 *
 * 對外介面（window.JiuwuStore）：
 *   init(cfg)                → Promise<{ mode, data|null }>   載入資料
 *   save(db)                 → 依變更的部分（settings / employees / months/<key>）寫入
 *   onRemoteChange(fn)       → 其他裝置修改時呼叫 fn(db)
 *   onStatus(fn)             → 連線狀態變化：fn({mode, connected, error})
 *   loadUi() / saveUi(ui)    → 介面狀態（永遠只存本機）
 */
(function (root) {
  'use strict';

  var LOCAL_KEY = 'jiuwu_schedule_v1';
  var UI_KEY = 'jiuwu_schedule_ui_v1';

  var mode = 'local';
  var base = '';                 // firebase: <databaseURL>/<path>
  var lastSynced = {};           // 上次寫入 / 收到的各部分 JSON 字串
  var remoteHandlers = [];
  var statusHandlers = [];
  var status = { mode: 'local', connected: false, error: null };
  var pending = {};              // path -> value（待寫入）
  var flushTimer = null;
  var current = null;            // 最近一次的完整資料（供比較）
  var es = null;

  /* ---------- 工具 ---------- */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined && v[k] !== null; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
  }
  // Firebase 會把連續數字鍵的物件轉成陣列，這裡轉回物件
  function objectify(v) {
    if (Array.isArray(v)) {
      var o = {};
      v.forEach(function (x, i) { if (x !== null && x !== undefined) o[i] = x; });
      return o;
    }
    return v && typeof v === 'object' ? v : {};
  }
  function setStatus(patch) {
    status = Object.assign({}, status, patch);
    statusHandlers.forEach(function (fn) { try { fn(status); } catch (e) { /* ignore */ } });
  }
  function emitRemote(db) {
    remoteHandlers.forEach(function (fn) { try { fn(db); } catch (e) { /* ignore */ } });
  }

  /* ---------- 正規化 ---------- */
  function freshDraft() {
    return { phase: 'draft', prefs: {}, cells: null, roster: null, targets: null, attempt: 0, perDay: null, generatedAt: null };
  }
  function normMonthState(ms) {
    ms = ms && typeof ms === 'object' ? ms : {};
    var out = freshDraft();
    out.phase = ms.phase === 'generated' ? 'generated' : 'draft';
    var pr = objectify(ms.prefs);
    Object.keys(pr).forEach(function (e) {
      var row = objectify(pr[e]), r = {};
      Object.keys(row).forEach(function (d) { if (row[d] === 'R' || row[d] === 'S' || row[d] === 'C') r[d] = row[d]; });
      if (Object.keys(r).length) out.prefs[e] = r;
    });
    if (out.phase === 'generated') {
      out.cells = {};
      var c = objectify(ms.cells);
      Object.keys(c).forEach(function (e) {
        var row = objectify(c[e]), r = {};
        Object.keys(row).forEach(function (d) { if (row[d] === 'W' || row[d] === 'R' || row[d] === 'S' || row[d] === 'O' || row[d] === 'C') r[d] = row[d]; });
        out.cells[e] = r;
      });
      out.roster = Array.isArray(ms.roster) ? ms.roster.slice() : Object.keys(out.cells);
      out.targets = ms.targets && typeof ms.targets === 'object' ? ms.targets : {};
      out.attempt = ms.attempt || 0;
      out.perDay = ms.perDay || null;
      out.generatedAt = ms.generatedAt || null;
    }
    return out;
  }
  function normMonth(m) {
    m = m && typeof m === 'object' ? m : {};
    return {
      saved: m.saved ? normMonthState(m.saved) : null,
      working: normMonthState(m.working),
      savedAt: m.savedAt || null
    };
  }
  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    var out = { version: 2, employees: [], settings: { perDay: 2 }, months: {}, holidays: {} };
    var emps = Array.isArray(d.employees) ? d.employees : Object.keys(objectify(d.employees)).map(function (k) { return d.employees[k]; });
    emps.forEach(function (e) {
      if (e && e.id && typeof e.name === 'string') {
        var hire = /^\d{4}-\d{2}-\d{2}$/.test(String(e.hireDate || '')) ? e.hireDate : null;
        out.employees.push({ id: e.id, name: e.name, hireDate: hire, createdAt: e.createdAt || 0, deleted: !!e.deleted, deletedAt: e.deletedAt || null });
      }
    });
    var pd = parseInt(d.settings && d.settings.perDay, 10);
    out.settings.perDay = pd >= 1 && pd <= 20 ? pd : 2;
    var months = objectify(d.months);
    Object.keys(months).forEach(function (k) {
      if (/^\d{4}-\d{2}$/.test(k)) out.months[k] = normMonth(months[k]);
    });
    var hol = objectify(d.holidays);
    Object.keys(hol).forEach(function (k) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && hol[k]) {
        out.holidays[k] = { name: String(hol[k].name || '').slice(0, 30), closed: !!hol[k].closed };
      }
    });
    return out;
  }

  /* ---------- 本機 ---------- */
  function localLoad() {
    try { var raw = localStorage.getItem(LOCAL_KEY); if (raw) return normalize(JSON.parse(raw)); } catch (e) { /* ignore */ }
    return null;
  }
  function localSave(db) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); return true; } catch (e) { return false; }
  }
  function loadUi() {
    try { var raw = localStorage.getItem(UI_KEY); if (raw) return JSON.parse(raw) || {}; } catch (e) { /* ignore */ }
    return {};
  }
  function saveUi(ui) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* ignore */ }
  }

  /* ---------- Firebase REST ---------- */
  function fbUrl(path) { return base + (path ? '/' + path : '') + '.json'; }
  function fbGet() {
    return fetch(fbUrl(''), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function fbPut(path, value) {
    return fetch(fbUrl(path) + '?print=silent', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
  }
  function fbDelete(path) {
    return fetch(fbUrl(path) + '?print=silent', { method: 'DELETE' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
  }

  // 把資料拆成可個別寫入的部分
  function parts(db) {
    var out = { settings: db.settings, employees: db.employees, holidays: db.holidays || {} };
    Object.keys(db.months || {}).forEach(function (k) { out['months/' + k] = db.months[k]; });
    return out;
  }
  function queueChanged(db) {
    var p = parts(db);
    var changed = 0;
    Object.keys(p).forEach(function (path) {
      var s = stableStringify(p[path]);
      if (lastSynced[path] !== s) { pending[path] = p[path]; changed++; }
    });
    return changed;
  }
  function flush() {
    flushTimer = null;
    var paths = Object.keys(pending);
    if (!paths.length) return Promise.resolve();
    var batch = pending; pending = {};
    return Promise.all(paths.map(function (path) {
      var s = stableStringify(batch[path]);
      return fbPut(path, batch[path]).then(function () { lastSynced[path] = s; });
    })).then(function () {
      setStatus({ connected: true, error: null });
    }, function (err) {
      // 寫入失敗：放回佇列稍後重試
      paths.forEach(function (path) { if (!(path in pending)) pending[path] = batch[path]; });
      setStatus({ connected: false, error: String(err && err.message || err) });
      if (!flushTimer) flushTimer = setTimeout(flush, 5000);
    });
  }
  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 400);
  }

  function applyRemote(pathStr, data, isPatch) {
    var segs = pathStr.split('/').filter(Boolean);
    var db = current ? JSON.parse(JSON.stringify(current)) : { version: 2, employees: [], settings: { perDay: 2 }, months: {}, holidays: {} };
    if (segs.length === 0) {
      var whole = normalize(isPatch ? Object.assign({}, db, data || {}) : (data || {}));
      db = whole;
    } else {
      // 找到目標節點並設定
      var node = db;
      for (var i = 0; i < segs.length - 1; i++) {
        if (!node[segs[i]] || typeof node[segs[i]] !== 'object') node[segs[i]] = {};
        node = node[segs[i]];
      }
      var last = segs[segs.length - 1];
      if (isPatch) {
        if (!node[last] || typeof node[last] !== 'object') node[last] = {};
        Object.keys(data || {}).forEach(function (k) { if (data[k] === null) delete node[last][k]; else node[last][k] = data[k]; });
      } else if (data === null || data === undefined) {
        delete node[last];
      } else {
        node[last] = data;
      }
      db = normalize(db);
    }
    // 是否真的與本機不同
    var before = current ? stableStringify(current) : '';
    var after = stableStringify(db);
    current = db;
    var p = parts(db);
    Object.keys(p).forEach(function (k) { lastSynced[k] = stableStringify(p[k]); });
    Object.keys(lastSynced).forEach(function (k) { if (!(k in p)) delete lastSynced[k]; });
    if (before !== after) { localSave(db); emitRemote(db); }
  }

  function openStream() {
    if (typeof EventSource === 'undefined') return;
    if (es) { try { es.close(); } catch (e) { /* ignore */ } }
    es = new EventSource(fbUrl(''));
    es.addEventListener('put', function (ev) {
      try { var msg = JSON.parse(ev.data); applyRemote(msg.path || '/', msg.data, false); } catch (e) { /* ignore */ }
      setStatus({ connected: true, error: null });
    });
    es.addEventListener('patch', function (ev) {
      try { var msg = JSON.parse(ev.data); applyRemote(msg.path || '/', msg.data, true); } catch (e) { /* ignore */ }
    });
    es.addEventListener('cancel', function () { setStatus({ connected: false, error: 'stream cancelled' }); });
    es.addEventListener('auth_revoked', function () { setStatus({ connected: false, error: 'auth revoked' }); });
    es.onerror = function () { setStatus({ connected: false, error: 'stream error' }); };
    es.onopen = function () { setStatus({ connected: true, error: null }); };
  }

  /* ---------- 對外 ---------- */
  function init(cfg) {
    cfg = cfg || {};
    var fb = cfg.firebase || {};
    if (cfg.storage === 'firebase' && fb.databaseURL) {
      mode = 'firebase';
      base = String(fb.databaseURL).replace(/\/+$/, '') + '/' + String(fb.path || 'jiuwu_schedule').replace(/^\/+|\/+$/g, '');
      setStatus({ mode: 'firebase', connected: false, error: null });
      return fbGet().then(function (data) {
        var db = normalize(data || {});
        current = db;
        var p = parts(db);
        Object.keys(p).forEach(function (k) { lastSynced[k] = stableStringify(p[k]); });
        localSave(db);
        setStatus({ connected: true, error: null });
        openStream();
        return { mode: mode, data: db, empty: !data };
      }).catch(function (err) {
        // 連不上：先用本機快取，並持續嘗試串流
        setStatus({ connected: false, error: String(err && err.message || err) });
        var cached = localLoad();
        current = cached;
        openStream();
        return { mode: mode, data: cached, offline: true };
      });
    }
    mode = 'local';
    setStatus({ mode: 'local', connected: true, error: null });
    var db = localLoad();
    current = db;
    return Promise.resolve({ mode: mode, data: db });
  }

  function save(db) {
    current = db;
    localSave(db);
    if (mode === 'firebase') {
      if (queueChanged(db)) scheduleFlush();
    }
  }

  function onRemoteChange(fn) { remoteHandlers.push(fn); }
  function onStatus(fn) { statusHandlers.push(fn); fn(status); }

  root.JiuwuStore = {
    init: init, save: save, onRemoteChange: onRemoteChange, onStatus: onStatus,
    loadUi: loadUi, saveUi: saveUi, normalize: normalize, normMonthState: normMonthState,
    stableStringify: stableStringify, freshDraft: freshDraft,
    getMode: function () { return mode; }
  };
})(typeof window !== 'undefined' ? window : this);
