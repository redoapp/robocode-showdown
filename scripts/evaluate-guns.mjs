#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const rounds = Number(value("--rounds", "50"));
const league = value("--league", "sanity");
const output = resolve(value(
  "--output",
  join(ROOT, "bots", "alee-bot", "training", "evaluations", `gun-ablation-${Date.now()}.json`),
));
const defaultGuns = ["ensemble", "head-on", "linear", "circular", "guess-factor-histogram", "knn"];
const guns = value("--guns", defaultGuns.join(",")).split(",").map((gun) => gun.trim()).filter(Boolean);
if (!guns.includes("ensemble") || guns.some((gun) => !defaultGuns.includes(gun))) {
  throw new Error(`--guns must include ensemble and use: ${defaultGuns.join(", ")}`);
}
mkdirSync(dirname(output), { recursive: true });

function evaluate(gun) {
  return new Promise((resolvePromise, reject) => {
    const reportPath = `${output}.${gun}.tmp.json`;
    const child = spawn(process.execPath, [
      join(ROOT, "scripts", "evaluate-bot.mjs"),
      "--league", league,
      "--rounds", String(rounds),
      "--parallelism", "1",
      "--gun", gun,
      "--force",
      "--output", reportPath,
    ], { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`${gun} evaluator exited ${code}`));
      resolvePromise(JSON.parse(readFileSync(reportPath, "utf8")));
    });
  });
}

const reports = [];
for (const gun of guns) reports.push(await evaluate(gun));
const ranking = reports.map((report) => ({
  gun: report.gun,
  candidateScore: report.aggregate.candidateScore,
  scoreRatio: report.aggregate.scoreRatio,
  meanMargin: report.aggregate.marginInterval.mean,
  lowerMargin: report.aggregate.marginInterval.lower,
})).sort((left, right) => right.candidateScore - left.candidateScore);
const ensemble = ranking.find((entry) => entry.gun === "ensemble");
const bestConstituent = ranking.find((entry) => entry.gun !== "ensemble");
const result = {
  reportVersion: 1,
  league,
  roundsPerMatchup: rounds,
  ranking,
  ensembleBeatsEveryConstituent: ensemble.candidateScore > bestConstituent.candidateScore,
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, ...result }, null, 2));
