#!/usr/bin/env node
// Offline eligibility report for a PyTorch-trained "mlp-json-v1" candidate.
//
// Evaluates the candidate through scripts/lib/mlp-inference.mjs — the same
// forward-pass code the bot ships — after first proving that code reproduces
// the trainer's golden logits. Gates on simulated hit rate against the
// majority and segmented-histogram baselines, using the common report format
// consumed by evaluate-bot.mjs and promote-bot.mjs.
//
// Usage: node scripts/offline-report-candidate.mjs --candidate <id-or-path> [--runs-dir <path>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argmax, forward, validateModel } from "./lib/mlp-inference.mjs";
import {
  majorityBin,
  predictKnn,
  predictSegmentedHistogram,
  scorePredictions,
  trainSegmentedHistogram,
} from "./lib/gf-baselines.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOT_DIR = join(ROOT, "bots", "alee-bot");
const BINS = 31;
const FEATURE_COUNT = 18;
const PARITY_TOLERANCE = 1e-4;

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const candidateArg = value("--candidate", null);
if (!candidateArg) throw new Error("Usage: node scripts/offline-report-candidate.mjs --candidate <id-or-path>");
const candidateDirectory = candidateArg.includes("/")
  ? resolve(candidateArg)
  : join(BOT_DIR, "training", "candidates", candidateArg);
const runsDirectory = resolve(value("--runs-dir", join(BOT_DIR, "training", "runs")));

const manifest = JSON.parse(readFileSync(join(candidateDirectory, "manifest.json"), "utf8"));
const model = validateModel(
  JSON.parse(readFileSync(join(candidateDirectory, "model.json"), "utf8")),
  { featureCount: FEATURE_COUNT, bins: BINS },
);

// 1. Golden parity: the JS forward pass must reproduce the trainer's logits.
const golden = JSON.parse(readFileSync(join(candidateDirectory, "golden.json"), "utf8"));
let maxDifference = 0;
for (const sample of golden) {
  const logits = forward(model, Float64Array.from(sample.features));
  for (let index = 0; index < BINS; index += 1) {
    maxDifference = Math.max(maxDifference, Math.abs(logits[index] - sample.logits[index]));
  }
}
if (maxDifference > PARITY_TOLERANCE) {
  throw new Error(`golden parity failed: max logit difference ${maxDifference} exceeds ${PARITY_TOLERANCE}`);
}
console.log(`golden parity ok over ${golden.length} vectors (max logit difference ${maxDifference.toExponential(2)})`);

// 2. Rebuild the trainer's split and evaluate through the deployed code path.
function loadRun(directory) {
  const records = [];
  for (const filename of readdirSync(directory).filter((entry) => /^wave-outcomes-.*\.jsonl$/.test(entry)).sort()) {
    for (const line of readFileSync(join(directory, filename), "utf8").split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.recordType === "wave-outcome" && record.schemaVersion === 2) records.push(record);
    }
  }
  return records;
}
const trainingRecords = manifest.trainingRuns.flatMap((name) => loadRun(join(runsDirectory, name)));
const validationRecords = manifest.validationRuns.flatMap((name) => loadRun(join(runsDirectory, name)));
if (trainingRecords.length === 0 || validationRecords.length === 0) {
  throw new Error("could not reload the candidate's training/validation runs");
}

function evaluateRecords(records) {
  const predictions = records.map((record) => argmax(forward(model, Float64Array.from(record.features))));
  const banded = scorePredictions(predictions, records, BINS);
  let logLoss = 0;
  for (const record of records) {
    const logits = forward(model, Float64Array.from(record.features));
    let max = -Infinity;
    for (const logit of logits) max = Math.max(max, logit);
    let denominator = 0;
    for (const logit of logits) denominator += Math.exp(logit - max);
    logLoss -= Math.log(Math.max(Math.exp(logits[record.label] - max) / denominator, 1e-12));
  }
  return {
    examples: records.length,
    top1Accuracy: banded.top1,
    within1BinAccuracy: banded.within1,
    simulatedHitRate: banded.simulatedHitRate,
    logLoss: logLoss / records.length,
  };
}

const trainingMetrics = evaluateRecords(trainingRecords);
const validationMetrics = evaluateRecords(validationRecords);
const majority = majorityBin(trainingRecords, BINS);
const segmentedModel = trainSegmentedHistogram(trainingRecords, BINS);
const baselineMetrics = {
  majority: scorePredictions(validationRecords.map(() => majority), validationRecords, BINS),
  segmentedHistogram: scorePredictions(predictSegmentedHistogram(segmentedModel, validationRecords), validationRecords, BINS),
  knn: scorePredictions(predictKnn(trainingRecords, validationRecords, BINS), validationRecords, BINS),
};

const eligibleForBattleEvaluation = validationMetrics.simulatedHitRate > baselineMetrics.majority.simulatedHitRate
  && validationMetrics.simulatedHitRate > baselineMetrics.segmentedHistogram.simulatedHitRate
  && validationMetrics.logLoss < Math.log(BINS);

const report = {
  reportVersion: 2,
  candidateId: manifest.candidateId,
  trainer: "pytorch",
  goldenParity: { vectors: golden.length, maxLogitDifference: maxDifference, tolerance: PARITY_TOLERANCE },
  trainingRuns: manifest.trainingRuns,
  validationRuns: manifest.validationRuns,
  baselineMetrics,
  trainingMetrics,
  validationMetrics,
  eligibleForBattleEvaluation,
};
writeFileSync(join(candidateDirectory, "offline-report.json"), `${JSON.stringify(report, null, 2)}\n`);
manifest.eligibleForBattleEvaluation = eligibleForBattleEvaluation;
writeFileSync(join(candidateDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
