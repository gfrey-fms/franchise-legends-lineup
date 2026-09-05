/* Power rankings overlay — loaded after app.js */
FX.standings = (id) => "https://www.fantrax.com/fxea/general/getStandings?leagueId=" + encodeURIComponent(id);
FX.matchups = (id, period) => "https://www.fantrax.com/fxea/general/getMatchupScores?leagueId=" + encodeURIComponent(id) + (period ? ("&period=" + period) : "");
const RANK_WEIGHTS = { recent: 0.5, season: 0.3, win: 0.2 };
const PLAYOFF_TEAMS_PER_LEAGUE = 6;
const HUNT_CAP = 6;
let leagueInfo = null;
let rankingData = null;

function parseRecord(points) {
  const parts = String(points || "0-0-0").split("-").map(n => parseInt(n, 10) || 0);
  return { w: parts[0] || 0, l: parts[1] || 0, t: parts[2] || 0 };
}
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function minMaxNorm(values) {
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map(v => ((v - min) / (max - min)) * 100);
}
function uniqueGames(matchups) {
  const seen = new Set();
  const games = [];
  (matchups || []).forEach(m => {
    const a = m.away, h = m.home;
    if (!a || !h || !a.teamId || !h.teamId) return;
    const key = [a.teamId, h.teamId].sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    games.push({ away: a, home: h });
  });
  return games;
}
function weekFromMatchups(matchups) {
  const games = uniqueGames(matchups);
  const pf = {}, names = {}, opp = {};
  games.forEach(g => {
    pf[g.away.teamId] = Number(g.away.score || 0);
    pf[g.home.teamId] = Number(g.home.score || 0);
    names[g.away.teamId] = g.away.teamName;
    names[g.home.teamId] = g.home.teamName;
    (opp[g.away.teamId] ||= []).push(Number(g.home.score || 0));
    (opp[g.home.teamId] ||= []).push(Number(g.away.score || 0));
  });
  const pa = {}, nGames = {};
  Object.keys(opp).forEach(id => {
    nGames[id] = opp[id].length;
    pa[id] = avg(opp[id]);
  });
  return { pf, pa, nGames, names, games: games.length };
}
function lastRegularPeriod(info) {
  if (info && info.playoffs && info.playoffs.lastRegularSeasonPeriod) {
    return Number(info.playoffs.lastRegularSeasonPeriod);
  }
  const sps = (info && info.scoringPeriods) || [];
  return sps.length ? Math.max(...sps.map(p => Number(p.number) || 0)) : 21;
}
function seedSort(a, b) {
  if (b.winPct !== a.winPct) return b.winPct - a.winPct;
  if (b.seasonAvg !== a.seasonAvg) return b.seasonAvg - a.seasonAvg;
  return (b.pfTotal || 0) - (a.pfTotal || 0);
}
function weekIsComplete(n, week, periodMeta, now) {
  const scores = Object.values((week && week.pf) || {});
  if (scores.some(s => Number(s) > 0)) return true;
  if (periodMeta && periodMeta.endDate && new Date(periodMeta.endDate).getTime() < now) return true;
  return false;
}
function stillAlive(team, cutoffWins, leaderWins) {
  const maxW = team.w + (team.remaining || 0);
  return maxW >= cutoffWins || maxW >= (leaderWins || 0);
}
function leaguePicture(teams) {
  const byDiv = {};
  teams.forEach(t => { (byDiv[t.division] ||= []).push(t); });
  const winners = [];
  const rest = [];
  Object.keys(byDiv).sort().forEach(div => {
    const arr = byDiv[div].slice().sort(seedSort);
    winners.push(Object.assign({}, arr[0], { berth: "Division Winner" }));
    arr.slice(1).forEach(t => rest.push(t));
  });
  winners.sort(seedSort);
  rest.sort(seedSort);
  const wcCount = Math.max(0, PLAYOFF_TEAMS_PER_LEAGUE - winners.length);
  const wc = rest.slice(0, wcCount).map(t => Object.assign({}, t, { berth: "Wild Card" }));
  const inField = winners.concat(wc).map((t, i) => Object.assign({}, t, { seed: i + 1 }));
  const inIds = new Set(inField.map(t => t.id));
  const cutoffWins = inField.length ? Math.min.apply(null, inField.map(t => t.w)) : 0;
  const leaderWins = {};
  winners.forEach(w => { leaderWins[w.division] = w.w; });
  const alive = teams.filter(t => !inIds.has(t.id) && stillAlive(t, cutoffWins, leaderWins[t.division]));
  alive.sort((a, b) => {
    const ga = cutoffWins - a.w, gb = cutoffWins - b.w;
    if (ga !== gb) return ga - gb;
    return seedSort(a, b);
  });
  const bubble = alive.slice(0, HUNT_CAP).map(t => {
    const gb = cutoffWins - t.w;
    const bits = ["In the hunt"];
    if (gb <= 0) bits.push("tied");
    else bits.push(gb + " GB");
    if (t.remaining > 0) bits.push(t.remaining + " left");
    return Object.assign({}, t, { berth: bits.join(" \u00b7 ") });
  });
  return { seeds: inField, bubble, aliveCount: alive.length, cutoffWins, byDiv };
}

