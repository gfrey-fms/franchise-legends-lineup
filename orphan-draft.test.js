"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const engine = require("./orphan-draft-engine");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error("FAIL", name);
    console.error(err && err.stack || err);
    process.exitCode = 1;
  }
}

function must(result) {
  assert.ok(result.ok, result && result.error);
  assert.ok(result.changed, "expected a write");
  return result.state;
}

test("contract types: R1 is MiLB, everything else is MLB, plain 1 is not 1/1", () => {
  const cases = [
    ["R1", "milb", "R1", "R1"],
    ["r1", "milb", "R1", "R1"],
    ["R2", "mlb", "R2", "R2"],
    ['"2/4"', "mlb", "years", "2/4"],
    ["2/4", "mlb", "years", "2/4"],
    ['"3/4"', "mlb", "years", "3/4"],
    ["F5/5", "mlb", "franchise", "F5/5"],
    ["F3/4", "mlb", "franchise", "F3/4"],
    ["f5/5", "mlb", "franchise", "F5/5"],
    [1, "mlb", "extendable", "1"],
    ["1", "mlb", "extendable", "1"],
    ["1/1", "mlb", "years", "1/1"],
    ["  R1  ", "milb", "R1", "R1"],
  ];
  cases.forEach(([raw, pool, kind, contract]) => {
    const parsed = engine.parseContract(raw);
    assert.strictEqual(parsed.pool, pool, String(raw));
    assert.strictEqual(parsed.kind, kind, String(raw));
    assert.strictEqual(parsed.contract, contract, String(raw));
  });
});

test("csv import keeps quoted contracts and commas inside quotes", () => {
  const csv = [
    "ID,Player,Team,Position,RkOv,Status,Age,Salary,Contract,FPts,FP/G,Ros",
    '*aaa*,"Judge, Aaron",NYY,OF,1,OLD,34,76,1,10,1,0.5',
    '*bbb*,Prospect,MIA,SP,100,OLD,19,1,R1,0,0,0.1',
    '*ccc*,Vet,LAD,1B,20,OLD,30,12,"""2/4""",40,2,0.2',
  ].join("\n");
  const { players } = engine.rowsToPlayers(engine.parseCsv(csv));
  assert.strictEqual(players.length, 3);
  assert.strictEqual(players[0].name, "Judge, Aaron");
  assert.strictEqual(players[0].kind, "extendable");
  assert.strictEqual(players[1].pool, "milb");
  assert.strictEqual(players[2].contract, "2/4");
  assert.strictEqual(players[2].pool, "mlb");
});

function started(now) {
  let state = must(engine.reduce(null, { type: "create", now, name: "Test" }));
  const { players } = engine.rowsToPlayers([
    { ID: "p1", Player: "Aaron Judge", Team: "NYY", Position: "OF", RkOv: 1, Age: 34, Salary: 76, Contract: "1", FPts: 100, "FP/G": 4, Ros: 1 },
    { ID: "p2", Player: "Kruz Schoolcraft", Team: "SD", Position: "SP", RkOv: 50, Age: 19, Salary: 3, Contract: "R1", FPts: 0, "FP/G": 0, Ros: 0.2 },
    { ID: "p3", Player: "Brandon Marsh", Team: "PHI", Position: "OF", RkOv: 40, Age: 27, Salary: 15, Contract: '"4/4"', FPts: 20, "FP/G": 1, Ros: 0.4 },
    { ID: "p4", Player: "Shohei Ohtani", Team: "LAD", Position: "UT,SP", RkOv: 2, Age: 32, Salary: 25, Contract: "F5/5", FPts: 80, "FP/G": 3, Ros: 0.9 },
  ]);
  state = must(engine.reduce(state, { type: "import", now, players }));
  state = must(engine.reduce(state, { type: "addTeam", now, name: "Alpha", mlb: 100, milb: 20 }));
  const alpha = Object.values(state.teams)[0];
  state = must(engine.reduce(state, { type: "addTeam", now, name: "Bravo", mlb: 40, milb: 5 }));
  const bravo = Object.values(state.teams).find((t) => t.id !== alpha.id);
  state = must(engine.reduce(state, { type: "start", now }));
  return { state, alpha, bravo };
}

