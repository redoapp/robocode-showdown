#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeBattle,
  bootstrapMeanInterval,
  candidateRoundMargins,
  candidateRoundScoreRatios,
  compareBattleReports,
} from "./lib/evaluation.mjs";
import {
  assertArtifactSnapshotUnchanged,
  inspectCandidateArtifacts,
  snapshotArtifactFiles,
} from "./lib/artifacts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOT_DIR = join(ROOT, "bots", "alee-bot");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const candidateArg = value("--candidate", "fallback");
const leagueName = value("--league", "sanity");
const roundsOverride = value("--rounds", null);
const parallelismOverride = value("--parallelism", null);
const outputPath = value("--output", null);
const incumbentArg = value("--incumbent", "champion");
const gun = value("--gun", "ensemble");
const force = args.includes("--force");
const validGuns = new Set(["ensemble", "head-on", "linear", "circular", "guess-factor-histogram", "knn", "mlp-v2"]);
if (!validGuns.has(gun)) throw new Error(`Unknown gun ${gun}`);
const leagues = JSON.parse(readFileSync(join(BOT_DIR, "config", "leagues.json"), "utf8"));
const league = leagues.leagues[leagueName];
if (!league) throw new Error(`Unknown league ${leagueName}`);
const rounds = roundsOverride === null ? league.rounds : Number(roundsOverride);
const parallelism = parallelismOverride === null ? (league.parallelism ?? 1) : Number(parallelismOverride);
if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error("rounds must be a positive integer");
if (!Number.isSafeInteger(parallelism) || parallelism <= 0) throw new Error("parallelism must be a positive integer");

let candidateDirectory = null;
let candidateManifest = null;
let offlineReport = null;
let candidateSnapshot = null;
if (candidateArg !== "fallback") {
  candidateDirectory = candidateArg.includes("/")
    ? resolve(candidateArg)
    : join(BOT_DIR, "training", "candidates", candidateArg);
  candidateSnapshot = inspectCandidateArtifacts(candidateDirectory);
  candidateManifest = candidateSnapshot.manifest;
  offlineReport = candidateSnapshot.offlineReport;
  if (!offlineReport.eligibleForBattleEvaluation && !force) {
    throw new Error("Candidate failed offline eligibility; pass --force only for diagnostic evaluation");
  }
}