async function loadRankings(force) {
  if (!leagueId) return;
  const hint = $("prHint");
  if (hint) hint.textContent = "Fetching standings and weekly matchup scores from Fantrax…";
  try {
    const cacheKey = "fl_rank_v2_" + leagueId;
    if (!force) {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.at && (Date.now() - parsed.at < 30 * 60 * 1000)) {
            rankingData = parsed.data;
            renderRankings();
            if (hint) hint.textContent = "Showing cached live pull (≤30 min). Refresh Stats for a new pull.";
            return;
          }
        } catch (_) {}
      }
    }
    const info = leagueInfo || await fetchJson(FX.league(leagueId) + "&excludePlayerInfo=true");
    leagueInfo = info;
    const lastReg = lastRegularPeriod(info);
    const periods = ((info.scoringPeriods) || []).filter(p => Number(p.number) <= lastReg);
    const periodNums = periods.length ? periods.map(p => Number(p.number)).sort((a,b)=>a-b) : Array.from({length: lastReg}, (_, i) => i + 1);
    const periodMeta = {};
    periods.forEach(p => { periodMeta[Number(p.number)] = p; });
    const [standings, ...weekPayloads] = await Promise.all([
      fetchJson(FX.standings(leagueId)),
      ...periodNums.map(n => fetchJson(FX.matchups(leagueId, n)).then(d => ({ n, d })).catch(() => ({ n, d: { matchups: [] } }))),
    ]);
    const weeks = {};
    weekPayloads.forEach(({ n, d }) => {
      const w = weekFromMatchups(d.matchups || []);
      if (w.games > 0) weeks[n] = w;
    });
    const now = Date.now();
    const completedWeeks = Object.keys(weeks).map(Number).filter(n => weekIsComplete(n, weeks[n], periodMeta[n], now)).sort((a,b)=>a-b);
    const futureWeeks = Object.keys(weeks).map(Number).filter(n => completedWeeks.indexOf(n) < 0).sort((a,b)=>a-b);
    const recentWeeks = completedWeeks.slice(-2);
    const lastDone = completedWeeks.length ? completedWeeks[completedWeeks.length - 1] : 0;
    const weeksLeft = Math.max(0, lastReg - lastDone);
    const teamInfo = info.teamInfo || {};
    const rows = (standings || []).map(s => {
      const rec = parseRecord(s.points);
      const id = s.teamId;
      const meta = teamInfo[id] || {};
      const weeklyPf = [], weeklyPa = [];
      completedWeeks.forEach(n => {
        if (weeks[n].pf[id] == null) return;
        weeklyPf.push(weeks[n].pf[id]);
        weeklyPa.push(weeks[n].pa[id]);
      });
      const recentPf = recentWeeks.map(n => weeks[n].pf[id]).filter(v => v != null);
      const recentPa = recentWeeks.map(n => weeks[n].pa[id]).filter(v => v != null);
      const recentG = recentWeeks.map(n => weeks[n].nGames[id] || 0);
      let remaining = 0;
      futureWeeks.forEach(n => { remaining += weeks[n].nGames[id] || 0; });
      if (remaining === 0 && weeksLeft > 0) {
        const played = rec.w + rec.l + rec.t;
        const avgG = completedWeeks.length ? played / completedWeeks.length : 2;
        remaining = Math.round(avgG * weeksLeft);
      }
      return {
        id, name: s.teamName || meta.name || id,
        division: meta.division || "",
        rankApi: s.rank,
        winPct: Number(s.winPercentage || 0),
        w: rec.w, l: rec.l, t: rec.t,
        remaining: remaining,
        pfTotal: weeklyPf.reduce((a,b)=>a+b,0),
        seasonAvg: avg(weeklyPf),
        recent: avg(recentPf),
        recentPa: avg(recentPa),
        gamesPerRecentWeek: recentG.length ? avg(recentG) : 0,
        weeksPlayed: weeklyPf.length,
      };
    });
    const nR = minMaxNorm(rows.map(r => r.recent));
    const nS = minMaxNorm(rows.map(r => r.seasonAvg));
    const nW = minMaxNorm(rows.map(r => r.winPct));
    const paMed = median(rows.map(r => r.recentPa));
    rows.forEach((r, i) => {
      r.normRecent = nR[i]; r.normSeason = nS[i]; r.normWin = nW[i];
      r.power = nR[i] * RANK_WEIGHTS.recent + nS[i] * RANK_WEIGHTS.season + nW[i] * RANK_WEIGHTS.win;
      let trend = "";
      if (r.recent > r.seasonAvg * 1.1) trend += "\uD83D\uDD25";
      else if (r.recent < r.seasonAvg * 0.9) trend += "\u2744\uFE0F";
      if (r.recentPa > paMed * 1.1) trend += "\uD83D\uDEE3\uFE0F";
      else if (r.recentPa < paMed * 0.9) trend += "\u26F5";
      r.trend = trend;
    });
    rows.sort((a, b) => b.power - a.power);
    rows.forEach((r, i) => { r.powerRank = i + 1; });
    rankingData = { rows, weeks, completedWeeks, recentWeeks, lastReg, weeksLeft, fetchedAt: new Date().toISOString() };
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: rankingData })); } catch (_) {}
    renderRankings();
    if (hint) hint.textContent = "Live from Fantrax \u00b7 regular season weeks 1\u2013" + lastReg + " \u00b7 last 2 weeks for form: " + recentWeeks.join(" + ") + ".";
  } catch (e) {
    if (hint) hint.textContent = "Could not load rankings: " + (e.message || e);
  }
}

