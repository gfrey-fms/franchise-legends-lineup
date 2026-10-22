Franchise Legends lineup planner, live power rankings, and orphan-draft auction.

After login, paste the Fantrax league ID and pick your team. The app opens on League (power rankings / playoff picture / division standings) pulled live from Fantrax. My Lineup is the contract diamond planner. **Orphan Draft** auctions players from orphaned rosters.

Rankings: 50% last-2-weeks PF, 30% season weekly PF average, 20% win%. Weekly PA is the average of unique opponents that week (1–4 games, not hardcoded). Regular season only (periods 1–lastRegularSeasonPeriod).

## Orphan Draft

Orphaned players are split into two pools:

- **MiLB** — contract `R1` only.
- **MLB** — everyone else: `R2`, any `X/Y` deal (including `F5/5` franchise tags), and a plain `1`. A plain `1` is its own extendable contract, not `1/1`.

Quoted exports like `"2/4"` are read as year 2 of 4. The Status column (the old fantasy team) is ignored. Each drafting team has its own MLB budget and its own MiLB budget. Any unlocked team can nominate from either pool. One auction runs per pool, so MLB and MiLB can be live at the same time. Bids go up in whole dollars. The winner keeps the player's contract and the winning bid becomes the new salary. Locking MLB only stops that team in the MLB pool.

`node orphan-draft.test.js` checks contract parsing, the sample workbook, bids, timer tiers, pause, lock, undo, void, and serialized bid races.

### Try it with no backend (local demo)

1. Log in with the league password.
2. Open **Orphan Draft** (it's on the setup screen, and on League and My Lineup).
3. Choose **Enter local demo**.
4. Enter the admin PIN from `orphan-draft-config.js`. The prototype default is `draft-admin`, and the demo screen shows it.
5. **Load sample export** (or choose a Fantrax `.xlsx` / `.csv`), add teams, set both budgets, set the clocks, and press **Start**.
6. Use **Viewing as** to sit as each team in this window. Other tabs on this computer share the same draft.

Demo mode never leaves the browser. A join link works in another tab here; it does not reach another device. **Short timers** makes the clock easy to practice (MLB 12s, MiLB 10s).

### Auction clock

The commissioner sets each pool's clock:

- **X** — length of a new nomination.
- **Reset 1** — if a bid lands with under **Y** seconds left, the clock resets to the Reset 1 time.
- **Reset 2** — optional. If a bid lands with under **Z** seconds left (Z must be lower than Y), the clock resets to the Reset 2 time instead.

Turn Reset 2 off for a single soft close. Set Reset 1's two numbers equal and any bid under Y puts the clock back to Y. **Soft close only** does that for both pools.

Defaults (Reset 2 on, as a stable floor): MLB is 60s, under 20s resets to 20s, under 8s resets to 8s. MiLB is 45s / 15s / 6s. A bid that is not under Y leaves the clock alone. The current high bid is reserved against that team's pool budget until they are outbid or they win.

### Pause, undo, export

**Pause** freezes both clocks. **Resume** continues them with the time that was left. Nothing is awarded while paused.

**Undo last bid** steps an open auction back one bid. Undoing the opening bid returns the player to the pool. If the restored clock has already expired, it is given the Reset 1 time so the auction doesn't end on the undo itself.

**Void award** returns that player to the pool and refunds the bid. It does not reopen the old auction. Lowering a budget does not pull back a bid already on the table.

**Export CSV** downloads `Player, Winning Team, Contract, New Salary, Pool` for awards that were not voided. There is no roster-size cap in this prototype.

## SETUP

Live bidding uses [Firebase Realtime Database](https://firebase.google.com/docs/database). The static site talks to it from the browser. Bids and the final award run inside transactions. The award compares a Firebase **server timestamp** to the auction's end time, so two bids at the same moment can't both win, and a laptop clock that is running fast can't award the player early. Countdowns use Firebase's server time offset.

Someone has to have the draft open for an expired clock to be resolved. If nobody is connected, the auction awards the next time a client opens it, using the server time — not early.

### 1. Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), add a project.
2. Build → Realtime Database → Create database. You can start locked; the rules below replace the default. Pick a region near the league.
3. Project settings → Your apps → add a Web app (`</>`). Copy the SDK config. You need `apiKey`, `authDomain`, `databaseURL`, and `projectId`.

### 2. Put the keys in one file

Edit `orphan-draft-config.js` (this is the only config file):

```javascript
window.ORPHAN_DRAFT_CONFIG = {
  adminPin: "choose-a-pin",
  closeToleranceMs: 500,
  draftPath: "orphanDrafts",
  firebase: {
    apiKey: "…",
    authDomain: "your-project.firebaseapp.com",
    databaseURL: "https://your-project-default-rtdb.firebaseio.com",
    projectId: "your-project",
  },
};
```

Leave `databaseURL` empty to keep live mode off. `adminPin` is a prototype gate checked in the browser. It is not real authentication, and anyone who can view source can read it. Change it before sharing a live draft, and don't put private keys in this file.

`closeToleranceMs` is how far the server's close stamp may lead `endsAt` and still count (clock skew). 500 ms is the default.

### 3. Publish the database rules

Realtime Database → Rules → paste the contents of `orphan-draft.rules.json` → Publish.

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "orphanDrafts": {
      ".read": true,
      ".write": true
    }
  }
}
```

The rest of the database is closed. The `orphanDrafts` tree is world-readable and world-writable, which matches a PIN that lives in the page. Don't store anything private in this database. A determined visitor can write the draft directly until the rules are tightened.

### 4. Run a draft

1. Reload the site and open **Orphan Draft** → **Connect to live draft**.
2. Enter the admin PIN. If this is the first time, **Create draft**.
3. Import the Fantrax export (`.xlsx` or `.csv`) or load the included `orphan-draft-sample.xlsx`. Fix any pool assignment that looks wrong. Pool changes are blocked once a player is nominated or won. **Recompute pools** puts available players back to the contract default.
4. Add drafting teams. Set each MLB budget and each MiLB budget (they can differ). Copy each team's join link.
5. Set the clocks. **Start**.
6. Owners log in with the league password and open their join link (`?draft=…&join=CODE`). They nominate, bid, and lock each pool on their own.
7. **Pause** / **Resume** as needed. **Undo last bid** or **Void** a mistaken award. **Export CSV** when you want the results.

Creating a new live draft leaves the previous one stored under its id. Join links that include `?draft=` still open the old one. New visitors without a draft id follow `orphanDrafts/activeId`.

### Fantrax columns

ID, Player, Team, Position, RkOv, Status, Age, Salary, Contract, FPts, FP/G, Ros. Team is the MLB club. Status is ignored.
