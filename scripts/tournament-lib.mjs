/**
 * Robocode Showdown — tournament core
 * ===================================
 *
 * Shared engine behind the tournament CLI (tournament.mjs) and the live
 * bracket viewer / control panel (bracket-view.mjs). Format: groups of ~4 ->
 * ONE melee battle per group -> top 2 finishers advance -> single-elimination
 * 1v1 knockout -> champion.
 *
 * Bots are identified by their folder name under bots/, so code changes and
 * `git pull` between rounds never break the bracket.
 *
 * Mutating helpers validate their input and throw TournamentError with a
 * user-facing message on bad input or wrong phase, so callers can surface it
 * directly (CLI: stderr; viewer: HTTP 400). On success they persist the state
 * file themselves.
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BOTS_DIR = join(ROOT, "bots");
export const STATE_FILE = join(__dirname, "tournament-state.json");

/** Expected, user-facing failures (bad input, wrong phase, stale format). */
export class TournamentError extends Error {}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export function loadState(file = STATE_FILE) {
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.groups?.some((g) => g.matches)) {
    throw new TournamentError(
      "tournament-state.json is from the old round-robin format. " +
        "Reset (npm run tournament -- reset, or the Reset button in the bracket viewer) and redraw with the melee format."
    );
  }
  return state;
}

