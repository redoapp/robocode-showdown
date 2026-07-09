import { GameState } from "./state.ts";
import { absoluteBearing, normalizeRelative, normalizeAbsolute, dist, clamp, project, RAD, DEG } from "./geom.ts";
import { bulletSpeed, maxEscapeAngle, nextVelocity, maxTurnRate, MAX_SPEED } from "./physics.ts";
import { PuppetMind } from "./puppet.ts";

/** Number of GuessFactor bins across [-1, 1]. Center = flat/head-on. */
const BINS = 47;
const MID = (BINS - 1) / 2;
const binToGf = (i: number): number => (i - MID) / MID;
const gfToBin = (gf: number): number => clamp(Math.round(gf * MID + MID), 0, BINS - 1);

interface FirePoint {
  features: number[];
  gf: number;
  logIndex: number;
}

interface MyWave {
  fireTime: number;
  originX: number;
  originY: number;
  bSpeed: number;
  refAngle: number; // absolute angle me->enemy at fire
  lateralDir: number;
  mea: number; // max escape angle (rad)
  features: number[];
  // predicted GF from each virtual gun, captured at fire time, for scoring:
  predicted: number[];
  /** Real bullet in the air, or a tick-wave just for learning? */
  real: boolean;
}

/** Feature weights for the KNN distance metric. */
const FEATURE_W = [3.0, 4.0, 2.0, 2.5, 2.0, 1.5];

function segment(gs: GameState): number[] {
  const d = gs.distanceToEnemy();
  return [
    clamp(d / 800, 0, 1),
    clamp(Math.abs(gs.enemyLateralSpeed) / MAX_SPEED, 0, 1),
    clamp((gs.enemyAdvancingSpeed / MAX_SPEED + 1) / 2, 0, 1),
    gs.enemyWallProximity(),
    clamp(gs.timeSinceDirChange / 40, 0, 1),
    clamp(gs.enemy.speed / MAX_SPEED, 0, 1),
  ];
}

function featureDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] - b[i]) * FEATURE_W[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * A GuessFactor gun backed by KNN over a feature space. Two instances run as
 * "virtual guns": a stable all-time one and a recency-weighted anti-surfer one
 * that tracks how a flattening/surfing enemy is *currently* dodging.
 */
class KnnGun {
  private points: FirePoint[] = [];
  private readonly k: number;
  private readonly recencyDecay: number; // 1 = no decay, <1 = weight recent logs more

  constructor(k: number, recencyDecay: number) {
    this.k = k;
    this.recencyDecay = recencyDecay;
  }

  log(features: number[], gf: number, logIndex: number): void {
    this.points.push({ features, gf, logIndex });
    if (this.points.length > 3000) this.points.shift();
  }

  hasData(): boolean {
    return this.points.length >= 3;
  }

  /** Best GuessFactor for the current segment (peak of kernel-smoothed density). */
  bestGf(features: number[], nowIndex: number): number {
    if (this.points.length === 0) return 0;
    const scored = this.points.map((p) => ({ p, d: featureDist(features, p.features) }));
    scored.sort((a, b) => a.d - b.d);
    const k = Math.min(this.k, scored.length);

    const density = new Float64Array(BINS);
    for (let i = 0; i < k; i++) {
      const { p, d } = scored[i];
      const proximity = 1 / (1 + d); // closer neighbours count more
      const recency = this.recencyDecay === 1 ? 1 : Math.pow(this.recencyDecay, nowIndex - p.logIndex);
      const w = proximity * recency;
      const center = gfToBin(p.gf);
      // Gaussian kernel smoothing across bins.
      for (let b = 0; b < BINS; b++) {
        const dx = b - center;
        density[b] += w * Math.exp((-dx * dx) / 8);
      }
    }
    let bestBin = MID;
    let bestVal = -1;
    for (let b = 0; b < BINS; b++) {
      if (density[b] > bestVal) {
        bestVal = density[b];
        bestBin = b;
      }
    }
    return binToGf(bestBin);
  }
}

/**
 * The full gun: a virtual-gun array (head-on, linear, stable-KNN, anti-surf KNN)
 * scored on every wave that reaches the enemy. Real fire uses whichever gun is
 * currently hitting most — so against a wave-surfer the anti-surf gun takes over
 * automatically, and against a simple mover the stable gun wins.
 */
export class Gun {
  private stable = new KnnGun(60, 1.0);
  private antiSurf = new KnnGun(15, 0.97);
  private waves: MyWave[] = [];
  private logIndex = 0;

  // Rolling virtual-gun scores (exponentially decayed hit credit).
  private scores = [0, 0, 0, 0, 0, 0, 0, 0];
  private readonly GUN_NAMES = [
    "head-on",
    "circular",
    "stable-GF",
    "anti-surf",
    "surf-keep",
    "surf-flip",
    "surf-stop",
    "puppet",
  ];
  /** Full reconstruction of a textbook surfer's dodge brain (optional). */
  puppet: PuppetMind | null = null;

  onRoundStart(): void {
    this.waves = [];
  }

  /** Index of the current best virtual gun (for the HUD). */
  bestGunIndex(): number {
    let bi = 0;
    for (let i = 1; i < this.scores.length; i++) if (this.scores[i] > this.scores[bi]) bi = i;
    return bi;
  }
  bestGunName(): string {
    return this.GUN_NAMES[this.bestGunIndex()];
  }
  /** True once we have enough data to trust a learned gun over raw prediction. */
  warmedUp(): boolean {
    return this.stable.hasData();
  }

  /**
   * Exact-simulation circular/linear prediction: play the enemy forward with its
   * current speed and turn rate until our bullet reaches it, then express that
   * intercept as a GuessFactor. With turn rate ≈ 0 this IS linear targeting.
   * Deadly against anything that "just keeps orbiting" — including wave surfers
   * whose danger maps are still empty.
   */
  private simGf(gs: GameState, power: number, turnRate: number): number {
    const me = gs.me;
    const bSpeed = bulletSpeed(power);
    let ex = gs.enemy.x;
    let ey = gs.enemy.y;
    let h = gs.enemy.direction;
    const spd = gs.enemy.speed;
    const W = gs.arenaWidth;
    const H = gs.arenaHeight;
    for (let t = 1; t <= 110; t++) {
      h += turnRate;
      ex += Math.cos(h * RAD) * spd;
      ey += Math.sin(h * RAD) * spd;
      ex = clamp(ex, 18, W - 18);
      ey = clamp(ey, 18, H - 18);
      if (dist(me.x, me.y, ex, ey) <= bSpeed * t) break;
    }
    const refAngle = absoluteBearing(me.x, me.y, gs.enemy.x, gs.enemy.y);
    const offset = normalizeRelative(absoluteBearing(me.x, me.y, ex, ey) - refAngle) * RAD;
    const mea = maxEscapeAngle(bSpeed);
    return clamp((offset / mea) * gs.enemyLateralDir, -1.05, 1.05);
  }

  /**
   * The surfer's tell: simulate the ENEMY wave-surfing MY bullet — orbiting me
   * with standard true-surfing mechanics (orbit ± lean, wall smoothing, real
   * accel/brake physics) in the given direction/drive — and return the GF where
   * my bullet would intercept it. A surfer only has a handful of dodge options;
   * one virtual gun per option lets the scoreboard learn which it favours.
   */
  private surfOptGf(gs: GameState, power: number, orbitDir: number, drive: number): number {
    const me = gs.me;
    const bSpeed = bulletSpeed(power);
    const W = gs.arenaWidth;
    const H = gs.arenaHeight;
    let ex = gs.enemy.x;
    let ey = gs.enemy.y;
    let h = gs.enemy.direction;
    let vel = gs.enemy.speed;

    const wallSmooth = (x: number, y: number, heading: number, od: number): number => {
      const safe = (hh: number): boolean => {
        const p = project(x, y, hh, 130);
        return p.x > 40 && p.x < W - 40 && p.y > 40 && p.y < H - 40;
      };
      if (safe(heading)) return normalizeAbsolute(heading);
      for (let a = 6; a <= 174; a += 6) {
        if (safe(heading + od * a)) return normalizeAbsolute(heading + od * a);
        if (safe(heading - od * a)) return normalizeAbsolute(heading - od * a);
      }
      return absoluteBearing(x, y, W / 2, H / 2);
    };

    for (let t = 1; t <= 110; t++) {
      const bearing = absoluteBearing(ex, ey, me.x, me.y);
      const d = dist(ex, ey, me.x, me.y);
      const lean = clamp((500 - d) * 0.1, -30, 30);
      const desired = wallSmooth(ex, ey, bearing + orbitDir * (90 + lean), orbitDir);
      const turn = clamp(normalizeRelative(desired - h), -maxTurnRate(vel), maxTurnRate(vel));
      h = normalizeAbsolute(h + turn);
      vel = nextVelocity(vel, drive);
      ex += Math.cos(h * RAD) * vel;
      ey += Math.sin(h * RAD) * vel;
      ex = clamp(ex, 18, W - 18);
      ey = clamp(ey, 18, H - 18);
      if (dist(me.x, me.y, ex, ey) <= bSpeed * t + 18) break;
    }
    const refAngle = absoluteBearing(me.x, me.y, gs.enemy.x, gs.enemy.y);
    const offset = normalizeRelative(absoluteBearing(me.x, me.y, ex, ey) - refAngle) * RAD;
    return clamp((offset / maxEscapeAngle(bSpeed)) * gs.enemyLateralDir, -1.05, 1.05);
  }

  private gfCandidates(gs: GameState, features: number[], power: number): number[] {
    // The enemy's CURRENT orbit direction around me, in wave sign convention:
    // +1 means "keeps moving the way it's been moving laterally".
    const od = gs.enemyLateralDir;

    // The puppet: full reconstruction of a wave-surfer's decision — its danger
    // model rebuilt from our own observations, its dodge simulated exactly.
    let puppetGf = 0;
    const pos = this.puppet ? this.puppet.predictDodge(gs, power) : null;
    if (pos) {
      const refAngle = absoluteBearing(gs.me.x, gs.me.y, gs.enemy.x, gs.enemy.y);
      const offset = normalizeRelative(absoluteBearing(gs.me.x, gs.me.y, pos.x, pos.y) - refAngle) * RAD;
      puppetGf = clamp((offset / maxEscapeAngle(bulletSpeed(power))) * gs.enemyLateralDir, -1.05, 1.05);
    }

    return [
      0, // head-on
      this.simGf(gs, power, gs.enemyTurnRate), // circular (≈ linear when turnRate ~ 0)
      this.stable.bestGf(features, this.logIndex),
      this.antiSurf.bestGf(features, this.logIndex),
      this.surfOptGf(gs, power, od, 1), // surfer keeps orbiting
      this.surfOptGf(gs, power, -od, 1), // surfer flips direction
      this.surfOptGf(gs, power, od, 0), // surfer slams the brakes
      puppetGf,
    ];
  }

  /**
   * Compute the absolute angle to aim the gun at, and register a wave so we can
   * learn from where the enemy actually was when the bullet arrived.
   */
  aim(gs: GameState, power: number): number {
    const me = gs.me;
    const en = gs.enemy;
    const refAngle = absoluteBearing(me.x, me.y, en.x, en.y);
    const bSpeed = bulletSpeed(power);
    const mea = maxEscapeAngle(bSpeed);
    const features = segment(gs);
    const predicted = this.gfCandidates(gs, features, power);

    const chosenGf = predicted[this.bestGunIndex()];
    const aimAngle = refAngle + chosenGf * gs.enemyLateralDir * mea * DEG;
    return normalizeRelative(aimAngle);
  }

  /** Call right after a real shot is fired so we can score/learn from it. */
  registerShot(gs: GameState, power: number): void {
    this.pushWave(gs, power, true);
  }

  /**
   * A tick-wave: launched every turn whether or not we fired, so the stable
   * KNN gun trains on ~200 samples a round instead of ~30. (Anti-surf learning
   * and the scoreboard stay real-bullet-only — surfers only dodge real waves.)
   */
  registerTickWave(gs: GameState, power: number): void {
    this.pushWave(gs, power, false);
  }

  private pushWave(gs: GameState, power: number, real: boolean): void {
    const me = gs.me;
    const en = gs.enemy;
    const bSpeed = bulletSpeed(power);
    const features = segment(gs);
    this.waves.push({
      fireTime: gs.me.time,
      originX: me.x,
      originY: me.y,
      bSpeed,
      refAngle: absoluteBearing(me.x, me.y, en.x, en.y),
      lateralDir: gs.enemyLateralDir,
      mea: maxEscapeAngle(bSpeed),
      features,
      // Tick-waves skip the (expensive) full candidate set — they don't score guns.
      predicted: real ? this.gfCandidates(gs, features, power) : [],
      real,
    });
  }

  /**
   * Advance every in-flight wave. When one reaches the enemy, record the actual
   * GuessFactor into both KNN buffers and update the virtual-gun scoreboard.
   */
  update(gs: GameState): void {
    const en = gs.enemy;
    const now = gs.me.time;
    const remaining: MyWave[] = [];
    for (const w of this.waves) {
      const radius = (now - w.fireTime) * w.bSpeed;
      const d = dist(w.originX, w.originY, en.x, en.y);
      if (radius >= d - 1) {
        // Wave has reached the enemy. Where were they, in GF terms?
        const angle = absoluteBearing(w.originX, w.originY, en.x, en.y);
        const offset = normalizeRelative(angle - w.refAngle) * RAD;
        const actualGf = clamp((offset / w.mea) * w.lateralDir, -1, 1);

        this.stable.log(w.features, actualGf, this.logIndex);
        this.logIndex++;

        if (w.real) {
          // Anti-surf learning + gun scoring only trust REAL bullets — that's
          // all a surfer reacts to.
          this.antiSurf.log(w.features, actualGf, this.logIndex);
          const tol = clamp((18 / Math.max(d, 1)) / w.mea, 0.03, 0.5); // bot-width in GF units
          for (let i = 0; i < w.predicted.length; i++) {
            const hit = Math.abs(w.predicted[i] - actualGf) <= tol ? 1 : 0;
            this.scores[i] = this.scores[i] * 0.98 + hit;
          }
        }
      } else {
        remaining.push(w);
      }
    }
    this.waves = remaining;
  }
}
