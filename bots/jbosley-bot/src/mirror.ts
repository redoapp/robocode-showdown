/**
 * The Mirror Mind — jbosley-bot's signature trick.
 *
 * Strong opponents aim with a KNN GuessFactor gun trained on OUR movement. But
 * everything such a gun learns about us is something we also know about
 * ourselves. So we run the same class of gun in reverse: train it on our own
 * kinematics as seen from the enemy's position, and every time an enemy wave
 * spawns we KNOW the GuessFactors a statistical gun would have aimed at — and
 * surf away from precisely those angles, not just historical averages.
 *
 * Implements the standard GF-KNN recipe (12-feature situation vector, L1
 * feature distance with weights, exponential GF kernel over 61 bins, an
 * all-data flavor and a recency-weighted flavor) faithfully enough to mirror
 * any bot built on the same well-known formula.
 */
import { absoluteBearing, clamp, dist, distanceToWall, normalizeRelative, sign, RAD } from "./geom.ts";
import { bulletSpeed, MAX_SPEED } from "./physics.ts";
import { GameState } from "./state.ts";

interface MySnap {
  x: number;
  y: number;
  direction: number;
  speed: number;
  time: number;
}

interface MirrorPoint {
  features: number[];
  gf: number;
  time: number;
}

interface MirrorWave {
  sourceX: number;
  sourceY: number;
  fireTime: number;
  speed: number;
  absBearing: number;
  orbitDir: number;
  maeDeg: number;
  features: number[];
}

const FEATURE_WEIGHTS = [4.0, 3.0, 1.6, 3.0, 1.6, 2.6, 2.0, 1.0, 1.6, 1.6, 2.2, 1.0];
const MAX_POINTS = 8000;
const KERNEL_LAMBDA = 22;
const RECENCY_HALFLIFE = 250;
const N_BINS = 61;
const BIN_W = 2 / N_BINS;

export class MirrorMind {
  private points: MirrorPoint[] = [];
  private pending: MirrorWave[] = [];
  private myHist: MySnap[] = [];
  private lastOrbitDir = 1;
  private bins = new Float64Array(N_BINS);

  /** Predictions attached to a wave the enemy fired LAST tick (one-tick lag). */
  lastLaunchPredictions: number[] | null = null;

  onRoundStart(): void {
    this.pending = [];
    this.myHist = [];
    this.lastLaunchPredictions = null;
  }

  size(): number {
    return this.points.length;
  }

  /**
   * Advance the mirror one scan: log my own state, resolve tick-waves that
   * reached me (training data), and launch a fresh tick-wave from the enemy's
   * position — capturing the predictions ITS gun would have made this tick.
   */
  update(gs: GameState, enemyPower: number): void {
    const me = gs.me;
    const now = me.time;
    this.myHist.push({ x: me.x, y: me.y, direction: me.direction, speed: me.speed, time: now });
    if (this.myHist.length > 2000) this.myHist.shift();

    // Resolve mirror waves that have reached me.
    const flying: MirrorWave[] = [];
    for (const w of this.pending) {
      if ((now - w.fireTime) * w.speed >= dist(w.sourceX, w.sourceY, me.x, me.y)) {
        const bearing = absoluteBearing(w.sourceX, w.sourceY, me.x, me.y);
        const offset = normalizeRelative(bearing - w.absBearing);
        const gf = clamp((offset / w.maeDeg) * w.orbitDir, -1, 1);
        this.points.push({ features: w.features, gf, time: w.fireTime });
        if (this.points.length > MAX_POINTS) this.points.shift();
      } else {
        flying.push(w);
      }
    }
    this.pending = flying;

    // Launch this tick's wave and remember what the enemy's gun would predict.
    const setup = this.extract(gs, enemyPower);
    this.lastLaunchPredictions = this.predict(setup, now);
    this.pending.push({
      sourceX: gs.enemy.x,
      sourceY: gs.enemy.y,
      fireTime: now,
      speed: bulletSpeed(enemyPower),
      absBearing: setup.absBearing,
      orbitDir: setup.orbitDir,
      maeDeg: setup.maeDeg,
      features: setup.features,
    });
  }

