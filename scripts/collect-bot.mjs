#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOT_DIR = join(ROOT, "bots", "alee-bot");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const leagueName = value("--league", "training");
const roundsOverride = value("--rounds", null);
const startIndex = Number(value("--start-index", "1"));
const prefix = value("--run-prefix", `corpus-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const config = JSON.parse(readFileSync(join(BOT_DIR, "config", "leagues.json"), "utf8"));
const league = config.leagues[leagueName];
if (!league) throw new Error(`Unknown league ${leagueName}`);
const rounds = roundsOverride === null ? league.rounds : Number(roundsOverride);
if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error("rounds must be a positive integer");
if (!Number.isSafeInteger(startIndex) || startIndex <= 0 || startIndex > league.matchups.length) {
  throw new Error("start index must identify a league matchup (1-based)");
}

function collect(matchup, index) {
  return new Promise((resolvePromise, reject) => {
    const runId = `${prefix}-${String(index + 1).padStart(2, "0")}-${matchup.join("-")}`;
    const child = spawn(process.execPath, [
      join(ROOT, "scripts", "battle.mjs"),
      "alee-bot",
      ...matchup,
      "--rounds", String(rounds),
      "--mode", "collection",
      "--run-id", runId,
    ], { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(runId) : reject(new Error(`${runId} exited ${code}`)));
  });
}

const runIds = [];
for (let index = startIndex - 1; index < league.matchups.length; index += 1) {
  runIds.push(await collect(league.matchups[index], index));
}
console.log(JSON.stringify({ league: leagueName, roundsPerMatchup: rounds, runIds }, null, 2));
