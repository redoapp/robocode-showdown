/**
 * The Puppet — the second half of the mirror trick.
 *
 * A true wave-surfer dodges using a danger model trained on two streams: where
 * our bullets HIT it, and where our waves PASSED it. Both streams are fully
 * observable from our side of the arena. So we reconstruct the standard
 * surfer's danger model (KNN over situation features, exponential GF kernel,
 * heavy hit weight + flattener-gated visit weight), replay its three-option
 * decision (orbit CCW / orbit CW / brake) with exact game physics, and aim at
 * the intercept point it would choose. Against a textbook wave-surfer, the
 * we can know where the surfer will dodge before it does.
 */
import { absoluteBearing, clamp, dist, distanceToWall, normalizeAbsolute, normalizeRelative, project, sign, RAD } from "./geom.ts";
import { bulletSpeed, maxEscapeAngle, nextVelocity, maxTurnRate, MAX_SPEED, BOT_RADIUS } from "./physics.ts";
import { GameState } from "./state.ts";

interface PuppetPoint {
  features: number[];
  gf: number;
  weight: number;
  isVisit: boolean;
}

interface TrackedWave {
  fireTime: number;
  originX: number;
  originY: number;
  power: number;
  bSpeed: number;
  refAngle: number; // absolute bearing origin -> enemy at fire time
  orbitDir: number; // enemy's lateral direction at fire time
  mea: number; // radians
  features: number[]; // the ENEMY's situation at our fire time
}

const SURF_FEATURE_WEIGHTS = [3.0, 3.0, 1.5, 1.5, 2.0, 1.0];
const MAX_POINTS = 2500;

/** The standard surfer's situation features, computed about the ENEMY. */
function enemyFeatures(gs: GameState, sourceX: number, sourceY: number, power: number): number[] {
  const en = gs.enemy;
  const absToEnemy = absoluteBearing(sourceX, sourceY, en.x, en.y);
  const relHeading = (en.direction - absToEnemy) * RAD;
  const lateral = en.speed * Math.sin(relHeading);
  const advancing = en.speed * Math.cos(relHeading);
  const d = dist(sourceX, sourceY, en.x, en.y);
  const bft = d / bulletSpeed(power);

  const od = lateral === 0 ? 1 : sign(lateral);
  const towardSource = absoluteBearing(en.x, en.y, sourceX, sourceY);
  const tangent = towardSource + od * 90;
  const wallFwd = distanceToWall(en.x, en.y, tangent, gs.arenaWidth, gs.arenaHeight);
  const wallRev = distanceToWall(en.x, en.y, tangent + 180, gs.arenaWidth, gs.arenaHeight);

  return [
    clamp(bft / 80, 0, 1.5),
    clamp(Math.abs(lateral) / MAX_SPEED, 0, 1),
    clamp((advancing + MAX_SPEED) / (2 * MAX_SPEED), 0, 1),
    clamp(Math.abs(en.speed) / MAX_SPEED, 0, 1),
    clamp(wallFwd / 500, 0, 1),
    clamp(wallRev / 500, 0, 1),
  ];
}

export class PuppetMind {
  private points: PuppetPoint[] = [];
  private waves: TrackedWave[] = [];
  private myHits = 0;
  private myShotsPassed = 0;

  onRoundStart(): void {
    this.waves = [];
  }

  size(): number {
    return this.points.length;
  }

  /** Register one of our REAL bullets so we can rebuild the surfer's training data. */
  onMyShot(gs: GameState, power: number): void {
    const me = gs.me;
    const en = gs.enemy;
    const relHeading = (en.direction - absoluteBearing(me.x, me.y, en.x, en.y)) * RAD;
    const lateral = en.speed * Math.sin(relHeading);
    this.waves.push({
      fireTime: gs.me.time,
      originX: me.x,
      originY: me.y,
      power,
      bSpeed: bulletSpeed(power),
      refAngle: absoluteBearing(me.x, me.y, en.x, en.y),
      orbitDir: lateral === 0 ? 1 : sign(lateral),
      mea: maxEscapeAngle(bulletSpeed(power)),
      features: enemyFeatures(gs, me.x, me.y, power),
    });
  }

