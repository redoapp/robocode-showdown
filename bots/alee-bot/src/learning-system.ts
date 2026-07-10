import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  absoluteBearing,
  bulletSpeed,
  clamp,
  distance,
  distanceToWallAlongHeading,
  lateralDirection,
  normalizeRelativeAngle,
} from "./combat-state.ts";
import type { CombatState, OpponentState, SelfState } from "./combat-state.ts";

export const FEATURE_SCHEMA_VERSION = 2;
export const FEATURE_COUNT = 18;
export const GUESS_FACTOR_BINS = 31;
export const MODEL_FORMAT = "mlp-json-v1";

export type ChampionManifest = Readonly<{
  artifactVersion: 2;
  modelFormat: typeof MODEL_FORMAT;
  featureSchemaVersion: 2;
  featureCount: number;
  guessFactorBins: number;
  modelSha256?: string;
  candidateId?: string;
}>;

// The deployed model is framework-free JSON produced by the PyTorch trainer
// (scripts/train_guess_factor.py) and verified against golden logits by
// scripts/offline-report-candidate.mjs before it can reach battle evaluation.
type CompiledLinear = Readonly<{
  inputSize: number;
  outputSize: number;
  weights: Float32Array; // row-major [outputSize x inputSize]
  bias: Float32Array;
  relu: boolean;
}>;

export function makeFeatureVector(
  combat: CombatState,
  self: SelfState,
  opponent: OpponentState,
  power: number,
) {
  const previous = combat.getPreviousOpponent(opponent.id);
  const origin = { x: self.x, y: self.y };
  const target = { x: opponent.x, y: opponent.y };
  const range = distance(origin, target);
  const bearing = absoluteBearing(origin, target);
  const relativeHeading = normalizeRelativeAngle(opponent.direction - bearing) * (Math.PI / 180);
  const lateralVelocity = Math.sin(relativeHeading) * opponent.speed;
  const advancingVelocity = Math.cos(relativeHeading) * opponent.speed;
  const rangeDelta = previous ? range - distance(origin, previous) : 0;
  const arenaDiagonal = Math.hypot(self.arenaWidth, self.arenaHeight);
  const wallForward = distanceToWallAlongHeading(target, opponent.direction, self.arenaWidth, self.arenaHeight);
  const wallReverse = distanceToWallAlongHeading(target, opponent.direction + 180, self.arenaWidth, self.arenaHeight);
  const nearestWall = Math.min(opponent.x, opponent.y, self.arenaWidth - opponent.x, self.arenaHeight - opponent.y);
  const flightTime = range / bulletSpeed(power);

  return Float32Array.from([
    clamp(range / arenaDiagonal, 0, 1),
    clamp(flightTime / 100, 0, 1),
    clamp(lateralVelocity / 8, -1, 1),
    clamp(advancingVelocity / 8, -1, 1),
    clamp(opponent.acceleration / 2, -1, 1),
    clamp(opponent.turnRate / 10, -1, 1),
    clamp(opponent.timeSinceDirectionChange / 40, 0, 1),
    clamp(opponent.timeSinceVelocityChange / 40, 0, 1),
    Math.sin(relativeHeading),
    Math.cos(relativeHeading),
    clamp(wallForward / arenaDiagonal, 0, 1),
    clamp(wallReverse / arenaDiagonal, 0, 1),
    clamp(opponent.energy / 100, 0, 1),
    clamp(self.energy / 100, 0, 1),
    clamp(rangeDelta / 8, -1, 1),
    lateralDirection(opponent, bearing),
    clamp(self.enemyCount / 5, 0, 1),
    clamp(nearestWall / (Math.min(self.arenaWidth, self.arenaHeight) / 2), 0, 1),
  ]);
}

function validateManifest(value: unknown): ChampionManifest {
  if (!value || typeof value !== "object") throw new Error("champion manifest must be an object");
  const manifest = value as Partial<ChampionManifest>;
  if (manifest.artifactVersion !== 2) throw new Error(`unsupported artifact version ${String(manifest.artifactVersion)}`);
  if (manifest.modelFormat !== MODEL_FORMAT) throw new Error(`model format ${String(manifest.modelFormat)} does not match ${MODEL_FORMAT}`);
  if (manifest.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
    throw new Error(`feature schema ${String(manifest.featureSchemaVersion)} does not match ${FEATURE_SCHEMA_VERSION}`);
  }
  if (manifest.featureCount !== FEATURE_COUNT) throw new Error(`feature count ${String(manifest.featureCount)} does not match ${FEATURE_COUNT}`);
  if (manifest.guessFactorBins !== GUESS_FACTOR_BINS) {
    throw new Error(`bin count ${String(manifest.guessFactorBins)} does not match ${GUESS_FACTOR_BINS}`);
  }
  return Object.freeze(manifest as ChampionManifest);
}

