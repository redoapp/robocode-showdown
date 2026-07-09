#!/usr/bin/env node
/**
 * Robocode Showdown — tournament manager
 * ======================================
 *
 * Format: groups of ~4 -> ONE melee battle per group (everyone in the group
 * fights at once) -> top 2 finishers advance -> single-elimination 1v1
 * knockout -> champion.
 *
 * You run the actual battles in the Robocode GUI (best for spectating on the
 * big screen). This tool just draws the groups, tracks results, and
 * builds/advances the knockout bracket. State is saved to
 * scripts/tournament-state.json so you can stop and resume any time.
 *
 * Bots are identified by their folder name under bots/. That means people can
 * `git pull` and change their bot's CODE between rounds without breaking the
 * bracket — the identities stay the same.
 *
 * Bots enter the draw by opting in: `"tournament": true` in their
 * bots/<name>/<name>.json (`new-bot` sets it for you). Reference bots without
 * the flag stay out unless pulled in with --include or --all.
 *
 * Commands (run from repo root):
 *   npm run tournament -- draw [--all] [--include A,B] [--exclude A,B]
 *                                               Draw groups (one melee each)
 *   npm run tournament -- status                Full overview (default)
 *   npm run tournament -- next                  Show the next battles to run
 *   npm run tournament -- report A first,second[,third,...]   Group melee order
 *   npm run tournament -- report K1-2 <winner>  Knockout result
 *   npm run tournament -- knockout              Seed the bracket (after groups)
 *   npm run tournament -- bracket               Show the knockout bracket
 *   npm run tournament -- reset                 Wipe all tournament state
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BOTS_DIR = join(ROOT, "bots");
const STATE_FILE = join(__dirname, "tournament-state.json");

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (state.groups?.some((g) => g.matches)) {
    console.error(
      "tournament-state.json is from the old round-robin format.\n" +
        "Run `npm run tournament -- reset` and redraw with the melee format."
    );
    process.exit(1);
  }
  return state;
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// A bot folder is any directory under bots/ that contains <dir>/<dir>.json
function scanBots() {
  if (!existsSync(BOTS_DIR)) return [];
  return readdirSync(BOTS_DIR)
    .filter((n) => {
      const p = join(BOTS_DIR, n);
      try {
        return statSync(p).isDirectory() && existsSync(join(p, `${n}.json`));
      } catch {
        return false;
      }
    })
    .sort();
}

// A bot opts in to the tournament with `"tournament": true` in its <name>.json.
function optedIn(name) {
  try {
    return JSON.parse(readFileSync(join(BOTS_DIR, name, `${name}.json`), "utf8")).tournament === true;
  } catch {
    return false;
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const letters = (i) => {
  // 0->A, 25->Z, 26->AA ...
  let s = "";
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

// ---------------------------------------------------------------------------
// DRAW: build groups — each group is a single melee battle
// ---------------------------------------------------------------------------
function buildGroups(bots) {
  const n = bots.length;
  // Aim for groups of 4; distribute as evenly as possible (sizes differ by <=1).
  const numGroups = Math.max(1, Math.round(n / 4));
  const shuffled = shuffle(bots);
  const groups = Array.from({ length: numGroups }, (_, i) => ({
    name: letters(i),
    bots: [],
    // Finishing order of the group melee, best first. Must cover at least the
    // top 2 (the qualifiers); trailing places are optional.
    result: null,
  }));
  // Snake-deal so groups stay balanced.
  shuffled.forEach((bot, idx) => groups[idx % numGroups].bots.push(bot));
  return groups;
}

function cmdDraw(args) {
  if (existsSync(STATE_FILE)) {
    console.error("A tournament already exists. Run `reset` first if you really want to redraw.");
    process.exit(1);
  }
  const listArg = (flag) => {
    const idx = args.indexOf(flag);
    const set = new Set();
    if (idx !== -1 && args[idx + 1]) args[idx + 1].split(",").forEach((x) => set.add(x.trim()));
    return set;
  };
  const exclude = listArg("--exclude");
  const include = listArg("--include");
  const all = args.includes("--all");

  const onDisk = scanBots().filter((b) => !exclude.has(b));
  const missingIncludes = [...include].filter((b) => !onDisk.includes(b));
  if (missingIncludes.length) {
    console.error(`--include names not found in bots/: ${missingIncludes.join(", ")}`);
    process.exit(1);
  }
  const bots = onDisk.filter((b) => all || include.has(b) || optedIn(b));
  const optedOut = onDisk.filter((b) => !bots.includes(b));

  if (bots.length < 2) {
    console.error(`Need at least 2 opted-in bots to run a tournament. Found ${bots.length}.`);
    if (optedOut.length) {
      console.error(`Not opted in: ${optedOut.join(", ")}`);
      console.error(`Opt a bot in with "tournament": true in its <name>.json, or draw with --include/--all.`);
    }
    if (exclude.size) console.error(`(excluded: ${[...exclude].join(", ")})`);
    process.exit(1);
  }

  const groups = buildGroups(bots);
  const state = {
    createdAt: new Date().toISOString(),
    participants: bots,
    excluded: [...exclude],
    groups,
    knockout: null,
  };
  saveState(state);

  console.log(`Drew ${bots.length} bots into ${groups.length} group melee(s):\n`);
  renderGroups(state);
  if (optedOut.length) {
    console.log(`\nSkipped (not opted in): ${optedOut.join(", ")}`);
  }
  console.log("\nRun each group's melee in the GUI (all its bots in one battle), then");
  console.log("record the finishing order — at least the top 2:");
  console.log("  npm run tournament -- report A first,second[,third,...]");
  console.log("  npm run tournament -- status");
}

// ---------------------------------------------------------------------------
// Group placements
// ---------------------------------------------------------------------------
function groupComplete(group) {
  return Array.isArray(group.result) && group.result.length >= 2;
}
function allGroupsComplete(state) {
  return state.groups.every(groupComplete);
}

// Rows for display: reported finishers with their place, then unreported bots.
function placementsFor(group) {
  const result = group.result ?? [];
  const rows = result.map((bot, i) => ({ bot, place: i + 1 }));
  for (const bot of group.bots) {
    if (!result.includes(bot)) rows.push({ bot, place: null });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// KNOCKOUT
// ---------------------------------------------------------------------------
function roundName(numPlayers) {
  if (numPlayers === 2) return "Final";
  if (numPlayers === 4) return "Semi-finals";
  if (numPlayers === 8) return "Quarter-finals";
  return `Round of ${numPlayers}`;
}

function seedKnockout(state) {
  const winners = state.groups.map((g) => g.result[0]);
  const runners = state.groups.map((g) => g.result[1] ?? null);
  const qualifiers = [];
  const G = winners.length;
  // World Cup crossing: winner of group i faces runner-up of the NEXT group,
  // so nobody meets a group-mate in the first knockout round.
  for (let i = 0; i < G; i++) {
    const w = winners[i];
    const r = runners[(i + 1) % G];
    if (w && r) qualifiers.push([w, r]);
    else if (w) qualifiers.push([w, "BYE"]);
  }
  const matches = qualifiers.map(([a, b], idx) => ({
    id: `K1-${idx + 1}`,
    a,
    b,
    winner: b === "BYE" ? a : null,
  }));
  const numPlayers = matches.length * 2;
  state.knockout = { rounds: [{ index: 1, name: roundName(numPlayers), matches }] };
  advanceKnockout(state); // resolve any BYE auto-wins immediately
}

function advanceKnockout(state) {
  const ko = state.knockout;
  if (!ko) return;
  const cur = ko.rounds[ko.rounds.length - 1];
  if (cur.matches.length === 1 && cur.matches[0].winner) return; // champion decided
  if (!cur.matches.every((m) => m.winner)) return; // current round not finished

  const advancers = cur.matches.map((m) => m.winner);
  if (advancers.length === 1) return; // that was the final

  const nextIdx = cur.index + 1;
  const matches = [];
  const queue = advancers.slice();
  // If odd, the first advancer gets a bye into the following round.
  let n = 1;
  if (queue.length % 2 === 1) {
    matches.push({ id: `K${nextIdx}-${n}`, a: queue.shift(), b: "BYE", winner: null });
    matches[0].winner = matches[0].a;
    n++;
  }
  while (queue.length >= 2) {
    matches.push({ id: `K${nextIdx}-${n}`, a: queue.shift(), b: queue.shift(), winner: null });
    n++;
  }
  const numPlayers = matches.length * 2;
  ko.rounds.push({ index: nextIdx, name: roundName(numPlayers), matches });
  advanceKnockout(state); // cascade through any byes
}

function cmdKnockout(state) {
  if (!state) return noTournament();
  if (state.knockout) {
    console.log("Knockout already seeded.\n");
    renderBracket(state);
    return;
  }
  if (!allGroupsComplete(state)) {
    console.error("Not all group melees are reported yet. Finish the group stage first.\n");
    renderPending(state);
    process.exit(1);
  }
  seedKnockout(state);
  saveState(state);
  console.log("Knockout bracket seeded from the top 2 of each group melee:\n");
  renderBracket(state);
  console.log("\nRun the matches, then: npm run tournament -- report <matchId> <winner>");
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
function reportGroup(state, group, args) {
  // Accept "first,second,third" or space-separated names; need at least top 2.
  const order = args
    .join(",")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (order.length < 2) {
    console.error(`Usage: report ${group.name} first,second[,third,...]  (at least the top 2 finishers)`);
    process.exit(1);
  }
  const unknown = order.filter((b) => !group.bots.includes(b));
  if (unknown.length) {
    console.error(`Not in group ${group.name}: ${unknown.join(", ")}. Group bots: ${group.bots.join(", ")}`);
    process.exit(1);
  }
  if (new Set(order).size !== order.length) {
    console.error("Each bot can only appear once in the finishing order.");
    process.exit(1);
  }

  const previously = group.result;
  group.result = order;
  saveState(state);

  const verb = previously ? "Updated" : "Recorded";
  console.log(`${verb}: melee ${group.name}  ->  ${order.map((b, i) => `${i + 1}. ${b}`).join("  ")}`);
  if (previously && state.knockout) {
    console.log("⚠  The knockout is already seeded — changing a group result won't re-seed it.");
  }

  if (allGroupsComplete(state) && !state.knockout) {
    console.log("\nAll group melees are in! Seed the bracket:");
    console.log("  npm run tournament -- knockout");
  }
}

function findKnockoutMatch(state, id) {
  if (!state.knockout) return null;
  for (const r of state.knockout.rounds) {
    const m = r.matches.find((x) => x.id === id);
    if (m) return { m, round: r };
  }
  return null;
}

function cmdReport(state, args) {
  if (!state) return noTournament();
  const id = args[0];
  if (!id || !args[1]) {
    console.error("Usage: report <group> first,second[,...]   or   report <matchId> <winner>");
    process.exit(1);
  }

  const group = state.groups.find((g) => g.name === id);
  if (group) return reportGroup(state, group, args.slice(1));

  const found = findKnockoutMatch(state, id);
  if (!found) {
    console.error(`No group or match with id "${id}". Run \`status\` to see ids.`);
    process.exit(1);
  }
  const { m } = found;
  const winner = args[1];
  if (winner.toLowerCase() === "draw") {
    console.error("Knockout matches can't be draws — pick a winner (use total score, then 1st places, or re-run the battle).");
    process.exit(1);
  }
  if (winner !== m.a && winner !== m.b) {
    console.error(`Winner must be "${m.a}" or "${m.b}". Got "${winner}".`);
    process.exit(1);
  }

  const previously = m.winner;
  m.winner = winner;
  advanceKnockout(state);
  saveState(state);

  const verb = previously ? "Updated" : "Recorded";
  console.log(`${verb}: ${m.id}  ${m.a} vs ${m.b}  ->  ${winner} wins`);

  const last = state.knockout.rounds[state.knockout.rounds.length - 1];
  if (last.matches.length === 1 && last.matches[0].winner) {
    console.log(`\n🏆  CHAMPION: ${last.matches[0].winner}  🏆`);
  }
}

// ---------------------------------------------------------------------------
// RENDERING
// ---------------------------------------------------------------------------
function renderGroups(state) {
  for (const g of state.groups) {
    console.log(`Group ${g.name}:  ${g.bots.join(", ")}`);
  }
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function renderPlacements(state) {
  for (const g of state.groups) {
    const w = Math.max(8, ...g.bots.map((b) => b.length));
    console.log(`\nGroup ${g.name}${groupComplete(g) ? " (melee played)" : " (melee pending)"}`);
    for (const row of placementsFor(g)) {
      const qualifies = row.place !== null && row.place <= 2;
      const place = row.place === null ? "—" : `${row.place}.`;
      console.log(`${qualifies ? "→" : " "} ${pad(place, 3)}${pad(row.bot, w)}`);
    }
  }
}

function renderPending(state) {
  const pending = [];
  for (const g of state.groups) {
    if (!groupComplete(g)) pending.push(`  ${pad(g.name, 6)} melee: ${g.bots.join(" vs ")}`);
  }
  if (state.knockout) {
    const last = state.knockout.rounds[state.knockout.rounds.length - 1];
    for (const m of last.matches) if (!m.winner) pending.push(`  ${pad(m.id, 6)} ${m.a} vs ${m.b}  (${last.name})`);
  }
  if (pending.length === 0) {
    console.log("No battles pending. 🎉");
  } else {
    console.log("Battles still to play:");
    console.log(pending.join("\n"));
  }
}

function renderBracket(state) {
  if (!state.knockout) {
    console.log("(Knockout not seeded yet — run `knockout` once the group stage is done.)");
    return;
  }
  for (const r of state.knockout.rounds) {
    console.log(`\n${r.name}`);
    for (const m of r.matches) {
      const res =
        m.b === "BYE"
          ? `${m.a} advances (bye)`
          : m.winner
          ? `${m.a} vs ${m.b}  ->  ${m.winner}`
          : `${m.a} vs ${m.b}`;
      console.log(`  ${pad(m.id, 6)} ${res}`);
    }
  }
  const last = state.knockout.rounds[state.knockout.rounds.length - 1];
  if (last.matches.length === 1 && last.matches[0].winner) {
    console.log(`\n🏆  CHAMPION: ${last.matches[0].winner}  🏆`);
  }
}

function cmdStatus(state) {
  if (!state) return noTournament();
  console.log(`Robocode Showdown — drawn ${new Date(state.createdAt).toLocaleString()}`);
  console.log(`${state.participants.length} bots · ${state.groups.length} group melees`);
  renderPlacements(state);
  if (state.knockout) {
    console.log("\n=== KNOCKOUT ===");
    renderBracket(state);
  } else if (allGroupsComplete(state)) {
    console.log("\nGroup stage complete. Seed the bracket:  npm run tournament -- knockout");
  }
  console.log("");
  renderPending(state);
  // Warn if any participant's folder disappeared (e.g. bad git pull).
  const onDisk = new Set(scanBots());
  const missing = state.participants.filter((b) => !onDisk.has(b));
  if (missing.length) {
    console.log(`\n⚠  These bots are in the bracket but missing from bots/: ${missing.join(", ")}`);
    console.log("   They still need to be present to boot in the GUI. Check the latest git pull.");
  }
}

function cmdNext(state) {
  if (!state) return noTournament();
  renderPending(state);
}

function cmdReset() {
  if (existsSync(STATE_FILE)) {
    unlinkSync(STATE_FILE);
    console.log("Tournament state wiped.");
  } else {
    console.log("Nothing to reset.");
  }
}

function noTournament() {
  console.log("No tournament yet. Draw one with:  npm run tournament -- draw");
}

function help() {
  console.log(`Robocode Showdown — tournament manager

  draw [--all] [--include A,B] [--exclude A,B]
                           Draw groups of ~4; each group fights ONE melee battle
                           (only bots with "tournament": true in their .json;
                           --include pulls in named bots, --all takes everyone)
  status                   Placements + bracket + pending battles (default)
  next                     List the battles still to play
  report <group> first,second[,third,...]
                           Record a group melee's finishing order (top 2 minimum)
  report <matchId> <winner>
                           Record a knockout result (winner = bot name)
  knockout                 Seed the knockout bracket from the top 2 of each group
  bracket                  Show the knockout bracket
  reset                    Delete all tournament state

Bots are identified by folder name, so people can change their bot's code and
git pull between rounds without breaking the bracket. A bot enters the draw by
opting in: "tournament": true in bots/<name>/<name>.json (new-bot sets this).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
const state = loadState();

switch (cmd) {
  case "draw":
    cmdDraw(args);
    break;
  case "report":
    cmdReport(state, args);
    break;
  case "knockout":
    cmdKnockout(state);
    break;
  case "bracket":
    if (!state) noTournament();
    else renderBracket(state);
    break;
  case "next":
    cmdNext(state);
    break;
  case "reset":
    cmdReset();
    break;
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  case undefined:
  case "status":
    cmdStatus(state);
    break;
  default:
    console.error(`Unknown command "${cmd}".\n`);
    help();
    process.exit(1);
}
