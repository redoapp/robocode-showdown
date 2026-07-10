#!/usr/bin/env node
// Preflight for schema-v2 wave-outcome training data (spec section 7.1).
//
// Answers, before any training run: is there learnable signal in this
// dataset at all? It validates every run, reports class/opponent/real-virtual
// balance, and evaluates cheap reference predictors (majority, segmented
// histogram, kNN) on leave-one-run-out splits. If none of them beat the
// majority baseline on simulated hit rate, an MLP trained on the same data
// will not either — collect better data instead of tuning the model.
//
// Usage: node scripts/preflight-training-data.mjs [--runs-dir <path>] [--json <out.json>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  majorityBin,
  predictKnn,
  predictSegmentedHistogram,
  scorePredictions,
  trainSegmentedHistogram,
} from "./lib/gf-baselines.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const RUNS_DIRECTORY = resolve(value("--runs-dir", join(ROOT, "bots", "alee-bot", "training", "runs")));
const JSON_OUTPUT = value("--json", null);

const BINS = 31;
const FEATURE_COUNT = 18;

function loadRuns(runsDirectory) {
  if (!existsSync(runsDirectory)) throw new Error(`No runs directory at ${runsDirectory}`);
  const runs = [];
  for (const name of readdirSync(runsDirectory).sort()) {
    const directory = join(runsDirectory, name);
    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 2) continue;
    const records = [];
    for (const filename of readdirSync(directory).filter((entry) => /^wave-outcomes-.*\.jsonl$/.test(entry)).sort()) {
      for (const line of readFileSync(join(directory, filename), "utf8").split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.recordType !== "wave-outcome" || record.schemaVersion !== 2) continue;
        if (!Array.isArray(record.features) || record.features.length !== FEATURE_COUNT) continue;
        records.push(record);
      }
    }
    if (records.length > 0) runs.push({ name, opponents: manifest.opponents ?? [], records });
  }
  return runs;
}

function majorityShare(records) {
  const majority = majorityBin(records, BINS);
  return records.filter((record) => record.label === majority).length / records.length;
}

function formatPercent(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

const runs = loadRuns(RUNS_DIRECTORY);
if (runs.length === 0) throw new Error(`No schema-v2 runs with records under ${RUNS_DIRECTORY}`);

const warnings = [];
console.log(`Preflight over ${runs.length} run(s) at ${RUNS_DIRECTORY}\n`);
console.log("=== Runs ===");
const runSummaries = runs.map((run) => {
  const real = run.records.filter((record) => record.waveKind === "real").length;
  const majority = majorityBin(run.records, BINS);
  const share = majorityShare(run.records);
  console.log(`  ${run.name.padEnd(26)} n=${String(run.records.length).padStart(6)} real=${String(real).padStart(5)} opponents=[${run.opponents.join(",") || "?"}] majority=bin${majority} (${formatPercent(share)})`);
  if (run.opponents.length === 0) warnings.push(`${run.name}: manifest has no opponents list; opponent-held-out splits cannot see it`);
  return { name: run.name, opponents: run.opponents, records: run.records.length, realWaves: real, majorityBin: majority, majorityShare: share };
});

const allRecords = runs.flatMap((run) => run.records);
const realShare = allRecords.filter((record) => record.waveKind === "real").length / allRecords.length;
if (realShare < 0.05) {
  warnings.push(`only ${formatPercent(realShare)} of waves are real; opponents that react to actual fire are effectively unrepresented`);
}
const shares = runSummaries.map((summary) => summary.majorityShare);
if (Math.max(...shares) - Math.min(...shares) > 0.06) {
  warnings.push("majority-class share differs by >6pp across runs; the collecting bot's behavior likely changed between runs — mixing them trains on inconsistent distributions");
}
if (new Set(runs.flatMap((run) => run.opponents)).size < 2) {
  warnings.push("dataset covers fewer than two known opponents; a general model cannot be validated");
}

console.log("\n=== Leave-one-run-out baselines (simulated hit rate is the metric that matters) ===");
const folds = [];
for (const heldOut of runs) {
  const training = runs.filter((run) => run !== heldOut).flatMap((run) => run.records);
  if (training.length === 0) continue;
  const validation = heldOut.records;
  const majority = majorityBin(training, BINS);
  const results = {
    majority: scorePredictions(validation.map(() => majority), validation, BINS),
    segmented: scorePredictions(predictSegmentedHistogram(trainSegmentedHistogram(training, BINS), validation), validation, BINS),
    knn: scorePredictions(predictKnn(training, validation, BINS), validation, BINS),
  };
  folds.push({ heldOut: heldOut.name, trainingRecords: training.length, validationRecords: validation.length, results });
  console.log(`\n  held out: ${heldOut.name} (train n=${training.length}, val n=${validation.length})`);
  for (const [label, metrics] of Object.entries(results)) {
    console.log(`    ${label.padEnd(10)} top1=${formatPercent(metrics.top1)}  ±1bin=${formatPercent(metrics.within1)}  simHit=${formatPercent(metrics.simulatedHitRate)}`);
  }
}

const beatingFolds = folds.filter((fold) => fold.results.knn.simulatedHitRate > fold.results.majority.simulatedHitRate
  || fold.results.segmented.simulatedHitRate > fold.results.majority.simulatedHitRate);
console.log(`\n=== Verdict ===`);
console.log(`  ${beatingFolds.length}/${folds.length} held-out folds show a reference predictor beating majority on simulated hit rate.`);
if (beatingFolds.length === 0) {
  console.log("  No learnable signal detected — fix data collection before training any model.");
} else if (beatingFolds.length < folds.length) {
  console.log("  Signal exists but does not transfer to every run — check the warnings for distribution shift.");
} else {
  console.log("  Signal present in every fold; a trained model has something to learn.");
}
for (const warning of warnings) console.log(`  WARNING: ${warning}`);

if (JSON_OUTPUT) {
  const verdict = { runs: runSummaries, realWaveShare: realShare, folds, foldsWithSignal: beatingFolds.length, totalFolds: folds.length, warnings };
  writeFileSync(resolve(JSON_OUTPUT), `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`\nWrote ${resolve(JSON_OUTPUT)}`);
}