  private gfOf(w: TrackedWave, x: number, y: number): number {
    const bearing = absoluteBearing(w.originX, w.originY, x, y);
    const offset = normalizeRelative(bearing - w.refAngle) * RAD;
    return clamp((offset / w.mea) * w.orbitDir, -1, 1);
  }

  /** Advance waves; when one passes the enemy, log the visit (flattener stream). */
  update(gs: GameState): void {
    const en = gs.enemy;
    const now = gs.me.time;
    const remaining: TrackedWave[] = [];
    for (const w of this.waves) {
      const radius = (now - w.fireTime) * w.bSpeed;
      if (radius >= dist(w.originX, w.originY, en.x, en.y)) {
        this.myShotsPassed++;
        this.addPoint(w.features, this.gfOf(w, en.x, en.y), 0.5, true);
      } else {
        remaining.push(w);
      }
    }
    this.waves = remaining;
  }

  /** One of our bullets hit — the surfer logs this GF heavily; so do we. */
  onMyBulletHit(gs: GameState): void {
    const en = gs.enemy;
    const now = gs.me.time;
    let best: TrackedWave | null = null;
    let bestErr = 1e9;
    for (const w of this.waves) {
      const err = Math.abs((now - w.fireTime) * w.bSpeed - dist(w.originX, w.originY, en.x, en.y));
      if (err < bestErr) {
        bestErr = err;
        best = w;
      }
    }
    this.myHits++;
    if (best && bestErr < 60) this.addPoint(best.features, this.gfOf(best, en.x, en.y), 4.0, false);
  }

  private addPoint(features: number[], gf: number, weight: number, isVisit: boolean): void {
    this.points.push({ features, gf, weight, isVisit });
    if (this.points.length > MAX_POINTS) this.points.shift();
  }

  /** The standard surfer's adaptive flattener gate: our hit rate over ~11%. */
  private flattener(): number {
    return clamp(this.myHits / Math.max(1, this.myShotsPassed) / 0.11, 0, 1.2);
  }

  private neighbors(features: number[]): { gf: number; w: number }[] {
    const n = this.points.length;
    if (n === 0) return [];
    const k = Math.max(6, Math.min(60, Math.round(2 * Math.sqrt(n))));
    const flat = this.flattener();
    const scored = this.points.map((p) => {
      let d = 0;
      for (let j = 0; j < features.length; j++) d += SURF_FEATURE_WEIGHTS[j] * Math.abs(features[j] - p.features[j]);
      return { d, p };
    });
    scored.sort((a, b) => a.d - b.d);
    const kk = Math.min(k, n);
    const scale = Math.max(1e-6, scored[kk - 1].d);
    const out: { gf: number; w: number }[] = [];
    for (let i = 0; i < kk; i++) {
      const p = scored[i].p;
      const gate = p.isVisit ? flat : 1;
      out.push({ gf: p.gf, w: p.weight * gate * Math.exp((-scored[i].d / scale) * 2) });
    }
    return out;
  }

  private dangerAt(nb: { gf: number; w: number }[], gf: number): number {
    let s = 0;
    for (const x of nb) s += x.w * Math.exp(-Math.abs(x.gf - gf) * 12);
    return s;
  }

  /** Textbook-surfer wall smoothing (stick 130, margin 40). */
  private wallSmooth(x: number, y: number, heading: number, od: number, W: number, H: number): number {
    const safe = (h: number): boolean => {
      const p = project(x, y, h, 130);
      return p.x > 40 && p.x < W - 40 && p.y > 40 && p.y < H - 40;
    };
    if (safe(heading)) return normalizeAbsolute(heading);
    for (let a = 5; a <= 175; a += 5) {
      if (safe(heading + od * a)) return normalizeAbsolute(heading + od * a);
      if (safe(heading - od * a)) return normalizeAbsolute(heading - od * a);
    }
    return absoluteBearing(x, y, W / 2, H / 2);
  }

