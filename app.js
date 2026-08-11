/* ========= Config ========= */
const APP_PASSWORD = "legends";
const CURRENT_YEAR = 2026;
const CURRENT_CAP = 360;
const OFFSEASON_CAP = 260;
const SLOT_DEFS = { OF:3, SS:1, "2B":1, "3B":1, "1B":1, C:1, SP:4, RP:3, P:2, UT:2 };
const FX = {
  rosters: (id) => "https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=" + encodeURIComponent(id),
  league:  (id) => "https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=" + encodeURIComponent(id),
  players: () => "https://www.fantrax.com/fxea/general/getPlayerIds?sport=MLB",
};

let leagueId = null, leagueName = "", teamId = null, teamName = "";
let basePlayers = [];
let currentYear = CURRENT_YEAR;
let state = {};
let playerNames = {};
let playerInfo = {};

function showToast(msg, isError) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2500);
}
function $(id) { return document.getElementById(id); }
function showScreen(name) {
  ["loginScreen", "setupScreen", "dashboard"].forEach(id => {
    $(id).classList.toggle("hidden", id !== name);
  });
}
function isAuthed() { return sessionStorage.getItem("fl_auth") === "1"; }
function doLogin() {
  if ($("passwordInput").value === APP_PASSWORD) {
    sessionStorage.setItem("fl_auth", "1");
    $("loginError").textContent = "";
    showSetup();
  } else {
    $("loginError").textContent = "Incorrect password.";
  }
}
function doLogout() {
  sessionStorage.removeItem("fl_auth");
  sessionStorage.removeItem("fl_leagueId");
  sessionStorage.removeItem("fl_teamId");
  showScreen("loginScreen");
}
function showSetup() {
  showScreen("setupScreen");
  const saved = sessionStorage.getItem("fl_leagueId");
  if (saved) $("leagueIdInput").value = saved;
}

