/* Orphan Draft UI: commissioner desk, owner draft room, local demo, Firebase live mode. */
(function () {
  var engine = window.OrphanDraftEngine;
  var cfg = window.ORPHAN_DRAFT_CONFIG || { adminPin: "", firebase: {}, closeToleranceMs: 500, draftPath: "orphanDrafts" };
  var POOLS = engine.POOLS;
  var adapter = null;
  var unsub = null;
  var demoSingleton = null;
  var liveSingleton = null;
  var pendingJoin = "";
  var pendingOpen = false;
  var didQuery = false;
  var nudgeLock = false;
  var toastTimer = 0;
  var ui = { q: "", pos: "all", sort: "rkOv", dir: 1, poolTab: "mlb", includeWon: false };
  var session = {
    mode: null,
    role: null,
    teamId: null,
    pinOk: sessionStorage.getItem("fl_od_pin") === "1",
    entered: false,
  };
  var defaultDir = {
    name: 1, mlbTeam: 1, position: 1, age: 1, rkOv: 1,
    fpts: -1, fpg: -1, ros: -1, contract: 1, originalSalary: -1,
  };
  var SAMPLE_TEAMS = [
    ["Alpha", 200, 40],
    ["Bravo", 180, 55],
    ["Charlie", 220, 30],
    ["Delta", 160, 45],
    ["Echo", 250, 25],
  ];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    var v = Math.round(Number(n) || 0);
    return (v < 0 ? "-$" : "$") + Math.abs(v);
  }
  function num(v, digits) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    if (!Number.isFinite(n)) return "—";
    if (digits == null) return String(Math.round(n) === n ? Math.round(n) : Math.round(n * 100) / 100);
    return n.toFixed(digits);
  }
  function formatClock(ms) {
    ms = Math.max(0, ms);
    if (ms < 10000) return (ms / 1000).toFixed(1);
    var sec = Math.ceil(ms / 1000);
    var m = Math.floor(sec / 60);
    var r = sec % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function domId(prefix, id) {
    return prefix + "-" + String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  }
  function liveConfigured() {
    var fb = cfg.firebase || {};
    return !!(fb.apiKey && fb.databaseURL);
  }
  function stateNow() {
    return adapter ? adapter.getState() : null;
  }
  function myTeam(state) {
    if (!state || !session.teamId) return null;
    return state.teams[session.teamId] || null;
  }
  function teamName(state, id) {
    var t = state.teams && state.teams[id];
    return t ? t.name : "Unknown";
  }
  function showToast(msg, isError) {
    var t = $("odToast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }
  function joinUrl(code) {
    var u = new URL(location.href);
    u.search = "";
    u.hash = "";
    var st = stateNow();
    if (session.mode === "demo") u.searchParams.set("demo", "1");
    else if (st && st.meta && st.meta.id) u.searchParams.set("draft", st.meta.id);
    u.searchParams.set("join", code);
    return u.toString();
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { showToast("Link copied."); }, function () {
        showToast(text);
      });
    }
    showToast(text);
    return Promise.resolve();
  }

  function act(action) {
    if (!adapter) return Promise.resolve({ ok: false, error: "Not connected." });
    return Promise.resolve(adapter.dispatch(action)).then(function (res) {
      if (!res) return res;
      if (!res.ok) {
        showToast(res.error || "That didn't save.", true);
        render();
      }
      else if (action.type === "import" && res.info) {
        var info = res.info;
        showToast("Imported " + info.added + " new, " + info.updated + " updated" + (info.skipped ? ", " + info.skipped + " left as-is" : "") + ".");
      }
      return res;
    }).catch(function (err) {
      showToast((err && err.message) || String(err), true);
      return { ok: false, error: String(err) };
    });
  }

  function setAdapter(next) {
    if (unsub) unsub();
    unsub = null;
    if (adapter && adapter !== next && adapter.close) adapter.close();
    adapter = next;
    if (adapter) unsub = adapter.subscribe(function () { render(); });
  }

  /* ---------- demo adapter (localStorage + Web Locks, shared across tabs) ---------- */
  function createDemoAdapter() {
    if (demoSingleton) return demoSingleton;
    var KEY = "fl_orphan_draft_v1";
    var LOCK = "fl-orphan-draft";
    var current = null;
    var listeners = [];
    var bc = null;
    try { bc = new BroadcastChannel("fl_orphan_draft"); } catch (e) { bc = null; }

    function read() {
      try {
        var raw = localStorage.getItem(KEY);
        return raw ? engine.normalize(JSON.parse(raw)) : null;
      } catch (e) { return null; }
    }
    function write(next) {
      localStorage.setItem(KEY, JSON.stringify(next));
      current = next;
    }
    function notify() {
      listeners.forEach(function (fn) {
        try { fn(current); } catch (e) { /* keep the room alive */ }
      });
    }
    function reload() {
      var next = read();
      if (next && current && next.rev === current.rev) return;
      if (!next && !current) return;
      current = next;
      notify();
    }
    if (bc) bc.onmessage = function () { reload(); };
    window.addEventListener("storage", function (e) {
      if (e.key === KEY) reload();
    });

    function withLock(fn) {
      if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, fn);
      return Promise.resolve(fn());
    }

    var api = {
      mode: "demo",
      now: function () { return Date.now(); },
      getState: function () { return current; },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      load: function () {
        current = read();
        return Promise.resolve(current);
      },
      dispatch: function (action) {
        return withLock(function () {
          var base = read();
          if (action.type === "create" && base && !action.replace) {
            current = base;
            return { ok: true, changed: false, state: base };
          }
          var result = engine.reduce(base, Object.assign({ now: Date.now() }, action));
          if (result.ok && result.changed && result.state) write(result.state);
          else current = base;
          return result;
        }).then(function (result) {
          if (result && result.ok && result.changed) {
            if (bc) bc.postMessage({ rev: result.state.rev });
            notify();
          }
          return result;
        });
      },
      nudge: function () {
        var s = current || read();
        if (!s || s.meta.status !== "live") return Promise.resolve();
        var now = Date.now();
        var due = POOLS.some(function (pool) {
          var a = s.auctions[pool];
          return a && a.status === "open" && !a.frozen && now >= a.endsAt;
        });
        if (!due) return Promise.resolve();
        return api.dispatch({ type: "tick" });
      },
      clockLabel: function () { return "this browser's clock"; },
    };
    demoSingleton = api;
    return api;
  }

  /* ---------- Firebase live adapter ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing && existing.dataset.loaded === "1") return resolve();
      if (existing) {
        existing.addEventListener("load", function () { resolve(); });
        existing.addEventListener("error", function () { reject(new Error("Could not load " + src)); });
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { s.dataset.loaded = "1"; resolve(); };
      s.onerror = function () { reject(new Error("Could not load Firebase (" + src + ").")); };
      document.head.appendChild(s);
    });
  }

  function createLiveAdapter() {
    if (liveSingleton) return liveSingleton;
    var fbCfg = cfg.firebase || {};
    var rootPath = (cfg.draftPath || "orphanDrafts").replace(/^\/+|\/+$/g, "");
    var db = null;
    var offset = 0;
    var current = null;
    var draftRef = null;
    var listeners = [];
    var ready = null;
    var inflight = false;
    var pendingFinish = false;
    var boundId = null;

    function serverNow() { return Date.now() + (offset || 0); }
    function notify() {
      listeners.forEach(function (fn) {
        try { fn(current); } catch (e) { /* ignore */ }
      });
    }
    function accept(val) {
      current = val ? engine.normalize(engine.clone(val)) : null;
      notify();
      maybeFinishClose();
    }
    function ensure() {
      if (ready) return ready;
      ready = loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js")
        .then(function () { return loadScript("https://www.gstatic.com/firebasejs/10.14.1/firebase-database-compat.js"); })
        .then(function () {
          if (!firebase.apps.length) {
            firebase.initializeApp({
              apiKey: fbCfg.apiKey,
              authDomain: fbCfg.authDomain || undefined,
              databaseURL: fbCfg.databaseURL,
              projectId: fbCfg.projectId || undefined,
            });
          }
          db = firebase.database();
          db.ref(".info/serverTimeOffset").on("value", function (snap) { offset = snap.val() || 0; });
        });
      return ready;
    }
    function bind(id) {
      if (draftRef) draftRef.off();
      boundId = id;
      draftRef = db.ref(rootPath + "/drafts/" + id);
      draftRef.on("value", function (snap) { accept(snap.val()); });
    }
    function clearInflight() {
      inflight = false;
      if (pendingFinish) {
        pendingFinish = false;
        maybeFinishClose();
      }
    }
    function maybeFinishClose() {
      if (!current) return;
      if (inflight) { pendingFinish = true; return; }
      var tol = cfg.closeToleranceMs == null ? 500 : cfg.closeToleranceMs;
      var pool = null;
      POOLS.forEach(function (name) {
        if (pool) return;
        var a = current.auctions[name];
        if (a && a.status === "closing" && typeof a.closeToken === "number") pool = name;
      });
      if (!pool) return;
      inflight = true;
      dispatch({ type: "awardClosing", pool: pool, tolerance: tol }).then(clearInflight, clearInflight);
    }
    function runTransaction(mutator) {
      var error = null;
      var abortedClean = false;
      return draftRef.transaction(function (snapshot) {
        if (snapshot && snapshot.__txn_retry) {
          error = "Draft data was unavailable. Try again.";
          abortedClean = false;
          return;
        }
        if (snapshot == null) {
          if (current) return { __txn_retry: true };
          error = "No draft on the server.";
          abortedClean = false;
          return;
        }
        var result = mutator(engine.normalize(engine.clone(snapshot)));
        if (!result || result.error || result.changed === false) {
          abortedClean = !!result && !result.error && result.changed === false;
          error = result && result.error;
          return;
        }
        abortedClean = false;
        error = null;
        return result.state;
      }).then(function (res) {
        if (!res || !res.committed) {
          if (abortedClean) return { ok: true, changed: false, state: current };
          return { ok: false, changed: false, error: error || "Not saved. Try again.", state: current };
        }
        return { ok: true, changed: true, state: res.snapshot.val() };
      });
    }
    function dispatch(action) {
      return ensure().then(function () {
        if (action.type === "create") {
          var fresh = engine.reduce(null, Object.assign({ now: serverNow(), replace: true }, action));
          var id = fresh.state.meta.id;
          return db.ref(rootPath + "/drafts/" + id).set(fresh.state).then(function () {
            return db.ref(rootPath + "/activeId").set(id);
          }).then(function () {
            bind(id);
            accept(fresh.state);
            return fresh;
          });
        }
        if (!draftRef) return { ok: false, error: "Not connected to a draft." };
        var stamped = Object.assign({}, action);
        if (stamped.type !== "awardClosing") stamped.now = serverNow();
        return runTransaction(function (snapshot) {
          return engine.reduce(snapshot, stamped);
        });
      });
    }
      function requestClose() {
      return runTransaction(function (base) {
        if (!base || base.meta.status !== "live") return { changed: false, state: base };
        var next = engine.clone(base);
        var now = serverNow();
        var marked = false;
        POOLS.forEach(function (pool) {
          var a = next.auctions[pool];
          if (!a || a.status !== "open" || a.frozen) return;
          if (now < a.endsAt) return;
          a.status = "closing";
          a.closeToken = firebase.database.ServerValue.TIMESTAMP;
          marked = true;
        });
        if (!marked) return { changed: false, state: base };
        next.rev = (base.rev || 0) + 1;
        return { ok: true, changed: true, state: next };
      });
    }

    var api = {
      mode: "live",
      now: serverNow,
      getState: function () { return current; },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      connect: function (id) {
        return ensure().then(function () {
          if (id) {
            bind(id);
            return draftRef.once("value").then(function (snap) {
              current = snap.val() ? engine.normalize(engine.clone(snap.val())) : null;
              return current;
            });
          }
          return db.ref(rootPath + "/activeId").once("value").then(function (snap) {
            var active = snap.val();
            if (!active) return null;
            bind(active);
            return draftRef.once("value").then(function (s) {
              current = s.val() ? engine.normalize(engine.clone(s.val())) : null;
              return current;
            });
          });
        });
      },
      dispatch: dispatch,
      nudge: function () {
        if (!current || current.meta.status !== "live" || inflight) return Promise.resolve();
        var now = serverNow();
        var due = POOLS.some(function (pool) {
          var a = current.auctions[pool];
          return a && a.status === "open" && !a.frozen && now >= a.endsAt;
        });
        if (!due) return Promise.resolve();
        inflight = true;
        return requestClose().then(clearInflight, clearInflight);
      },
      close: function () {
        if (draftRef) draftRef.off();
        draftRef = null;
        boundId = null;
      },
      clockLabel: function () {
        return "Firebase server clock (" + (offset >= 0 ? "+" : "") + Math.round(offset) + " ms)";
      },
    };
    liveSingleton = api;
    return api;
  }

  function enterDemo() {
    var demo = createDemoAdapter();
    setAdapter(demo);
    session.mode = "demo";
    session.entered = true;
    session.role = null;
    session.teamId = null;
    return demo.load().then(function (state) {
      if (!state) {
        return demo.dispatch({
          type: "create",
          id: "local-demo",
          name: "Franchise Legends Orphan Draft",
        });
      }
      render();
      return { ok: true, state: state };
    });
  }

  function enterLive(draftId) {
    if (!liveConfigured()) {
      showToast("Add Firebase keys in orphan-draft-config.js to use live mode.", true);
      return Promise.resolve();
    }
    var live = createLiveAdapter();
    setAdapter(live);
    session.mode = "live";
    session.entered = true;
    session.role = null;
    session.teamId = null;
    showToast("Connecting to Firebase…");
    return live.connect(draftId || "").then(function (state) {
      if (!state) showToast("No live draft yet. The commissioner can create one.");
      render();
      return state;
    }).catch(function (err) {
      showToast((err && err.message) || "Could not connect.", true);
      render();
    });
  }

  function sitTeam(teamId) {
    session.role = "owner";
    session.teamId = teamId;
    render();
  }
  function sitAdmin() {
    if (!session.pinOk) {
      var field = $("od-pin");
      if (field) {
        showToast("Enter the admin PIN first.", true);
        field.focus();
        render();
        return;
      }
      var entered = window.prompt("Admin PIN");
      if (entered == null) { render(); return; }
      tryPin(entered);
      if (!session.pinOk) render();
      return;
    }
    session.role = "admin";
    session.teamId = null;
    render();
  }
  function tryPin(value) {
    if (String(value || "") !== String(cfg.adminPin || "")) {
      showToast("Wrong admin PIN.", true);
      return false;
    }
    session.pinOk = true;
    sessionStorage.setItem("fl_od_pin", "1");
    session.role = "admin";
    session.teamId = null;
    showToast("Commissioner desk unlocked.");
    render();
    return true;
  }
  function tryJoin(code) {
    var state = stateNow();
    var team = engine.teamByCode(state, code);
    if (!team) {
      showToast("No team has that join code.", true);
      return false;
    }
    sitTeam(team.id);
    showToast("Seated as " + team.name + ".");
    return true;
  }

  /* ---------- render ---------- */
  function captureKeep() {
    var active = document.activeElement;
    if (!active || !active.closest) return null;
    if (active.hasAttribute("data-no-keep")) return null;
    if (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") return null;
    var box = active.closest("[data-keep]");
    if (!box) return null;
    var fields = [];
    box.querySelectorAll("input, textarea").forEach(function (el) {
      if (!el.id) return;
      fields.push({
        id: el.id,
        value: el.value,
        checked: el.checked,
        type: el.type,
        start: el.selectionStart,
        end: el.selectionEnd,
      });
    });
    return { focusId: active.id, fields: fields };
  }
  function restoreKeep(saved) {
    if (!saved) return;
    saved.fields.forEach(function (f) {
      var el = $(f.id);
      if (!el) return;
      if (f.type === "checkbox") el.checked = f.checked;
      else el.value = f.value;
    });
    var el = $(saved.focusId);
    if (!el) return;
    el.focus();
    var field = null;
    saved.fields.forEach(function (f) { if (f.id === saved.focusId) field = f; });
    if (field && el.setSelectionRange && field.start != null && field.type !== "checkbox" && field.type !== "number") {
      try { el.setSelectionRange(field.start, field.end); } catch (e) { /* number inputs */ }
    }
  }

  function seatLabel() {
    var state = stateNow();
    if (session.role === "admin") return "Commissioner";
    var team = myTeam(state);
    return team ? team.name : "Spectator";
  }
  function headerHtml() {
    var seat = "";
    if (session.entered && session.mode === "demo") {
      seat = '<div class="od-seat"><label for="od-seat">Viewing as</label>' + seatSelect() + '</div>';
    } else if (session.entered && session.role) {
      seat = '<div class="od-seat"><span class="od-badge">' + esc(seatLabel()) + '</span>' +
        '<button type="button" class="od-mini" data-act="unseat">Leave seat</button></div>';
    }
    return '' +
      '<div class="header"><div><h1>Franchise Legends</h1><div class="sub">Orphan Draft · Live auction</div></div>' +
      '<div class="header-right">' + seat + '</div></div>' +
      '<div class="app-nav">' +
      '<button type="button" class="cs-btn year-tab" data-act="nav-league">League</button>' +
      '<button type="button" class="cs-btn year-tab" data-act="nav-lineup">Lineup</button>' +
      '<button type="button" class="cs-btn year-tab active" data-act="nav-orphan">Orphan Draft</button>' +
      '</div>';
  }
  function seatSelect() {
    if (session.mode !== "demo" || !session.entered) return '<select id="od-seat" data-no-keep disabled><option>—</option></select>';
    var state = stateNow();
    var html = '<select id="od-seat" data-no-keep>';
    html += '<option value=""' + (!session.role ? " selected" : "") + '>Choose a seat</option>';
    html += '<option value="admin"' + (session.role === "admin" ? " selected" : "") + '>Commissioner</option>';
    if (state) {
      teamsOf(state).forEach(function (t) {
        html += '<option value="' + esc(t.id) + '"' + (session.teamId === t.id ? " selected" : "") + '>' + esc(t.name) + '</option>';
      });
    }
    html += '</select>';
    return html;
  }
  function teamsOf(state) {
    return Object.keys(state.teams || {}).map(function (id) { return state.teams[id]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function counts(state) {
    var c = { mlb: 0, milb: 0, mlbWon: 0, milbWon: 0 };
    Object.keys(state.players || {}).forEach(function (id) {
      var p = state.players[id];
      if (p.status === "won") c[p.pool + "Won"]++;
      else c[p.pool]++;
    });
    return c;
  }

  function gateHtml() {
    var saved = false;
    try { saved = !!localStorage.getItem("fl_orphan_draft_v1"); } catch (e) { saved = false; }
    var liveNote = liveConfigured()
      ? "Firebase keys are set. Live bids sync across devices."
      : "Live mode is off until databaseURL and apiKey are set in orphan-draft-config.js. Demo mode needs nothing.";
    return '' +
      '<div class="od-gate-wrap"><div class="panel-box od-gate">' +
      '<h1>Orphan Draft</h1><div class="sub">Auction the orphaned pool. MLB and MiLB run on separate budgets.</div>' +
      '<p class="od-lead">R1 contracts are the MiLB pool. Everyone else — R2, year X of Y, franchise tags, and a plain 1 — is the MLB pool. The old fantasy team is ignored. The winner keeps the contract and the winning bid becomes the salary.</p>' +
      '<div class="od-split">' +
      '<div class="od-block"><h2>Local demo</h2><p>Full auction in this browser, shared across tabs. No keys.</p>' +
      '<button type="button" class="cs-btn" data-act="enter-demo">' + (saved ? "Resume demo" : "Enter local demo") + '</button>' +
      (saved ? ' <button type="button" class="od-mini" data-act="reset-demo">Reset demo</button>' : '') +
      '</div>' +
      '<div class="od-block"><h2>Live draft</h2><p>' + esc(liveNote) + '</p>' +
      '<button type="button" class="cs-btn" data-act="enter-live"' + (liveConfigured() ? "" : " disabled") + '>Connect to live draft</button>' +
      '</div></div></div></div>';
  }

  function roleHtml() {
    var state = stateNow();
    var demo = session.mode === "demo";
    var teams = state ? teamsOf(state) : [];
    var teamBtns = "";
    if (demo) {
      teamBtns = teams.map(function (t) {
        return '<button type="button" class="od-mini" data-act="sit-team" data-team="' + esc(t.id) + '">' + esc(t.name) + '</button>';
      }).join(" ");
    }
    return '' +
      '<div class="od-gate-wrap"><div class="panel-box od-gate">' +
      '<h1>' + (demo ? "Demo draft" : "Live draft") + '</h1>' +
      '<div class="sub">' + (state ? esc(state.meta.name) + " · " + esc(state.meta.status) : "Connecting…") + '</div>' +
      '<div class="od-block" style="margin-bottom:12px"><h2>Commissioner</h2>' +
      '<div class="od-field"><label for="od-pin">Admin PIN</label><input id="od-pin" type="password" autocomplete="off" placeholder="PIN"></div>' +
      (demo ? '<div class="od-pin-hint">Prototype demo PIN: ' + esc(cfg.adminPin || "") + '</div>' : '<p class="od-note">The PIN is the one in orphan-draft-config.js.</p>') +
      '<button type="button" class="cs-btn" data-act="submit-pin">Open commissioner desk</button></div>' +
      '<div class="od-block"><h2>Drafting team</h2>' +
      '<div class="od-inline"><input id="od-join" type="text" autocomplete="off" placeholder="Join code" maxlength="8" style="text-transform:uppercase">' +
      '<button type="button" class="cs-btn" data-act="submit-join">Join</button></div>' +
      (demo && teamBtns ? '<p class="od-note" style="margin-top:10px">Or sit as a demo team:</p><div class="od-inline">' + teamBtns + '</div>' : '') +
      '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button type="button" class="od-mini" data-act="leave-draft">Back</button></div>' +
      '</div></div>';
  }

  function statusBar(state) {
    var label = { setup: "Setup", live: "Live", paused: "Paused", complete: "Complete" }[state.meta.status] || state.meta.status;
    var admin = session.role === "admin";
    var buttons = "";
    if (admin) {
      if (state.meta.status === "setup" || state.meta.status === "complete") {
        buttons += '<button type="button" class="cs-btn" data-act="start">Start draft</button>';
      }
      if (state.meta.status === "live") buttons += '<button type="button" class="cs-btn" data-act="pause">Pause</button>';
      if (state.meta.status === "paused") buttons += '<button type="button" class="cs-btn" data-act="resume">Resume</button>';
      if (state.meta.status !== "complete") buttons += '<button type="button" class="od-mini" data-act="end">End draft</button>';
      buttons += '<button type="button" class="od-mini" data-act="export">Export CSV</button>';
      buttons += '<button type="button" class="od-mini" data-act="reset-draft">Reset results</button>';
      if (session.mode === "live") buttons += '<button type="button" class="od-mini" data-act="create-live">New live draft</button>';
    }
    return '' +
      '<div class="od-statusline"><div class="od-badges">' +
      '<span class="od-badge ' + esc(state.meta.status) + '">' + esc(label) + '</span>' +
      '<span class="od-badge ' + (session.mode === "demo" ? "demo" : "live") + '">' + (session.mode === "demo" ? "Demo" : "Live") + '</span>' +
      '<span class="od-badge">' + esc(adapter ? adapter.clockLabel() : "") + '</span>' +
      '</div><div class="od-actions">' + buttons + '</div></div>';
  }

  function clockClass(state, pool, ms, frozen) {
    if (frozen) return "od-clock frozen";
    var t = state.timers[pool];
    if (t.reset2Enabled && ms < t.reset2Below * 1000) return "od-clock hot";
    if (ms < t.reset1Below * 1000) return "od-clock warn";
    return "od-clock";
  }
  function auctionCard(state, pool) {
    var a = state.auctions[pool];
    var team = myTeam(state);
    var admin = session.role === "admin";
    var frozen = !!(a && (a.frozen || state.meta.status === "paused"));
    var now = adapter ? adapter.now() : Date.now();
    var ms = 0;
    if (a) ms = frozen ? (a.remainingMs || 0) : (a.endsAt - now);
    var body = "";
    if (!a) {
      body = '<div class="od-empty">No ' + engine.poolLabel(pool) + ' player on the clock.</div>';
    } else {
      var player = state.players[a.playerId];
      var high = teamName(state, a.highTeamId);
      body = '<div class="' + clockClass(state, pool, ms, frozen) + '" data-pool="' + pool + '">' +
        (ms <= 0 && !frozen ? "Awarding…" : formatClock(ms)) + '</div>' +
        '<div class="od-player-name">' + esc(player ? player.name : "Player") + '</div>' +
        '<div class="od-meta">' + esc(player ? player.position : "") + ' · ' + esc(player ? player.mlbTeam : "") +
        ' · Age ' + num(player && player.age) + ' · RkOv ' + num(player && player.rkOv) + '<br>' +
        'Contract <strong>' + esc(player ? player.contract : "") + '</strong> stays. High bid becomes the salary.<br>' +
        'High bid <strong>' + money(a.highBid) + '</strong> · ' + esc(high) +
        (a.highTeamId === a.nominatorTeamId ? " (opened)" : "") + '</div>';
      if (team && !admin) {
        var hint = bidHint(state, team, pool);
        body += '<div class="od-bid-row" data-keep="bid-' + pool + '">' +
          '<input id="od-bid-' + pool + '" class="od-bid-input" data-pool="' + pool + '" type="number" min="1" step="1" inputmode="numeric" placeholder="' + (hint.min || "") + '">' +
          '<button type="button" class="cs-btn" data-act="bid" data-pool="' + pool + '"' + (hint.ok ? "" : " disabled") + '>Bid</button></div>' +
          '<div class="od-note">' + esc(hint.ok ? ("At least " + money(hint.min) + ". You can bid up to " + money(hint.max) + ".") : hint.reason) + '</div>';
      }
      if (a.bids && a.bids.length) {
        body += '<div class="od-log" style="margin-top:8px">';
        a.bids.slice().reverse().forEach(function (b) {
          body += '<div class="row">' + esc(teamName(state, b.teamId)) + ' · ' + money(b.amount) + '</div>';
        });
        body += '</div>';
      }
    }
    if (admin && a) {
      body += '<div class="od-inline"><button type="button" class="od-mini" data-act="undo-bid" data-pool="' + pool + '">Undo last bid</button></div>';
    }
    return '<div class="od-card ' + pool + '"><h2>' + engine.poolLabel(pool) + ' <span>auction</span></h2>' + body + '</div>';
  }

  function bidHint(state, team, pool) {
    var a = state.auctions[pool];
    if (state.meta.status !== "live") return { ok: false, reason: "The draft isn't live." };
    if (!team) return { ok: false, reason: "Join a team to bid." };
    if (team.locked[pool]) return { ok: false, reason: engine.poolLabel(pool) + " roster is locked." };
    if (!a || a.frozen || state.meta.status === "paused") return { ok: false, reason: "No live " + engine.poolLabel(pool) + " auction." };
    if (a.status !== "open") return { ok: false, reason: "Awarding the high bid…" };
    if (a.highTeamId === team.id) return { ok: false, reason: "You're the high bidder." };
    var min = a.highBid + 1;
    var max = engine.maxBid(state, team.id, pool);
    if (min > max) return { ok: false, reason: "Need " + money(min) + " and only " + money(max) + " is left to bid.", min: min, max: max };
    return { ok: true, reason: "", min: min, max: max };
  }

  function pillsHtml(state) {
    var team = myTeam(state);
    if (!team || session.role !== "owner") return "";
    function pill(pool) {
      var left = engine.remaining(state, team.id, pool);
      var locked = team.locked[pool];
      return '<div class="od-pill"><div class="lbl">' + engine.poolLabel(pool) + ' left</div>' +
        '<div class="amt' + (left < 0 ? " over" : "") + '">' + money(left) + '</div>' +
        '<div class="od-note">Budget ' + money(team.budgets[pool]) + ' · held ' + money(engine.committed(state, team.id, pool)) + '</div>' +
        '<button type="button" class="od-mini od-lock' + (locked ? " on" : "") + '" data-act="lock" data-pool="' + pool + '">' +
        (locked ? "Unlock " : "Lock ") + engine.poolLabel(pool) + '</button></div>';
    }
    return '<div class="od-pills">' + pill("mlb") + pill("milb") + '</div>';
  }

  function budgetTable(state, admin) {
    var rows = teamsOf(state).map(function (t) {
      var mlbLeft = engine.remaining(state, t.id, "mlb");
      var milbLeft = engine.remaining(state, t.id, "milb");
      if (!admin) {
        return '<tr' + (t.id === session.teamId ? ' class="mine"' : "") + '><td>' + esc(t.name) + '</td>' +
          '<td class="num">' + money(mlbLeft) + '</td><td class="num">' + money(milbLeft) + '</td>' +
          '<td>' + (t.locked.mlb ? "Locked" : "Open") + '</td><td>' + (t.locked.milb ? "Locked" : "Open") + '</td></tr>';
      }
      var id = t.id;
      return '<tr data-keep="team-' + esc(id) + '"><td><input id="' + domId("od-name", id) + '" value="' + esc(t.name) + '"></td>' +
        '<td><input id="' + domId("od-mlb", id) + '" type="number" min="0" step="1" value="' + t.budgets.mlb + '"></td>' +
        '<td class="num">' + money(mlbLeft) + '</td>' +
        '<td><input id="' + domId("od-milb", id) + '" type="number" min="0" step="1" value="' + t.budgets.milb + '"></td>' +
        '<td class="num">' + money(milbLeft) + '</td>' +
        '<td><button type="button" class="od-mini" data-act="save-team" data-team="' + esc(id) + '">Save</button></td>' +
        '<td><span class="od-code">' + esc(t.code) + '</span> <button type="button" class="od-mini" data-act="copy-link" data-team="' + esc(id) + '">Copy link</button></td>' +
        '<td><button type="button" class="od-mini" data-act="remove-team" data-team="' + esc(id) + '">Remove</button></td></tr>';
    }).join("");
    if (!rows) return '<div class="od-empty">No drafting teams yet.</div>';
    if (!admin) {
      return '<table class="pr-table"><thead><tr><th>Team</th><th class="num">MLB left</th><th class="num">MiLB left</th><th>MLB</th><th>MiLB</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    return '<div class="pr-table-wrap od-team-table"><table class="pr-table"><thead><tr><th>Team</th><th>MLB budget</th><th class="num">MLB left</th><th>MiLB budget</th><th class="num">MiLB left</th><th></th><th>Join</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function timerForm(state, pool) {
    var t = state.timers[pool];
    var pre = "od-" + pool + "-";
    return '<div data-keep="timer-' + pool + '"><h2>' + engine.poolLabel(pool) + ' clock</h2>' +
      '<div class="od-field"><label for="' + pre + 'x">Auction length X (seconds)</label><input id="' + pre + 'x" type="number" min="5" step="1" value="' + t.auctionSeconds + '"></div>' +
      '<div class="od-grid-2">' +
      '<div class="od-field"><label for="' + pre + 'y">Reset 1 under Y</label><input id="' + pre + 'y" type="number" min="1" step="1" value="' + t.reset1Below + '"></div>' +
      '<div class="od-field"><label for="' + pre + 'r1">Reset 1 sets clock to</label><input id="' + pre + 'r1" type="number" min="1" step="1" value="' + t.reset1To + '"></div>' +
      '</div>' +
      '<label class="od-check"><input id="' + pre + 'r2on" type="checkbox"' + (t.reset2Enabled ? " checked" : "") + '> Reset 2 on</label>' +
      '<div class="od-grid-2">' +
      '<div class="od-field"><label for="' + pre + 'z">Reset 2 under Z</label><input id="' + pre + 'z" type="number" min="1" step="1" value="' + t.reset2Below + '"></div>' +
      '<div class="od-field"><label for="' + pre + 'r2">Reset 2 sets clock to</label><input id="' + pre + 'r2" type="number" min="1" step="1" value="' + t.reset2To + '"></div>' +
      '</div>' +
      '<p class="od-note">' + esc(engine.describeTimers(t)) + '</p>' +
      '<button type="button" class="od-mini" data-act="save-timers" data-pool="' + pool + '">Save ' + engine.poolLabel(pool) + ' timers</button></div>';
  }

  function importCard() {
    return '<div class="od-card"><h2>Player pool</h2>' +
      '<p class="od-note">Fantrax export (.xlsx or .csv). R1 goes to MiLB. You can override any available player after import.</p>' +
      '<div class="od-inline"><input id="od-file" data-no-keep type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>' +
      '<div class="od-inline"><button type="button" class="cs-btn" data-act="load-sample">Load sample export</button>' +
      '<button type="button" class="od-mini" data-act="recompute">Recompute pools</button></div></div>';
  }

  function teamsCard(state) {
    return '<div class="od-card"><h2>Drafting teams</h2>' +
      '<div class="od-inline">' +
      '<input id="od-new-name" placeholder="Team name" style="min-width:120px">' +
      '<input id="od-new-mlb" type="number" min="0" step="1" value="200" style="width:80px" title="MLB budget">' +
      '<input id="od-new-milb" type="number" min="0" step="1" value="40" style="width:80px" title="MiLB budget">' +
      '<button type="button" class="cs-btn" data-act="add-team">Add team</button>' +
      '<button type="button" class="od-mini" data-act="add-five">Add 5 sample teams</button></div>' +
      '<p class="od-note">Budgets are per team and per pool. The two number boxes are MLB then MiLB.</p>' +
      budgetTable(state, true) + '</div>';
  }

  function awardsHtml(state, admin) {
    var rows = (state.awards || []).filter(function (a) { return admin ? true : !a.voided; }).slice(0, 12);
    if (!rows.length) return '<div class="od-empty">No awards yet.</div>';
    return rows.map(function (a) {
      var p = state.players[a.playerId];
      var line = esc(p ? p.name : a.playerId) + " · " + esc(teamName(state, a.teamId)) + " · " + esc(a.contract) + " · " + money(a.amount) + " · " + engine.poolLabel(a.pool);
      if (a.voided) return '<div class="row od-won">Voided · ' + line + '</div>';
      var btn = admin ? ' <button type="button" class="od-mini" data-act="void-award" data-award="' + esc(a.id) + '">Void</button>' : "";
      return '<div class="row">' + line + btn + '</div>';
    }).join("");
  }

  function rosterHtml(state, team) {
    if (!team) return "";
    function list(pool) {
      var items = (state.awards || []).filter(function (a) {
        return !a.voided && a.teamId === team.id && a.pool === pool;
      });
      if (!items.length) return '<div class="od-empty">No ' + engine.poolLabel(pool) + ' players yet.</div>';
      return items.map(function (a) {
        var p = state.players[a.playerId];
        return '<div class="row"><strong>' + esc(p ? p.name : "") + '</strong> · ' + esc(p ? p.position : "") +
          ' · ' + esc(a.contract) + ' · ' + money(a.amount) + '</div>';
      }).join("");
    }
    return '<div class="od-grid-2"><div class="od-card"><h2>Your MLB roster</h2><div class="od-roster">' + list("mlb") + '</div></div>' +
      '<div class="od-card milb"><h2>Your MiLB roster</h2><div class="od-roster">' + list("milb") + '</div></div></div>';
  }

  function logHtml(state) {
    var rows = (state.log || []).slice(0, 40);
    if (!rows.length) return '<div class="od-empty">No bids yet.</div>';
    return '<div class="od-log">' + rows.map(function (row) {
      var time = row.at ? new Date(row.at).toLocaleTimeString() : "";
      return '<div class="row"><span>' + esc(time) + '</span> ' + esc(row.message) + '</div>';
    }).join("") + '</div>';
  }

  function sortedPlayers(state) {
    var list = Object.keys(state.players).map(function (id) { return state.players[id]; });
    var q = ui.q.trim().toLowerCase();
    list = list.filter(function (p) {
      if (p.pool !== ui.poolTab) return false;
      if (!ui.includeWon && p.status === "won") return false;
      if (ui.pos !== "all") {
        var parts = String(p.position || "").toUpperCase().split(",").map(function (s) { return s.trim(); });
        if (parts.indexOf(ui.pos) < 0) return false;
      }
      if (!q) return true;
      return (p.name + " " + p.mlbTeam + " " + p.position + " " + p.contract).toLowerCase().indexOf(q) >= 0;
    });
    var key = ui.sort;
    var dir = ui.dir;
    list.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      var text = key === "name" || key === "mlbTeam" || key === "position" || key === "contract";
      if (text) return String(av || "").localeCompare(String(bv || "")) * dir;
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.name.localeCompare(b.name);
      return (av - bv) * dir;
    });
    return list;
  }
  function sortHead(key, label, cls) {
    var mark = ui.sort === key ? (ui.dir > 0 ? " ▲" : " ▼") : "";
    return '<th class="od-sort ' + (cls || "") + '" data-act="sort" data-key="' + key + '">' + label + mark + '</th>';
  }
  function positions(state) {
    var set = {};
    Object.keys(state.players).forEach(function (id) {
      String(state.players[id].position || "").split(",").forEach(function (p) {
        var t = p.trim().toUpperCase();
        if (t) set[t] = true;
      });
    });
    return Object.keys(set).sort();
  }
  function playersHtml(state) {
    var admin = session.role === "admin";
    var team = myTeam(state);
    var c = counts(state);
    var posOpts = '<option value="all">All positions</option>' + positions(state).map(function (p) {
      return '<option value="' + esc(p) + '"' + (ui.pos === p ? " selected" : "") + '>' + esc(p) + '</option>';
    }).join("");
    var head = '<div class="od-tabs">' +
      '<button type="button" class="od-mini' + (ui.poolTab === "mlb" ? " on" : "") + '" data-act="pool-tab" data-pool="mlb">MLB · ' + c.mlb + ' left</button>' +
      '<button type="button" class="od-mini' + (ui.poolTab === "milb" ? " on" : "") + '" data-act="pool-tab" data-pool="milb">MiLB · ' + c.milb + ' left</button>' +
      '</div>' +
      '<div class="od-filters" data-keep="filters">' +
      '<div><label for="od-search">Search</label><input id="od-search" value="' + esc(ui.q) + '" placeholder="Name, team, pos"></div>' +
      '<div><label for="od-pos">Position</label><select id="od-pos" data-no-keep>' + posOpts + '</select></div>' +
      '<label class="od-check"><input id="od-won" data-no-keep type="checkbox"' + (ui.includeWon ? " checked" : "") + '> Include won</label>' +
      '</div>';
    var rows = sortedPlayers(state).map(function (p) {
      var cls = p.status === "won" ? "od-won" : p.status === "nominated" ? "od-nominated" : "";
      var poolCell = admin && p.status === "available"
        ? '<select data-no-keep data-pool-for="' + esc(p.id) + '"><option value="mlb"' + (p.pool === "mlb" ? " selected" : "") + '>MLB</option><option value="milb"' + (p.pool === "milb" ? " selected" : "") + '>MiLB</option></select>'
        : engine.poolLabel(p.pool) + (p.poolEdited ? " *" : "");
      var action = "";
      if (!admin && team && p.status === "available") {
        var openId = domId("od-open", p.id);
        var can = canNominate(state, team, p);
        action = '<span data-keep="open-' + esc(p.id) + '"><input id="' + openId + '" class="od-open" type="number" min="1" step="1" value="1" style="width:64px"> ' +
          '<button type="button" class="od-mini" data-act="nominate" data-player="' + esc(p.id) + '"' + (can.ok ? "" : " disabled") + '>Nominate</button></span>';
      } else if (p.status === "nominated") action = "On the clock";
      else if (p.status === "won") action = "Won · " + esc(teamName(state, p.winnerTeamId));
      return '<tr class="' + cls + '"><td>' + esc(p.name) + '</td><td>' + esc(p.mlbTeam) + '</td><td>' + esc(p.position) + '</td>' +
        '<td class="num">' + num(p.age) + '</td><td class="num">' + num(p.rkOv) + '</td><td class="num">' + num(p.fpts, 1) + '</td>' +
        '<td class="num">' + num(p.fpg, 2) + '</td><td>' + esc(p.contract) + '</td><td class="num">' + money(p.originalSalary) + '</td>' +
        '<td>' + poolCell + '</td><td>' + action + '</td></tr>';
    }).join("");
    return head + '<div class="pr-table-wrap od-scroll"><table class="pr-table"><thead><tr>' +
      sortHead("name", "Player") + sortHead("mlbTeam", "MLB") + sortHead("position", "Pos") +
      sortHead("age", "Age", "num") + sortHead("rkOv", "RkOv", "num") + sortHead("fpts", "FPts", "num") +
      sortHead("fpg", "FP/G", "num") + sortHead("contract", "Contract") + sortHead("originalSalary", "Orig $", "num") +
      '<th>Pool</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="11" class="od-empty">No players in this view.</td></tr>') +
      '</tbody></table></div>';
  }
  function canNominate(state, team, player) {
    if (state.meta.status !== "live") return { ok: false };
    if (!team || team.locked[player.pool]) return { ok: false };
    if (player.status !== "available") return { ok: false };
    if (state.auctions[player.pool]) return { ok: false };
    if (engine.maxBid(state, team.id, player.pool) < 1) return { ok: false };
    return { ok: true };
  }

  function roomHtml() {
    var state = stateNow();
    if (!state) {
      var waiting = session.role === "admin"
        ? '<div class="od-card"><h2>Create the draft</h2><p class="od-note">This writes a new draft and points the live room at it.</p><button type="button" class="cs-btn" data-act="create-live">Create draft</button></div>'
        : '<div class="hint-bar">' + (session.role ? "Waiting for the commissioner to create the draft." : "Connecting to the draft…") + '</div>';
      return headerHtml() + (session.role ? waiting : roleHtml());
    }
    if (!session.role) return headerHtml() + roleHtml();
    var admin = session.role === "admin";
    var c = counts(state);
    var html = headerHtml() + statusBar(state) + pillsHtml(state);
    html += '<div class="od-grid-2">' + auctionCard(state, "mlb") + auctionCard(state, "milb") + '</div>';
    if (!admin) {
      html += rosterHtml(state, myTeam(state));
      html += '<div class="section"><h2>Budgets <span class="count">' + teamsOf(state).length + ' teams</span></h2>' + budgetTable(state, false) + '</div>';
    } else {
      html += '<div class="od-grid-2">' + importCard() +
        '<div class="od-card"><h2>Timers</h2>' + timerForm(state, "mlb") + '<hr style="border:0;border-top:1px solid var(--border-dark);margin:12px 0">' + timerForm(state, "milb") +
        '<div class="od-inline"><button type="button" class="od-mini" data-act="fast-timers">Short timers</button>' +
        '<button type="button" class="od-mini" data-act="soft-close">Soft close only</button></div></div></div>';
      html += teamsCard(state);
      html += '<div class="od-grid-2"><div class="od-card"><h2>Awards</h2><div class="od-roster">' + awardsHtml(state, true) + '</div></div>' +
        '<div class="od-card"><h2>Bid history</h2>' + logHtml(state) + '</div></div>';
    }
    html += '<div class="section"><h2>' + (admin ? "Review pool" : "Available players") +
      ' <span class="count">MLB ' + c.mlb + ' · MiLB ' + c.milb + '</span></h2>' +
      (admin ? '<p class="od-note">A star on the pool means a commissioner override. Won and nominated players stay put.</p>' : '') +
      playersHtml(state) + '</div>';
    html += '<div class="rules-bar od-rules"><strong>Rules:</strong> one live auction per pool, $1 minimum raise, budgets are separate, locking one pool leaves the other open. ' +
      'When the clock hits zero the high bidder wins the existing contract at the winning bid. ' +
      (admin ? "Undo last bid steps the open auction back. Void award returns that player to the pool." : "") + '</div>';
    html += '<div class="footer">Franchise Legends · Orphan Draft' + (session.mode === "demo" ? " · local demo" : " · live") + '</div>';
    return html;
  }

  function view() {
    if (!session.entered) return headerHtml() + gateHtml();
    return roomHtml();
  }

  var renderNest = 0;
  function render() {
    if (renderNest) return;
    renderNest++;
    try {
      ensureShell();
      var saved = captureKeep();
      var app = $("odApp");
      if (!app) return;
      app.innerHTML = view();
      restoreKeep(saved);
      paintClocks();
    } finally {
      renderNest--;
    }
  }

  function paintClocks() {
    var state = stateNow();
    if (!state || !adapter) return;
    var now = adapter.now();
    document.querySelectorAll(".od-clock").forEach(function (el) {
      var pool = el.dataset.pool;
      var a = state.auctions[pool];
      if (!a) return;
      var frozen = !!(a.frozen || state.meta.status === "paused");
      var ms = frozen ? (a.remainingMs || 0) : (a.endsAt - now);
      el.textContent = ms <= 0 && !frozen ? "Awarding…" : formatClock(ms);
      el.className = clockClass(state, pool, ms, frozen);
    });
  }

  function readTimers(pool) {
    var pre = "od-" + pool + "-";
    return {
      auctionSeconds: $(pre + "x") && $(pre + "x").value,
      reset1Below: $(pre + "y") && $(pre + "y").value,
      reset1To: $(pre + "r1") && $(pre + "r1").value,
      reset2Enabled: $(pre + "r2on") ? $(pre + "r2on").checked : false,
      reset2Below: $(pre + "z") && $(pre + "z").value,
      reset2To: $(pre + "r2") && $(pre + "r2").value,
    };
  }

  function importRows(pack) {
    if (!pack || !pack.players || !pack.players.length) {
      showToast(pack && pack.warnings && pack.warnings[0] ? pack.warnings[0] : "No players found in that file.", true);
      return;
    }
    if (pack.warnings && pack.warnings.length) showToast(pack.warnings[0], true);
    act({ type: "import", players: pack.players });
  }
  function importFile(file) {
    var name = file.name || "";
    if (/\.csv$/i.test(name) || file.type === "text/csv") {
      file.text().then(function (text) { importRows(engine.rowsToPlayers(engine.parseCsv(text))); })
        .catch(function (err) { showToast(err.message || "Could not read that CSV.", true); });
      return;
    }
    file.arrayBuffer().then(function (buf) {
      return engine.rowsFromXlsxBuffer(buf).then(function (rows) { importRows(engine.rowsToPlayers(rows)); });
    }).catch(function (err) { showToast(err.message || "Could not read that spreadsheet.", true); });
  }

  function onClick(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    var action = btn.dataset.act;
    if (action === "nav-league") return goLeague();
    if (action === "nav-lineup") return goLineup();
    if (action === "nav-orphan") return;
    if (action === "enter-demo") return enterDemo();
    if (action === "reset-demo") {
      if (!confirm("Reset the local demo draft?")) return;
      setAdapter(createDemoAdapter());
      session.mode = "demo";
      session.entered = true;
      session.role = null;
      session.teamId = null;
      return act({ type: "reset", id: "local-demo", name: "Franchise Legends Orphan Draft" });
    }
    if (action === "enter-live") return enterLive("");
    if (action === "unseat") {
      session.role = null;
      session.teamId = null;
      render();
      return;
    }
    if (action === "create-live") {
      if (session.mode !== "live") return;
      if (!confirm("Create a new live draft and point new visitors at it? The previous draft stays stored.")) return;
      return act({ type: "create", name: "Franchise Legends Orphan Draft" });
    }
    if (action === "leave-draft") {
      session.entered = false;
      session.role = null;
      session.teamId = null;
      render();
      return;
    }
    if (action === "submit-pin") return tryPin(($("od-pin") && $("od-pin").value) || "");
    if (action === "submit-join") return tryJoin(($("od-join") && $("od-join").value) || "");
    if (action === "sit-team") return sitTeam(btn.dataset.team);
    if (action === "pool-tab") { ui.poolTab = btn.dataset.pool; render(); return; }
    if (action === "sort") {
      var key = btn.dataset.key;
      if (ui.sort === key) ui.dir = -ui.dir;
      else { ui.sort = key; ui.dir = defaultDir[key] || 1; }
      render();
      return;
    }
    if (action === "load-sample") {
      showToast("Loading sample export…");
      fetch("orphan-draft-sample.xlsx").then(function (res) {
        if (!res.ok) throw new Error("Sample file missing (" + res.status + ").");
        return res.arrayBuffer();
      }).then(function (buf) {
        return engine.rowsFromXlsxBuffer(buf);
      }).then(function (rows) { importRows(engine.rowsToPlayers(rows)); })
        .catch(function (err) { showToast(err.message || "Could not load the sample.", true); });
      return;
    }
    if (action === "add-team") {
      return act({
        type: "addTeam",
        name: ($("od-new-name") && $("od-new-name").value) || "",
        mlb: ($("od-new-mlb") && $("od-new-mlb").value) || 0,
        milb: ($("od-new-milb") && $("od-new-milb").value) || 0,
      });
    }
    if (action === "add-five") {
      var chain = Promise.resolve();
      SAMPLE_TEAMS.forEach(function (row) {
        chain = chain.then(function () {
          return act({ type: "addTeam", name: row[0], mlb: row[1], milb: row[2] });
        });
      });
      return;
    }
    if (action === "save-team") {
      var id = btn.dataset.team;
      return act({
        type: "updateTeam",
        teamId: id,
        name: ($(domId("od-name", id)) && $(domId("od-name", id)).value) || "",
        mlb: $(domId("od-mlb", id)) && $(domId("od-mlb", id)).value,
        milb: $(domId("od-milb", id)) && $(domId("od-milb", id)).value,
      });
    }
    if (action === "remove-team") return act({ type: "removeTeam", teamId: btn.dataset.team });
    if (action === "copy-link") {
      var st = stateNow();
      var team = st && st.teams[btn.dataset.team];
      if (team) copyText(joinUrl(team.code));
      return;
    }
    if (action === "save-timers") return act({ type: "setTimers", pool: btn.dataset.pool, timers: readTimers(btn.dataset.pool) });
    if (action === "fast-timers") {
      var fast = engine.fastTimers();
      return act({ type: "setAllTimers", mlb: fast.mlb, milb: fast.milb }).then(function (res) {
        if (res && res.ok) showToast("Short timers saved. MLB 12s, MiLB 10s, with both reset tiers.");
      });
    }
    if (action === "soft-close") {
      var st2 = stateNow();
      if (!st2) return;
      function soft(t) { return Object.assign({}, t, { reset2Enabled: false, reset1To: t.reset1Below }); }
      return act({ type: "setAllTimers", mlb: soft(st2.timers.mlb), milb: soft(st2.timers.milb) }).then(function (res) {
        if (res && res.ok) showToast("Reset 2 is off. A bid under Y resets the clock to Y.");
      });
    }
    if (action === "recompute") return act({ type: "recomputePools" });
    if (action === "start") return act({ type: "start" });
    if (action === "pause") return act({ type: "pause" });
    if (action === "resume") return act({ type: "resume" });
    if (action === "end") return act({ type: "end" });
    if (action === "reset-draft") {
      if (!confirm("Clear auctions, awards, and rosters? Teams, budgets, timers, and the pool stay.")) return;
      return act({ type: "reset", id: stateNow() && stateNow().meta.id, name: stateNow() && stateNow().meta.name });
    }
    if (action === "export") {
      var data = stateNow();
      if (!data) return;
      var csv = engine.exportCsv(data);
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "orphan-draft-results.csv";
      link.click();
      URL.revokeObjectURL(link.href);
      showToast("Exported results.");
      return;
    }
    if (action === "undo-bid") return act({ type: "undoBid", pool: btn.dataset.pool });
    if (action === "void-award") return act({ type: "voidAward", awardId: btn.dataset.award });
    if (action === "lock") {
      var team = myTeam(stateNow());
      if (!team) return;
      var pool = btn.dataset.pool;
      return act({ type: "lock", teamId: team.id, pool: pool, locked: !team.locked[pool] });
    }
    if (action === "nominate") {
      var playerId = btn.dataset.player;
      var input = $(domId("od-open", playerId));
      var amount = input && input.value !== "" ? Number(input.value) : 1;
      return act({ type: "nominate", teamId: session.teamId, playerId: playerId, amount: amount });
    }
    if (action === "bid") {
      var poolName = btn.dataset.pool;
      var field = $("od-bid-" + poolName);
      var st3 = stateNow();
      var auction = st3 && st3.auctions[poolName];
      var amount2 = field && field.value !== "" ? Number(field.value) : (auction ? auction.highBid + 1 : 1);
      return act({ type: "bid", teamId: session.teamId, pool: poolName, amount: amount2 });
    }
  }

  function onChange(e) {
    var t = e.target;
    if (t && t.id === "od-seat") {
      var currentSeat = session.role === "admin" ? "admin" : (session.teamId || "");
      if (t.value === currentSeat) return;
      if (t.value === "admin") sitAdmin();
      else if (t.value) sitTeam(t.value);
      else if (session.role || session.teamId) {
        session.role = null;
        session.teamId = null;
        render();
      }
      return;
    }
    if (t && t.id === "od-pos") { ui.pos = t.value; render(); return; }
    if (t && t.id === "od-won") { ui.includeWon = t.checked; render(); return; }
    if (t && t.id === "od-file" && t.files && t.files[0]) {
      importFile(t.files[0]);
      t.value = "";
      return;
    }
    if (t && t.getAttribute("data-pool-for")) {
      act({ type: "setPool", playerId: t.getAttribute("data-pool-for"), pool: t.value });
    }
  }
  function onInput(e) {
    if (e.target && e.target.id === "od-search") {
      if (ui.q === e.target.value) return;
      ui.q = e.target.value;
      render();
    }
  }
  function onKey(e) {
    if (e.key !== "Enter") return;
    var t = e.target;
    if (!t) return;
    if (t.id === "od-pin") { e.preventDefault(); tryPin(t.value); }
    if (t.id === "od-join") { e.preventDefault(); tryJoin(t.value); }
    if (t.id === "od-new-name") { e.preventDefault(); var add = document.querySelector('[data-act="add-team"]'); if (add) add.click(); }
    if (t.classList && t.classList.contains("od-bid-input")) {
      e.preventDefault();
      var bid = document.querySelector('[data-act="bid"][data-pool="' + t.dataset.pool + '"]');
      if (bid && !bid.disabled) bid.click();
    }
  }

  function goLeague() {
    showScreen("leagueDash");
    if (typeof rankingData === "undefined" || !rankingData) {
      if (typeof loadRankings === "function") loadRankings(false);
    } else if (typeof renderRankings === "function") renderRankings();
  }
  function goLineup() {
    if (typeof teamId !== "undefined" && teamId && typeof applyTeam === "function") applyTeam(teamId);
    showScreen("dashboard");
    if (typeof render === "function") window.renderLineupSafe();
  }

  function ensureShell() {
    var root = $("orphanDraft");
    if (!root || root.dataset.ready === "1") return;
    root.dataset.ready = "1";
    root.innerHTML = '<div id="odApp"></div>';
    var toast = document.createElement("div");
    toast.id = "odToast";
    toast.className = "toast";
    root.appendChild(toast);
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("input", onInput);
    root.addEventListener("keydown", onKey);
  }

  function onShow() {
    ensureShell();
    if (!didQuery) {
      didQuery = true;
      var params = new URLSearchParams(location.search);
      pendingJoin = (params.get("join") || "").trim().toUpperCase();
      if (params.get("demo") === "1") {
        enterDemo().then(function () { if (pendingJoin) tryJoin(pendingJoin); });
        return;
      }
      if (params.get("draft") || (params.get("join") && liveConfigured())) {
        enterLive(params.get("draft") || "").then(function () { if (pendingJoin) tryJoin(pendingJoin); });
        return;
      }
    }
    render();
  }

  function openDraft() {
    if (sessionStorage.getItem("fl_auth") !== "1") {
      showToast("Log in first.", true);
      return;
    }
    showScreen("orphanDraft");
  }

  var prevShow = window.showScreen;
  window.showScreen = function (name) {
    var od = $("orphanDraft");
    if (name === "orphanDraft") {
      if (sessionStorage.getItem("fl_auth") !== "1") {
        if (od) od.classList.add("hidden");
        prevShow("loginScreen");
        return;
      }
      ["loginScreen", "setupScreen", "leagueDash", "dashboard"].forEach(function (id) {
        var el = $(id);
        if (el) el.classList.add("hidden");
      });
      if (od) od.classList.remove("hidden");
      document.title = "Orphan Draft — Franchise Legends";
      onShow();
      return;
    }
    if (od) od.classList.add("hidden");
    if (document.title.indexOf("Orphan Draft") === 0) document.title = "Franchise Legends — Lineup Planner";
    prevShow(name);
  };

  // The lineup renderer is global `render` from app.js. Don't let our render() shadow calls
  // from the League/Lineup buttons — those call the global directly. Alias it before any
  // confusion inside this closure (this file's render is local).
  window.renderLineupSafe = function () {
    if (typeof window.render === "function" && window.render !== render) window.render();
  };

  function bindEntry() {
    ["toOrphanFromSetup", "toOrphanBtn", "navOrphan", "toOrphanFromLineup"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", openDraft);
    });
    var loginBtn = $("loginBtn");
    if (loginBtn) loginBtn.addEventListener("click", function () {
      setTimeout(function () {
        if (pendingOpen && sessionStorage.getItem("fl_auth") === "1") {
          pendingOpen = false;
          showScreen("orphanDraft");
        }
      }, 0);
    });
  }

  setInterval(function () {
    var root = $("orphanDraft");
    if (!root || root.classList.contains("hidden")) return;
    paintClocks();
    if (!adapter || nudgeLock || !session.entered) return;
    nudgeLock = true;
    Promise.resolve(adapter.nudge()).then(function () { nudgeLock = false; }, function () { nudgeLock = false; });
  }, 200);

  var params = new URLSearchParams(location.search);
  if (params.get("demo") === "1" || params.get("draft") || params.get("join")) pendingOpen = true;
  bindEntry();
  if (pendingOpen && sessionStorage.getItem("fl_auth") === "1") showScreen("orphanDraft");

  window.OrphanDraftUI = { onShow: onShow };
})();
