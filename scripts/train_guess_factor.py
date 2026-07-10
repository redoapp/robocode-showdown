#!/usr/bin/env python3
"""Train the alee-bot GuessFactor gun in PyTorch.

Training happens here; the deployed artifact is framework-free JSON weights executed by
a ~40-line forward pass in the bot, verified against golden vectors exported
by this script. Run scripts/offline-report-candidate.mjs afterwards to produce
the offline eligibility report through the same code path the bot ships.

Usage:
  uv run --python 3.12 --with torch scripts/train_guess_factor.py \
      [--runs-dir bots/alee-bot/training/runs] [--epochs 200] [--onnx]
"""

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler

FEATURE_COUNT = 18
BINS = 31
BOT_RADIUS = 18.0
ARENA_DIAGONAL = math.hypot(800, 600)
GF_BIN_WIDTH = 2 / (BINS - 1)
REAL_WAVE_WEIGHT = 3.0


def load_runs(runs_dir: Path):
    runs = []
    for directory in sorted(p for p in runs_dir.iterdir() if p.is_dir()):
        manifest_path = directory / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("schemaVersion") != 2:
            continue
        if manifest.get("featureCount") != FEATURE_COUNT or manifest.get("guessFactorBins") != BINS:
            raise SystemExit(f"{directory.name}: feature schema mismatch")
        records = []
        for shard in sorted(directory.glob("wave-outcomes-*.jsonl")):
            for line in shard.read_text().splitlines():
                if not line:
                    continue
                record = json.loads(line)
                if record.get("recordType") != "wave-outcome" or record.get("schemaVersion") != 2:
                    raise SystemExit(f"{shard}: invalid record schema")
                if len(record["features"]) != FEATURE_COUNT or not (0 <= record["label"] < BINS):
                    raise SystemExit(f"{shard}: invalid record")
                records.append(record)
        if records:
            runs.append({"name": directory.name, "manifest": manifest, "records": records})
    if len(runs) < 2:
        raise SystemExit(f"Need at least two schema-v2 runs for a battle-level split; found {len(runs)}")
    return runs


def split_runs(runs):
    # Same rule as the JS trainer: last ceil(20%) of name-sorted runs validate.
    validation_count = max(1, math.ceil(len(runs) * 0.2))
    return runs[:-validation_count], runs[-validation_count:]


def tensors(records):
    features = torch.tensor([r["features"] for r in records], dtype=torch.float32)
    labels = torch.tensor([r["label"] for r in records], dtype=torch.long)
    return features, labels


def tolerance_bins(record):
    """How many GF bins the target bot spans at this range and bullet speed."""
    range_ = max(record["features"][0] * ARENA_DIAGONAL, BOT_RADIUS * 2)
    max_escape = math.asin(min(1.0, 8.0 / record["bulletSpeed"]))
    half_width = math.atan2(BOT_RADIUS, range_)
    return max(1, round(half_width / max_escape / GF_BIN_WIDTH))


@torch.no_grad()
def evaluate(model, records):
    features, labels = tensors(records)
    logits = model(features)
    predictions = logits.argmax(dim=1)
    log_probabilities = torch.log_softmax(logits, dim=1)
    errors = (predictions - labels).abs()
    tolerances = torch.tensor([tolerance_bins(r) for r in records])
    return {
        "examples": len(records),
        "top1Accuracy": (errors == 0).float().mean().item(),
        "within1BinAccuracy": (errors <= 1).float().mean().item(),
        "simulatedHitRate": (errors <= tolerances).float().mean().item(),
        "logLoss": nn.functional.nll_loss(log_probabilities, labels).item(),
    }


def make_model(hidden_sizes):
    layers = []
    width = FEATURE_COUNT
    for size in hidden_sizes:
        layers += [nn.Linear(width, size), nn.ReLU()]
        width = size
    layers.append(nn.Linear(width, BINS))
    return nn.Sequential(*layers)


def sample_weights(records):
    counts = [0] * BINS
    for record in records:
        counts[record["label"]] += 1
    return torch.tensor([
        (REAL_WAVE_WEIGHT if record["waveKind"] == "real" else 1.0) / math.sqrt(counts[record["label"]])
        for record in records
    ], dtype=torch.double)


def export_layers(model):
    layers = []
    for module in model:
        if isinstance(module, nn.Linear):
            layers.append({
                "kind": "linear",
                "inputSize": module.in_features,
                "outputSize": module.out_features,
                "weights": [[round(v, 8) for v in row] for row in module.weight.tolist()],
                "bias": [round(v, 8) for v in module.bias.tolist()],
            })
        elif isinstance(module, nn.ReLU):
            layers.append({"kind": "relu"})
    return layers


