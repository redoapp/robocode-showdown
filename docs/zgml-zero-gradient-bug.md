# zgml bug report: training never updates weights (all gradients are zero)

**Evaluated repo:** `candrewlee14/zgml`, branch `alee/executable-stencil-runtime-plan`, commit `286381c` (removed from the submission after this result).

## Summary

Every training path — `model.fit(loader, …)`, `train.fit(optimizer, loader, lossFn, …)`, and a manual `zeroGrad()/backward()/step()` loop — leaves the model at its initialization. `backward()` produces **zero gradients for every parameter**. The fit evidence *claims* success (`steps=2560`, `native=true`, a full compiled plan), but the reported loss stays at the uniform baseline and the model's outputs never change.

This reproduces:

- in both the native Zig lane (`native: true`) and the JS lane (`native: false`);
- with `nn.sequential(...)` and with a subclassed `nn.Module`;
- with `crossEntropyLoss` and with `loss.mse` (MSE converges only the bias — exactly the constant-mean solution — confirming that gradients reach at most the bias, not the weights);
- with `optim.adamW` and `optim.adam`;
- with `data.dataLoader` batches and with hand-built batch tensors (the loader itself is fine: inspected `batch.input`/`batch.target` match the source data).

Observed consequence downstream: an 18→64→31 MLP trained for 40 epochs on a trivially separable synthetic task (`label = round(features[0] * 30)`, other 17 features noise) stays at random accuracy (3.9% ≈ 1/31), where any working trainer reaches ~100%.

## Minimal repro

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { data, gradMode, loss, nn, optim, tensor, train } = require("zgml");

const FEATURES = 18, CLASSES = 31, N = 4096;
let state = 42 >>> 0;
const random = () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 0x100000000);
const inputs = [], labels = [];
for (let i = 0; i < N; i += 1) {
  const row = Array.from({ length: FEATURES }, () => random() * 2 - 1);
  row[0] = random();
  inputs.push(...row);
  labels.push(Math.round(row[0] * (CLASSES - 1)));
}

const model = nn.sequential([nn.linear(FEATURES, 64), nn.relu(), nn.linear(64, CLASSES)]);
const optimizer = optim.adamW(model, { lr: 0.003, weightDecay: 0.0001 });
const criterion = loss.crossEntropyLoss({ classes: CLASSES });

// Direct gradient check: every parameter gradient is exactly zero.
optimizer.zeroGrad();
const objective = criterion.forward(
  model.forward(tensor(inputs.slice(0, 64 * FEATURES), [64, FEATURES])),
  tensor(labels.slice(0, 64), [64]),
);
objective.backward();
for (const parameter of model.parameters()) {
  let sum = 0;
  for (const value of parameter.grad?.data ?? []) sum += Math.abs(value);
  console.log("grad abs sum:", sum);            // prints 0 for all 4 parameters
}

// Full fit: claims steps ran, model stays at init (~3.2% accuracy expected ~100%).
const dataset = data.tensorDataset(tensor(inputs, [N, FEATURES]), tensor(labels, [N]));
const loader = data.dataLoader(dataset, { batchSize: 64, shuffle: true, seed: 7 });
const fit = model.fit(loader, { optimizer, loss: criterion, epochs: 40 });
console.log("fit:", fit.steps, "steps, native:", fit.native, "losses recorded:", fit.losses?.length);
const logits = gradMode.inferenceMode(() => model.forward(tensor(inputs, [N, FEATURES])));
const predictions = train.predictClasses(logits, { classes: CLASSES });
let hits = 0;
for (let i = 0; i < N; i += 1) if (predictions[i] === labels[i]) hits += 1;
console.log("accuracy:", (hits / N * 100).toFixed(1), "% (should be near 100%)");
```

Observed output (macOS arm64, Node 25.9.0, `npm run build:native:release` + `build:package`):

```
grad abs sum: 0   (x4)
fit: 2560 steps, native: true, losses recorded: 1
accuracy: 3.9 % (should be near 100%)
```

Two additional details that may help localize it:

1. `fit.losses` contains a single entry (~`ln(classes)` = 3.43) despite `steps=2560`; the `examples/bun_training/train_mlp.ts` smoke asserts one loss per step, so evidence recording is also affected.
2. `examples/node_training/train_mnist_mlp.cjs` asserts `after.meanLoss < before.meanLoss` — that assertion should be failing on this branch too, which suggests the training smokes were not run against this commit.

Inference is unaffected: `model.inference(...)`, `compile.compileForInference(...)`, and checkpoint restore all behave correctly.
