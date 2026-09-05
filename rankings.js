/* Power rankings overlay — loaded after app.js */
FX.standings = (id) => "https://www.fantrax.com/fxea/general/getStandings?leagueId=" + encodeURIComponent(id);
FX.matchups = (id, period) => "https://www.fantrax.com/fxea/general/getMatchupScores?leagueId=" + encodeURIComponent(id) + (period ? ("&period=" + period) : "");
const RANK_WEIGHTS = { recent: 0.5, season: 0.3, win: 0.2 };
const PLAYOFF_TEAMS_PER_LEAGUE = 6;
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
  const bubble = rest.slice(wcCount, wcCount + 4).map(t => Object.assign({}, t, { berth: "In the hunt" }));
  const inField = winners.concat(wc).map((t, i) => Object.assign({}, t, { seed: i + 1 }));
  return { seeds: inField, bubble, byDiv };
}

async function loadRankings(force) {
  if (!leagueId) return;
  const hint = $("prHint");
  hint.textContent = "Fetching standings and weekly matchup scores from Fantrax…";
  try {
    const cacheKey = "fl_rank_" + leagueId;
    if (!force) {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.at && (Date.now() - parsed.at < 30 * 60 * 1000)) {
            rankingData = parsed.data;
            renderRankings();
            hint.textContent = "Showing cached live pull (≤30 min). Refresh Stats for a new pull.";
            return;
          }
        } catch (_) {}
      }
    }
    const info = leagueInfo || await fetchJson(FX.league(leagueId));
    leagueInfo = info;
    const lastReg = lastRegularPeriod(info);
    const periods = ((info.scoringPeriods) || []).filter(p => Number(p.number) <= lastReg);
    const periodNums = periods.length ? periods.map(p => Number(p.number)).sort((a,b)=>a-b) : Array.from({length: lastReg}, (_, i) => i + 1);

    const [standings, ...weekPayloads] = await Promise.all([
      fetchJson(FX.standings(leagueId)),
      ...periodNums.map(n => fetchJson(FX.matchups(leagueId, n)).then(d => ({ n, d })).catch(() => ({ n, d: { matchups: [] } }))),
    ]);

    const weeks = {};
    weekPayloads.forEach(({ n, d }) => {
      const w = weekFromMatchups(d.matchups || []);
      if (w.games > 0) weeks[n] = w;
    });
    const completedWeeks = Object.keys(weeks).map(Number).sort((a,b)=>a-b);
    const recentWeeks = completedWeeks.slice(-2);
    const teamInfo = info.teamInfo || {};
    const rows = (standings || []).map(s => {
      const rec = parseRecord(s.points);
      const id = s.teamId;
      const meta = teamInfo[id] || {};
      const weeklyPf = [], weeklyPa = [], weeklyG = [];
      completedWeeks.forEach(n => {
        if (weeks[n].pf[id] == null) return;
        weeklyPf.push(weeks[n].pf[id]);
        weeklyPa.push(weeks[n].pa[id]);
        weeklyG.push(weeks[n].nGames[id] || 0);
      });
      const recentPf = recentWeeks.map(n => weeks[n].pf[id]).filter(v => v != null);
      const recentPa = recentWeeks.map(n => weeks[n].pa[id]).filter(v => v != null);
      const recentG = recentWeeks.map(n => weeks[n].nGames[id] || 0);
      return {
        id, name: s.teamName || meta.name || id,
        division: meta.division || "",
        rankApi: s.rank,
        winPct: Number(s.winPercentage || 0),
        w: rec.w, l: rec.l, t: rec.t,
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

    rankingData = { rows, weeks, completedWeeks, recentWeeks, lastReg, fetchedAt: new Date().toISOString() };
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data: rankingData })); } catch (_) {}
    renderRankings();
    hint.textContent = "Live from Fantrax \u00b7 regular season weeks 1\u2013" + lastReg + " \u00b7 last 2 weeks for form: " + recentWeeks.join(" + ") + ".";
  } catch (e) {
    hint.textContent = "Could not load rankings: " + (e.message || e);
  }
}

function renderRankings() {
  if (!rankingData) return;
  const { rows, recentWeeks, lastReg } = rankingData;
  $("prWeekLabel").textContent = "Thru week " + lastReg + " \u00b7 form " + (recentWeeks || []).join("+");
  $("prMeta").innerHTML = "Weights <strong>50% recent / 30% season avg / 20% win%</strong>. Games/Wk is the average number of unique H2H matchups in the last two weeks (not hardcoded).";
  $("prBody").innerHTML = rows.map(r => {
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
  const rows = pic.seeds.concat(pic.bubble);
  $(bodyId).innerHTML = rows.map(r => {
    const cls = r.berth === "Division Winner" ? "seed-dw" : (r.berth === "Wild Card" ? "seed-wc" : "seed-out");
    return "<tr class='" + (r.id === teamId ? "mine" : "") + "'>" +
      "<td class='rank-cell'>" + (r.seed || "") + "</td>" +
      "<td class='" + cls + "'>" + r.name + "</td>" +
      "<td>" + r.division.replace(/^AL |^NL /, "") + "</td>" +
      "<td class='num'>" + r.w + "</td>" +
      "<td class='num'>" + r.l + "</td>" +
      "<td class='num'>" + (r.winPct * 100).toFixed(1) + "%</td>" +
      "<td class='" + cls + "'>" + r.berth + "</td></tr>";
  }).join("");
}

function renderDivisions(rows) {
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

enterDashboard = function() {
  const tid = $("teamSelect").value;
  const team = (window._fxTeams || []).find(t => t.id === tid);
  if (!team) { $("setupError").textContent = "Select a team."; return; }
  teamId = tid;
  teamName = team.name;
  basePlayers = buildRosterFromTeam(team);
  currentYear = CURRENT_YEAR;
  sessionStorage.setItem("fl_teamId", tid);
  $("teamTitle").textContent = teamName;
  $("leagueSub").textContent = leagueName + " \u00b7 Fantrax " + leagueId;
  if ($("leagueDashTitle")) $("leagueDashTitle").textContent = leagueName || "Franchise Legends";
  if ($("leagueDashSub")) $("leagueDashSub").textContent = teamName + " \u00b7 Power Rankings";
  showScreen("leagueDash");
  loadRankings(false);
};

function bindRankingNav() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  on("changeTeamBtn2", () => showSetup());
  on("toLineupBtn", () => { showScreen("dashboard"); render(); });
  on("toLeagueBtn", () => { showScreen("leagueDash"); if (!rankingData) loadRankings(false); else renderRankings(); });
  on("navLeague", () => { showScreen("leagueDash"); if (!rankingData) loadRankings(false); else renderRankings(); });
  on("navLineup", () => { showScreen("dashboard"); render(); });
  on("refreshRankBtn", () => loadRankings(true));
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindRankingNav);
else bindRankingNav();