test("nominate, outbid, budget cap, and no self-bid", () => {
  const now = 1_000_000;
  let { state, alpha, bravo } = started(now);
  state = must(engine.reduce(state, { type: "nominate", now, teamId: alpha.id, playerId: "p1", amount: 10 }));
  assert.strictEqual(state.auctions.mlb.highBid, 10);
  assert.strictEqual(state.auctions.mlb.endsAt, now + 60_000);
  assert.strictEqual(state.players.p1.status, "nominated");
  const self = engine.reduce(state, { type: "bid", now: now + 1000, teamId: alpha.id, pool: "mlb", amount: 11 });
  assert.strictEqual(self.ok, false);
  const low = engine.reduce(state, { type: "bid", now: now + 1000, teamId: bravo.id, pool: "mlb", amount: 10 });
  assert.strictEqual(low.ok, false);
  const over = engine.reduce(state, { type: "bid", now: now + 1000, teamId: bravo.id, pool: "mlb", amount: 41 });
  assert.strictEqual(over.ok, false);
  state = must(engine.reduce(state, { type: "bid", now: now + 1000, teamId: bravo.id, pool: "mlb", amount: 40 }));
  assert.strictEqual(state.auctions.mlb.highTeamId, bravo.id);
  assert.strictEqual(engine.remaining(state, bravo.id, "mlb"), 0);
  assert.strictEqual(engine.maxBid(state, bravo.id, "mlb"), 40);
  assert.strictEqual(engine.remaining(state, alpha.id, "mlb"), 100);
});

test("timer tiers and reset-2 off soft close", () => {
  const t0 = 5_000_000;
  let { state, alpha, bravo } = started(t0);
  state = must(engine.reduce(state, {
    type: "setTimers",
    now: t0,
    pool: "mlb",
    timers: { auctionSeconds: 60, reset1Below: 20, reset1To: 20, reset2Enabled: true, reset2Below: 8, reset2To: 12 },
  }));
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p1", amount: 1 }));
  // 30s left — above Y, clock stays.
  let bidAt = t0 + 30_000;
  state = must(engine.reduce(state, { type: "bid", now: bidAt, teamId: bravo.id, pool: "mlb", amount: 2 }));
  assert.strictEqual(state.auctions.mlb.endsAt, t0 + 60_000);
  // 15s left — under Y, not under Z, reset to 20s.
  bidAt = state.auctions.mlb.endsAt - 15_000;
  state = must(engine.reduce(state, { type: "bid", now: bidAt, teamId: alpha.id, pool: "mlb", amount: 3 }));
  assert.strictEqual(state.auctions.mlb.endsAt, bidAt + 20_000);
  // 5s left — under Z, reset to 12s.
  bidAt = state.auctions.mlb.endsAt - 5_000;
  state = must(engine.reduce(state, { type: "bid", now: bidAt, teamId: bravo.id, pool: "mlb", amount: 4 }));
  assert.strictEqual(state.auctions.mlb.endsAt, bidAt + 12_000);

  state = must(engine.reduce(state, {
    type: "setTimers",
    now: bidAt,
    pool: "mlb",
    timers: { reset2Enabled: false, reset1Below: 20, reset1To: 20 },
  }));
  bidAt = state.auctions.mlb.endsAt - 4_000;
  const before = state.auctions.mlb.endsAt;
  state = must(engine.reduce(state, { type: "bid", now: bidAt, teamId: alpha.id, pool: "mlb", amount: 5 }));
  assert.ok(state.auctions.mlb.endsAt !== before);
  assert.strictEqual(state.auctions.mlb.endsAt, bidAt + 20_000);
});

test("reset 2 cannot be configured at or above reset 1", () => {
  const now = 10;
  let { state } = started(now);
  const bad = engine.reduce(state, {
    type: "setTimers",
    now,
    pool: "milb",
    timers: { reset2Enabled: true, reset1Below: 10, reset2Below: 10, reset2To: 8 },
  });
  assert.strictEqual(bad.ok, false);
});