const evaluationId = `${leagueName}-${gun}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDirectory = candidateDirectory
  ? join(candidateDirectory, "evaluations", evaluationId)
  : join(BOT_DIR, "training", "evaluations", "fallback", evaluationId);
const rawDirectory = join(outputDirectory, "raw");
mkdirSync(rawDirectory, { recursive: true });

const configuredChampionDirectory = join(BOT_DIR, "champion");
let incumbentDirectory = null;
let incumbentId = "fallback";
let incumbentSnapshot = null;
let incumbentSource = "fallback";
if (incumbentArg !== "fallback") {
  const requestedDirectory = incumbentArg === "champion" ? configuredChampionDirectory : resolve(incumbentArg);
  if (existsSync(join(requestedDirectory, "manifest.json")) && existsSync(join(requestedDirectory, "model.json"))) {
    incumbentDirectory = requestedDirectory;
    incumbentSource = incumbentArg === "champion" ? "champion" : "custom";
    const incumbentManifest = JSON.parse(readFileSync(join(requestedDirectory, "manifest.json"), "utf8"));
    incumbentId = incumbentManifest.candidateId ?? incumbentManifest.championId ?? "champion";
    incumbentSnapshot = snapshotArtifactFiles(requestedDirectory, ["manifest.json", "model.json"]);
  } else if (incumbentArg !== "champion") {
    throw new Error(`incumbent directory has no manifest/model: ${requestedDirectory}`);
  }
}
// Passing an explicitly empty artifact directory prevents a locally installed
// champion from silently changing what "fallback" means.
const explicitFallbackDirectory = join(outputDirectory, "fallback-artifact");
mkdirSync(explicitFallbackDirectory, { recursive: true });

function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    // Match the Robocode server's wildcard/IPv6 bind semantics. Probing only
    // 127.0.0.1 can incorrectly select a port already held on ::1.
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

const workerPorts = { candidate: [], incumbent: [] };
const usedPorts = new Set();
for (const subject of ["candidate", "incumbent"]) {
  for (let index = 0; index < league.matchups.length; index += 1) {
    let port;
    do port = await findFreePort(); while (usedPorts.has(port));
    usedPorts.add(port);
    workerPorts[subject].push(port);
  }
}

function runBattle(matchup, index, subject, artifactDirectory) {
  return new Promise((resolvePromise, reject) => {
    const jsonPath = join(rawDirectory, `${subject}-matchup-${String(index + 1).padStart(2, "0")}.json`);
    const command = [
      join(ROOT, "scripts", "battle.mjs"),
      "alee-bot",
      ...matchup,
      "--rounds", String(rounds),
      "--mode", "evaluation",
      "--json", jsonPath,
    ];
    command.push("--candidate-dir", artifactDirectory ?? explicitFallbackDirectory);
    const env = {
      ...process.env,
      // Ports are selected serially and de-duplicated before workers launch.
      ROBOCODE_PORT: String(workerPorts[subject][index]),
    };
    if (gun !== "ensemble") env.ALEE_FORCE_GUN = gun;
    else delete env.ALEE_FORCE_GUN;
    const child = spawn(process.execPath, command, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${subject} battle ${index + 1} exited ${code}\n${stderr}\n${stdout}`));
        return;
      }
      if (!existsSync(jsonPath)) {
        reject(new Error(`battle ${index + 1} did not create ${jsonPath}`));
        return;
      }
      resolvePromise(JSON.parse(readFileSync(jsonPath, "utf8")));
    });
  });
}

async function runPool(items, parallelism, subject, artifactDirectory) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await runBattle(items[index], index, subject, artifactDirectory);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelism, items.length) }, worker));
  return results;
}

