import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CombatState, SelfState, binToGuessFactor, guessFactorToBin } from "../src/combat-state.js";
import { FEATURE_COUNT, GUESS_FACTOR_BINS, LearningSystem, makeFeatureVector } from "../src/learning-system.js";

const self: SelfState = {
  roundNumber: 1,
  turnNumber: 12,
  botId: 1,
  x: 400,
  y: 300,
  direction: 0,
  gunDirection: 0,
  radarDirection: 0,
  speed: 4,
  energy: 80,
  arenaWidth: 800,
  arenaHeight: 600,
  enemyCount: 1,
};

test("schema-v2 feature encoder is finite, bounded, and stable-sized", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  combat.observeScan({
    turnNumber: 10,
    scannedBotId: 7,
    energy: 60,
    x: 650,
    y: 500,
    direction: 210,
    speed: 5,
  }, GUESS_FACTOR_BINS);
  const opponent = combat.observeScan({
    turnNumber: 12,
    scannedBotId: 7,
    energy: 60,
    x: 642,
    y: 494,
    direction: 204,
    speed: 4,
  }, GUESS_FACTOR_BINS).opponent;
  const features = makeFeatureVector(combat, self, opponent, 2);
  assert.equal(features.length, FEATURE_COUNT);
  for (const feature of features) {
    assert.ok(Number.isFinite(feature));
    assert.ok(feature >= -1 && feature <= 1);
  }
});

test("GuessFactor bins round-trip at both edges and center", () => {
  for (const factor of [-1, 0, 1]) {
    const bin = guessFactorToBin(factor, GUESS_FACTOR_BINS);
    assert.equal(binToGuessFactor(bin, GUESS_FACTOR_BINS), factor);
  }
});

test("champion loads mlp-json-v1 artifacts and predicts through the pure-TS forward pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "alee-champion-"));
  // One linear layer: logit[b] = features[0] for every bin except bin 3,
  // which gets features[0] + 1 — so bin 3 must dominate the output.
  const weights = Array.from({ length: GUESS_FACTOR_BINS }, () => {
    const row = new Array<number>(FEATURE_COUNT).fill(0);
    row[0] = 1;
    return row;
  });
  const bias = new Array<number>(GUESS_FACTOR_BINS).fill(0);
  bias[3] = 1;
  const model = {
    format: "mlp-json-v1",
    featureCount: FEATURE_COUNT,
    guessFactorBins: GUESS_FACTOR_BINS,
    layers: [{ kind: "linear", inputSize: FEATURE_COUNT, outputSize: GUESS_FACTOR_BINS, weights, bias }],
  };
  const modelText = JSON.stringify(model);
  writeFileSync(join(directory, "model.json"), modelText);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    artifactVersion: 2,
    modelFormat: "mlp-json-v1",
    featureSchemaVersion: 2,
    featureCount: FEATURE_COUNT,
    guessFactorBins: GUESS_FACTOR_BINS,
    modelSha256: createHash("sha256").update(modelText).digest("hex"),
  }));

  const previousChampion = process.env.ALEE_CHAMPION_DIR;
  process.env.ALEE_CHAMPION_DIR = directory;
  try {
    const learning = new LearningSystem();
    assert.equal(learning.loadChampion("/nonexistent"), true);
    const features = new Float32Array(FEATURE_COUNT).fill(0);
    features[0] = 0.5;
    const logits = learning.predict(features);
    assert.ok(logits);
    assert.equal(logits.length, GUESS_FACTOR_BINS);
    assert.ok(Math.abs(logits[3] - 1.5) < 1e-6);
    assert.ok(Math.abs(logits[0] - 0.5) < 1e-6);
    learning.dispose();
  } finally {
    if (previousChampion === undefined) delete process.env.ALEE_CHAMPION_DIR;
    else process.env.ALEE_CHAMPION_DIR = previousChampion;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("champion loading rejects hash mismatches and wrong artifact versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "alee-champion-bad-"));
  const model = {
    format: "mlp-json-v1",
    featureCount: FEATURE_COUNT,
    guessFactorBins: GUESS_FACTOR_BINS,
    layers: [{
      kind: "linear",
      inputSize: FEATURE_COUNT,
      outputSize: GUESS_FACTOR_BINS,
      weights: Array.from({ length: GUESS_FACTOR_BINS }, () => new Array<number>(FEATURE_COUNT).fill(0)),
      bias: new Array<number>(GUESS_FACTOR_BINS).fill(0),
    }],
  };
  writeFileSync(join(directory, "model.json"), JSON.stringify(model));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    artifactVersion: 2,
    modelFormat: "mlp-json-v1",
    featureSchemaVersion: 2,
    featureCount: FEATURE_COUNT,
    guessFactorBins: GUESS_FACTOR_BINS,
    modelSha256: "0".repeat(64),
  }));

  const previousChampion = process.env.ALEE_CHAMPION_DIR;
  process.env.ALEE_CHAMPION_DIR = directory;
  try {
    assert.throws(() => new LearningSystem().loadChampion("/nonexistent"), /hash does not match/);

    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      artifactVersion: 1,
      modelPrefix: "guess-factor-v2",
      featureSchemaVersion: 2,
      featureCount: FEATURE_COUNT,
      guessFactorBins: GUESS_FACTOR_BINS,
    }));
    assert.throws(() => new LearningSystem().loadChampion("/nonexistent"), /artifact version/);
  } finally {
    if (previousChampion === undefined) delete process.env.ALEE_CHAMPION_DIR;
    else process.env.ALEE_CHAMPION_DIR = previousChampion;
    rmSync(directory, { recursive: true, force: true });
  }
});
