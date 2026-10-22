/* Orphan Draft auction engine.
 * Pure state transitions shared by local demo mode and Firebase live mode.
 * Timers and awards are decided from the `now` the caller passes in.
 * Live mode passes a server-adjusted clock, and awards compare a server
 * timestamp (closeToken) to endsAt inside awardClosing.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OrphanDraftEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var POOLS = ["mlb", "milb"];

  function defaultTimer(partial) {
    return {
      auctionSeconds: partial.auctionSeconds,
      reset1Below: partial.reset1Below,
      reset1To: partial.reset1To,
      reset2Enabled: partial.reset2Enabled,
      reset2Below: partial.reset2Below,
      reset2To: partial.reset2To,
    };
  }

  function defaultTimers() {
    return {
      mlb: defaultTimer({
        auctionSeconds: 60,
        reset1Below: 20,
        reset1To: 20,
        reset2Enabled: true,
        reset2Below: 8,
        reset2To: 8,
      }),
      milb: defaultTimer({
        auctionSeconds: 45,
        reset1Below: 15,
        reset1To: 15,
        reset2Enabled: true,
        reset2Below: 6,
        reset2To: 6,
      }),
    };
  }

  function fastTimers() {
    var tune = function (x, y, z) {
      return defaultTimer({
        auctionSeconds: x,
        reset1Below: y,
        reset1To: y,
        reset2Enabled: true,
        reset2Below: z,
        reset2To: z,
      });
    };
    return { mlb: tune(12, 8, 4), milb: tune(10, 6, 3) };
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function poolLabel(pool) {
    return pool === "milb" ? "MiLB" : "MLB";
  }

  function uid(prefix) {
    return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
  }

  function makeCode(used) {
    var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (var n = 0; n < 30; n++) {
      var s = "";
      for (var i = 0; i < 6; i++) s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
      if (!used[s]) return s;
    }
    return ("T" + Date.now().toString(36)).toUpperCase();
  }

  function safeId(id) {
    return String(id == null ? "" : id).trim().replace(/[.#$[\]/]/g, "_");
  }

  function ok(state) {
    return { ok: true, changed: true, error: null, state: state };
  }
  function noop(state) {
    return { ok: true, changed: false, error: null, state: state };
  }
  function fail(state, error) {
    return { ok: false, changed: false, error: error, state: state };
  }

  function pushLog(state, at, type, message) {
    state.log.unshift({ id: uid("log"), at: at, type: type, message: message });
    if (state.log.length > 120) state.log.length = 120;
  }

  function normalize(state) {
    if (!state) return state;
    if (!state.meta) state.meta = { id: "draft", name: "Orphan Draft", status: "setup", createdAt: 0, pausedAt: null, version: 1 };
    if (!state.timers || !state.timers.mlb || !state.timers.milb) state.timers = defaultTimers();
    if (!state.teams) state.teams = {};
    if (!state.players) state.players = {};
    if (!state.auctions) state.auctions = {};
    POOLS.forEach(function (pool) {
      if (!state.auctions[pool]) state.auctions[pool] = null;
    });
    if (!Array.isArray(state.awards)) state.awards = [];
    if (!Array.isArray(state.bidLog)) state.bidLog = [];
    if (!Array.isArray(state.log)) state.log = [];
    Object.keys(state.teams).forEach(function (id) {
      var team = state.teams[id];
      if (!team.budgets) team.budgets = { mlb: 0, milb: 0 };
      if (team.budgets.mlb == null) team.budgets.mlb = 0;
      if (team.budgets.milb == null) team.budgets.milb = 0;
      if (!team.locked) team.locked = { mlb: false, milb: false };
    });
    return state;
  }

  function blankDraft(name, now, id) {
    return {
      rev: 1,
      meta: {
        id: id || uid("od"),
        name: name || "Orphan Draft",
        status: "setup",
        createdAt: now || 0,
        pausedAt: null,
        version: 1,
      },
      timers: defaultTimers(),
      teams: {},
      players: {},
      auctions: { mlb: null, milb: null },
      bidLog: [],
      awards: [],
      log: [],
    };
  }

  function parseContract(raw) {
    if (raw == null) return { contract: "", pool: "mlb", kind: "unknown" };
    var s = String(raw).trim().replace(/^[\s"'“”]+|[\s"'“”]+$/g, "").trim();
    if (!s) return { contract: "", pool: "mlb", kind: "unknown" };
    if (/^r1$/i.test(s)) return { contract: "R1", pool: "milb", kind: "R1" };
    if (/^r2$/i.test(s)) return { contract: "R2", pool: "mlb", kind: "R2" };
    var multi = s.match(/^(F)?(\d+)\s*\/\s*(\d+)$/i);
    if (multi) {
      var contract = (multi[1] ? "F" : "") + String(Number(multi[2])) + "/" + String(Number(multi[3]));
      return { contract: contract, pool: "mlb", kind: multi[1] ? "franchise" : "years" };
    }
    if (s === "1") return { contract: "1", pool: "mlb", kind: "extendable" };
    return { contract: s, pool: "mlb", kind: "unknown" };
  }

  function numOrNull(v) {
    if (v == null || v === "") return null;
    var n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  }

  var HEADER_MAP = {
    id: "id",
    player: "name",
    team: "mlbTeam",
    position: "position",
    pos: "position",
    rkov: "rkOv",
    status: "formerTeam",
    age: "age",
    salary: "salary",
    contract: "contractRaw",
    fpts: "fpts",
    "fp/g": "fpg",
    fpg: "fpg",
    "fp/g ": "fpg",
    ros: "ros",
  };

  function mapRow(row) {
    var mapped = {};
    if (!row || typeof row !== "object") return mapped;
    Object.keys(row).forEach(function (k) {
      var key = HEADER_MAP[String(k).trim().toLowerCase()];
      if (key) mapped[key] = row[k];
    });
    return mapped;
  }

  function rowsToPlayers(rows) {
    var players = [];
    var warnings = [];
    var seen = {};
    (rows || []).forEach(function (row, idx) {
      var mapped = mapRow(row);
      var name = String(mapped.name == null ? "" : mapped.name).trim();
      if (!name) return;
      var rawId = String(mapped.id == null ? "" : mapped.id).trim();
      var id = safeId(rawId || ("row-" + (idx + 1)));
      if (!rawId) warnings.push("Row " + (idx + 2) + " (" + name + ") has no ID; used " + id + ".");
      if (seen[id]) warnings.push("Duplicate ID " + id + " (" + name + "); kept the later row.");
      seen[id] = true;
      var parsed = parseContract(mapped.contractRaw);
      var salary = numOrNull(mapped.salary);
      players.push({
        id: id,
        fantraxId: rawId || id,
        name: name,
        mlbTeam: String(mapped.mlbTeam == null ? "" : mapped.mlbTeam).trim(),
        position: String(mapped.position == null ? "" : mapped.position).trim(),
        rkOv: numOrNull(mapped.rkOv),
        age: numOrNull(mapped.age),
        originalSalary: salary == null ? 0 : salary,
        salary: salary == null ? 0 : salary,
        contractRaw: mapped.contractRaw == null ? "" : String(mapped.contractRaw),
        contract: parsed.contract || "—",
        kind: parsed.kind,
        fpts: numOrNull(mapped.fpts),
        fpg: numOrNull(mapped.fpg),
        ros: numOrNull(mapped.ros),
        pool: parsed.pool,
      });
    });
    return { players: players, warnings: warnings };
  }

  function parseCsv(text) {
    var src = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var rows = [];
    var row = [];
    var cur = "";
    var inQ = false;
    for (var i = 0; i < src.length; i++) {
      var c = src.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (src.charAt(i + 1) === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).filter(function (r) {
      return r.some(function (cell) { return String(cell).trim() !== ""; });
    }).map(function (r) {
      var o = {};
      header.forEach(function (h, idx) { o[h] = r[idx] == null ? "" : r[idx]; });
      return o;
    });
  }

  function decodeXml(s) {
    return String(s)
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function xmlAttr(tag, name) {
    var re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '="([^"]*)"');
    var m = re.exec(tag);
    return m ? m[1] : "";
  }

  function parseSharedStrings(xml) {
    var out = [];
    if (!xml) return out;
    var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    var m;
    while ((m = siRe.exec(xml))) {
      var texts = [];
      var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      var t;
      while ((t = tRe.exec(m[1]))) texts.push(decodeXml(t[1]));
      out.push(texts.join(""));
    }
    return out;
  }

  function colIndex(cellRef) {
    var letters = String(cellRef || "").replace(/[^A-Z]/gi, "").toUpperCase();
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function rowsFromSheetXml(sheetXml, sharedXml) {
    var strings = parseSharedStrings(sharedXml || "");
    var matrix = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while ((rm = rowRe.exec(sheetXml || ""))) {
      var cells = [];
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      var cm;
      while ((cm = cellRe.exec(rm[1]))) {
        var attrs = cm[1];
        var inner = cm[2] || "";
        var ref = xmlAttr(attrs, "r");
        var t = xmlAttr(attrs, "t");
        var value = "";
        if (t === "inlineStr") {
          var parts = [];
          var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          var tm;
          while ((tm = tRe.exec(inner))) parts.push(decodeXml(tm[1]));
          value = parts.join("");
        } else {
          var v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          value = v ? decodeXml(v[1]) : "";
          if (t === "s") value = strings[Number(value)] || "";
        }
        cells[colIndex(ref)] = value;
      }
      if (cells.length) matrix.push(cells);
    }
    if (!matrix.length) return [];
    var header = matrix[0];
    var out = [];
    for (var r = 1; r < matrix.length; r++) {
      var obj = {};
      var any = false;
      for (var c = 1; c < header.length; c++) {
        if (!header[c]) continue;
        var val = matrix[r][c] == null ? "" : matrix[r][c];
        if (String(val).trim() !== "") any = true;
        obj[header[c]] = val;
      }
      if (any) out.push(obj);
    }
    return out;
  }

  function findEocd(view) {
    var len = view.byteLength;
    var start = Math.max(0, len - 22 - 65536);
    for (var i = len - 22; i >= start; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  function inflateRaw(bytes) {
    if (typeof require === "function") {
      try {
        var zlib = require("zlib");
        return Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes))));
      } catch (e) { /* browser or no zlib */ }
    }
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("This browser can't unzip .xlsx files. Save the export as CSV and import that."));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  function unzip(buffer) {
    var view = new DataView(buffer);
    var u8 = new Uint8Array(buffer);
    var eocd = findEocd(view);
    if (eocd < 0) return Promise.reject(new Error("That file is not an .xlsx workbook."));
    var count = view.getUint16(eocd + 10, true);
    var cd = view.getUint32(eocd + 16, true);
    var jobs = [];
    for (var n = 0; n < count; n++) {
      if (view.getUint32(cd, true) !== 0x02014b50) {
        return Promise.reject(new Error("Couldn't read the spreadsheet archive."));
      }
      var method = view.getUint16(cd + 10, true);
      var compSize = view.getUint32(cd + 20, true);
      var nameLen = view.getUint16(cd + 28, true);
      var extraLen = view.getUint16(cd + 30, true);
      var commentLen = view.getUint16(cd + 32, true);
      var localOff = view.getUint32(cd + 42, true);
      var name = new TextDecoder().decode(u8.subarray(cd + 46, cd + 46 + nameLen));
      var localNameLen = view.getUint16(localOff + 26, true);
      var localExtraLen = view.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + localNameLen + localExtraLen;
      var comp = u8.subarray(dataStart, dataStart + compSize);
      jobs.push({ name: name, method: method, comp: comp });
      cd += 46 + nameLen + extraLen + commentLen;
    }
    return Promise.all(jobs.map(function (job) {
      if (job.method === 0) return Promise.resolve([job.name, job.comp]);
      if (job.method !== 8) return Promise.reject(new Error("Unsupported spreadsheet compression."));
      return inflateRaw(job.comp).then(function (data) { return [job.name, data]; });
    })).then(function (pairs) {
      var files = {};
      pairs.forEach(function (p) { files[p[0]] = p[1]; });
      return files;
    });
  }

  function decodeName(u8) {
    return new TextDecoder("utf-8").decode(u8);
  }

  function rowsFromXlsxBuffer(buffer) {
    return unzip(buffer).then(function (files) {
      var sheetPath = "xl/worksheets/sheet1.xml";
      var rels = files["xl/_rels/workbook.xml.rels"];
      var wb = files["xl/workbook.xml"];
      if (rels && wb) {
        var relsTxt = decodeName(rels);
        var wbTxt = decodeName(wb);
        var sheetTag = /<sheet\b[^>]*>/.exec(wbTxt);
        var rid = sheetTag && /r:id="([^"]+)"/.exec(sheetTag[0]);
        if (rid) {
          var relTag = new RegExp('<Relationship\\b[^>]*Id="' + rid[1] + '"[^>]*>').exec(relsTxt);
          var target = relTag && /Target="([^"]+)"/.exec(relTag[0]);
          if (target) {
            var t = target[1];
            if (t.indexOf("xl/") !== 0) t = "xl/" + t.replace(/^\//, "");
            sheetPath = t;
          }
        }
      }
      if (!files[sheetPath]) return Promise.reject(new Error("No worksheet found in that workbook."));
      var shared = files["xl/sharedStrings.xml"] ? decodeName(files["xl/sharedStrings.xml"]) : "";
      return rowsFromSheetXml(decodeName(files[sheetPath]), shared);
    });
  }

  function wholeDollars(amount) {
    var n = Number(amount);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: "Bids are whole dollars." };
    }
    if (n < 1) return { ok: false, error: "The minimum bid is $1." };
    if (n > 10000) return { ok: false, error: "That bid is above the $10,000 prototype cap." };
    return { ok: true, value: n };
  }

  function nonNegInt(amount, label) {
    var n = Number(amount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: label + " must be a whole dollar amount, 0 or more." };
    }
    return { ok: true, value: n };
  }

  function teamById(state, teamId) {
    return state.teams[teamId] || null;
  }

  function spent(state, teamId, pool) {
    return (state.awards || []).reduce(function (sum, a) {
      if (a.voided || a.teamId !== teamId || a.pool !== pool) return sum;
      return sum + a.amount;
    }, 0);
  }

  function committed(state, teamId, pool) {
    var a = state.auctions[pool];
    if (!a || a.highTeamId !== teamId) return 0;
    if (a.status !== "open" && a.status !== "closing") return 0;
    return a.highBid || 0;
  }

  function maxBid(state, teamId, pool) {
    var team = teamById(state, teamId);
    if (!team) return 0;
    return Math.max(0, (team.budgets[pool] || 0) - spent(state, teamId, pool));
  }

  function remaining(state, teamId, pool) {
    return maxBid(state, teamId, pool) - committed(state, teamId, pool);
  }

  function liveAuction(state, pool) {
    var a = state.auctions[pool];
    if (!a) return null;
    if (a.status !== "open" && a.status !== "closing") return null;
    return a;
  }

  /* A nomination opens the clock at X.
   * A later bid leaves the clock alone unless remaining is under Y (reset to
   * Reset 1) or, when enabled, under Z (reset to Reset 2, which wins). */
  function extensionMs(remainingMs, timers) {
    if (timers.reset2Enabled && remainingMs < timers.reset2Below * 1000) {
      return timers.reset2To * 1000;
    }
    if (remainingMs < timers.reset1Below * 1000) return timers.reset1To * 1000;
    return null;
  }

  function nextEndsAt(timers, now, currentEnds, isNewBid) {
    if (!isNewBid || currentEnds == null) return now + timers.auctionSeconds * 1000;
    var extra = extensionMs(currentEnds - now, timers);
    if (extra == null) return currentEnds;
    return now + extra;
  }

  function describeTimers(t) {
    var s = "Nomination starts a " + t.auctionSeconds + "s clock. A bid with " +
      t.reset1Below + "s or more left does not move it. Under " + t.reset1Below +
      "s, it resets to " + t.reset1To + "s.";
    if (t.reset2Enabled) {
      s += " Under " + t.reset2Below + "s, it resets to " + t.reset2To + "s instead.";
      if (t.reset2To > t.reset2Below && t.reset2To < t.reset1Below) {
        s += " That new time is still under " + t.reset1Below + "s, so the next bid can apply Reset 1. Set Reset 2's time at or under " + t.reset2Below + "s for a hard floor.";
      }
    } else {
      s += " Reset 2 is off: any bid under " + t.reset1Below + "s resets to " + t.reset1To + "s (set those equal for a classic soft close).";
    }
    return s;
  }

  function cleanTimers(input, prev) {
    var t = Object.assign({}, prev, input || {});
    var num = function (v, d, min, max) {
      var n = Number(v);
      if (!Number.isFinite(n)) return d;
      n = Math.round(n);
      if (n < min) n = min;
      if (n > max) n = max;
      return n;
    };
    var auctionSeconds = num(t.auctionSeconds, prev.auctionSeconds, 5, 3600);
    var reset1Below = num(t.reset1Below, prev.reset1Below, 1, auctionSeconds);
    var reset1To = num(t.reset1To, prev.reset1To, 1, 3600);
    var reset2Below = num(t.reset2Below, prev.reset2Below, 1, 3600);
    var reset2To = num(t.reset2To, prev.reset2To, 1, 3600);
    var reset2Enabled = !!t.reset2Enabled;
    if (reset2Enabled && reset2Below >= reset1Below) {
      return { error: "Reset 2's threshold (Z) has to be lower than Reset 1 (Y)." };
    }
    return {
      timers: {
        auctionSeconds: auctionSeconds,
        reset1Below: reset1Below,
        reset1To: reset1To,
        reset2Enabled: reset2Enabled,
        reset2Below: reset2Below,
        reset2To: reset2To,
      },
    };
  }

  function requireLive(state) {
    if (state.meta.status === "live") return null;
    if (state.meta.status === "paused") return "The draft is paused.";
    if (state.meta.status === "complete") return "The draft is over.";
    return "The commissioner hasn't started the draft.";
  }

  function importPlayers(next, players, now) {
    var busy = Object.keys(next.players).some(function (id) {
      return next.players[id].status !== "available";
    });
    if (next.meta.status === "setup" && !busy) next.players = {};
    var added = 0;
    var updated = 0;
    var skipped = 0;
    (players || []).forEach(function (p) {
      var existing = next.players[p.id];
      if (existing && existing.status !== "available") { skipped++; return; }
      next.players[p.id] = {
        id: p.id,
        fantraxId: p.fantraxId || p.id,
        name: p.name,
        mlbTeam: p.mlbTeam || "",
        position: p.position || "",
        rkOv: p.rkOv,
        age: p.age,
        originalSalary: p.originalSalary,
        salary: p.originalSalary,
        contractRaw: p.contractRaw,
        contract: p.contract,
        kind: p.kind,
        fpts: p.fpts,
        fpg: p.fpg,
        ros: p.ros,
        pool: p.pool === "milb" ? "milb" : "mlb",
        poolEdited: false,
        status: "available",
        winnerTeamId: null,
        winningBid: null,
        wonAt: null,
      };
      if (existing) updated++;
      else added++;
    });
    var total = Object.keys(next.players).length;
    pushLog(next, now, "import", "Imported players (" + added + " new, " + updated + " updated, " + skipped + " skipped). Pool size " + total + ".");
    return { added: added, updated: updated, skipped: skipped };
  }

  function awardPool(next, pool, now, tolerance) {
    var a = next.auctions[pool];
    if (!a || a.frozen) return false;
    if (a.status !== "open" && a.status !== "closing") return false;
    if (now + (tolerance || 0) < a.endsAt) return false;
    var player = next.players[a.playerId];
    var team = next.teams[a.highTeamId];
    if (!player || !team) {
      if (player && player.status === "nominated") player.status = "available";
      next.auctions[pool] = null;
      pushLog(next, now, "award", poolLabel(pool) + " auction cleared (missing player or team).");
      return true;
    }
    player.status = "won";
    player.winnerTeamId = team.id;
    player.winningBid = a.highBid;
    player.wonAt = now;
    player.salary = a.highBid;
    var award = {
      id: uid("award"),
      auctionId: a.auctionId,
      pool: pool,
      playerId: player.id,
      teamId: team.id,
      amount: a.highBid,
      contract: player.contract,
      at: now,
      voided: false,
    };
    next.awards.unshift(award);
    (a.bids || []).forEach(function (b, i, arr) {
      next.bidLog.unshift({
        id: b.id,
        auctionId: a.auctionId,
        pool: pool,
        playerId: player.id,
        teamId: b.teamId,
        amount: b.amount,
        at: b.at,
        endsAt: b.endsAt,
        won: i === arr.length - 1,
        voided: false,
      });
    });
    next.auctions[pool] = null;
    pushLog(next, now, "award", team.name + " won " + player.name + " for $" + a.highBid + " (" + player.contract + ", " + poolLabel(pool) + ").");
    return true;
  }

  function placeBid(next, args) {
    var err = requireLive(next);
    if (err) return err;
    var team = teamById(next, args.teamId);
    if (!team) return "Team not found.";
    var player = next.players[args.playerId];
    var pool = args.pool;
    var auction = pool ? liveAuction(next, pool) : null;
    var opening = !auction;
    if (opening) {
      if (!player) return "Player not found.";
      if (player.status !== "available") return player.name + " is not available.";
      pool = player.pool;
      if (liveAuction(next, pool)) return poolLabel(pool) + " already has a live auction.";
    } else {
      if (auction.status !== "open") return "That auction is closing.";
      if (args.now >= auction.endsAt) return "That auction has ended.";
      player = next.players[auction.playerId];
      if (!player) return "Player not found.";
      pool = auction.pool;
    }
    if (team.locked && team.locked[pool]) return poolLabel(pool) + " roster is locked.";
    var money = wholeDollars(args.amount);
    if (!money.ok) return money.error;
    var cap = maxBid(next, team.id, pool);
    if (money.value > cap) {
      return "That bid is over the " + poolLabel(pool) + " budget (" + (cap < 0 ? "-$" + Math.abs(cap) : "$" + cap) + " available to bid).";
    }
    var timers = next.timers[pool];
    if (opening) {
      var ends = nextEndsAt(timers, args.now, null, false);
      var auctionId = uid("auc");
      var bid = {
        id: uid("bid"),
        teamId: team.id,
        amount: money.value,
        at: args.now,
        prevEndsAt: null,
        endsAt: ends,
      };
      next.players[player.id].status = "nominated";
      next.auctions[pool] = {
        auctionId: auctionId,
        pool: pool,
        playerId: player.id,
        nominatorTeamId: team.id,
        highBid: money.value,
        highTeamId: team.id,
        openedAt: args.now,
        endsAt: ends,
        status: "open",
        frozen: false,
        remainingMs: null,
        closeToken: null,
        seq: 1,
        bids: [bid],
      };
      pushLog(next, args.now, "nominate", team.name + " nominated " + player.name + " (" + poolLabel(pool) + ") at $" + money.value + ".");
      return null;
    }
    if (auction.highTeamId === team.id) return "You're already the high bidder.";
    if (money.value < auction.highBid + 1) return "Bid at least $" + (auction.highBid + 1) + ".";
    var prevEnds = auction.endsAt;
    var newEnds = nextEndsAt(timers, args.now, auction.endsAt, true);
    auction.highBid = money.value;
    auction.highTeamId = team.id;
    auction.endsAt = newEnds;
    auction.seq += 1;
    auction.bids.push({
      id: uid("bid"),
      teamId: team.id,
      amount: money.value,
      at: args.now,
      prevEndsAt: prevEnds,
      endsAt: newEnds,
    });
    var moved = newEnds !== prevEnds;
    pushLog(next, args.now, "bid", team.name + " bid $" + money.value + " on " + player.name + (moved ? " (clock reset)." : "."));
    return null;
  }

  function bump(next, state) {
    next.rev = (state.rev || 0) + 1;
    return ok(next);
  }

  function reduce(state, action) {
    action = action || {};
    var now = action.now || 0;
    if (action.type === "create" || action.type === "reset") {
      var keepId = action.id || (state && action.type === "reset" ? state.meta.id : null);
      var name = action.name || (state && state.meta && state.meta.name) || "Orphan Draft";
      var fresh = blankDraft(name, now, keepId);
      if (action.type === "create" && action.id) fresh.meta.id = action.id;
      pushLog(fresh, now, "create", (action.type === "reset" ? "Draft reset." : "Draft created."));
      fresh.rev = state && action.type === "reset" ? (state.rev || 0) + 1 : 1;
      return ok(fresh);
    }
    if (!state) return fail(null, "No draft yet.");
    var next = normalize(clone(state));

    if (action.type === "import") {
      var pack = importPlayers(next, action.players || [], now);
      return Object.assign(bump(next, state), { info: pack });
    }

    if (action.type === "setPool") {
      var player = next.players[action.playerId];
      if (!player) return fail(state, "Player not found.");
      if (player.status !== "available") return fail(state, player.name + " can't change pools while nominated or won.");
      var pool = action.pool === "milb" ? "milb" : action.pool === "mlb" ? "mlb" : null;
      if (!pool) return fail(state, "Pool must be MLB or MiLB.");
      if (player.pool === pool) return noop(state);
      player.pool = pool;
      player.poolEdited = true;
      pushLog(next, now, "pool", player.name + " moved to the " + poolLabel(pool) + " pool.");
      return bump(next, state);
    }

    if (action.type === "recomputePools") {
      var n = 0;
      Object.keys(next.players).forEach(function (id) {
        var p = next.players[id];
        if (p.status !== "available") return;
        var parsed = parseContract(p.contract);
        p.pool = parsed.pool;
        p.poolEdited = false;
        n++;
      });
      pushLog(next, now, "pool", "Recomputed pools from contracts for " + n + " available players.");
      return bump(next, state);
    }

    if (action.type === "addTeam") {
      var teamName = String(action.name || "").trim();
      if (!teamName) return fail(state, "Team name is required.");
      var mlb = nonNegInt(action.mlb, "MLB budget");
      if (!mlb.ok) return fail(state, mlb.error);
      var milb = nonNegInt(action.milb, "MiLB budget");
      if (!milb.ok) return fail(state, milb.error);
      var used = {};
      Object.keys(next.teams).forEach(function (id) { used[next.teams[id].code] = true; });
      var team = {
        id: uid("t"),
        name: teamName,
        code: makeCode(used),
        budgets: { mlb: mlb.value, milb: milb.value },
        locked: { mlb: false, milb: false },
      };
      next.teams[team.id] = team;
      pushLog(next, now, "team", "Added " + team.name + " (MLB $" + team.budgets.mlb + " / MiLB $" + team.budgets.milb + ", code " + team.code + ").");
      return Object.assign(bump(next, state), { info: { teamId: team.id, code: team.code } });
    }

    if (action.type === "updateTeam") {
      var existing = next.teams[action.teamId];
      if (!existing) return fail(state, "Team not found.");
      if (action.name != null) {
        var renamed = String(action.name).trim();
        if (!renamed) return fail(state, "Team name is required.");
        existing.name = renamed;
      }
      if (action.mlb != null) {
        var nb = nonNegInt(action.mlb, "MLB budget");
        if (!nb.ok) return fail(state, nb.error);
        existing.budgets.mlb = nb.value;
      }
      if (action.milb != null) {
        var nmb = nonNegInt(action.milb, "MiLB budget");
        if (!nmb.ok) return fail(state, nmb.error);
        existing.budgets.milb = nmb.value;
      }
      pushLog(next, now, "team", "Updated " + existing.name + " budgets (MLB $" + existing.budgets.mlb + " / MiLB $" + existing.budgets.milb + ").");
      return bump(next, state);
    }

    if (action.type === "removeTeam") {
      var victim = next.teams[action.teamId];
      if (!victim) return fail(state, "Team not found.");
      var wonAny = (next.awards || []).some(function (a) { return !a.voided && a.teamId === victim.id; });
      if (wonAny) return fail(state, victim.name + " already has players. Void those awards first.");
      var bidding = POOLS.some(function (pool) {
        var a = liveAuction(next, pool);
        return a && (a.highTeamId === victim.id || a.nominatorTeamId === victim.id || (a.bids || []).some(function (b) { return b.teamId === victim.id; }));
      });
      if (bidding) return fail(state, victim.name + " is in a live auction.");
      if (next.meta.status !== "setup" && next.meta.status !== "paused") {
        return fail(state, "Remove teams during setup or while paused.");
      }
      delete next.teams[victim.id];
      pushLog(next, now, "team", "Removed " + victim.name + ".");
      return bump(next, state);
    }

    if (action.type === "setTimers") {
      if (POOLS.indexOf(action.pool) < 0) return fail(state, "Unknown pool.");
      var cleaned = cleanTimers(action.timers, next.timers[action.pool]);
      if (cleaned.error) return fail(state, cleaned.error);
      next.timers[action.pool] = cleaned.timers;
      pushLog(next, now, "timer", poolLabel(action.pool) + " timers updated. " + describeTimers(cleaned.timers));
      return bump(next, state);
    }

    if (action.type === "setAllTimers") {
      var mlbT = cleanTimers(action.mlb, next.timers.mlb);
      if (mlbT.error) return fail(state, "MLB: " + mlbT.error);
      var milbT = cleanTimers(action.milb, next.timers.milb);
      if (milbT.error) return fail(state, "MiLB: " + milbT.error);
      next.timers.mlb = mlbT.timers;
      next.timers.milb = milbT.timers;
      pushLog(next, now, "timer", "Both pool timers updated.");
      return bump(next, state);
    }

    if (action.type === "start") {
      if (next.meta.status === "live") return noop(state);
      if (next.meta.status === "paused") return fail(state, "The draft is paused. Resume it.");
      if (!Object.keys(next.teams).length) return fail(state, "Add at least one drafting team.");
      if (!Object.keys(next.players).length) return fail(state, "Import the player pool first.");
      next.meta.status = "live";
      next.meta.pausedAt = null;
      pushLog(next, now, "start", "Draft is live.");
      return bump(next, state);
    }

    if (action.type === "pause") {
      if (next.meta.status !== "live") return fail(state, "Only a live draft can be paused.");
      next.meta.status = "paused";
      next.meta.pausedAt = now;
      POOLS.forEach(function (pool) {
        var a = next.auctions[pool];
        if (!a) return;
        a.remainingMs = Math.max(0, a.endsAt - now);
        a.frozen = true;
        a.status = "open";
        a.closeToken = null;
      });
      pushLog(next, now, "pause", "Draft paused. Clocks are frozen.");
      return bump(next, state);
    }

    if (action.type === "resume") {
      if (next.meta.status !== "paused") return fail(state, "The draft is not paused.");
      next.meta.status = "live";
      next.meta.pausedAt = null;
      POOLS.forEach(function (pool) {
        var a = next.auctions[pool];
        if (!a || !a.frozen) return;
        var rem = Math.max(0, a.remainingMs || 0);
        a.endsAt = now + rem;
        a.frozen = false;
        a.remainingMs = null;
        a.status = "open";
        a.closeToken = null;
      });
      pushLog(next, now, "resume", "Draft resumed.");
      return bump(next, state);
    }

    if (action.type === "end") {
      if (next.meta.status === "complete") return noop(state);
      var open = POOLS.some(function (pool) { return !!liveAuction(next, pool); });
      if (open) return fail(state, "Let the open auction finish, or undo the nomination, before ending.");
      next.meta.status = "complete";
      next.meta.pausedAt = null;
      pushLog(next, now, "end", "Draft marked complete.");
      return bump(next, state);
    }

    if (action.type === "nominate") {
      var nomErr = placeBid(next, {
        teamId: action.teamId,
        playerId: action.playerId,
        amount: action.amount,
        now: now,
      });
      if (nomErr) return fail(state, nomErr);
      return bump(next, state);
    }

    if (action.type === "bid") {
      var bidErr = placeBid(next, {
        teamId: action.teamId,
        pool: action.pool,
        amount: action.amount,
        now: now,
      });
      if (bidErr) return fail(state, bidErr);
      return bump(next, state);
    }

    if (action.type === "lock") {
      var locker = next.teams[action.teamId];
      if (!locker) return fail(state, "Team not found.");
      if (POOLS.indexOf(action.pool) < 0) return fail(state, "Unknown pool.");
      var locked = !!action.locked;
      if (!!locker.locked[action.pool] === locked) return noop(state);
      locker.locked[action.pool] = locked;
      pushLog(next, now, "lock", locker.name + (locked ? " locked " : " unlocked ") + poolLabel(action.pool) + ".");
      return bump(next, state);
    }

    if (action.type === "tick") {
      if (next.meta.status !== "live") return noop(state);
      var changed = false;
      POOLS.forEach(function (pool) {
        var a = next.auctions[pool];
        if (!a || a.status !== "open" || a.frozen) return;
        if (awardPool(next, pool, now, 0)) changed = true;
      });
      if (!changed) return noop(state);
      return bump(next, state);
    }

    if (action.type === "markClosing") {
      if (next.meta.status !== "live") return noop(state);
      var marked = false;
      POOLS.forEach(function (pool) {
        var a = next.auctions[pool];
        if (!a || a.status !== "open" || a.frozen) return;
        if (now < a.endsAt) return;
        a.status = "closing";
        a.closeToken = null;
        marked = true;
      });
      if (!marked) return noop(state);
      return bump(next, state);
    }

    if (action.type === "awardClosing") {
      var pool = action.pool;
      var a = next.auctions[pool];
      if (!a || a.status !== "closing") return noop(state);
      if (typeof a.closeToken !== "number") return noop(state);
      var tol = action.tolerance == null ? 500 : action.tolerance;
      if (a.closeToken + tol < a.endsAt) {
        a.status = "open";
        a.closeToken = null;
        pushLog(next, now, "timer", poolLabel(pool) + " close was early and was reopened.");
        return bump(next, state);
      }
      if (!awardPool(next, pool, a.closeToken, tol)) return noop(state);
      return bump(next, state);
    }

    if (action.type === "reopenClosing") {
      var stuck = next.auctions[action.pool];
      if (!stuck || stuck.status !== "closing") return noop(state);
      stuck.status = "open";
      stuck.closeToken = null;
      return bump(next, state);
    }

    if (action.type === "undoBid") {
      var auc = next.auctions[action.pool];
      if (!auc || (auc.status !== "open" && !auc.frozen)) return fail(state, "No open " + poolLabel(action.pool) + " auction.");
      if (!auc.bids || !auc.bids.length) return fail(state, "No bids to undo.");
      var removed = auc.bids.pop();
      var removedTeam = next.teams[removed.teamId];
      var removedName = removedTeam ? removedTeam.name : removed.teamId;
      var p = next.players[auc.playerId];
      if (!auc.bids.length) {
        if (p && p.status === "nominated") p.status = "available";
        next.auctions[action.pool] = null;
        pushLog(next, now, "undo", "Voided " + removedName + "'s $" + removed.amount + " nomination"
          + (p ? " of " + p.name : "") + ". Player is back in the pool.");
        return bump(next, state);
      }
      var prev = auc.bids[auc.bids.length - 1];
      auc.highBid = prev.amount;
      auc.highTeamId = prev.teamId;
      auc.seq += 1;
      if (auc.frozen) {
        var pauseAt = next.meta.pausedAt || now;
        var restored = prev.endsAt;
        var rem = restored - pauseAt;
        if (rem < 1000) rem = Math.max(10, next.timers[action.pool].reset1To) * 1000;
        auc.remainingMs = rem;
        auc.endsAt = pauseAt + rem;
      } else {
        var ends = prev.endsAt;
        if (ends <= now + 500) ends = now + Math.max(10, next.timers[action.pool].reset1To) * 1000;
        auc.endsAt = ends;
      }
      pushLog(next, now, "undo", "Voided " + removedName + "'s $" + removed.amount + " bid"
        + (p ? " on " + p.name : "") + ". High bid is $" + auc.highBid + ".");
      return bump(next, state);
    }

    if (action.type === "voidAward") {
      var award = (next.awards || []).find(function (a) { return a.id === action.awardId && !a.voided; });
      if (!award) return fail(state, "Award not found.");
      var wonPlayer = next.players[award.playerId];
      if (!wonPlayer || wonPlayer.status !== "won" || wonPlayer.winnerTeamId !== award.teamId) {
        return fail(state, "That player is no longer on the winning roster.");
      }
      award.voided = true;
      wonPlayer.status = "available";
      wonPlayer.winnerTeamId = null;
      wonPlayer.winningBid = null;
      wonPlayer.wonAt = null;
      wonPlayer.salary = wonPlayer.originalSalary;
      (next.bidLog || []).forEach(function (b) {
        if (b.auctionId === award.auctionId) b.voided = true;
      });
      var winner = next.teams[award.teamId];
      pushLog(next, now, "void", "Voided " + (winner ? winner.name : "team") + "'s win of " + wonPlayer.name + ". Player is back in the " + poolLabel(award.pool) + " pool.");
      if (next.meta.status === "complete") next.meta.status = "live";
      return bump(next, state);
    }

    return fail(state, "Unknown action.");
  }

  function csvEscape(value) {
    var s = String(value == null ? "" : value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCsv(state) {
    var lines = [["Player", "Winning Team", "Contract", "New Salary", "Pool"].join(",")];
    var awards = (state && state.awards ? state.awards : []).filter(function (a) { return !a.voided; }).slice().reverse();
    awards.forEach(function (a) {
      var p = state.players[a.playerId];
      var t = state.teams[a.teamId];
      lines.push([
        csvEscape(p ? p.name : a.playerId),
        csvEscape(t ? t.name : a.teamId),
        csvEscape(a.contract),
        String(a.amount),
        a.pool === "milb" ? "MiLB" : "MLB",
      ].join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function teamByCode(state, code) {
    if (!state || !code) return null;
    var want = String(code).trim().toUpperCase();
    var found = null;
    Object.keys(state.teams || {}).forEach(function (id) {
      if (state.teams[id].code === want) found = state.teams[id];
    });
    return found;
  }

  /* Retry a pure reduce until the rev it was based on is still current.
   * Firebase does this inside runTransaction; demo mode does it under a lock.
   * Exposed so tests can prove two stale bids don't clobber each other. */
  function transact(cell, action) {
    for (var i = 0; i < 8; i++) {
      var snap = cell.state;
      var result = reduce(snap, action);
      if (!result.ok || !result.changed) return result;
      if (cell.state !== snap) continue;
      cell.state = result.state;
      return result;
    }
    return fail(cell.state, "Too much contention. Try that bid again.");
  }

  return {
    POOLS: POOLS,
    defaultTimers: defaultTimers,
    fastTimers: fastTimers,
    blankDraft: blankDraft,
    normalize: normalize,
    clone: clone,
    parseContract: parseContract,
    parseCsv: parseCsv,
    rowsToPlayers: rowsToPlayers,
    rowsFromSheetXml: rowsFromSheetXml,
    rowsFromXlsxBuffer: rowsFromXlsxBuffer,
    reduce: reduce,
    transact: transact,
    spent: spent,
    committed: committed,
    maxBid: maxBid,
    remaining: remaining,
    describeTimers: describeTimers,
    exportCsv: exportCsv,
    teamByCode: teamByCode,
    poolLabel: poolLabel,
    extensionMs: extensionMs,
    nextEndsAt: nextEndsAt,
    safeId: safeId,
  };
});