async function fetchJson(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function ensurePlayerNames() {
  const cached = sessionStorage.getItem("fl_playerNames");
  if (cached) {
    try { playerNames = JSON.parse(cached); return; } catch (_) {}
  }
  $("setupStatus").textContent = "Downloading MLB player list (one-time)…";
  const data = await fetchJson(FX.players());
  const map = {};
  for (const [id, p] of Object.entries(data)) {
    if (p && p.name) map[id] = p.name;
  }
  playerNames = map;
  try { sessionStorage.setItem("fl_playerNames", JSON.stringify(map)); } catch (_) {}
}

async function loadLeague() {
  const id = $("leagueIdInput").value.trim();
  $("setupError").textContent = "";
  $("setupStatus").textContent = "";
  $("setupStatus").className = "status-msg";
  if (!id) { $("setupError").textContent = "Enter a Fantrax league ID."; return; }
  $("loadLeagueBtn").disabled = true;
  $("setupStatus").textContent = "Loading league…";
  try {
    await ensurePlayerNames();
    $("setupStatus").textContent = "Fetching rosters…";
    const [rosters, league] = await Promise.all([
      fetchJson(FX.rosters(id)),
      fetchJson(FX.league(id)),
    ]);
    leagueId = id;
    leagueName = league.leagueName || "Fantrax League";
    playerInfo = league.playerInfo || {};
    const teams = Object.entries(rosters.rosters || {}).map(([tid, t]) => ({
      id: tid,
      name: t.teamName || (league.teamInfo && league.teamInfo[tid] && league.teamInfo[tid].name) || tid,
      count: (t.rosterItems || []).length,
      items: t.rosterItems || [],
    })).sort((a, b) => a.name.localeCompare(b.name));
    if (!teams.length) throw new Error("No teams found for this league ID.");
    window._fxTeams = teams;
    const sel = $("teamSelect");
    sel.innerHTML = teams.map(t => '<option value="' + t.id + '">' + t.name + " (" + t.count + ")</option>").join("");
    const savedTeam = sessionStorage.getItem("fl_teamId");
    if (savedTeam && teams.some(t => t.id === savedTeam)) sel.value = savedTeam;
    $("teamField").classList.remove("hidden");
    $("enterRow").classList.remove("hidden");
    $("setupStatus").className = "status-msg ok";
    $("setupStatus").textContent = "Loaded " + leagueName + " · " + teams.length + " teams";
    sessionStorage.setItem("fl_leagueId", id);
  } catch (e) {
    $("setupError").textContent = "Could not load league: " + (e.message || e);
    $("setupStatus").textContent = "";
  } finally {
    $("loadLeagueBtn").disabled = false;
  }
}

function buildRosterFromTeam(team) {
  return (team.items || []).map(p => {
    const pid = p.id;
    const eligStr = (playerInfo[pid] && playerInfo[pid].eligiblePos) || "UT";
    const elig = eligStr.split(",").map(s => s.trim()).filter(Boolean);
    if (!elig.includes("UT")) elig.push("UT");
    return {
      id: pid, name: playerNames[pid] || pid, position: p.position || "UT",
      status: p.status || "ACTIVE", salary: Number(p.salary || 0),
      contract: (p.contract && p.contract.name) || "1", eligible: elig,
      extension: null, rookieEligible: false, frozen: false,
    };
  });
}

function enterDashboard() {
  const tid = $("teamSelect").value;
  const team = (window._fxTeams || []).find(t => t.id === tid);
  if (!team) { $("setupError").textContent = "Select a team."; return; }
  teamId = tid; teamName = team.name;
  basePlayers = buildRosterFromTeam(team);
  currentYear = CURRENT_YEAR;
  sessionStorage.setItem("fl_teamId", tid);
  $("teamTitle").textContent = teamName;
  $("leagueSub").textContent = leagueName + " · Fantrax " + leagueId;
  showScreen("dashboard");
  render();
}

function eligOf(p) { return Array.isArray(p.eligible) ? p.eligible : []; }
function canPlay(p, pos) {
  if (pos === "UT" || pos === "BENCH" || pos === "IR" || pos === "MINORS") return true;
  return eligOf(p).includes(pos);
}
function effectiveContract(p) {
  return p.contract || "1";
}
function willGraduateToR2(p) {
  return (p.contract || "").toUpperCase() === "R1" && !!p.rookieEligible;
}
function isRookieContract(c) {
  const u = (c || "").toUpperCase();
  return u === "R1" || u === "R2";
}
function needsExtension(p) {
  if (willGraduateToR2(p)) return false;
  const c = effectiveContract(p);
  return c === "1" || c.toUpperCase() === "R2";
}
function canFreeze(p) {
  const c = effectiveContract(p);
  if (c.toUpperCase() === "R2") return true;
  if (/F?\d+\s*\/\s*\d+/i.test(c)) return true;
  return false;
}
function teamHasF(list) {
  return list.some(p => {
    if ((p.contract || "").toUpperCase().includes("F")) return true;
    if (p.extension === 5) return true;
    return false;
  });
}
function countingSalary(p, year) {
  if (year > CURRENT_YEAR) {
    const c = effectiveContract(p);
    if (p.status === "MINORS" && isRookieContract(c)) return 0;
  }
  return Number(p.salary || 0);
}
function projectOneYear(p) {
  const c0 = effectiveContract(p);
  const sal0 = Number(p.salary || 0);
  if (p.frozen) return { ...p, frozen: false, extension: null, rookieEligible: false };
  if ((c0 || "").toUpperCase() === "R1" && p.rookieEligible) {
    let status = p.status;
    if (status === "MINORS") status = "RESERVE";
    return { ...p, contract: "R2", salary: sal0, status, extension: null, rookieEligible: false, frozen: false };
  }
  if (p.extension && (c0 === "1" || c0.toUpperCase() === "R2")) {
    const years = p.extension;
    const isF = years === 5;
    const bump = isF ? 1 : 3;
    return { ...p, contract: (isF ? "F" : "") + "1/" + years, salary: sal0 + bump, extension: null, rookieEligible: false, frozen: false };
  }
  if (c0.toUpperCase() === "R2") return null;
  if (c0.toUpperCase() === "R1") {
    return { ...p, contract: "R1", salary: sal0, extension: null, rookieEligible: false, frozen: false };
  }
  const m = String(c0).match(/F?(\d+)\s*\/\s*(\d+)/i);
  if (m) {
    const cur = parseInt(m[1], 10), total = parseInt(m[2], 10);
    const isF = /F/i.test(c0);
    if (cur >= total) return null;
    const bump = isF ? 1 : 3;
    return { ...p, contract: (isF ? "F" : "") + (cur + 1) + "/" + total, salary: sal0 + bump, extension: null, rookieEligible: false, frozen: false };
  }
  if (/^\d+$/.test(c0)) {
    if (c0 === "1") return null;
    return { ...p, contract: String(parseInt(c0, 10) + 1), salary: sal0 + 3, extension: null, frozen: false };
  }
  return { ...p, contract: c0, salary: sal0, extension: null, frozen: false };
}
function buildYears() {
  const years = {};
  years[CURRENT_YEAR] = { cap: CURRENT_CAP, label: CURRENT_YEAR + " (Current)", players: basePlayers.map(p => ({ ...p })) };
  let prev = years[CURRENT_YEAR].players;
  for (let i = 1; i <= 3; i++) {
    const y = CURRENT_YEAR + i;
    const next = [];
    for (const p of prev) {
      const np = projectOneYear(p);
      if (np) next.push(np);
    }
    years[y] = { cap: OFFSEASON_CAP, label: y + " (Offseason)", players: next };
    prev = next;
  }
  return years;
}

function emptyCard() {
  return '<div class="player empty" data-empty="1"><div class="name">Empty</div></div>';
}
function extControls(p) {
  if (currentYear !== CURRENT_YEAR) return "";
  let html = "";
  if ((p.contract || "").toUpperCase() === "R1") {
    const on = p.rookieEligible ? "on" : "";
    html += '<button type="button" class="cs-btn ctl-btn r2 ' + on + '" data-action="rookie" data-id="' + p.id + '">' +
      (p.rookieEligible ? "R2 (eligible) \u2713" : "Mark R1 \u2192 R2") + "</button>";
  }
  if (canFreeze(p)) {
    const on = p.frozen ? "on" : "";
    html += '<button type="button" class="cs-btn ctl-btn freeze ' + on + '" data-action="freeze" data-id="' + p.id + '">' +
      (p.frozen ? "Frozen \u2713" : "Freeze contract") + "</button>";
  }
  if (needsExtension(p)) {
    const hasF = teamHasF(basePlayers.filter(x => x.id !== p.id));
    const cur = p.extension || "";
    let cls = "ext-select";
    if (p.extension) cls += p.extension === 5 ? " has-f" : " has-ext";
    html += '<select class="' + cls + '" data-action="extend" data-id="' + p.id + '">' +
      '<option value="">No extension (release)</option>' +
      '<option value="1"' + (cur===1?" selected":"") + '>Extend 1 year (+$3)</option>' +
      '<option value="2"' + (cur===2?" selected":"") + '>Extend 2 years (+$3/yr)</option>' +
      '<option value="3"' + (cur===3?" selected":"") + '>Extend 3 years (+$3/yr)</option>' +
      '<option value="4"' + (cur===4?" selected":"") + '>Extend 4 years (+$3/yr)</option>' +
      '<option value="5"' + (cur===5?" selected":"") + (hasF && cur!==5 ? " disabled" : "") +
        '>Extend 5 years F (+$1/yr)' + (hasF && cur!==5 ? " \u2014 F taken" : "") + "</option></select>";
  }
  return html ? '<div class="ext-row">' + html + "</div>" : "";
}
function playerCard(p) {
  if (!p) return emptyCard();
  const c = effectiveContract(p);
  const elig = eligOf(p).join(", ");
  return '<div class="player" draggable="true" data-id="' + p.id +
    '" data-name="' + p.name.replace(/"/g, "&quot;") +
    '" data-eligible=\'' + JSON.stringify(p.eligible) +
    '\' data-salary="' + p.salary + '" data-contract="' + c +
    '" data-status="' + p.status + '" data-position="' + p.position + '">' +
    '<div class="name">' + p.name + "</div>" +
    '<div class="meta">$' + Number(p.salary).toFixed(0) + " \u00b7 " + (willGraduateToR2(p) ? "R1\u2192R2" : c) + (p.frozen ? " \u2744" : "") + "</div>" +
    '<div class="elig-hint">' + elig + "</div>" + extControls(p) + "</div>";
}
function benchCard(p, extraClass) {
  const c = effectiveContract(p);
  const elig = eligOf(p).join(", ");
  return '<div class="bench-card ' + (extraClass||"") + '" draggable="true" data-id="' + p.id +
    '" data-name="' + p.name.replace(/"/g, "&quot;") +
    '" data-eligible=\'' + JSON.stringify(p.eligible) +
    '\' data-salary="' + p.salary + '" data-contract="' + c +
    '" data-status="' + p.status + '" data-position="' + p.position + '">' +
    '<div class="top"><div class="left"><div class="name">' + p.name + "</div>" +
    '<div class="pos">' + p.position + " \u00b7 " + elig + "</div></div>" +
    '<div class="right"><div class="salary">$' + Number(p.salary).toFixed(0) + "</div>" +
    '<div class="contract">' + (willGraduateToR2(p) ? "R1\u2192R2" : c) + (p.frozen ? " \u2744" : "") + "</div></div></div>" +
    extControls(p) + "</div>";
}
function getYearPlayers() { return state[currentYear].players; }
function groupPlayers(list) {
  const active = list.filter(p => p.status === "ACTIVE");
  const byPos = {};
  active.forEach(p => {
    const pos = p.position || "UT";
    if (!byPos[pos]) byPos[pos] = [];
    byPos[pos].push(p);
  });
  return {
    byPos,
    reserve: list.filter(p => p.status === "RESERVE"),
    ir: list.filter(p => p.status === "INJURED_RESERVE"),
    minors: list.filter(p => p.status === "MINORS"),
  };
}
function fillSlot(container, pos, count, byPos) {
  container.innerHTML = "";
  const arr = byPos[pos] || [];
  for (let i = 0; i < count; i++) {
    const wrap = document.createElement("div");
    wrap.className = "side-slot drop-zone";
    wrap.dataset.slot = pos + "_" + i;
    wrap.dataset.pos = pos;
    wrap.dataset.status = "ACTIVE";
    wrap.innerHTML = playerCard(arr[i] || null);
    container.appendChild(wrap);
  }
}
function render() {
  state = buildYears();
  const yd = state[currentYear];
  const list = yd.players;
  const g = groupPlayers(list);
  const total = list.reduce((s, p) => s + countingSalary(p, currentYear), 0);
  const cap = yd.cap;
  const space = cap - total;
  const amt = $("salaryAmount");
  amt.textContent = "$" + total.toFixed(0) + " / $" + cap;
  amt.classList.toggle("over", total > cap);
  $("capSpace").textContent =
    (space >= 0 ? "Cap Space: $" : "Over Cap: $") + Math.abs(space).toFixed(0) +
    (currentYear > CURRENT_YEAR ? " (MiLB R = $0)" : "");
  document.querySelectorAll(".diamond .slot").forEach(slot => {
    const pos = slot.dataset.pos;
    const raw = slot.dataset.slot || "";
    const parts = raw.split("_");
    const idx = parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : 0;
    [...slot.querySelectorAll(".player")].forEach(n => n.remove());
    const arr = g.byPos[pos] || [];
    slot.insertAdjacentHTML("beforeend", playerCard(arr[idx] || null));
  });
  fillSlot($("spGrid"), "SP", 4, g.byPos);
  fillSlot($("rpGrid"), "RP", 3, g.byPos);
  fillSlot($("pGrid"), "P", 2, g.byPos);
  fillSlot($("utGrid"), "UT", 2, g.byPos);
  $("benchGrid").innerHTML = g.reserve.map(p => benchCard(p, "bench-only-card")).join("");
  $("benchCount").textContent = g.reserve.length + " / 7";
  $("irGrid").innerHTML = g.ir.map(p => benchCard(p, "ir-card")).join("");
  $("irCount").textContent = g.ir.length;
  $("minorsGrid").innerHTML = g.minors.map(p => benchCard(p, "minors-card")).join("");
  $("minorsCount").textContent = g.minors.length;
  const expSec = $("expiredSection");
  if (currentYear > CURRENT_YEAR) {
    const ids = new Set(list.map(p => p.id));
    const expired = basePlayers.filter(p => !ids.has(p.id));
    const prev = state[currentYear - 1] ? state[currentYear - 1].players : basePlayers;
    const prevMap = Object.fromEntries(prev.map(p => [p.id, p]));
    $("expiredGrid").innerHTML = expired.map(p => {
      const src = prevMap[p.id] || p;
      return benchCard({ ...src, status: "EXPIRED" }, "");
    }).join("") || "<div style='color:var(--text-3);font-size:0.85rem'>None</div>";
    $("expiredCount").textContent = expired.length;
    expSec.style.display = "block";
  } else {
    expSec.style.display = "none";
  }
  bindDrag();
  bindExtControls();
  buildTabs();
}
function findInBase(id) { return basePlayers.find(p => p.id === id); }
function findInYear(id) { return getYearPlayers().find(p => p.id === id); }

function bindExtControls() {
  document.querySelectorAll("[data-action='extend']").forEach(sel => {
    sel.addEventListener("change", e => {
      e.stopPropagation();
      const p = findInBase(sel.dataset.id);
      if (!p) return;
      const v = sel.value;
      if (!v) {
        p.extension = null;
        showToast(p.name + ": no extension \u2192 will release");
      } else {
        const years = parseInt(v, 10);
        if (years === 5 && teamHasF(basePlayers.filter(x => x.id !== p.id))) {
          showToast("Only 1 Franchise (F) tag benefit allowed", true);
          sel.value = p.extension || "";
          return;
        }
        p.extension = years;
        p.frozen = false;
        showToast(p.name + " \u2192 " + years + "yr" + (years === 5 ? " F (+$1/yr)" : " (+$3/yr)"));
      }
      render();
    });
    sel.addEventListener("mousedown", e => e.stopPropagation());
    sel.addEventListener("click", e => e.stopPropagation());
  });
  document.querySelectorAll("[data-action='rookie']").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation(); e.preventDefault();
      const p = findInBase(btn.dataset.id);
      if (!p) return;
      p.rookieEligible = !p.rookieEligible;
      if (!p.rookieEligible) p.extension = null;
      showToast(p.name + (p.rookieEligible ? " marked R1\u2192R2 (next year: R2, same $, off Minors)" : " back to R1"));
      render();
    });
    btn.addEventListener("mousedown", e => e.stopPropagation());
  });
  document.querySelectorAll("[data-action='freeze']").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation(); e.preventDefault();
      const p = findInBase(btn.dataset.id);
      if (!p) return;
      p.frozen = !p.frozen;
      if (p.frozen) p.extension = null;
      showToast(p.name + (p.frozen ? " contract frozen" : " unfrozen"));
      render();
    });
    btn.addEventListener("mousedown", e => e.stopPropagation());
  });
}

