import {
  BOT_RADIUS,
  CombatState,
  CreateFriendlyWave,
  OpponentState,
  ResolvedFriendlyWave,
  SelfState,
  absoluteBearing,
  binToGuessFactor,
  clamp,
  distance,
  lateralDirection,
  normalizeRelativeAngle,
} from "./combat-state.js";
import { GUESS_FACTOR_BINS, LearningSystem, makeFeatureVector } from "./learning-system.js";

export type GunName = "head-on" | "linear" | "circular" | "guess-factor-histogram" | "knn" | "mlp-v2";
type CandidateAim = Readonly<{ gun: GunName; angle: number }>;
type GunStats = { hits: number; trials: number };
type Neighbor = Readonly<{ features: readonly number[]; guessFactor: number }>;

const VIRTUAL_SCORE_DECAY = 0.997;
const MAX_NEIGHBORS = 512;
const K_NEIGHBORS = 25;

export type GunPlan = Readonly<{
  opponentId: number;
  bulletPower: number;
  headOnBearing: number;
  lateralDirection: -1 | 1;
  selectedGun: GunName;
  selectedAimAngle: number;
  gunBearing: number;
  features: Float32Array;
  candidates: readonly CandidateAim[];
}>;

export type FiredBulletObservation = Readonly<{
  turnNumber: number;
  x: number;
  y: number;
  direction: number;
  power: number;
}>;

function centeredArgmax(values: ArrayLike<number>) {
  let bestIndex = Math.floor(values.length / 2);
  let bestValue = values[bestIndex] ?? Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] > bestValue) {
      bestIndex = index;
      bestValue = values[index];
    }
  }
  return bestIndex;
}

function smallestPositive(...values: number[]) {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  return positive.length > 0 ? Math.min(...positive) : undefined;
}

function linearAim(self: SelfState, opponent: OpponentState, projectileSpeed: number) {
  const heading = (opponent.direction * Math.PI) / 180;
  const vx = Math.cos(heading) * opponent.speed;
  const vy = Math.sin(heading) * opponent.speed;
  const dx = opponent.x - self.x;
  const dy = opponent.y - self.y;
  const a = vx * vx + vy * vy - projectileSpeed * projectileSpeed;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  let intercept: number | undefined;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) intercept = smallestPositive(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      intercept = smallestPositive((-b - root) / (2 * a), (-b + root) / (2 * a));
    }
  }
  if (intercept === undefined) return absoluteBearing(self, opponent);
  return absoluteBearing(self, {
    x: clamp(opponent.x + vx * intercept, BOT_RADIUS, self.arenaWidth - BOT_RADIUS),
    y: clamp(opponent.y + vy * intercept, BOT_RADIUS, self.arenaHeight - BOT_RADIUS),
  });
}

function circularAim(self: SelfState, opponent: OpponentState, projectileSpeed: number) {
  let x = opponent.x;
  let y = opponent.y;
  let direction = opponent.direction;
  for (let turn = 1; turn <= 100; turn += 1) {
    direction += opponent.turnRate;
    const radians = (direction * Math.PI) / 180;
    x = clamp(x + Math.cos(radians) * opponent.speed, BOT_RADIUS, self.arenaWidth - BOT_RADIUS);
    y = clamp(y + Math.sin(radians) * opponent.speed, BOT_RADIUS, self.arenaHeight - BOT_RADIUS);
    if (projectileSpeed * turn >= distance(self, { x, y })) break;
  }
  return absoluteBearing(self, { x, y });
}

export class GunSystem {
  private readonly histograms = new Map<number, Map<string, number[]>>();
  private readonly neighbors = new Map<number, Neighbor[]>();
  private readonly virtualGunStats = new Map<number, Map<string, Map<GunName, GunStats>>>();

  constructor(private readonly learning: LearningSystem) {}

