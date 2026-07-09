#!/usr/bin/env node
/**
 * Robocode Showdown — live bracket viewer + control panel
 * =======================================================
 *
 * Serves an auto-refreshing HTML page that visualizes AND controls the
 * tournament in scripts/tournament-state.json. Everything the CLI can do is
 * clickable in the page:
 *
 *   - no tournament yet   -> pick who's in and draw the group melees
 *   - group stage         -> click bots in finishing order to report a melee
 *   - group stage done    -> seed the knockout bracket
 *   - knockout            -> click a bot in a match to record the winner
 *   - any time            -> reset (with confirmation)
 *
 * The CLI (`npm run tournament -- ...`) keeps working against the same state
 * file — the page re-reads it on every poll, so you can mix and match. Leave
 * it on the projector and it updates a couple of seconds after each change.
 *
 *   npm run bracket [-- --port 4600] [-- --state path/to/state.json] [-- --no-open]
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TournamentError,
  loadState,
  resetState,
  scanBots,
  optedIn,
  draw,
  groupComplete,
  allGroupsComplete,
  placementsFor,
  reportGroupResult,
  reportMatchResult,
  seedKnockout,
  roundName,
  champion,
} from "./tournament-lib.mjs";

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

function readState() {
  try {
    return { state: loadState(STATE_FILE) };
  } catch (e) {
    if (e instanceof TournamentError) return { state: null, error: e.message };
    return { state: null }; // mid-write or corrupt; the next poll will pick it up
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Bracket model: real rounds + projected TBD rounds down to the Final
// ---------------------------------------------------------------------------
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
function renderSlot(bot, match, reportable) {
  if (bot === null) return `<div class="slot tbd">TBD</div>`;
  if (bot === "BYE") return `<div class="slot bye">bye</div>`;
  const cls =
    match.winner === null ? "" : match.winner === bot ? " winner" : match.winner === "draw" ? "" : " loser";
  const pick = reportable ? ` pick" data-match-id="${esc(match.id)}" data-pick="${esc(bot)}` : "";
  return `<div class="slot${cls}${pick}">${esc(bot)}</div>`;
}

function renderMatch(m, { onPath, isFinal, reportable }) {
  const classes = ["match"];
  if (onPath) classes.push("onpath");
  if (isFinal) classes.push("final");
  const feeds = m.feeds ? ` data-feeds="${esc(m.feeds)}"` : "";
  const path = onPath ? ` data-onpath="1"` : "";
  return `<div class="${classes.join(" ")}" data-match="${esc(m.id)}"${feeds}${path}>
    <div class="mid">${esc(m.id)}</div>
    ${renderSlot(m.a, m, reportable)}
    ${renderSlot(m.b, m, reportable)}
  </div>`;
}

function renderBracket(state) {
  const rounds = buildRounds(state.knockout);
  const champ = champion(state);
  const path = championPath(rounds, champ);
  const lastRealIdx = state.knockout.rounds.length - 1;

  const cols = rounds
    .map((r, ri) => {
      const isFinalRound = ri === rounds.length - 1;
      const isLastReal = ri === lastRealIdx;
      const matches = r.matches
        .map((m) => {
          // A result can be entered (or, in the latest round, corrected) here.
          const reportable =
            r.real && m.a && m.b && m.a !== "BYE" && m.b !== "BYE" && (!m.winner || isLastReal);
          return renderMatch(m, { onPath: path.has(m.id), isFinal: isFinalRound, reportable });
        })
        .join("\n");
      return `<div class="round${r.real ? "" : " projected"}">
        <div class="round-name">${esc(r.name)}</div>
        <div class="round-matches">${matches}</div>
      </div>`;
    })
    .join("\n");

  const banner = champ
    ? `<div class="champion">🏆 <strong>${esc(champ)}</strong> is the champion</div>`
    : `<div class="stage-note">Knockout — run each match in the GUI, then click the winning bot in its card.</div>`;

  return `${banner}<div id="bracket"><svg id="wires"></svg>${cols}</div>`;
}

function renderGroups(state) {
  const cards = state.groups
    .map((g) => {
      const done = groupComplete(g);
      const rows = placementsFor(g)
        .map((r) => {
          const qualifies = r.place !== null && r.place <= 2;
          return `<tr class="${qualifies ? "qualifies" : ""}">
            <td class="place">${r.place === null ? "–" : r.place}</td>
            <td class="botname">${qualifies ? "<span class='arrow'>→</span>" : ""}${esc(r.bot)}</td>
          </tr>`;
        })
        .join("\n");
      return `<div class="group" data-group="${esc(g.name)}" data-bots="${esc(JSON.stringify(g.bots))}">
        <div class="group-head">
          <div class="group-name">Group ${esc(g.name)}<span class="done">${done ? "melee played" : "melee pending"}</span></div>
          <button class="btn small" data-action="edit-group">${done ? "Edit result" : "Enter result"}</button>
        </div>
        <div class="group-body"><table>
          <thead><tr><th>#</th><th>Bot</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    })
    .join("\n");

  const total = state.groups.length;
  const played = state.groups.filter(groupComplete).length;
  const note =
    played === total
      ? `Group stage complete — seed the knockout bracket when ready.`
      : `Group stage — ${played} of ${total} group melees played. Run each group's melee in the GUI, then enter its finishing order here. Top 2 of each group advance.`;
  return `<div class="stage-note">${note}</div>
    <div id="groups">${cards}</div>`;
}

function renderDrawScreen() {
  const bots = scanBots();
  if (!bots.length) {
    return `<div class="empty">No bots found in bots/.<br>Create one with <code>npm run new-bot</code>.</div>`;
  }
  const rows = bots
    .map((b) => {
      const opted = optedIn(b);
      return `<label class="draw-bot"><input type="checkbox" data-bot="${esc(b)}"${opted ? " checked" : ""}>
        <span>${esc(b)}</span>${opted ? "" : `<span class="muted">not opted in</span>`}</label>`;
    })
    .join("\n");
  return `<div id="draw">
    <div class="stage-note">No tournament yet. Pick who's in — opted-in bots are pre-checked — then draw the group melees.</div>
    <div class="draw-list">${rows}</div>
    <div class="draw-tools">
      <button class="btn primary" data-action="draw">🎲 Draw groups</button>
      <button class="btn" data-action="check-all">Check all</button>
      <button class="btn" data-action="uncheck-all">Uncheck all</button>
    </div>
  </div>`;
}

function renderControls(state) {
  const btns = [];
  if (!state.knockout && allGroupsComplete(state)) {
    btns.push(`<button class="btn primary" data-action="seed">Seed knockout bracket</button>`);
  }
  btns.push(`<button class="btn danger-ghost" data-action="reset">Reset…</button>`);
  return `<div class="controls">${btns.join("\n")}</div>`;
}

function renderApp() {
  const { state, error } = readState();
  if (error) {
    return `<header><h1>Robocode Showdown</h1></header>
      <div class="empty">${esc(error)}<br><br>
      <button class="btn danger" data-action="reset">Reset…</button></div>`;
  }
  if (!state) {
    return `<header><div><h1>Robocode Showdown</h1><div class="sub">tournament control</div></div></header>${renderDrawScreen()}`;
  }
  const sub = `${state.participants.length} bots · ${state.groups.length} group${state.groups.length === 1 ? "" : "s"}`;
  const body = state.knockout ? renderBracket(state) : renderGroups(state);
  return `<header><div><h1>Robocode Showdown</h1><div class="sub">${esc(sub)}</div></div>${renderControls(state)}</header>${body}`;
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
    --accent: #2a78d6; --gold: #eda100; --danger: #c93a2e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19; --page: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --hairline: #2c2c2a; --border: rgba(255,255,255,0.10);
      --accent: #3987e5; --gold: #c98500; --danger: #e05a4e;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink);
    font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 28px 32px;
  }
  header {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin-bottom: 20px;
  }
  h1 { font-size: 22px; font-weight: 650; }
  .sub { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .btn {
    font: inherit; font-size: 13px; color: var(--ink);
    background: var(--surface); border: 1px solid var(--border); border-radius: 7px;
    padding: 5px 12px; cursor: pointer;
  }
  .btn:hover { border-color: var(--ink-2); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn:disabled:hover { border-color: var(--border); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  .btn.danger-ghost { color: var(--danger); }
  .btn.small { font-size: 12px; padding: 3px 9px; }
  .reset-confirm { font-size: 13px; color: var(--ink-2); display: inline-flex; gap: 8px; align-items: center; }

  .empty { color: var(--ink-2); padding: 48px 0; text-align: center; font-size: 17px; }
  .empty code { color: var(--ink); }

  .champion {
    font-size: 20px; margin-bottom: 18px;
    padding: 12px 16px; border: 1px solid var(--gold); border-radius: 10px;
    background: var(--surface); display: inline-block;
  }

  /* Draw screen */
  #draw { max-width: 560px; }
  .draw-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .draw-bot {
    display: flex; gap: 10px; align-items: center; padding: 8px 12px; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  }
  .draw-bot .muted { color: var(--muted); font-size: 12px; }
  .draw-tools { display: flex; gap: 8px; }

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
  .slot.pick { cursor: pointer; }
  .slot.pick:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .projected .match { border-style: dashed; }
  .confirmbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--hairline); font-size: 13px;
  }

  /* Groups */
  .stage-note { color: var(--ink-2); font-size: 14px; margin-bottom: 16px; }
  #groups { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  .group {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; min-width: 280px;
  }
  .group-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
  .group-name { font-weight: 650; }
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
  td.place { color: var(--muted); width: 28px; }
  tr.qualifies td.botname { font-weight: 600; }
  .arrow { color: var(--accent); margin-right: 5px; }

  /* Group result editor */
  .editor .hint { color: var(--ink-2); font-size: 12.5px; margin-bottom: 8px; }
  .editor .picks { margin: 0 0 10px 20px; padding: 0; }
  .editor .picks li { padding: 2px 0; font-weight: 600; }
  .editor .pool { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .editor-actions { display: flex; gap: 8px; }

  /* Toast */
  #toast {
    position: fixed; left: 50%; bottom: 24px; z-index: 10;
    transform: translateX(-50%) translateY(8px);
    background: var(--danger); color: #fff; padding: 9px 16px; border-radius: 8px;
    font-size: 14px; max-width: 80vw; opacity: 0; pointer-events: none;
    transition: opacity .15s, transform .15s;
  }
  #toast.show { opacity: 1; transform: translateX(-50%); }