test("award keeps the contract and replaces the salary", () => {
  const t0 = 8_000_000;
  let { state, alpha } = started(t0);
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p3", amount: 30 }));
  const ended = must(engine.reduce(state, { type: "tick", now: t0 + 60_000 }));
  assert.strictEqual(ended.players.p3.status, "won");
  assert.strictEqual(ended.players.p3.contract, "4/4");
  assert.strictEqual(ended.players.p3.salary, 30);
  assert.strictEqual(ended.players.p3.originalSalary, 15);
  assert.strictEqual(ended.players.p3.winnerTeamId, alpha.id);
  assert.strictEqual(ended.auctions.mlb, null);
  assert.strictEqual(engine.spent(ended, alpha.id, "mlb"), 30);
  assert.strictEqual(engine.remaining(ended, alpha.id, "mlb"), 70);
  const csv = engine.exportCsv(ended);
  assert.ok(csv.startsWith("Player,Winning Team,Contract,New Salary,Pool"));
  assert.ok(csv.indexOf("Brandon Marsh,Alpha,4/4,30,MLB") >= 0);
});

test("pause freezes the clock and resume continues it", () => {
  const t0 = 9_000_000;
  let { state, alpha } = started(t0);
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p2", amount: 2 }));
  state = must(engine.reduce(state, { type: "pause", now: t0 + 20_000 }));
  assert.strictEqual(state.auctions.milb.remainingMs, 25_000);
  const during = engine.reduce(state, { type: "tick", now: t0 + 90_000 });
  assert.strictEqual(during.changed, false);
  assert.strictEqual(during.state.players.p2.status, "nominated");
  const blocked = engine.reduce(state, { type: "bid", now: t0 + 21_000, teamId: alpha.id, pool: "milb", amount: 3 });
  assert.strictEqual(blocked.ok, false);
  state = must(engine.reduce(state, { type: "resume", now: t0 + 100_000 }));
  assert.strictEqual(state.auctions.milb.endsAt, t0 + 100_000 + 25_000);
  const early = engine.reduce(state, { type: "tick", now: state.auctions.milb.endsAt - 1 });
  assert.strictEqual(early.changed, false);
  state = must(engine.reduce(state, { type: "tick", now: state.auctions.milb.endsAt }));
  assert.strictEqual(state.players.p2.status, "won");
  assert.strictEqual(state.players.p2.contract, "R1");
  assert.strictEqual(state.players.p2.salary, 2);
});

test("lock is per pool", () => {
  const t0 = 7_000_000;
  let { state, alpha, bravo } = started(t0);
  state = must(engine.reduce(state, { type: "lock", now: t0, teamId: alpha.id, pool: "mlb", locked: true }));
  const blocked = engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p1", amount: 5 });
  assert.strictEqual(blocked.ok, false);
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p2", amount: 1 }));
  assert.strictEqual(state.auctions.milb.playerId, "p2");
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: bravo.id, playerId: "p1", amount: 5 }));
  const stillLocked = engine.reduce(state, { type: "bid", now: t0 + 1000, teamId: alpha.id, pool: "mlb", amount: 6 });
  assert.strictEqual(stillLocked.ok, false);
  state = must(engine.reduce(state, { type: "lock", now: t0 + 1000, teamId: alpha.id, pool: "mlb", locked: false }));
  state = must(engine.reduce(state, { type: "bid", now: t0 + 1500, teamId: alpha.id, pool: "mlb", amount: 6 }));
  assert.strictEqual(state.auctions.mlb.highTeamId, alpha.id);
  assert.ok(state.auctions.milb, "MiLB auction still running");
});