const reports = await runPool(league.matchups, parallelism, "candidate", candidateDirectory);
const incumbentReports = await runPool(league.matchups, parallelism, "incumbent", incumbentDirectory);
if (candidateSnapshot) {
  assertArtifactSnapshotUnchanged(candidateSnapshot, inspectCandidateArtifacts(candidateDirectory));
}
if (incumbentSnapshot) {
  assertArtifactSnapshotUnchanged(incumbentSnapshot, snapshotArtifactFiles(incumbentDirectory, ["manifest.json", "model.json"]));
}
const matchupSummaries = reports.map((report) => summarizeBattle(report));
const incumbentMatchupSummaries = incumbentReports.map((report) => summarizeBattle(report));
const incumbentComparisons = reports.map((report, index) => compareBattleReports(report, incumbentReports[index]));
const allMargins = reports.flatMap((report) => candidateRoundMargins(report));
const marginInterval = bootstrapMeanInterval(allMargins);
const allScoreRatioImprovements = reports.flatMap((report, index) => {
  const candidateRatios = candidateRoundScoreRatios(report);
  const incumbentRatios = candidateRoundScoreRatios(incumbentReports[index]);
  return candidateRatios.map((ratio, roundIndex) => ratio - incumbentRatios[roundIndex]);
});
const incumbentImprovementInterval = bootstrapMeanInterval(allScoreRatioImprovements);
const totalCandidateScore = reports.reduce((sum, report) => sum + report.results.find((result) => result.name === "alee-bot").totalScore, 0);
const totalOpponentScore = reports.reduce((sum, report) => sum + report.results.filter((result) => result.name !== "alee-bot").reduce((subtotal, result) => subtotal + result.totalScore, 0), 0);
const processFailures = reports.flatMap((report) => report.processFailures);
const incumbentProcessFailures = incumbentReports.flatMap((report) => report.processFailures);
// A pooled positive margin must not hide a regression against a protected
// opponent: every protected 1v1 must independently clear its interval.
const protectedOpponents = league.protectedOpponents ?? [];
const protectedRegressionTolerance = league.protectedRegressionTolerance ?? 0;
if (!Number.isFinite(protectedRegressionTolerance) || protectedRegressionTolerance < 0) {
  throw new Error("protectedRegressionTolerance must be a non-negative number");
}
const protectedResults = protectedOpponents.map((opponent) => {
  const matchupIndex = matchupSummaries.findIndex((summary) =>
    summary.participants.length === 2 && summary.participants.includes(opponent));
  if (matchupIndex < 0) return { opponent, present: false, passed: false, reason: "missing protected 1v1 matchup" };
  const candidate = matchupSummaries[matchupIndex];
  const comparison = incumbentComparisons[matchupIndex];
  const beatsOpponent = candidate.marginInterval.lower > 0;
  const avoidsRegression = comparison.scoreRatioImprovementInterval.lower >= -protectedRegressionTolerance;
  return {
    opponent,
    present: true,
    candidateMarginInterval: candidate.marginInterval,
    scoreRatioImprovementInterval: comparison.scoreRatioImprovementInterval,
    tolerance: protectedRegressionTolerance,
    beatsOpponent,
    avoidsRegression,
    passed: beatsOpponent && avoidsRegression,
  };
});
const protectedRegressions = protectedResults.filter((result) => !result.passed);
const officialLeagueRun = leagueName === "promotion" && rounds >= league.rounds && gun === "ensemble" && !force;
const promotionGates = {
  officialLeagueRun,
  offlineEligible: offlineReport?.eligibleForBattleEvaluation === true,
  provenanceEligible: candidateSnapshot?.provenanceEligible === true,
  candidateProcessesHealthy: processFailures.length === 0,
  incumbentProcessesHealthy: incumbentProcessFailures.length === 0,
  beatsLeague: marginInterval.lower > 0,
  improvesOnIncumbent: incumbentImprovementInterval.lower > 0,
  protectedOpponentsPass: protectedRegressions.length === 0,
};
const eligibleForPromotion = candidateArg !== "fallback" && Object.values(promotionGates).every(Boolean);
const evaluationReport = {
  reportVersion: 2,
  evaluationId,
  candidateId: candidateManifest?.candidateId ?? "fallback",
  gun,
  league: leagueName,
  roundsPerMatchup: rounds,
  matchups: matchupSummaries,
  incumbent: {
    candidateId: incumbentId,
    source: incumbentSource,
    artifact: incumbentSnapshot,
    matchups: incumbentMatchupSummaries,
  },
  incumbentComparisons,
  aggregate: {
    candidateScore: totalCandidateScore,
    opponentScore: totalOpponentScore,
    scoreRatio: totalCandidateScore / Math.max(1, totalOpponentScore),
    marginInterval,
    processFailures,
    incumbentProcessFailures,
    scoreRatioImprovementOverIncumbent: incumbentImprovementInterval,
    primaryProtectedOpponent: protectedOpponents[0] ?? null,
    protectedOpponents,
    protectedRegressionTolerance,
    protectedResults,
    protectedRegressions,
  },
  offlineEligible: offlineReport?.eligibleForBattleEvaluation ?? false,
  candidateArtifact: candidateSnapshot ? {
    fingerprint: candidateSnapshot.fingerprint,
    hashes: candidateSnapshot.artifacts,
    provenanceEligible: candidateSnapshot.provenanceEligible,
    provenanceIssues: candidateSnapshot.provenanceIssues,
  } : null,
  forcedDiagnostic: force,
  promotionGates,
  eligibleForPromotion,
};
writeFileSync(join(outputDirectory, "evaluation-report.json"), `${JSON.stringify(evaluationReport, null, 2)}\n`);
if (candidateDirectory) writeFileSync(join(candidateDirectory, "evaluation-report.json"), `${JSON.stringify(evaluationReport, null, 2)}\n`);
if (outputPath) {
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(evaluationReport, null, 2)}\n`);
}
console.log(JSON.stringify({ outputDirectory, ...evaluationReport }, null, 2));