</style>
</head>
<body>
<div id="app">${renderApp()}</div>
<div id="toast"></div>
<script>
  var POLL_MS = ${POLL_MS};
  // Client-side interaction state. While an editor / confirm is open, polling
  // keeps running but stops replacing the DOM so it can't clobber the edit.
  var ui = { editing: null, confirming: false };
  var lastHtml = null;

  function busy() { return !!(ui.editing || ui.confirming); }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "show";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ""; }, 4000);
  }

  async function api(path, body) {
    try {
      var res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      });
      var data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) { toast(data.error || "Request failed (" + res.status + ")"); return false; }
      return true;
    } catch (e) {
      toast("Request failed: " + e.message);
      return false;
    }
  }

  function refresh() {
    ui.editing = null;
    ui.confirming = false;
    lastHtml = null;
    poll(true);
  }

  function drawConnectors() {
    var svg = document.getElementById("wires");
    var wrap = document.getElementById("bracket");
    if (!svg || !wrap) return;
    svg.replaceChildren();
    var wr = wrap.getBoundingClientRect();
    var sx = wrap.scrollLeft, sy = wrap.scrollTop;
    for (var card of wrap.querySelectorAll("[data-feeds]")) {
      var target = wrap.querySelector('[data-match="' + CSS.escape(card.dataset.feeds) + '"]');
      if (!target) continue;
      var a = card.getBoundingClientRect(), b = target.getBoundingClientRect();
      var x1 = a.right - wr.left + sx, y1 = a.top + a.height / 2 - wr.top + sy;
      var x2 = b.left - wr.left + sx, y2 = b.top + b.height / 2 - wr.top + sy;
      var mx = (x1 + x2) / 2;
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", "M" + x1 + "," + y1 + " H" + mx + " V" + y2 + " H" + x2);
      if (card.dataset.onpath && target.dataset.onpath) p.setAttribute("class", "onpath");
      svg.appendChild(p);
    }
  }

  async function poll(force) {
    if (busy() && !force) { drawConnectors(); return; }
    try {
      var res = await fetch("/fragment");
      if (!res.ok) return;
      var html = await res.text();
      if (busy() && !force) return; // an editor opened while we were fetching
      if (force || html !== lastHtml) {
        lastHtml = html;
        document.getElementById("app").innerHTML = html;
      }
      drawConnectors();
    } catch (e) {}
  }

  function groupCard() {
    return document.querySelector('[data-group="' + CSS.escape(ui.editing.group) + '"]');
  }

  function renderEditor() {
    var ed = ui.editing;
    var card = groupCard();
    if (!card) return;
    var html = '<div class="editor"><div class="hint">Click bots in finishing order, winner first (top 2 is enough).</div>';
    html += '<ol class="picks">';
    for (var i = 0; i < ed.order.length; i++) html += "<li>" + escHtml(ed.order[i]) + "</li>";
    html += "</ol>";
    html += '<div class="pool">';
    for (var j = 0; j < ed.bots.length; j++) {
      var b = ed.bots[j];
      if (ed.order.indexOf(b) === -1) {
        html += '<button class="btn" data-action="pick-bot" data-bot="' + escHtml(b) + '">' + escHtml(b) + "</button>";
      }
    }
    html += "</div>";
    html += '<div class="editor-actions">'
      + '<button class="btn primary" data-action="save-order"' + (ed.order.length < 2 ? " disabled" : "") + ">Save result</button>"
      + '<button class="btn" data-action="undo-pick"' + (ed.order.length ? "" : " disabled") + ">Undo</button>"
      + '<button class="btn" data-action="cancel-edit">Cancel</button>'
      + "</div></div>";
    card.querySelector(".group-body").innerHTML = html;
  }

  function startMatchConfirm(slot) {
    ui.confirming = true;
    document.querySelectorAll(".confirmbar").forEach(function (el) { el.remove(); });
    var bar = document.createElement("div");
    bar.className = "confirmbar";
    bar.innerHTML = "<span><strong>" + escHtml(slot.dataset.pick) + "</strong> wins?</span>"
      + '<button class="btn primary" data-action="confirm-match" data-id="' + escHtml(slot.dataset.matchId)
      + '" data-winner="' + escHtml(slot.dataset.pick) + '">Confirm</button>'
      + '<button class="btn" data-action="cancel-confirm">Cancel</button>';
    slot.closest(".match").appendChild(bar);
    drawConnectors();
  }

  document.getElementById("app").addEventListener("click", async function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) {
      var slot = e.target.closest(".slot.pick");
      if (slot) startMatchConfirm(slot);
      return;
    }
    var action = el.dataset.action;

    if (action === "draw") {
      var bots = Array.prototype.map.call(
        document.querySelectorAll('#draw input[type="checkbox"]:checked'),
        function (c) { return c.dataset.bot; }
      );
      if (bots.length < 2) return toast("Pick at least 2 bots.");
      if (await api("/api/draw", { bots: bots })) refresh();
    } else if (action === "check-all" || action === "uncheck-all") {
      document.querySelectorAll('#draw input[type="checkbox"]').forEach(function (c) {
        c.checked = action === "check-all";
      });
    } else if (action === "reset") {
      ui.confirming = true;
      el.outerHTML = '<span class="reset-confirm">Wipe all tournament state?'
        + ' <button class="btn danger" data-action="reset-yes">Yes, reset</button>'
        + ' <button class="btn" data-action="reset-no">Cancel</button></span>';
    } else if (action === "reset-yes") {
      if (await api("/api/reset")) refresh();
    } else if (action === "reset-no") {
      refresh();
    } else if (action === "seed") {
      if (await api("/api/knockout")) refresh();
    } else if (action === "edit-group") {
      var card = el.closest("[data-group]");
      ui.editing = { group: card.dataset.group, bots: JSON.parse(card.dataset.bots), order: [] };
      renderEditor();
    } else if (action === "pick-bot") {
      ui.editing.order.push(el.dataset.bot);
      renderEditor();
    } else if (action === "undo-pick") {
      ui.editing.order.pop();
      renderEditor();
    } else if (action === "cancel-edit") {
      refresh();
    } else if (action === "save-order") {
      if (await api("/api/report-group", { group: ui.editing.group, order: ui.editing.order })) refresh();
    } else if (action === "confirm-match") {
      if (await api("/api/report-match", { id: el.dataset.id, winner: el.dataset.winner })) refresh();
    } else if (action === "cancel-confirm") {
      refresh();
    }
  });

  setInterval(poll, POLL_MS);
  window.addEventListener("resize", drawConnectors);
  poll(true);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new TournamentError("Request too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        reject(new TournamentError("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(pathname, req, res) {
  try {
    const body = await readBody(req);
    const requireState = () => {
      const state = loadState(STATE_FILE);
      if (!state) throw new TournamentError("No tournament yet — draw one first.");
      return state;
    };

    switch (pathname) {
      case "/api/draw": {
        if (!Array.isArray(body.bots)) throw new TournamentError("Expected a list of bot names.");
        const bots = body.bots.map(String);
        const excluded = scanBots().filter((b) => !bots.includes(b));
        draw(bots, { excluded, file: STATE_FILE });
        return sendJson(res, 200, { ok: true });
      }
      case "/api/report-group": {
        reportGroupResult(requireState(), String(body.group ?? ""), body.order, { file: STATE_FILE });
        return sendJson(res, 200, { ok: true });
      }
      case "/api/report-match": {
        reportMatchResult(requireState(), String(body.id ?? ""), String(body.winner ?? ""), { file: STATE_FILE });
        return sendJson(res, 200, { ok: true });
      }
      case "/api/knockout": {
        seedKnockout(requireState(), { file: STATE_FILE });
        return sendJson(res, 200, { ok: true });
      }
      case "/api/reset": {
        resetState(STATE_FILE);
        return sendJson(res, 200, { ok: true });
      }
      default:
        return sendJson(res, 404, { error: "not found" });
    }
  } catch (e) {
    return sendJson(res, e instanceof TournamentError ? 400 : 500, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    handleApi(url.pathname, req, res);
  } else if (url.pathname === "/fragment") {
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
  console.log(`Bracket viewer + control panel: ${url}`);
  console.log(`Watching ${STATE_FILE}`);
  if (OPEN) {
    const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", shell: platform() === "win32" }).on("error", () => {});
  }
});