test("one auction per pool, undo bid, undo nomination, void award", () => {
  const t0 = 6_000_000;
  let { state, alpha, bravo } = started(t0);
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p1", amount: 10 }));
  const second = engine.reduce(state, { type: "nominate", now: t0 + 10, teamId: bravo.id, playerId: "p4", amount: 3 });
  assert.strictEqual(second.ok, false);
  state = must(engine.reduce(state, { type: "bid", now: t0 + 1000, teamId: bravo.id, pool: "mlb", amount: 12 }));
  state = must(engine.reduce(state, { type: "undoBid", now: t0 + 2000, pool: "mlb" }));
  assert.strictEqual(state.auctions.mlb.highTeamId, alpha.id);
  assert.strictEqual(state.auctions.mlb.highBid, 10);
  state = must(engine.reduce(state, { type: "undoBid", now: t0 + 2500, pool: "mlb" }));
  assert.strictEqual(state.auctions.mlb, null);
  assert.strictEqual(state.players.p1.status, "available");

  state = must(engine.reduce(state, { type: "nominate", now: t0 + 3000, teamId: alpha.id, playerId: "p4", amount: 18 }));
  state = must(engine.reduce(state, { type: "tick", now: state.auctions.mlb.endsAt }));
  const award = state.awards[0];
  assert.strictEqual(state.players.p4.contract, "F5/5");
  assert.strictEqual(state.players.p4.salary, 18);
  state = must(engine.reduce(state, { type: "voidAward", now: t0 + 80_000, awardId: award.id }));
  assert.strictEqual(state.players.p4.status, "available");
  assert.strictEqual(state.players.p4.salary, 25);
  assert.strictEqual(state.players.p4.originalSalary, 25);
  assert.strictEqual(engine.spent(state, alpha.id, "mlb"), 0);
  assert.ok(state.awards[0].voided);
  const csv = engine.exportCsv(state);
  assert.ok(csv.indexOf("Ohtani") < 0);
});

test("pool override sticks until recompute, and won players are skipped", () => {
  const t0 = 4_000_000;
  let { state, alpha } = started(t0);
  state = must(engine.reduce(state, { type: "setPool", now: t0, playerId: "p2", pool: "mlb" }));
  assert.strictEqual(state.players.p2.pool, "mlb");
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p2", amount: 4 }));
  const blocked = engine.reduce(state, { type: "setPool", now: t0, playerId: "p2", pool: "milb" });
  assert.strictEqual(blocked.ok, false);
  state = must(engine.reduce(state, { type: "tick", now: state.auctions.mlb.endsAt }));
  const again = engine.rowsToPlayers([
    { ID: "p2", Player: "Kruz Schoolcraft", Team: "SD", Position: "SP", RkOv: 50, Age: 19, Salary: 3, Contract: "R1", FPts: 0, "FP/G": 0, Ros: 0.2 },
    { ID: "p9", Player: "New Guy", Team: "NYM", Position: "C", RkOv: 80, Age: 28, Salary: 1, Contract: "1", FPts: 1, "FP/G": 1, Ros: 0 },
  ]);
  state = must(engine.reduce(state, { type: "import", now: t0 + 100, players: again.players }));
  assert.strictEqual(state.players.p2.status, "won");
  assert.strictEqual(state.players.p2.pool, "mlb");
  assert.strictEqual(state.players.p9.pool, "mlb");
});

test("serialized transactions: a stale lower bid loses, a stale higher bid retries", () => {
  const t0 = 3_000_000;
  const boot = started(t0);
  const cell = { state: boot.state };
  const open = engine.transact(cell, { type: "nominate", now: t0, teamId: boot.alpha.id, playerId: "p1", amount: 5 });
  assert.strictEqual(open.ok, true);
  const low = engine.transact(cell, { type: "bid", now: t0 + 500, teamId: boot.bravo.id, pool: "mlb", amount: 4 });
  assert.strictEqual(low.ok, false);
  const first = engine.transact(cell, { type: "bid", now: t0 + 500, teamId: boot.bravo.id, pool: "mlb", amount: 8 });
  assert.strictEqual(first.state.auctions.mlb.highBid, 8);
  // Two clients both read the $8 auction. 9 and 12 are each valid against $8.
  // Applying 12 on the stale snapshot and then retrying 9 against the new state must reject 9.
  const stale = cell.state;
  const fromStale = engine.reduce(stale, { type: "bid", now: t0 + 800, teamId: boot.alpha.id, pool: "mlb", amount: 12 });
  assert.strictEqual(fromStale.ok, true);
  cell.state = fromStale.state;
  const retried = engine.reduce(cell.state, { type: "bid", now: t0 + 800, teamId: boot.bravo.id, pool: "mlb", amount: 9 });
  assert.strictEqual(retried.ok, false);
  assert.strictEqual(cell.state.auctions.mlb.highBid, 12);
  assert.strictEqual(cell.state.auctions.mlb.bids.length, 3);
});