export function compileModel(value: unknown): CompiledLinear[] {
  if (!value || typeof value !== "object") throw new Error("model must be an object");
  const model = value as {
    format?: string;
    featureCount?: number;
    guessFactorBins?: number;
    layers?: Array<{ kind?: string; inputSize?: number; outputSize?: number; weights?: number[][]; bias?: number[] }>;
  };
  if (model.format !== MODEL_FORMAT) throw new Error(`unsupported model format ${String(model.format)}`);
  if (model.featureCount !== FEATURE_COUNT || model.guessFactorBins !== GUESS_FACTOR_BINS) {
    throw new Error("model feature/bin sizes do not match the bot schema");
  }
  if (!Array.isArray(model.layers) || model.layers.length === 0) throw new Error("model has no layers");
  const compiled: CompiledLinear[] = [];
  let width = FEATURE_COUNT;
  for (let index = 0; index < model.layers.length; index += 1) {
    const layer = model.layers[index];
    if (layer.kind === "relu") {
      if (compiled.length === 0) throw new Error("relu cannot be the first layer");
      const previous = compiled[compiled.length - 1];
      compiled[compiled.length - 1] = { ...previous, relu: true };
      continue;
    }
    if (layer.kind !== "linear") throw new Error(`unsupported layer kind ${String(layer.kind)}`);
    if (layer.inputSize !== width) throw new Error(`layer ${index} expects ${String(layer.inputSize)} inputs, got ${width}`);
    if (!Array.isArray(layer.weights) || !Array.isArray(layer.bias)
      || layer.weights.length !== layer.outputSize || layer.bias.length !== layer.outputSize) {
    throw new Error(`layer ${index} weight/bias shape mismatch`);
    }
    const weights = new Float32Array(layer.outputSize! * layer.inputSize!);
    for (let row = 0; row < layer.outputSize!; row += 1) {
      const source = layer.weights[row];
      if (source.length !== layer.inputSize || !source.every(Number.isFinite)) throw new Error(`layer ${index} has an invalid weight row`);
      weights.set(source, row * layer.inputSize!);
    }
    if (!layer.bias.every(Number.isFinite)) throw new Error(`layer ${index} has an invalid bias`);
    compiled.push({
      inputSize: layer.inputSize!,
      outputSize: layer.outputSize!,
      weights,
      bias: Float32Array.from(layer.bias),
      relu: false,
    });
    width = layer.outputSize!;
  }
  if (width !== GUESS_FACTOR_BINS) throw new Error(`model outputs ${width} values, expected ${GUESS_FACTOR_BINS}`);
  return compiled;
}

export class LearningSystem {
  private readonly output = new Float32Array(GUESS_FACTOR_BINS);
  private layers: CompiledLinear[] | undefined;
  private buffers: [Float32Array, Float32Array] | undefined;
  private manifest: ChampionManifest | undefined;
  private loadAttempted = false;

  loadChampion(botDirectory: string) {
    if (this.layers) return true;
    if (this.loadAttempted) return false;
    this.loadAttempted = true;
    const championDirectory = process.env.ALEE_CHAMPION_DIR ?? join(botDirectory, "champion");
    const manifestPath = join(championDirectory, "manifest.json");
    const modelPath = join(championDirectory, "model.json");
    if (!existsSync(manifestPath) || !existsSync(modelPath)) return false;

    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    const modelText = readFileSync(modelPath, "utf8");
    if (manifest.modelSha256) {
      const hash = createHash("sha256").update(modelText).digest("hex");
      if (hash !== manifest.modelSha256) throw new Error("champion model hash does not match its manifest");
    }
    const layers = compileModel(JSON.parse(modelText));
    const maxWidth = Math.max(FEATURE_COUNT, ...layers.map((layer) => layer.outputSize));
    this.buffers = [new Float32Array(maxWidth), new Float32Array(maxWidth)];
    this.layers = layers;
    this.manifest = manifest;
    return true;
  }

  predict(features: Float32Array) {
    if (!this.layers || !this.buffers) return undefined;
    if (features.length !== FEATURE_COUNT) throw new Error(`expected ${FEATURE_COUNT} features, got ${features.length}`);
    let input: Float32Array = features;
    let bufferIndex = 0;
    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index];
      const target = index === this.layers.length - 1 ? this.output : this.buffers[bufferIndex];
      for (let out = 0; out < layer.outputSize; out += 1) {
        let sum = layer.bias[out];
        const offset = out * layer.inputSize;
        for (let inp = 0; inp < layer.inputSize; inp += 1) sum += layer.weights[offset + inp] * input[inp];
        target[out] = layer.relu && sum < 0 ? 0 : sum;
      }
      input = target;
      bufferIndex = 1 - bufferIndex;
    }
    return this.output;
  }

  getManifest() {
    return this.manifest;
  }

  dispose() {
    this.layers = undefined;
    this.buffers = undefined;
    this.manifest = undefined;
    this.loadAttempted = false;
  }
}
