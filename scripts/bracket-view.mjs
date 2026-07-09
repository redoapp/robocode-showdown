#!/usr/bin/env node
/**
 * Robocode Showdown — live bracket viewer
 * =======================================
 *
 * Serves an auto-refreshing HTML page that visualizes the tournament from
 * scripts/tournament-state.json: group standings while the group stage runs,
 * then the knockout bracket with the full path to the Final (future rounds
 * shown as TBD). Re-reads the state file on every poll, so keep it open on
 * the projector and it updates a couple of seconds after each
 * `npm run tournament -- report ...`.
 *
 *   npm run bracket [-- --port 4600] [-- --state path/to/state.json] [-- --no-open]
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag("--port", 4600));
const STATE_FILE = resolve(flag("--state", join(__dirname, "tournament-state.json")));
const OPEN = !argv.includes("--no-open");
const POLL_MS = 2000;

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null; // mid-write or corrupt; the next poll will pick it up
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Standings (mirrors tournament.mjs, which is a CLI and can't be imported
// without running it)
// ---------------------------------------------------------------------------
const WIN_POINTS = 3;
const DRAW_POINTS = 1;

function standingsFor(group) {
  const table = new Map();
  for (const bot of group.bots) {
    table.set(bot, { bot, played: 0, wins: 0, draws: 0, losses: 0, points: 0 });
  }
  for (const m of group.matches) {
    if (!m.winner) continue;
    if (m.winner === "draw") {
      for (const bot of [m.a, m.b]) {
        table.get(bot).played++;
        table.get(bot).draws++;
        table.get(bot).points += DRAW_POINTS;
      }
    } else {
      const loser = m.winner === m.a ? m.b : m.a;
      table.get(m.winner).played++;
      table.get(loser).played++;
      table.get(m.winner).wins++;
      table.get(loser).losses++;
      table.get(m.winner).points += WIN_POINTS;
    }
  }
  const rows = [...table.values()];
  rows.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.wins !== x.wins) return y.wins - x.wins;
    const h2h = group.matches.find(
      (m) => m.winner && m.winner !== "draw" && ((m.a === x.bot && m.b === y.bot) || (m.a === y.bot && m.b === x.bot))
    );
    if (h2h) {
      if (h2h.winner === x.bot) return -1;
      if (h2h.winner === y.bot) return 1;
    }
    if (x.losses !== y.losses) return x.losses - y.losses;
    return x.bot.localeCompare(y.bot);
  });
  return rows;
}

const groupComplete = (g) => g.matches.every((m) => m.winner);

// ---------------------------------------------------------------------------
// Bracket model: real rounds + projected TBD rounds down to the Final
// ---------------------------------------------------------------------------
function roundName(numPlayers) {
  if (numPlayers === 2) return "Final";
  if (numPlayers === 4) return "Semi-finals";
  if (numPlayers === 8) return "Quarter-finals";
  return `Round of ${numPlayers}`;
}

// Which next-round match does match i of a round with `count` matches feed?
// Mirrors advanceKnockout: winners queue up in match order; an odd queue
// gives the first winner a bye into next round's match 0.
function feedIndex(i, count) {
  return count % 2 === 1 ? (i === 0 ? 0 : Math.floor((i + 1) / 2)) : Math.floor(i / 2);
}

function buildRounds(knockout) {
  const rounds = knockout.rounds.map((r) => ({
    index: r.index,
    name: r.name,
    real: true,
    matches: r.matches.map((m) => ({ ...m })),
  }));

  // Project future rounds so the path to the Final is always on screen.
  let count = rounds[rounds.length - 1].matches.length;
  let index = rounds[rounds.length - 1].index;
  while (count > 1) {
    const next = count % 2 === 1 ? (count + 1) / 2 : count / 2;
    index++;
    rounds.push({
      index,
      name: roundName(next * 2),
      real: false,
      matches: Array.from({ length: next }, (_, i) => ({
        id: `K${index}-${i + 1}`,
        a: null,
        b: count % 2 === 1 && i === 0 ? "BYE" : null,
        winner: null,
      })),
    });
    count = next;
  }

  // Winners already decided in the last real round are known advancers — show
  // them in the first projected round instead of TBD. Slot assignment mirrors
  // advanceKnockout's queue order: with an odd field, winner 0 takes the bye
  // match, then winners pair up a/b in match order.
  const lastReal = knockout.rounds.length - 1;
  if (rounds.length > knockout.rounds.length) {
    const cur = rounds[lastReal];
    const next = rounds[lastReal + 1];
    const odd = cur.matches.length % 2 === 1;
    cur.matches.forEach((m, i) => {
      if (!m.winner) return;
      const target = next.matches[feedIndex(i, cur.matches.length)];
      const slot = odd ? (i === 0 || i % 2 === 1 ? "a" : "b") : i % 2 === 0 ? "a" : "b";
      target[slot] = m.winner;
    });
  }

  // Wire up feeds (real and projected alike — the advancement rule is the same).
  for (let r = 0; r < rounds.length - 1; r++) {
    const cur = rounds[r];
    cur.matches.forEach((m, i) => {
      m.feeds = rounds[r + 1].matches[feedIndex(i, cur.matches.length)].id;
    });
  }
  return rounds;
}

function champion(knockout) {
  const last = knockout.rounds[knockout.rounds.length - 1];
  return last.matches.length === 1 && last.matches[0].winner ? last.matches[0].winner : null;
}

// Match ids the champion played in (or advanced through), for path highlighting.
function championPath(rounds, champ) {
  const ids = new Set();
  if (!champ) return ids;
  for (const r of rounds) {
    for (const m of r.matches) {
      if (m.a === champ || m.b === champ) ids.add(m.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderSlot(bot, match) {
  if (bot === null) return `<div class="slot tbd">TBD</div>`;
  if (bot === "BYE") return `<div class="slot bye">bye</div>`;
  const cls =
    match.winner === null ? "" : match.winner === bot ? " winner" : match.winner === "draw" ? "" : " loser";
  return `<div class="slot${cls}">${esc(bot)}</div>`;
}

function renderMatch(m, { onPath, isFinal }) {
  const classes = ["match"];
  if (onPath) classes.push("onpath");
  if (isFinal) classes.push("final");
  const feeds = m.feeds ? ` data-feeds="${esc(m.feeds)}"` : "";
  const path = onPath ? ` data-onpath="1"` : "";
  return `<div class="${classes.join(" ")}" data-match="${esc(m.id)}"${feeds}${path}>
    <div class="mid">${esc(m.id)}</div>
    ${renderSlot(m.a, m)}
    ${renderSlot(m.b, m)}
  </div>`;
}

function renderBracket(state) {
  const rounds = buildRounds(state.knockout);
  const champ = champion(state.knockout);
  const path = championPath(rounds, champ);

  const cols = rounds
    .map((r, ri) => {
      const isFinalRound = ri === rounds.length - 1;
      const matches = r.matches
        .map((m) => renderMatch(m, { onPath: path.has(m.id), isFinal: isFinalRound }))
        .join("\n");
      return `<div class="round${r.real ? "" : " projected"}">
        <div class="round-name">${esc(r.name)}</div>
        <div class="round-matches">${matches}</div>
      </div>`;
    })
    .join("\n");

  const banner = champ
    ? `<div class="champion">🏆 <strong>${esc(champ)}</strong> is the champion</div>`
    : "";

  return `${banner}<div id="bracket"><svg id="wires"></svg>${cols}</div>`;
}

function renderGroups(state) {
  const cards = state.groups
    .map((g) => {
      const done = groupComplete(g);
      const rows = standingsFor(g)
        .map((r, i) => {
          // Like the CLI, only mark qualifiers once the group is decided.
          const qualifies = done && i < 2;
          return `<tr class="${qualifies ? "qualifies" : ""}">
            <td class="botname">${qualifies ? "<span class='arrow'>→</span>" : ""}${esc(r.bot)}</td>
            <td>${r.played}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td>
            <td class="pts">${r.points}</td>
          </tr>`;
        })
        .join("\n");
      return `<div class="group">
        <div class="group-name">Group ${esc(g.name)}${done ? '<span class="done">complete</span>' : ""}</div>
        <table>
          <thead><tr><th>Bot</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("\n");

  const total = state.groups.reduce((n, g) => n + g.matches.length, 0);
  const played = state.groups.reduce((n, g) => n + g.matches.filter((m) => m.winner).length, 0);
  return `<div class="stage-note">Group stage — ${played} of ${total} matches played. Top 2 of each group advance to the knockout.</div>
    <div id="groups">${cards}</div>`;
}

function renderApp() {
  const state = loadState();
  if (!state) {
    return `<div class="empty">No tournament yet.<br><code>npm run tournament -- draw</code></div>`;
  }
  const sub = `${state.participants.length} bots · ${state.groups.length} group${state.groups.length === 1 ? "" : "s"}`;
  const body = state.knockout ? renderBracket(state) : renderGroups(state);
  return `<header><h1>Robocode Showdown</h1><div class="sub">${esc(sub)}</div></header>${body}`;
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Robocode Showdown — bracket</title>
<style>
  :root {
    --surface: #fcfcfb; --page: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --hairline: #e1e0d9; --border: rgba(11,11,11,0.10);
    --accent: #2a78d6; --gold: #eda100;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19; --page: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --hairline: #2c2c2a; --border: rgba(255,255,255,0.10);
      --accent: #3987e5; --gold: #c98500;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 28px 32px;
  }
  header { margin-bottom: 20px; }
  h1 { font-size: 22px; font-weight: 650; }
  .sub { color: var(--ink-2); font-size: 13px; margin-top: 2px; }

  .empty { color: var(--ink-2); padding: 48px 0; text-align: center; font-size: 17px; }
  .empty code { color: var(--ink); }

  .champion {
    font-size: 20px; margin-bottom: 18px;
    padding: 12px 16px; border: 1px solid var(--gold); border-radius: 10px;
    background: var(--surface); display: inline-block;
  }

  /* Bracket */
  #bracket { position: relative; display: flex; gap: 56px; overflow-x: auto; padding: 4px; }
  #wires { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  #wires path { fill: none; stroke: var(--hairline); stroke-width: 2; }
  #wires path.onpath { stroke: var(--accent); stroke-width: 2.5; }
  .round { display: flex; flex-direction: column; min-width: 190px; z-index: 1; }
  .round-name {
    color: var(--muted); font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px;
  }
  .round-matches { flex: 1; display: flex; flex-direction: column; justify-content: space-around; gap: 18px; }
  .match {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 10px 9px; position: relative;
  }
  .match.onpath { border-color: var(--accent); }
  .match.final { border-width: 2px; }
  .mid { color: var(--muted); font-size: 10.5px; margin-bottom: 3px; }
  .slot { padding: 3px 4px; border-radius: 4px; font-size: 14.5px; }
  .slot.winner { font-weight: 650; }
  .slot.winner::after { content: " ✓"; color: var(--accent); font-weight: 700; }
  .slot.loser { color: var(--muted); }
  .slot.tbd, .slot.bye { color: var(--muted); font-style: italic; }
  .projected .match { border-style: dashed; }

  /* Groups */
  .stage-note { color: var(--ink-2); font-size: 14px; margin-bottom: 16px; }
  #groups { display: flex; flex-wrap: wrap; gap: 20px; }
  .group {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; min-width: 280px;
  }
  .group-name { font-weight: 650; margin-bottom: 8px; }
  .group-name .done {
    color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px;
  }
  table { border-collapse: collapse; width: 100%; }
  th {
    color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; text-align: center; padding: 4px 7px;
    border-bottom: 1px solid var(--hairline);
  }
  th:first-child { text-align: left; }
  td { padding: 5px 7px; text-align: center; font-variant-numeric: tabular-nums; }
  td.botname { text-align: left; }
  td.pts { font-weight: 650; }
  tr.qualifies td.botname { font-weight: 600; }
  .arrow { color: var(--accent); margin-right: 5px; }