  /**
   * Replay the surfer's decision against a bullet WE are about to fire, and
   * return the position it would be intercepted at — our aim point.
   */
  predictDodge(gs: GameState, power: number): { x: number; y: number } | null {
    if (this.points.length < 6) return null;
    const me = gs.me;
    const en = gs.enemy;
    const W = gs.arenaWidth;
    const H = gs.arenaHeight;
    const bSpeed = bulletSpeed(power);
    const wave: TrackedWave = {
      fireTime: gs.me.time,
      originX: me.x,
      originY: me.y,
      power,
      bSpeed,
      refAngle: absoluteBearing(me.x, me.y, en.x, en.y),
      orbitDir: (() => {
        const rel = (en.direction - absoluteBearing(me.x, me.y, en.x, en.y)) * RAD;
        const lat = en.speed * Math.sin(rel);
        return lat === 0 ? 1 : sign(lat);
      })(),
      mea: maxEscapeAngle(bSpeed),
      features: enemyFeatures(gs, me.x, me.y, power),
    };
    const nb = this.neighbors(wave.features);

    // The standard surfer's option set: orbit CCW, orbit CW, or brake.
    const options: Array<{ od: number; drive: number; penalty: number }> = [
      { od: 1, drive: 1, penalty: 1.0 },
      { od: -1, drive: 1, penalty: 1.0 },
      { od: 1, drive: 0, penalty: 1.3 },
    ];

    let bestPos = { x: en.x, y: en.y };
    let bestDanger = Infinity;
    for (const opt of options) {
      const pos = this.simulateDodge(gs, wave, opt.od, opt.drive);
      const d = this.dangerAt(nb, this.gfOf(wave, pos.x, pos.y)) * opt.penalty;
      if (d < bestDanger) {
        bestDanger = d;
        bestPos = pos;
      }
    }
    return bestPos;
  }

  /** Exact-physics simulation of the enemy surfing our wave with one option. */
  private simulateDodge(gs: GameState, wave: TrackedWave, od: number, drive: number): { x: number; y: number } {
    const me = gs.me;
    const W = gs.arenaWidth;
    const H = gs.arenaHeight;
    let x = gs.enemy.x;
    let y = gs.enemy.y;
    let h = gs.enemy.direction;
    let vel = gs.enemy.speed;
    let t = gs.me.time;

    for (let step = 0; step < 130; step++) {
      // Textbook orbit: perpendicular to the line to the threat ± distance lean.
      const bearing = absoluteBearing(x, y, me.x, me.y);
      const d = dist(x, y, me.x, me.y);
      const lean = clamp((500 - d) * 0.1, -30, 30);
      const target = this.wallSmooth(x, y, bearing + od * (90 + lean), od, W, H);
      const turn = clamp(normalizeRelative(target - h), -maxTurnRate(vel), maxTurnRate(vel));
      h = normalizeAbsolute(h + turn);
      vel = nextVelocity(vel, drive === 0 ? 0 : drive);
      x += Math.cos(h * RAD) * vel;
      y += Math.sin(h * RAD) * vel;
      if (x < BOT_RADIUS || x > W - BOT_RADIUS || y < BOT_RADIUS || y > H - BOT_RADIUS) {
        x = clamp(x, BOT_RADIUS, W - BOT_RADIUS);
        y = clamp(y, BOT_RADIUS, H - BOT_RADIUS);
        vel = 0;
      }
      t++;
      if ((t - wave.fireTime) * wave.bSpeed >= dist(wave.originX, wave.originY, x, y)) break;
    }
    return { x, y };
  }
}