  /** Build the 12-feature situation vector describing ME, seen from the enemy. */
  private extract(
    gs: GameState,
    power: number,
  ): { absBearing: number; orbitDir: number; maeDeg: number; features: number[] } {
    const me = gs.me;
    const src = gs.enemy;
    const hist = this.myHist;
    const n = hist.length;

    const absBearing = absoluteBearing(src.x, src.y, me.x, me.y);
    const distance = dist(src.x, src.y, me.x, me.y);
    const bSpeed = bulletSpeed(power);
    const bft = distance / bSpeed;

    const relHeading = (me.direction - absBearing) * RAD;
    const latVel = me.speed * Math.sin(relHeading);
    const advVel = me.speed * Math.cos(relHeading);
    const orbitDir = latVel === 0 ? this.lastOrbitDir : sign(latVel);
    this.lastOrbitDir = orbitDir;
    const moveDir = me.speed === 0 ? 0 : sign(me.speed);

    const prev = n >= 2 ? hist[n - 2] : hist[n - 1];
    const accel = Math.abs(me.speed - prev.speed) * (Math.abs(me.speed) < Math.abs(prev.speed) ? -1 : 1);

    let vChangeTimer = n;
    let dirChangeTimer = n;
    let decelTimer = n;
    let md = moveDir;
    for (let i = 1; i < Math.min(72, n); i++) {
      const cur = hist[n - i];
      const before = hist[n - i - 1];
      if (vChangeTimer === n && Math.abs(cur.speed - before.speed) > 0.01) vChangeTimer = i - 1;
      if (cur.speed !== 0) {
        if (md === 0) md = sign(cur.speed);
        else if (dirChangeTimer === n && sign(cur.speed) !== md) dirChangeTimer = i - 1;
      }
      if (decelTimer === n && md !== 0 && before.speed * md > cur.speed * md) decelTimer = i - 1;
    }

    const idx10 = Math.max(0, n - 1 - 10);
    const idx20 = Math.max(0, n - 1 - 20);
    const dist10 = dist(me.x, me.y, hist[idx10].x, hist[idx10].y);
    const dist20 = dist(me.x, me.y, hist[idx20].x, hist[idx20].y);

    const tangent = absBearing + orbitDir * 90;
    const wallFwd = distanceToWall(me.x, me.y, tangent, gs.arenaWidth, gs.arenaHeight);
    const wallRev = distanceToWall(me.x, me.y, tangent + 180, gs.arenaWidth, gs.arenaHeight);

    const timerNorm = (t: number): number => clamp(Math.min(t, 60) / Math.max(bft, 8), 0, 1);
    const maeDeg = (Math.asin(Math.min(1, MAX_SPEED / bSpeed)) * 180) / Math.PI;

    return {
      absBearing,
      orbitDir,
      maeDeg,
      features: [
        clamp(bft / 80, 0, 1.5),
        clamp(Math.abs(latVel) / MAX_SPEED, 0, 1),
        clamp((advVel + MAX_SPEED) / (2 * MAX_SPEED), 0, 1),
        clamp((accel + 2) / 3, 0, 1),
        clamp(Math.abs(me.speed) / MAX_SPEED, 0, 1),
        timerNorm(dirChangeTimer),
        timerNorm(decelTimer),
        timerNorm(vChangeTimer),
        clamp(dist10 / 80, 0, 1),
        clamp(dist20 / 160, 0, 1),
        clamp(wallFwd / 500, 0, 1),
        clamp(wallRev / 500, 0, 1),
      ],
    };
  }

  /** KNN + kernel density: the GF an enemy GF-gun would aim at (both flavors). */
  private predict(setup: { features: number[] }, now: number): number[] | null {
    const n = this.points.length;
    if (n < 12) return null;
    const k = Math.max(6, Math.min(80, Math.round(2 * Math.sqrt(n))));
    const q = setup.features;
    const scored: { d: number; gf: number; time: number }[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      let d = 0;
      for (let j = 0; j < q.length; j++) d += FEATURE_WEIGHTS[j] * Math.abs(q[j] - p.features[j]);
      scored[i] = { d, gf: p.gf, time: p.time };
    }
    scored.sort((a, b) => a.d - b.d);
    const kk = Math.min(k, n);
    const scale = Math.max(1e-6, scored[kk - 1].d);
    return [this.densest(scored, kk, scale, now, false), this.densest(scored, kk, scale, now, true)];
  }

  private densest(
    scored: { d: number; gf: number; time: number }[],
    kk: number,
    scale: number,
    now: number,
    recency: boolean,
  ): number {
    this.bins.fill(0);
    for (let i = 0; i < kk; i++) {
      let w = Math.exp((-scored[i].d / scale) * 2);
      if (recency) w *= Math.exp(-(now - scored[i].time) / RECENCY_HALFLIFE);
      const gf = scored[i].gf;
      const center = Math.round((gf + 1) / BIN_W - 0.5);
      const reach = Math.round(-Math.log(0.02) / (KERNEL_LAMBDA * BIN_W));
      const lo = Math.max(0, center - reach);
      const hi = Math.min(N_BINS - 1, center + reach);
      for (let b = lo; b <= hi; b++) {
        const mid = (b + 0.5) * BIN_W - 1;
        this.bins[b] += w * Math.exp(-Math.abs(mid - gf) * KERNEL_LAMBDA);
      }
    }
    let best = 0;
    let bestIdx = Math.floor(N_BINS / 2);
    for (let b = 0; b < N_BINS; b++) {
      if (this.bins[b] > best) {
        best = this.bins[b];
        bestIdx = b;
      }
    }
    return (bestIdx + 0.5) * BIN_W - 1;
  }
}