</style>
</head>
<body>
<div id="app">${renderApp()}</div>
<script>
  function drawConnectors() {
    const svg = document.getElementById("wires");
    const wrap = document.getElementById("bracket");
    if (!svg || !wrap) return;
    svg.replaceChildren();
    const wr = wrap.getBoundingClientRect();
    const sx = wrap.scrollLeft, sy = wrap.scrollTop;
    for (const card of wrap.querySelectorAll("[data-feeds]")) {
      const target = wrap.querySelector('[data-match="' + CSS.escape(card.dataset.feeds) + '"]');
      if (!target) continue;
      const a = card.getBoundingClientRect(), b = target.getBoundingClientRect();
      const x1 = a.right - wr.left + sx, y1 = a.top + a.height / 2 - wr.top + sy;
      const x2 = b.left - wr.left + sx, y2 = b.top + b.height / 2 - wr.top + sy;
      const mx = (x1 + x2) / 2;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", "M" + x1 + "," + y1 + " H" + mx + " V" + y2 + " H" + x2);
      if (card.dataset.onpath && target.dataset.onpath) p.setAttribute("class", "onpath");
      svg.appendChild(p);
    }
  }

  let lastHtml = null;
  async function poll() {
    try {
      const res = await fetch("/fragment");
      if (!res.ok) return;
      const html = await res.text();
      if (html !== lastHtml) {
        lastHtml = html;
        document.getElementById("app").innerHTML = html;
      }
      drawConnectors();
    } catch {}
  }
  setInterval(poll, ${POLL_MS});
  window.addEventListener("resize", drawConnectors);
  drawConnectors();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (url.pathname === "/fragment") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderApp());
  } else if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderPage());
  } else {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Bracket viewer: ${url}`);
  console.log(`Watching ${STATE_FILE}`);
  if (OPEN) {
    const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", shell: platform() === "win32" }).on("error", () => {});
  }
});
