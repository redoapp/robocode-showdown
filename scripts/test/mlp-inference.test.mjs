import assert from "node:assert/strict";
import { test } from "node:test";
import { argmax, forward, validateModel } from "../lib/mlp-inference.mjs";

const tinyModel = {
  format: "mlp-json-v1",
  featureSchemaVersion: 2,
  featureCount: 2,
  guessFactorBins: 3,
  layers: [
    { kind: "linear", inputSize: 2, outputSize: 2, weights: [[1, 0], [0, -1]], bias: [0, 0.5] },
    { kind: "relu" },
    { kind: "linear", inputSize: 2, outputSize: 3, weights: [[1, 0], [0, 1], [1, 1]], bias: [0.1, 0.2, 0.3] },
  ],
};

test("forward computes a hand-checkable MLP", () => {
  // input [2, 1] -> linear [2, -0.5] -> relu [2, 0] -> linear [2.1, 0.2, 2.3]
  const logits = forward(tinyModel, Float64Array.from([2, 1]));
  assert.deepEqual(Array.from(logits), [2.1, 0.2, 2.3]);
  assert.equal(argmax(logits), 2);
});

test("validateModel accepts the tiny model and rejects shape mismatches", () => {
  assert.equal(validateModel(tinyModel, { featureCount: 2, bins: 3 }), tinyModel);
  assert.throws(() => validateModel(tinyModel, { featureCount: 3, bins: 3 }), /feature count/);
  assert.throws(() => validateModel({ ...tinyModel, guessFactorBins: 5 }, { featureCount: 2, bins: 3 }), /bin count/);
  const badRow = structuredClone(tinyModel);
  badRow.layers[0].weights[0] = [1];
  assert.throws(() => validateModel(badRow, { featureCount: 2, bins: 3 }), /invalid weight row/);
  const wrongOutput = structuredClone(tinyModel);
  wrongOutput.layers[2].outputSize = 2;
  wrongOutput.layers[2].weights = [[1, 0], [0, 1]];
  wrongOutput.layers[2].bias = [0, 0];
  assert.throws(() => validateModel(wrongOutput, { featureCount: 2, bins: 3 }), /outputs 2/);
});

test("validateModel rejects non-finite weights", () => {
  const corrupt = structuredClone(tinyModel);
  corrupt.layers[0].weights[0][1] = Number.NaN;
  assert.throws(() => validateModel(corrupt, { featureCount: 2, bins: 3 }), /invalid weight row/);
});