function bindDrag() {
  let draggedEl = null;
  document.querySelectorAll(".player:not(.empty), .bench-card").forEach(el => {
    el.addEventListener("dragstart", e => {
      if (e.target.closest("select, button")) { e.preventDefault(); return; }
      draggedEl = el;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", el.dataset.id);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      document.querySelectorAll(".drag-over-valid, .drag-over-invalid").forEach(s => {
        s.classList.remove("drag-over-valid", "drag-over-invalid");
      });
      draggedEl = null;
    });
  });
  document.querySelectorAll(".slot, .side-slot, .drop-zone").forEach(zone => {
    zone.addEventListener("dragover", e => {
      e.preventDefault();
      if (!draggedEl) return;
      const p = findInYear(draggedEl.dataset.id);
      if (!p) return;
      const pos = zone.dataset.pos;
      const valid = canPlay(p, pos);
      zone.classList.toggle("drag-over-valid", valid);
      zone.classList.toggle("drag-over-invalid", !valid);
      e.dataTransfer.dropEffect = valid ? "move" : "none";
    });
    zone.addEventListener("dragleave", () => {
      zone.classList.remove("drag-over-valid", "drag-over-invalid");
    });
    zone.addEventListener("drop", e => {
      e.preventDefault();
      zone.classList.remove("drag-over-valid", "drag-over-invalid");
      if (!draggedEl) return;
      const id = draggedEl.dataset.id;
      const list = currentYear === CURRENT_YEAR ? basePlayers : state[currentYear].players;
      const p = list.find(x => x.id === id);
      if (!p) return;
      const targetPos = zone.dataset.pos;
      const targetStatus = zone.dataset.status || "ACTIVE";
      if (!canPlay(p, targetPos)) {
        showToast(p.name + " is not eligible for " + targetPos, true);
        return;
      }
      if (targetStatus === "ACTIVE" && !["BENCH","IR","MINORS"].includes(targetPos)) {
        const max = SLOT_DEFS[targetPos] || 1;
        const occupants = list.filter(x => x.status === "ACTIVE" && x.position === targetPos && x.id !== id);
        if (occupants.length >= max) {
          const _parts = (zone.dataset.slot || "").split("_");
          const idx = _parts.length > 1 ? parseInt(_parts[_parts.length - 1], 10) : 0;
          const inSlot = occupants[idx] || occupants[occupants.length - 1];
          if (inSlot) {
            if (p.status === "ACTIVE" && canPlay(inSlot, p.position)) {
              inSlot.status = "ACTIVE";
              inSlot.position = p.position;
            } else {
              inSlot.status = "RESERVE";
            }
          }
        }
        p.status = "ACTIVE";
        p.position = targetPos;
        showToast(p.name + " \u2192 " + targetPos);
      } else if (targetStatus === "RESERVE" || targetPos === "BENCH") {
        p.status = "RESERVE";
        showToast(p.name + " \u2192 Bench");
      } else if (targetStatus === "INJURED_RESERVE" || targetPos === "IR") {
        p.status = "INJURED_RESERVE";
        showToast(p.name + " \u2192 IR");
      } else if (targetStatus === "MINORS" || targetPos === "MINORS") {
        const cDrop = (effectiveContract(p) || "").toUpperCase();
        if (cDrop === "R2") {
          showToast(p.name + " is R2 and cannot be on Minors", true);
          return;
        }
        p.status = "MINORS";
        showToast(p.name + " \u2192 Minors");
      }
      render();
    });
  });
}