function renderRankings() {
  if (!rankingData) return;
  const { rows, recentWeeks, lastReg } = rankingData;
  if ($("prWeekLabel")) $("prWeekLabel").textContent = "Thru week " + lastReg + " \u00b7 form " + (recentWeeks || []).join("+");
  if ($("prMeta")) $("prMeta").innerHTML = "Weights <strong>50% recent / 30% season avg / 20% win%</strong>. Hunt list = teams that can still reach the last playoff spot or their division leader (cap " + HUNT_CAP + ").";
  if ($("prBody")) $("prBody").innerHTML = rows.map(r => {
    const mine = r.id === teamId ? " mine" : "";
    return "<tr class='" + mine + "'>" +
      "<td class='rank-cell'>" + r.powerRank + "</td>" +
      "<td>" + r.name + "</td>" +
      "<td>" + (r.division || "") + "</td>" +
      "<td class='num'>" + r.recent.toFixed(1) + "</td>" +
      "<td class='num'>" + r.seasonAvg.toFixed(1) + "</td>" +
      "<td class='num'>" + (r.winPct * 100).toFixed(1) + "%</td>" +
      "<td class='num'>" + r.w + "-" + r.l + (r.t ? ("-" + r.t) : "") + "</td>" +
      "<td class='num'><strong>" + r.power.toFixed(1) + "</strong></td>" +
      "<td class='trend-cell'>" + (r.trend || "\u2014") + "</td>" +
      "<td class='num'>" + r.recentPa.toFixed(1) + "</td>" +
      "<td class='num'>" + r.gamesPerRecentWeek.toFixed(1) + "</td></tr>";
  }).join("");
  renderLeagueTable("alBody", leaguePicture(rows.filter(r => (r.division || "").indexOf("AL") === 0)));
  renderLeagueTable("nlBody", leaguePicture(rows.filter(r => (r.division || "").indexOf("NL") === 0)));
  renderDivisions(rows);
}

