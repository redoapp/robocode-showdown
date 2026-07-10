import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balancedResample,
  majorityBin,
  predictKnn,
  predictSegmentedHistogram,
  scorePredictions,
  toleranceBins,
  trainSegmentedHistogram,
} from "../lib/gf-baselines.mjs";

const BINS = 31;

function record(label, features, { waveKind = "virtual", bulletSpeed = 14 } = {}) {
  return { label, features, waveKind, bulletSpeed };
}

function featuresAt(range, lateral = 0) {
  const features = new Array(18).fill(0);
  features[0] = range;
  features[2] = lateral;
  features[10] = 0.5;
  return features;
}

test("majorityBin returns the most frequent label", () => {
  const records = [record(3, featuresAt(0.2)), record(3, featuresAt(0.2)), record(7, featuresAt(0.2))];
  assert.equal(majorityBin(records, BINS), 3);
});

test("toleranceBins widens at close range and never drops below one bin", () => {
  const close = toleranceBins(record(15, featuresAt(0.08)), BINS);
  const far = toleranceBins(record(15, featuresAt(0.9)), BINS);
  assert.ok(close > far, `expected close-range tolerance ${close} > far-range ${far}`);
  assert.ok(far >= 1);
});

test("scorePredictions separates exact, near, and simulated-hit accuracy", () => {
  const records = [record(10, featuresAt(0.9)), record(10, featuresAt(0.9))];
  const metrics = scorePredictions([10, 11], records, BINS);
  assert.equal(metrics.top1, 0.5);
  assert.equal(metrics.within1, 1);
  assert.ok(metrics.simulatedHitRate >= 0.5);
});

test("segmented histogram predicts the label its segment saw", () => {
  const orbiting = featuresAt(0.3, 0.9);
  const still = featuresAt(0.3, 0);
  const trainingRecords = [
    ...Array.from({ length: 20 }, () => record(24, orbiting)),
    ...Array.from({ length: 20 }, () => record(15, still)),
  ];
  const model = trainSegmentedHistogram(trainingRecords, BINS);
  assert.deepEqual(predictSegmentedHistogram(model, [record(0, orbiting), record(0, still)]), [24, 15]);
});

test("kNN recovers a feature-conditional label on separable data", () => {
  const trainingRecords = [];
  for (let index = 0; index < 40; index += 1) {
    trainingRecords.push(record(25, featuresAt(0.2, 0.95)));
    trainingRecords.push(record(15, featuresAt(0.8, 0.05)));
  }
  const predictions = predictKnn(trainingRecords, [record(0, featuresAt(0.2, 0.95)), record(0, featuresAt(0.8, 0.05))], BINS);
  assert.deepEqual(predictions, [25, 15]);
});

test("balancedResample is deterministic, size-preserving, and softens imbalance", () => {
  const records = [
    ...Array.from({ length: 90 }, () => record(15, featuresAt(0.5))),
    ...Array.from({ length: 10 }, () => record(3, featuresAt(0.5))),
  ];
  const first = balancedResample(records, BINS);
  const second = balancedResample(records, BINS);
  assert.equal(first.length, records.length);
  assert.deepEqual(first.map((r) => r.label), second.map((r) => r.label));
  const minorityShare = first.filter((r) => r.label === 3).length / first.length;
  assert.ok(minorityShare > 0.1, `expected minority share above raw 0.1, got ${minorityShare}`);
  assert.ok(minorityShare < 0.5, `expected majority class to stay dominant, got minority ${minorityShare}`);
});

test("balancedResample upweights real waves", () => {
  const records = [
    ...Array.from({ length: 50 }, () => record(15, featuresAt(0.5), { waveKind: "virtual" })),
    ...Array.from({ length: 50 }, () => record(15, featuresAt(0.5), { waveKind: "real" })),
  ];
  const resampled = balancedResample(records, BINS, { realWeight: 3 });
  const realShare = resampled.filter((r) => r.waveKind === "real").length / resampled.length;
  assert.ok(realShare > 0.6, `expected real waves oversampled, got share ${realShare}`);
});