function buildTabs() {
  const tabs = $("yearTabs");
  const activeY = currentYear;
  tabs.innerHTML = "";
  Object.keys(state).map(Number).sort().forEach(y => {
    const btn = document.createElement("button");
    btn.className = "year-tab cs-btn" + (y === activeY ? " active" : "");
    btn.innerHTML = state[y].label + '<span class="cap-note">$' + state[y].cap + "</span>";
    btn.addEventListener("click", () => { currentYear = y; render(); });
    tabs.appendChild(btn);
  });
}

$("loginBtn").addEventListener("click", doLogin);
$("passwordInput").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
$("loadLeagueBtn").addEventListener("click", loadLeague);
$("leagueIdInput").addEventListener("keydown", e => { if (e.key === "Enter") loadLeague(); });
$("enterDashBtn").addEventListener("click", enterDashboard);
$("logoutBtn").addEventListener("click", doLogout);
$("changeTeamBtn").addEventListener("click", () => showSetup());
$("resetContractsBtn").addEventListener("click", () => {
  let n = 0;
  basePlayers.forEach(p => {
    if (p.extension != null || p.rookieEligible || p.frozen) n++;
    p.extension = null;
    p.rookieEligible = false;
    p.frozen = false;
  });
  showToast(n ? ("Reset " + n + " contract selection" + (n > 1 ? "s" : "")) : "No contract selections to reset");
  render();
});

if (isAuthed()) showSetup();
else showScreen("loginScreen");