  plan(combat: CombatState, self: SelfState, opponent: OpponentState, powerBias = 1): GunPlan {
    const range = distance(self, opponent);
    const bulletPower = this.chooseBulletPower(self, opponent, range, powerBias);
    const projectileSpeed = 20 - 3 * bulletPower;
    const headOnBearing = absoluteBearing(self, opponent);
    const direction = lateralDirection(opponent, headOnBearing);
    const features = makeFeatureVector(combat, self, opponent, bulletPower);
    const segment = this.segmentFor(features);
    const histogram = this.histogramFor(opponent.id, segment);
    const histogramFactor = binToGuessFactor(centeredArgmax(histogram), GUESS_FACTOR_BINS);
    const knnFactor = this.knnGuessFactor(opponent.id, features);
    const maxEscapeAngle = (Math.asin(8 / projectileSpeed) * 180) / Math.PI;
    const candidates: CandidateAim[] = [
      { gun: "head-on", angle: headOnBearing },
      { gun: "linear", angle: linearAim(self, opponent, projectileSpeed) },
      { gun: "circular", angle: circularAim(self, opponent, projectileSpeed) },
      {
        gun: "guess-factor-histogram",
        angle: normalizeRelativeAngle(headOnBearing + histogramFactor * maxEscapeAngle * direction),
      },
      {
        gun: "knn",
        angle: normalizeRelativeAngle(headOnBearing + knnFactor * maxEscapeAngle * direction),
      },
    ];
    const learned = this.learning.predict(features);
    if (learned) {
      const factor = binToGuessFactor(centeredArgmax(learned), GUESS_FACTOR_BINS);
      candidates.push({
        gun: "mlp-v2",
        angle: normalizeRelativeAngle(headOnBearing + factor * maxEscapeAngle * direction),
      });
    }
    const forcedGun = process.env.ALEE_FORCE_GUN as GunName | undefined;
    const forced = forcedGun ? candidates.find((candidate) => candidate.gun === forcedGun) : undefined;
    if (forcedGun && !forced) throw new Error(`forced gun ${forcedGun} is unavailable`);
    const selected = forced
      ?? [...candidates].sort((left, right) =>
        this.gunScore(opponent.id, right.gun, segment) - this.gunScore(opponent.id, left.gun, segment))[0];
    return Object.freeze({
      opponentId: opponent.id,
      bulletPower,
      headOnBearing,
      lateralDirection: direction,
      selectedGun: selected.gun,
      selectedAimAngle: selected.angle,
      gunBearing: normalizeRelativeAngle(selected.angle - self.gunDirection),
      features,
      candidates: Object.freeze(candidates),
    });
  }

  waveInput(plan: GunPlan, self: SelfState, kind: "real" | "virtual"): CreateFriendlyWave {
    return this.makeWave(plan, self, kind, plan.selectedGun, plan.selectedAimAngle, true);
  }

  actualWaveInput(
    plan: GunPlan,
    self: SelfState,
    opponent: OpponentState,
    bullet: FiredBulletObservation,
  ): CreateFriendlyWave {
    const origin = { x: bullet.x, y: bullet.y };
    const headOnBearing = absoluteBearing(origin, opponent);
    return {
      kind: "real",
      opponentId: plan.opponentId,
      fireTurn: bullet.turnNumber,
      origin,
      headOnBearing,
      selectedAimAngle: bullet.direction,
      selectedGun: plan.selectedGun,
      collectForTraining: true,
      lateralDirection: lateralDirection(opponent, headOnBearing),
      bulletPower: bullet.power,
      features: Array.from(plan.features),
    };
  }

  virtualWaveInputs(plan: GunPlan, self: SelfState) {
    const waves = plan.candidates.map((candidate) => this.makeWave(
      plan,
      self,
      "virtual",
      candidate.gun,
      candidate.angle,
      false,
    ));
    waves.push(this.makeWave(plan, self, "virtual", "training-reference", plan.headOnBearing, true));
    return waves;
  }

  observeOutcome(resolved: ResolvedFriendlyWave) {
    if (resolved.wave.collectForTraining) {
      const histogram = this.histogramFor(
        resolved.wave.opponentId,
        this.segmentFor(resolved.wave.features),
      );
      histogram[resolved.label] += resolved.wave.kind === "real" ? 2 : 1;
      if (resolved.wave.selectedGun === "training-reference") {
        const samples = this.neighbors.get(resolved.wave.opponentId) ?? [];
        samples.push(Object.freeze({
          features: Object.freeze([...resolved.wave.features]),
          guessFactor: resolved.guessFactor,
        }));
        if (samples.length > MAX_NEIGHBORS) samples.splice(0, samples.length - MAX_NEIGHBORS);
        this.neighbors.set(resolved.wave.opponentId, samples);
      }
    }
    if (resolved.wave.selectedGun === "training-reference") return;
    const gun = resolved.wave.selectedGun as GunName;
    const segment = this.segmentFor(resolved.wave.features);
    const stats = this.statsFor(resolved.wave.opponentId, gun, segment);
    const globalStats = this.statsFor(resolved.wave.opponentId, gun, "global");
    const arrival = absoluteBearing(resolved.wave.origin, resolved.target);
    const angularWidth = (Math.atan2(BOT_RADIUS, distance(resolved.wave.origin, resolved.target)) * 180) / Math.PI;
    const wouldHit = Math.abs(normalizeRelativeAngle(arrival - resolved.wave.selectedAimAngle)) <= angularWidth;
    const weight = resolved.wave.kind === "real" ? 2 : 1;
    for (const target of [stats, globalStats]) {
      target.hits *= VIRTUAL_SCORE_DECAY;
      target.trials *= VIRTUAL_SCORE_DECAY;
      target.trials += weight;
      if (wouldHit) target.hits += weight;
    }
  }

  removeOpponent(_opponentId: number) {
    // Gun learning is battle-scoped and intentionally survives round deaths.
  }

  shouldFire(self: SelfState, plan: GunPlan, gunHeat: number) {
    return self.energy > plan.bulletPower + 0.1 && gunHeat === 0 && Math.abs(plan.gunBearing) < 7;
  }

