#!/usr/bin/env node
/**
 * Robocode Showdown — tournament manager (CLI)
 * ============================================
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
 * The engine lives in tournament-lib.mjs, shared with the live bracket viewer
 * (`npm run bracket`) — which can also do everything below from the browser.
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

import {
  TournamentError,
  loadState,
  resetState,
  scanBots,
  selectBots,
  draw,
  groupComplete,
  allGroupsComplete,
  placementsFor,
  reportGroupResult,
  reportMatchResult,
  seedKnockout,
  champion,
} from "./tournament-lib.mjs";

// ---------------------------------------------------------------------------
// DRAW
// ---------------------------------------------------------------------------
function cmdDraw(args) {
  const listArg = (flag) => {
    const idx = args.indexOf(flag);
    const set = new Set();
    if (idx !== -1 && args[idx + 1]) args[idx + 1].split(",").forEach((x) => set.add(x.trim()));
    return set;
  };
  const exclude = listArg("--exclude");
  const include = listArg("--include");
  const { bots, optedOut } = selectBots({ all: args.includes("--all"), include, exclude });

  if (bots.length < 2) {
    console.error(`Need at least 2 opted-in bots to run a tournament. Found ${bots.length}.`);
    if (optedOut.length) {
      console.error(`Not opted in: ${optedOut.join(", ")}`);
      console.error(`Opt a bot in with "tournament": true in its <name>.json, or draw with --include/--all.`);
    }
    if (exclude.size) console.error(`(excluded: ${[...exclude].join(", ")})`);
    process.exit(1);
  }

  const state = draw(bots, { excluded: [...exclude] });

  console.log(`Drew ${bots.length} bots into ${state.groups.length} group melee(s):\n`);
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
// KNOCKOUT
// ---------------------------------------------------------------------------
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
  console.log("Knockout bracket seeded from the top 2 of each group melee:\n");
  renderBracket(state);
  console.log("\nRun the matches, then: npm run tournament -- report <matchId> <winner>");
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
function cmdReport(state, args) {
  if (!state) return noTournament();
  const id = args[0];
  if (!id || !args[1]) {
    console.error("Usage: report <group> first,second[,...]   or   report <matchId> <winner>");
    process.exit(1);
  }

  if (state.groups.some((g) => g.name === id)) {
    // Accept "first,second,third" or space-separated names; need at least top 2.
    const order = args
      .slice(1)
      .join(",")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (order.length < 2) {
      console.error(`Usage: report ${id} first,second[,third,...]  (at least the top 2 finishers)`);
      process.exit(1);
    }
    const { updated, knockoutSeeded, allComplete } = reportGroupResult(state, id, order);
    console.log(`${updated ? "Updated" : "Recorded"}: melee ${id}  ->  ${order.map((b, i) => `${i + 1}. ${b}`).join("  ")}`);
    if (updated && knockoutSeeded) {
      console.log("⚠  The knockout is already seeded — changing a group result won't re-seed it.");
    }
    if (allComplete && !knockoutSeeded) {
      console.log("\nAll group melees are in! Seed the bracket:");
      console.log("  npm run tournament -- knockout");
    }
    return;
  }

  const { updated, match, champion: champ } = reportMatchResult(state, id, args[1]);
  console.log(`${updated ? "Updated" : "Recorded"}: ${match.id}  ${match.a} vs ${match.b}  ->  ${match.winner} wins`);
  if (champ) {
    console.log(`\n🏆  CHAMPION: ${champ}  🏆`);
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
  const champ = champion(state);
  if (champ) {
    console.log(`\n🏆  CHAMPION: ${champ}  🏆`);
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
  console.log(resetState() ? "Tournament state wiped." : "Nothing to reset.");
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

Everything above can also be done from the browser: npm run bracket.

Bots are identified by folder name, so people can change their bot's code and
git pull between rounds without breaking the bracket. A bot enters the draw by
opting in: "tournament": true in bots/<name>/<name>.json (new-bot sets this).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);

try {
  // draw/reset must work even if the state file is missing or in the old format.
  const state = cmd === "draw" || cmd === "reset" ? null : loadState();

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
} catch (e) {
  if (e instanceof TournamentError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
