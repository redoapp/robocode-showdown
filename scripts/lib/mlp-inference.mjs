// Framework-free forward pass for "mlp-json-v1" model artifacts produced by
// scripts/train_guess_factor.py. This is the reference implementation for the
// bot's runtime inference: a candidate is only deployable if this code
// reproduces the trainer's golden logits (see offline-report-candidate.mjs).

export function validateModel(model, { featureCount, bins }) {
  if (model.format !== "mlp-json-v1") throw new Error(`unsupported model format ${String(model.format)}`);
  if (model.featureCount !== featureCount) throw new Error(`feature count ${model.featureCount} does not match ${featureCount}`);
  if (model.guessFactorBins !== bins) throw new Error(`bin count ${model.guessFactorBins} does not match ${bins}`);
  if (!Array.isArray(model.layers) || model.layers.length === 0) throw new Error("model has no layers");
  let width = featureCount;
  for (const layer of model.layers) {
    if (layer.kind === "relu") continue;
    if (layer.kind !== "linear") throw new Error(`unsupported layer kind ${String(layer.kind)}`);
    if (layer.inputSize !== width) throw new Error(`layer expects ${layer.inputSize} inputs, got ${width}`);
    if (layer.weights.length !== layer.outputSize || layer.bias.length !== layer.outputSize) {
      throw new Error("layer weight/bias shape mismatch");
    }
    for (const row of layer.weights) {
      if (row.length !== layer.inputSize || !row.every(Number.isFinite)) throw new Error("invalid weight row");
    }
    width = layer.outputSize;
  }
  if (width !== bins) throw new Error(`model outputs ${width} values, expected ${bins}`);
  return model;
}

export function forward(model, features) {
  let activations = features;
  for (const layer of model.layers) {
    if (layer.kind === "relu") {
      for (let index = 0; index < activations.length; index += 1) {
        if (activations[index] < 0) activations[index] = 0;
      }
      continue;
    }
    const output = new Float64Array(layer.outputSize);
    for (let out = 0; out < layer.outputSize; out += 1) {
      let sum = layer.bias[out];
      const row = layer.weights[out];
      for (let inp = 0; inp < row.length; inp += 1) sum += row[inp] * activations[inp];
      output[out] = sum;
    }
    activations = output;
  }
  return activations;
}

export function argmax(values) {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[best]) best = index;
  }
  return best;
}