function renderLeagueTable(bodyId, pic) {
  const el = $(bodyId);
  if (!el) return;
  const rows = pic.seeds.concat(pic.bubble);
  let html = rows.map(r => {
    const cls = r.berth.indexOf("Division") === 0 ? "seed-dw" : (r.berth.indexOf("Wild") === 0 ? "seed-wc" : "seed-out");
    return "<tr class='" + (r.id === teamId ? "mine" : "") + "'>" +
      "<td class='rank-cell'>" + (r.seed || "") + "</td>" +
      "<td class='" + cls + "'>" + r.name + "</td>" +
      "<td>" + r.division.replace(/^AL |^NL /, "") + "</td>" +
      "<td class='num'>" + r.w + "</td>" +
      "<td class='num'>" + r.l + "</td>" +
      "<td class='num'>" + (r.winPct * 100).toFixed(1) + "%</td>" +
      "<td class='" + cls + "'>" + r.berth + "</td></tr>";
  }).join("");
  if (!pic.bubble.length) {
    html += "<tr><td></td><td class='seed-out' colspan='6'>No teams mathematically in the race</td></tr>";
  } else if (pic.aliveCount > pic.bubble.length) {
    html += "<tr><td></td><td class='seed-out' colspan='6'>+" + (pic.aliveCount - pic.bubble.length) + " more still alive (showing closest " + HUNT_CAP + ")</td></tr>";
  }
  el.innerHTML = html;
}

function renderDivisions(rows) {
  if (!$("divGrid")) return;
  const order = ["AL East","AL Central","AL West","NL East","NL Central","NL West"];
  const byDiv = {};
  rows.forEach(r => { (byDiv[r.division] ||= []).push(r); });
  $("divGrid").innerHTML = order.map(div => {
    const list = (byDiv[div] || []).slice().sort(seedSort);
    const body = list.map((t, i) => {
      return "<div class='row" + (i === 0 ? " winner" : "") + "'><span>" +
        (i === 0 ? "\u2605 " : "") + t.name + "</span><span>" + t.w + "-" + t.l +
        " \u00b7 " + (t.winPct * 100).toFixed(1) + "%</span></div>";
    }).join("");
    return "<div class='panel div-card'><h3>" + div + "</h3>" + body + "</div>";
  }).join("");
}

showScreen = function(name) {
  ["loginScreen", "setupScreen", "leagueDash", "dashboard"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", id !== name);
  });
};

function pickDefaultTeam(teams) {
  const saved = sessionStorage.getItem("fl_teamId");
  if (saved && teams.some(t => t.id === saved)) return saved;
  const reds = teams.find(t => /cincinnati reds/i.test(t.name));
  if (reds) return reds.id;
  return teams[0] ? teams[0].id : null;
}
function applyTeam(tid) {
  const team = (window._fxTeams || []).find(t => t.id === tid);
  if (!team) return false;
  teamId = tid;
  teamName = team.name;
  basePlayers = buildRosterFromTeam(team);
  currentYear = CURRENT_YEAR;
  sessionStorage.setItem("fl_teamId", tid);
  if ($("teamTitle")) $("teamTitle").textContent = teamName;
  if ($("leagueSub")) $("leagueSub").textContent = leagueName + " \u00b7 Fantrax " + leagueId;
  if ($("leagueDashTitle")) $("leagueDashTitle").textContent = leagueName || "Franchise Legends";
  if ($("leagueDashSub")) $("leagueDashSub").textContent = teamName + " \u00b7 Power Rankings";
  if ($("teamSelect")) $("teamSelect").value = tid;
  return true;
}
function hydrateRosters(id) {
  fetchJson(FX.rosters(id)).then(rosters => {
    const teams = Object.entries(rosters.rosters || {}).map(([tid, t]) => ({
      id: tid,
      name: t.teamName || tid,
      count: (t.rosterItems || []).length,
      items: t.rosterItems || [],
    })).sort((a, b) => a.name.localeCompare(b.name));
    if (!teams.length) return;
    window._fxTeams = teams;
    const sel = $("teamSelect");
    if (sel) {
      sel.innerHTML = teams.map(t => '<option value="' + t.id + '">' + t.name + " (" + t.count + ")</option>").join("");
      if (teamId) sel.value = teamId;
    }
    if (teamId) applyTeam(teamId);
  }).catch(() => {});
}