  private makeWave(
    plan: GunPlan,
    self: SelfState,
    kind: "real" | "virtual",
    selectedGun: string,
    selectedAimAngle: number,
    collectForTraining: boolean,
  ): CreateFriendlyWave {
    return {
      kind,
      opponentId: plan.opponentId,
      fireTurn: self.turnNumber,
      origin: { x: self.x, y: self.y },
      headOnBearing: plan.headOnBearing,
      selectedAimAngle,
      selectedGun,
      collectForTraining,
      lateralDirection: plan.lateralDirection,
      bulletPower: plan.bulletPower,
      features: Array.from(plan.features),
    };
  }

  private gunScore(opponentId: number, gun: GunName, segment = "global") {
    const stats = this.statsFor(opponentId, gun, segment);
    const priors: Record<GunName, [number, number]> = {
      "head-on": [1, 4],
      "linear": [2, 5],
      "circular": [1.5, 5],
      "guess-factor-histogram": [1.5, 5],
      // kNN falls back exactly to head-on before it has samples, making it the
      // safest cold-start expert while full-information virtual scores arrive.
      "knn": [3, 5],
      "mlp-v2": [1.5, 5],
    };
    const [priorHits, priorTrials] = priors[gun];
    return (stats.hits + priorHits) / (stats.trials + priorTrials) + 0.05 / Math.sqrt(stats.trials + 1);
  }

  private statsFor(opponentId: number, gun: GunName, segment: string) {
    const bySegment = this.virtualGunStats.get(opponentId) ?? new Map<string, Map<GunName, GunStats>>();
    this.virtualGunStats.set(opponentId, bySegment);
    const byGun = bySegment.get(segment) ?? new Map<GunName, GunStats>();
    bySegment.set(segment, byGun);
    const stats = byGun.get(gun) ?? { hits: 0, trials: 0 };
    byGun.set(gun, stats);
    return stats;
  }

  private chooseBulletPower(self: SelfState, opponent: OpponentState, range: number, powerBias: number) {
    const bestGunHitRate = Math.max(
      this.gunScore(opponent.id, "head-on"),
      this.gunScore(opponent.id, "linear"),
      this.gunScore(opponent.id, "circular"),
      this.gunScore(opponent.id, "guess-factor-histogram"),
      this.gunScore(opponent.id, "knn"),
    );
    const rangeFactor = clamp(520 / Math.max(range, 1), 0.3, 1);
    const hitProbability = clamp(bestGunHitRate * rangeFactor, 0.05, 0.95);
    const energyCap = self.energy < 12 ? 0.7 : self.energy < 25 ? 1.5 : 3;
    const candidates = [0.5, 0.75, 1, 1.5, 2, 2.5, 3]
      .filter((power) => power <= energyCap && power < self.energy);
    let bestPower = candidates[0] ?? 0.1;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const power of candidates) {
      const damage = 4 * power + Math.max(0, 2 * (power - 1));
      const killValue = damage >= opponent.energy ? 0.3 * opponent.energy : 0;
      const value = hitProbability * (damage + 3 * power + killValue) - power;
      if (value > bestValue) {
        bestValue = value;
        bestPower = power;
      }
    }
    return clamp(bestPower * powerBias, 0.1, Math.min(3, self.energy - 0.1));
  }

  private segmentFor(features: ArrayLike<number>) {
    const distanceBand = Math.min(3, Math.floor((features[0] ?? 0) * 4));
    const lateralBand = (features[2] ?? 0) < -0.2 ? -1 : (features[2] ?? 0) > 0.2 ? 1 : 0;
    const wallBand = (features[17] ?? 1) < 0.25 ? 0 : 1;
    return `${distanceBand}:${lateralBand}:${wallBand}`;
  }

  private histogramFor(opponentId: number, segment: string) {
    const segments = this.histograms.get(opponentId) ?? new Map<string, number[]>();
    this.histograms.set(opponentId, segments);
    const histogram = segments.get(segment) ?? new Array<number>(GUESS_FACTOR_BINS).fill(0);
    segments.set(segment, histogram);
    return histogram;
  }

  private knnGuessFactor(opponentId: number, features: ArrayLike<number>) {
    const samples = this.neighbors.get(opponentId);
    if (!samples || samples.length === 0) return 0;
    const nearest = samples.map((sample) => {
      let squaredDistance = 0;
      for (let index = 0; index < features.length; index += 1) {
        const delta = (features[index] ?? 0) - (sample.features[index] ?? 0);
        squaredDistance += delta * delta;
      }
      return { sample, squaredDistance };
    }).sort((left, right) => left.squaredDistance - right.squaredDistance).slice(0, K_NEIGHBORS);
    let weighted = 0;
    let totalWeight = 0;
    for (const neighbor of nearest) {
      const weight = 1 / (0.01 + neighbor.squaredDistance);
      weighted += neighbor.sample.guessFactor * weight;
      totalWeight += weight;
    }
    return clamp(weighted / totalWeight, -1, 1);
  }
}