export function saveState(state, file = STATE_FILE) {
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

/** Delete the state file. Returns true if there was one to delete. */
export function resetState(file = STATE_FILE) {
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

// ---------------------------------------------------------------------------
// Bot discovery
// ---------------------------------------------------------------------------
// A bot folder is any directory under bots/ that contains <dir>/<dir>.json
export function scanBots() {
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
export function optedIn(name) {
  try {
    return JSON.parse(readFileSync(join(BOTS_DIR, name, `${name}.json`), "utf8")).tournament === true;
  } catch {
    return false;
  }
}

/** Resolve the draw field from opt-in flags + --all/--include/--exclude. */
export function selectBots({ all = false, include = new Set(), exclude = new Set() } = {}) {
  const onDisk = scanBots().filter((b) => !exclude.has(b));
  const missingIncludes = [...include].filter((b) => !onDisk.includes(b));
  if (missingIncludes.length) {
    throw new TournamentError(`--include names not found in bots/: ${missingIncludes.join(", ")}`);
  }
  const bots = onDisk.filter((b) => all || include.has(b) || optedIn(b));
  return { bots, optedOut: onDisk.filter((b) => !bots.includes(b)) };
}

// ---------------------------------------------------------------------------
// DRAW: build groups — each group is a single melee battle
// ---------------------------------------------------------------------------
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

/** Draw a fresh tournament from an explicit list of bot folder names. */
export function draw(bots, { excluded = [], file = STATE_FILE } = {}) {
  if (existsSync(file)) {
    throw new TournamentError("A tournament already exists — reset it first if you really want to redraw.");
  }
  if (!Array.isArray(bots) || !bots.every((b) => typeof b === "string")) {
    throw new TournamentError("Expected a list of bot names.");
  }
  if (new Set(bots).size !== bots.length) {
    throw new TournamentError("Each bot can only appear once in the draw.");
  }
  const onDisk = scanBots();
  const unknown = bots.filter((b) => !onDisk.includes(b));
  if (unknown.length) {
    throw new TournamentError(`Not found in bots/: ${unknown.join(", ")}`);
  }
  if (bots.length < 2) {
    throw new TournamentError(`Need at least 2 bots to run a tournament. Got ${bots.length}.`);
  }

  const state = {
    createdAt: new Date().toISOString(),
    participants: bots,
    excluded,
    groups: buildGroups(bots),
    knockout: null,
  };
  saveState(state, file);
  return state;
}

// ---------------------------------------------------------------------------
// Group placements
// ---------------------------------------------------------------------------
export function groupComplete(group) {
  return Array.isArray(group.result) && group.result.length >= 2;
}

export function allGroupsComplete(state) {
  return state.groups.every(groupComplete);
}

// Rows for display: reported finishers with their place, then unreported bots.
export function placementsFor(group) {
  const result = group.result ?? [];
  const rows = result.map((bot, i) => ({ bot, place: i + 1 }));
  for (const bot of group.bots) {
    if (!result.includes(bot)) rows.push({ bot, place: null });
  }
  return rows;
}

/**
 * Record a group melee's finishing order (best first, at least the top 2).
 * The latest report wins; changing a result after the knockout is seeded is
 * allowed but won't re-seed (flagged in the return value).
 */
export function reportGroupResult(state, groupName, order, { file = STATE_FILE } = {}) {
  const group = state.groups.find((g) => g.name === groupName);
  if (!group) throw new TournamentError(`No group named "${groupName}".`);
  order = (Array.isArray(order) ? order : []).map((x) => String(x).trim()).filter(Boolean);
  if (order.length < 2) {
    throw new TournamentError(`Group ${groupName} needs at least the top 2 finishers.`);
  }
  const unknown = order.filter((b) => !group.bots.includes(b));
  if (unknown.length) {
    throw new TournamentError(
      `Not in group ${group.name}: ${unknown.join(", ")}. Group bots: ${group.bots.join(", ")}`
    );
  }
  if (new Set(order).size !== order.length) {
    throw new TournamentError("Each bot can only appear once in the finishing order.");
  }

  const previously = group.result;
  group.result = order;
  saveState(state, file);
  return {
    updated: previously != null,
    knockoutSeeded: !!state.knockout,
    allComplete: allGroupsComplete(state),
  };
}

// ---------------------------------------------------------------------------
// KNOCKOUT
// ---------------------------------------------------------------------------
export function roundName(numPlayers) {
  if (numPlayers === 2) return "Final";
  if (numPlayers === 4) return "Semi-finals";
  if (numPlayers === 8) return "Quarter-finals";
  return `Round of ${numPlayers}`;
}

/** Seed the bracket from the top 2 of each group (after the group stage). */
export function seedKnockout(state, { file = STATE_FILE } = {}) {
  if (state.knockout) throw new TournamentError("Knockout already seeded.");
  if (!allGroupsComplete(state)) {
    throw new TournamentError("Not all group melees are reported yet — finish the group stage first.");
  }

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
  saveState(state, file);
  return state.knockout;
}

export function advanceKnockout(state) {
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

export function findKnockoutMatch(state, id) {
  if (!state.knockout) return null;
  for (const r of state.knockout.rounds) {
    const m = r.matches.find((x) => x.id === id);
    if (m) return { m, round: r };
  }
  return null;
}

/**
 * Record a knockout result. Re-reporting is allowed only while the match's
 * winner hasn't been fed into a later round (i.e. it's still in the latest
 * round) — the latest report wins.
 */
export function reportMatchResult(state, id, winner, { file = STATE_FILE } = {}) {
  const found = findKnockoutMatch(state, id);
  if (!found) throw new TournamentError(`No group or match with id "${id}".`);
  const { m, round } = found;
  if (m.a === "BYE" || m.b === "BYE") {
    throw new TournamentError(`${id} is a bye — nothing to report.`);
  }
  if (String(winner).toLowerCase() === "draw") {
    throw new TournamentError(
      "Knockout matches can't be draws — pick a winner (use total score, then 1st places, or re-run the battle)."
    );
  }
  if (winner !== m.a && winner !== m.b) {
    throw new TournamentError(`Winner must be "${m.a}" or "${m.b}". Got "${winner}".`);
  }
  const rounds = state.knockout.rounds;
  if (m.winner && m.winner !== winner && round !== rounds[rounds.length - 1]) {
    throw new TournamentError(
      `${id} already sent ${m.winner} into a later round — its result can't be changed any more.`
    );
  }

  const previously = m.winner;
  m.winner = winner;
  advanceKnockout(state);
  saveState(state, file);
  return { updated: !!previously, match: m, champion: champion(state) };
}

/** The champion, or null while the final is undecided / knockout unseeded. */
export function champion(state) {
  const ko = state?.knockout;
  if (!ko) return null;
  const last = ko.rounds[ko.rounds.length - 1];
  return last.matches.length === 1 && last.matches[0].winner ? last.matches[0].winner : null;
}