loadLeague = async function() {
  const input = $("leagueIdInput");
  const id = ((input && input.value) || "").trim();
  if ($("setupError")) $("setupError").textContent = "";
  if ($("setupStatus")) { $("setupStatus").textContent = ""; $("setupStatus").className = "status-msg"; }
  if (!id) {
    if ($("setupError")) $("setupError").textContent = "Enter a Fantrax league ID.";
    return;
  }
  if ($("loadLeagueBtn")) $("loadLeagueBtn").disabled = true;
  if ($("setupStatus")) $("setupStatus").textContent = "Loading league…";
  try {
    const league = await fetchJson(FX.league(id) + "&excludePlayerInfo=true");
    leagueId = id;
    leagueName = league.leagueName || "Fantrax League";
    leagueInfo = league;
    playerInfo = league.playerInfo || {};
    const teamInfo = league.teamInfo || {};
    const teams = Object.entries(teamInfo).map(([tid, t]) => ({
      id: tid,
      name: (t && (t.name || t.teamName)) || tid,
      count: 0,
      items: [],
    })).sort((a, b) => a.name.localeCompare(b.name));
    if (!teams.length) throw new Error("No teams found for this league ID.");
    window._fxTeams = teams;
    const sel = $("teamSelect");
    if (sel) sel.innerHTML = teams.map(t => '<option value="' + t.id + '">' + t.name + "</option>").join("");
    const tid = pickDefaultTeam(teams);
    if (sel && tid) sel.value = tid;
    if ($("teamField")) $("teamField").classList.remove("hidden");
    if ($("enterRow")) $("enterRow").classList.remove("hidden");
    sessionStorage.setItem("fl_leagueId", id);
    applyTeam(tid);
    if ($("setupStatus")) {
      $("setupStatus").className = "status-msg ok";
      $("setupStatus").textContent = "Loaded " + leagueName + " \u00b7 " + teams.length + " teams";
    }
    showScreen("leagueDash");
    loadRankings(true);
    hydrateRosters(id);
  } catch (e) {
    if ($("setupError")) $("setupError").textContent = "Could not load league: " + (e.message || e);
    if ($("setupStatus")) $("setupStatus").textContent = "";
  } finally {
    if ($("loadLeagueBtn")) $("loadLeagueBtn").disabled = false;
  }
};

enterDashboard = function() {
  const tid = $("teamSelect") ? $("teamSelect").value : teamId;
  if (!applyTeam(tid)) {
    if ($("setupError")) $("setupError").textContent = "Select a team.";
    return;
  }
  showScreen("leagueDash");
  loadRankings(false);
};

function bindRankingNav() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  on("loadLeagueBtn", () => loadLeague());
  on("enterDashBtn", () => enterDashboard());
  on("changeTeamBtn2", () => showSetup());
  on("toLineupBtn", () => {
    if (teamId) applyTeam(teamId);
    showScreen("dashboard");
    if (typeof render === "function") render();
  });
  on("toLeagueBtn", () => { showScreen("leagueDash"); if (!rankingData) loadRankings(false); else renderRankings(); });
  on("navLeague", () => { showScreen("leagueDash"); if (!rankingData) loadRankings(false); else renderRankings(); });
  on("navLineup", () => {
    if (teamId) applyTeam(teamId);
    showScreen("dashboard");
    if (typeof render === "function") render();
  });
  on("refreshRankBtn", () => loadRankings(true));
  const lid = $("leagueIdInput");
  if (lid && !lid._rankBound) {
    lid._rankBound = true;
    lid.addEventListener("keydown", e => { if (e.key === "Enter") loadLeague(); });
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindRankingNav);
else bindRankingNav();