test("a late tick does not erase a bid that extended the clock", () => {
  const t0 = 2_000_000;
  let { state, alpha, bravo } = started(t0);
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p1", amount: 5 }));
  const ends = state.auctions.mlb.endsAt;
  const extended = must(engine.reduce(state, { type: "bid", now: ends - 5_000, teamId: bravo.id, pool: "mlb", amount: 6 }));
  assert.ok(extended.auctions.mlb.endsAt > ends);
  const staleAward = engine.reduce(state, { type: "tick", now: ends });
  assert.strictEqual(staleAward.ok, true);
  assert.strictEqual(staleAward.state.players.p1.status, "won");
  // The store retries the tick against the extended auction.
  const retried = engine.reduce(extended, { type: "tick", now: ends });
  assert.strictEqual(retried.changed, false);
  assert.strictEqual(retried.state.players.p1.status, "nominated");
  assert.strictEqual(retried.state.auctions.mlb.highBid, 6);
});

test("early close token reopens; a server token at the buzzer awards", () => {
  const t0 = 11_000_000;
  let { state, alpha } = started(t0);
  state = must(engine.reduce(state, { type: "nominate", now: t0, teamId: alpha.id, playerId: "p1", amount: 9 }));
  const ends = state.auctions.mlb.endsAt;
  state.auctions.mlb.status = "closing";
  state.auctions.mlb.closeToken = ends - 5_000;
  const early = must(engine.reduce(state, { type: "awardClosing", pool: "mlb", now: ends, tolerance: 500 }));
  assert.strictEqual(early.auctions.mlb.status, "open");
  assert.strictEqual(early.players.p1.status, "nominated");
  early.auctions.mlb.status = "closing";
  early.auctions.mlb.closeToken = ends - 200;
  const awarded = must(engine.reduce(early, { type: "awardClosing", pool: "mlb", now: ends, tolerance: 500 }));
  assert.strictEqual(awarded.players.p1.status, "won");
  assert.strictEqual(awarded.players.p1.salary, 9);
  assert.strictEqual(awarded.players.p1.contract, "1");
});

test("describeTimers mentions the soft close when reset 2 is off", () => {
  const t = engine.defaultTimers().mlb;
  assert.ok(engine.describeTimers(t).indexOf("8s") >= 0);
  const off = Object.assign({}, t, { reset2Enabled: false });
  assert.ok(/Reset 2 is off/.test(engine.describeTimers(off)));
});

(async function main() {
  const buf = fs.readFileSync(path.join(__dirname, "orphan-draft-sample.xlsx"));
  const rows = await engine.rowsFromXlsxBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { players, warnings } = engine.rowsToPlayers(rows);
  assert.strictEqual(warnings.length, 0, JSON.stringify(warnings));
  assert.strictEqual(players.length, 86);
  const milb = players.filter((p) => p.pool === "milb");
  assert.strictEqual(milb.length, 31);
  assert.ok(milb.every((p) => p.contract === "R1" && p.kind === "R1"));
  const judge = players.find((p) => p.name === "Aaron Judge");
  assert.strictEqual(judge.kind, "extendable");
  assert.strictEqual(judge.contract, "1");
  assert.strictEqual(judge.originalSalary, 76);
  const ohtani = players.find((p) => p.name === "Shohei Ohtani");
  assert.strictEqual(ohtani.contract, "F5/5");
  assert.strictEqual(ohtani.kind, "franchise");
  assert.strictEqual(ohtani.pool, "mlb");
  const quoted = players.filter((p) => p.kind === "years");
  assert.ok(quoted.length >= 10);
  assert.ok(quoted.every((p) => p.pool === "mlb" && /^\d+\/\d+$/.test(p.contract)));
  const schoolcraft = players.find((p) => p.name === "Kruz Schoolcraft");
  assert.strictEqual(schoolcraft.pool, "milb");
  passed++;
  if (process.exitCode) {
    console.error("some tests failed");
    process.exit(process.exitCode);
  }
  console.log(passed + " tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
