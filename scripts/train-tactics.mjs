#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TACTICAL_POLICY,
  comparePolicyReports,
  generatePopulation,
} from "./lib/tactical-search.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOT_DIRECTORY = join(ROOT, "bots", "alee-bot");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const integer = (name, fallback, minimum, maximum) => {
  const parsed = Number(value(name, String(fallback)));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
};

const leagueName = value("--league", "nemesis");
const populationSize = integer("--population", 6, 1, 64);
const generations = integer("--generations", 2, 1, 10);
const eliteCount = integer("--elites", 2, 1, populationSize);
const finalistCount = integer("--finalists", 2, 1, populationSize * generations);
const screeningRounds = integer("--rounds", 40, 5, 10_000);
const confirmationRounds = integer("--confirmation-rounds", 200, 10, 10_000);
const seed = integer("--seed", 20260709, 0, 0xffffffff);
const leagues = JSON.parse(readFileSync(join(BOT_DIRECTORY, "config", "leagues.json"), "utf8"));
const league = leagues.leagues[leagueName];
if (!league) throw new Error(`unknown tactical league ${leagueName}`);
if (!Array.isArray(league.matchups) || league.matchups.length === 0) throw new Error("tactical league is empty");

const runId = value("--run-id", `tactics-${leagueName}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error("--run-id contains unsafe characters");
const runDirectory = resolve(value("--output-dir", join(BOT_DIRECTORY, "training", "tactics", "runs", runId)));
const candidateDirectory = join(runDirectory, "candidate-policies");
const rawDirectory = join(runDirectory, "raw");
mkdirSync(candidateDirectory, { recursive: true });
mkdirSync(rawDirectory, { recursive: true });

const baselinePolicyPath = join(runDirectory, "baseline-policy.json");
writeFileSync(baselinePolicyPath, `${JSON.stringify(DEFAULT_TACTICAL_POLICY, null, 2)}\n`);

function runBattle(policyPath, opponents, rounds, label, matchupIndex) {
  return new Promise((resolvePromise, reject) => {
    const reportPath = join(rawDirectory, `${label}-matchup-${String(matchupIndex + 1).padStart(2, "0")}.json`);
    const command = [
      join(ROOT, "scripts", "battle.mjs"),
      "alee-bot",
      ...opponents,
      "--rounds", String(rounds),
      "--mode", "evaluation",
      "--tactical-policy", policyPath,
      "--json", reportPath,
    ];
    const child = spawn(process.execPath, command, { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`${label} matchup ${matchupIndex + 1} exited ${code}`));
      resolvePromise(JSON.parse(readFileSync(reportPath, "utf8")));
    });
  });
}

async function runLeague(policyPath, rounds, label) {
  const reports = [];
  for (let index = 0; index < league.matchups.length; index += 1) {
    reports.push(await runBattle(policyPath, league.matchups[index], rounds, label, index));
  }
  return reports;
}

console.log(`Tactical search ${runId}: ${generations} generations x ${populationSize} policies against ${leagueName}`);
console.log(`Screening baseline: ${screeningRounds} rounds x ${league.matchups.length} matchups`);
const screeningBaseline = await runLeague(baselinePolicyPath, screeningRounds, "screen-baseline");
const trials = [];
let parents = [DEFAULT_TACTICAL_POLICY];
for (let generation = 0; generation < generations; generation += 1) {
  const policies = generatePopulation(parents, populationSize, { seed, generation });
  const generationTrials = [];
  for (const policy of policies) {
    const policyPath = join(candidateDirectory, `${policy.policyId}.json`);
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    console.log(`Screening ${policy.policyId}`);
    const reports = await runLeague(policyPath, screeningRounds, `screen-${policy.policyId}`);
    const comparison = comparePolicyReports(reports, screeningBaseline, {
      protectedOpponents: league.protectedOpponents ?? [],
      seed,
    });
    const trial = { policy, policyPath, comparison };
    generationTrials.push(trial);
    trials.push(trial);
    console.log(`${policy.policyId}: mean delta ${comparison.aggregate.meanDifference.toFixed(2)}, 95% CI [${comparison.aggregate.lower.toFixed(2)}, ${comparison.aggregate.upper.toFixed(2)}]`);
  }
  generationTrials.sort((left, right) => right.comparison.aggregate.meanDifference - left.comparison.aggregate.meanDifference);
  parents = generationTrials.slice(0, eliteCount).map((trial) => trial.policy);
}

trials.sort((left, right) => right.comparison.aggregate.meanDifference - left.comparison.aggregate.meanDifference);
const finalists = trials.slice(0, Math.min(finalistCount, trials.length));
console.log(`Fresh confirmation baseline: ${confirmationRounds} rounds x ${league.matchups.length} matchups`);
const confirmationBaseline = await runLeague(baselinePolicyPath, confirmationRounds, "confirm-baseline");
const confirmations = [];
for (const finalist of finalists) {
  console.log(`Confirming ${finalist.policy.policyId}`);
  const reports = await runLeague(finalist.policyPath, confirmationRounds, `confirm-${finalist.policy.policyId}`);
  const comparison = comparePolicyReports(reports, confirmationBaseline, {
    protectedOpponents: league.protectedOpponents ?? [],
    seed: seed + 1,
  });
  confirmations.push({ policy: finalist.policy, screening: finalist.comparison, confirmation: comparison });
}
confirmations.sort((left, right) => right.confirmation.aggregate.meanDifference - left.confirmation.aggregate.meanDifference);
const winner = confirmations.find((entry) => entry.confirmation.retain) ?? null;
let retainedPolicyPath = null;
if (winner) {
  const retainedDirectory = join(runDirectory, "retained");
  mkdirSync(retainedDirectory, { recursive: true });
  retainedPolicyPath = join(retainedDirectory, "tactical-policy.json");
  writeFileSync(retainedPolicyPath, `${JSON.stringify(winner.policy, null, 2)}\n`);
}

const report = {
  reportVersion: 1,
  runId,
  seed,
  league: leagueName,
  protectedOpponents: league.protectedOpponents ?? [],
  bounds: {
    populationSize,
    generations,
    eliteCount,
    finalistCount,
    screeningRounds,
    confirmationRounds,
  },
  baselinePolicy: DEFAULT_TACTICAL_POLICY,
  trials: trials.map(({ policy, comparison }) => ({ policy, comparison })),
  confirmations,
  retainedPolicyId: winner?.policy.policyId ?? null,
  retainedPolicyPath,
};
writeFileSync(join(runDirectory, "search-report.json"), `${JSON.stringify(report, null, 2)}\n`);
// Rejected policy files are deliberately not retained. Their exact parameters
// and official battle comparisons remain embedded in search-report.json.
rmSync(candidateDirectory, { recursive: true, force: true });
console.log(JSON.stringify({
  runDirectory,
  retainedPolicyId: report.retainedPolicyId,
  retainedPolicyPath,
  confirmation: winner?.confirmation.aggregate ?? null,
}, null, 2));
