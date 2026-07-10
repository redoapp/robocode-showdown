/**
 * GuessFactor gun with k-nearest-neighbour targeting and a virtual-gun array —
 * the heart of the bot's aim.
 *
 * Each tick we:
 *   1. resolve any of our in-flight (virtual) waves that reached the enemy, and
 *      store the (features -> guessFactor) pair they observed;
 *   2. launch a new wave for the current situation;
 *   3. predict the enemy's guessFactor with several "gun flavors" (all-data KNN,
 *      recency-weighted KNN, and head-on) and fire with whichever flavor has the
 *      best hit rate so far — so we adapt to both static and adaptive movers.
 *
 * This learns the enemy's movement profile within a couple of seconds and,
 * unlike linear/circular guns, exploits any pattern in how they dodge.
 */
import { bearingForGF, extractWaveSetup, FEATURE_WEIGHTS, type WaveSetup } from "./features.ts";
import { GameState } from "./gameState.ts";
import { GFBins } from "./gfbins.ts";
import { GunWave } from "./gunWave.ts";
import { bulletSpeed, BOT_RADIUS } from "./physics.ts";
import { toRad } from "./geom.ts";

interface DataPoint {
  features: number[];
  gf: number;
  time: number;
}

interface PendingWave {
  wave: GunWave;
  predictions: number[]; // predicted GF per flavor
  distance: number;
  mae: number;
}

const MAX_POINTS = 15000;
const KERNEL_LAMBDA = 22;
const MIN_DATA_FOR_KNN = 12;
const RECENCY_HALFLIFE = 250; // ticks, for the recency-weighted flavor
const N_FLAVORS = 3; // 0 = all-data, 1 = recency-weighted, 2 = head-on

export class KnnGun {
  private readonly points: DataPoint[] = [];
  private pending: PendingWave[] = [];
  private lastOrbitDir = 1;
  private readonly bins = new GFBins(61);
  // Virtual-gun hit/shot counters per flavor (with a small prior).
  private readonly flavorHits = new Array(N_FLAVORS).fill(1);
  private readonly flavorShots = new Array(N_FLAVORS).fill(4);

  onRoundStart(): void {
    this.pending = [];
  }

  get dataCount(): number {
    return this.points.length;
  }

  hasData(): boolean {
    return this.points.length >= MIN_DATA_FOR_KNN;
  }

  /** Advance learning and return the absolute bearing to aim for this power. */
  aim(gs: GameState, power: number): number {
    const e = gs.enemy!;
    const now = gs.me.time;

    // 1. Resolve waves that reached the enemy -> training data + virtual scoring.
    const stillFlying: PendingWave[] = [];
    for (const p of this.pending) {
      if (p.wave.hasReached(now, e.x, e.y)) {
        const actualGf = p.wave.gfOf(e.x, e.y);
        this.addPoint(p.wave.features, actualGf, p.wave.fireTime);
        // Score each flavor: did its predicted GF fall within the enemy's width?
        const tolGf = this.gfTolerance(p.distance, p.mae);
        for (let f = 0; f < N_FLAVORS; f++) {
          this.flavorShots[f]++;
          if (Math.abs(p.predictions[f] - actualGf) <= tolGf) this.flavorHits[f]++;
        }
      } else {
        stillFlying.push(p);
      }
    }
    this.pending = stillFlying;

    // 2. Build the current situation and launch a wave to learn from it.
    const setup = extractWaveSetup(gs, power, this.lastOrbitDir);
    this.lastOrbitDir = setup.orbitDir;
    const predictions = this.predictAllFlavors(setup, now);
    this.pending.push({
      wave: new GunWave(setup, now, bulletSpeed(power)),
      predictions,
      distance: setup.distance,
      mae: setup.mae,
    });

    // 3. Fire with the flavor that's hitting best.
    const flavor = this.bestFlavor();
    return bearingForGF(setup.absBearing, setup.orbitDir, setup.mae, predictions[flavor]);
  }

  private addPoint(features: number[], gf: number, time: number): void {
    this.points.push({ features, gf, time });
    if (this.points.length > MAX_POINTS) this.points.shift();
  }

  /** Half-angle subtended by the enemy, expressed in GuessFactor units. */
  private gfTolerance(distance: number, maeDeg: number): number {
    const botAngle = Math.atan2(BOT_RADIUS, Math.max(distance, 1)); // rad
    return Math.min(0.95, botAngle / Math.max(toRad(maeDeg), 1e-6));
  }

  private bestFlavor(): number {
    let best = 0;
    let bestRate = -1;
    for (let f = 0; f < N_FLAVORS; f++) {
      const rate = this.flavorHits[f] / this.flavorShots[f];
      if (rate > bestRate) {
        bestRate = rate;
        best = f;
      }
    }
    return best;
  }

  /** Predict the GF for every gun flavor from the same neighbor set. */
  private predictAllFlavors(setup: WaveSetup, now: number): number[] {
    const n = this.points.length;
    if (n < MIN_DATA_FOR_KNN) return new Array(N_FLAVORS).fill(0);

    const k = Math.max(6, Math.min(80, Math.round(2 * Math.sqrt(n))));
    const query = setup.features;
    const scored: { d: number; gf: number; time: number }[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      let d = 0;
      for (let j = 0; j < query.length; j++) {
        d += FEATURE_WEIGHTS[j] * Math.abs(query[j] - p.features[j]);
      }
      scored[i] = { d, gf: p.gf, time: p.time };
    }
    scored.sort((a, b) => a.d - b.d);
    const kk = Math.min(k, n);
    const scale = Math.max(1e-6, scored[kk - 1].d);

    // Flavor 0: all-data density. Flavor 1: recency-weighted density.
    const gfAll = this.densestGF(scored, kk, scale, now, false);
    const gfRecent = this.densestGF(scored, kk, scale, now, true);
    return [gfAll, gfRecent, 0];
  }

  private densestGF(
    scored: { d: number; gf: number; time: number }[],
    kk: number,
    scale: number,
    now: number,
    recency: boolean,
  ): number {
    this.bins.reset();
    for (let i = 0; i < kk; i++) {
      let weight = Math.exp((-scored[i].d / scale) * 2);
      if (recency) weight *= Math.exp(-(now - scored[i].time) / RECENCY_HALFLIFE);
      this.bins.addVisit(scored[i].gf, KERNEL_LAMBDA, weight);
    }
    return this.bins.bestGF();
  }
}