def main():
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("--runs-dir", type=Path, default=root / "bots" / "alee-bot" / "training" / "runs")
    parser.add_argument("--out-dir", type=Path, default=root / "bots" / "alee-bot" / "training" / "candidates")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--patience", type=int, default=15)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-3)
    parser.add_argument("--seed", type=int, default=20260709)
    parser.add_argument("--hidden", type=str, default="64", help="comma-separated hidden layer sizes, e.g. 128,64")
    parser.add_argument("--onnx", action="store_true", help="also export model.onnx")
    args = parser.parse_args()
    hidden_sizes = [int(v) for v in args.hidden.split(",") if v]

    torch.manual_seed(args.seed)
    runs = load_runs(args.runs_dir)
    training_runs, validation_runs = split_runs(runs)
    training_records = [r for run in training_runs for r in run["records"]]
    validation_records = [r for run in validation_runs for r in run["records"]]
    print(f"training runs: {[r['name'] for r in training_runs]} ({len(training_records)} records)")
    print(f"validation runs: {[r['name'] for r in validation_runs]} ({len(validation_records)} records)")

    features, labels = tensors(training_records)
    sampler = WeightedRandomSampler(sample_weights(training_records), num_samples=len(training_records),
                                    generator=torch.Generator().manual_seed(args.seed))
    loader = DataLoader(TensorDataset(features, labels), batch_size=args.batch_size, sampler=sampler, drop_last=True)

    model = make_model(hidden_sizes)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    criterion = nn.CrossEntropyLoss()

    best_state = None
    best_hit_rate = -1.0
    best_epoch = -1
    stale = 0
    for epoch in range(args.epochs):
        model.train()
        for batch_features, batch_labels in loader:
            optimizer.zero_grad()
            criterion(model(batch_features), batch_labels).backward()
            optimizer.step()
        model.eval()
        validation = evaluate(model, validation_records)
        if validation["simulatedHitRate"] > best_hit_rate:
            best_hit_rate = validation["simulatedHitRate"]
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            best_epoch = epoch
            stale = 0
        else:
            stale += 1
        if epoch % 10 == 0 or stale == 0:
            print(f"epoch {epoch:3d} val simHit={validation['simulatedHitRate']:.3f} top1={validation['top1Accuracy']:.3f} logLoss={validation['logLoss']:.3f}")
        if stale >= args.patience:
            print(f"early stop at epoch {epoch} (best epoch {best_epoch})")
            break

    model.load_state_dict(best_state)
    model.eval()

    # Temperature calibration: a single scalar fitted on validation NLL.
    # Divides the final layer's weights/bias, so the exported artifact is
    # calibrated as-is. Argmax (and therefore simulated hit rate) is
    # unchanged; softmax probability mass — which the bot's aim uses —
    # stops being overconfident on unseen opponents.
    with torch.no_grad():
        validation_logits = model(tensors(validation_records)[0])
    validation_labels = tensors(validation_records)[1]
    log_temperature = torch.zeros(1, requires_grad=True)
    calibration = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=50)

    def calibration_closure():
        calibration.zero_grad()
        objective = nn.functional.cross_entropy(validation_logits / log_temperature.exp(), validation_labels)
        objective.backward()
        return objective

    calibration.step(calibration_closure)
    temperature = float(log_temperature.exp())
    final_linear = [m for m in model if isinstance(m, nn.Linear)][-1]
    with torch.no_grad():
        final_linear.weight.div_(temperature)
        final_linear.bias.div_(temperature)
    print(f"calibration temperature: {temperature:.3f}")

    training_metrics = evaluate(model, training_records)
    validation_metrics = evaluate(model, validation_records)
    print(f"best: train simHit={training_metrics['simulatedHitRate']:.3f} val simHit={validation_metrics['simulatedHitRate']:.3f}")

    model_payload = {
        "format": "mlp-json-v1",
        "featureSchemaVersion": 2,
        "featureCount": FEATURE_COUNT,
        "guessFactorBins": BINS,
        "layers": export_layers(model),
    }
    model_text = json.dumps(model_payload, indent=2) + "\n"

    # Golden vectors: real validation inputs and the exact logits the trained
    # model produced. The JS forward pass must reproduce them to be deployed.
    golden_records = validation_records[:: max(1, len(validation_records) // 16)][:16]
    with torch.no_grad():
        golden = [{
            "features": r["features"],
            "logits": [round(v, 8) for v in model(torch.tensor([r["features"]], dtype=torch.float32))[0].tolist()],
        } for r in golden_records]

    candidate_id = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime()) + "-pt-" + hashlib.sha256(model_text.encode()).hexdigest()[:8]
    candidate_dir = args.out_dir / candidate_id
    candidate_dir.mkdir(parents=True, exist_ok=True)
    (candidate_dir / "model.json").write_text(model_text)
    (candidate_dir / "golden.json").write_text(json.dumps(golden, indent=2) + "\n")
    manifest = {
        "artifactVersion": 2,
        "modelFormat": "mlp-json-v1",
        "candidateId": candidate_id,
        "featureSchemaVersion": 2,
        "featureCount": FEATURE_COUNT,
        "guessFactorBins": BINS,
        "modelSha256": hashlib.sha256(model_text.encode()).hexdigest(),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trainer": "pytorch",
        "training": {
            "epochs": args.epochs,
            "bestEpoch": best_epoch,
            "batchSize": args.batch_size,
            "learningRate": args.learning_rate,
            "seed": args.seed,
            "hiddenSizes": hidden_sizes,
            "calibrationTemperature": round(temperature, 6),
            "sampling": "inverse-sqrt-class-frequency",
            "realWaveWeight": REAL_WAVE_WEIGHT,
        },
        "datasetRuns": [run["name"] for run in runs],
        "trainingRuns": [run["name"] for run in training_runs],
        "validationRuns": [run["name"] for run in validation_runs],
        "pythonMetrics": {"training": training_metrics, "validation": validation_metrics},
    }
    (candidate_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    if args.onnx:
        torch.onnx.export(model, torch.zeros(1, FEATURE_COUNT), candidate_dir / "model.onnx",
                          input_names=["features"], output_names=["logits"])

    print(f"candidate: {candidate_dir}")
    print("next: node scripts/offline-report-candidate.mjs --candidate", candidate_id)


if __name__ == "__main__":
    main()
