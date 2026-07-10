/**
 * Wave-surfing movement (https://robowiki.net/wiki/Wave_Surfing).
 *
 * Each tick we:
 *   1. detect enemy fire (energy drop) and spawn an EnemyWave;
 *   2. advance active waves; when one passes us, log where we were (flattener)
 *      and drop it;
 *   3. for the nearest incoming wave, precisely simulate our motion for each
 *      option — orbit one way, orbit the other, or stop — predict the GF we'd be
 *      intercepted at, look up its danger, and pick the safest;
 *   4. when actually hit, record the hit GF so we learn to avoid it.
 *
 * This is classic single-wave "true surfing" with precise prediction; it makes
 * the bot far harder to hit than plain orbiting.
 */
import { absoluteBearing, clip, dist, nonzeroSign, normalizeAbsolute, normalizeRelative, project } from "./geom.ts";
import { GameState } from "./gameState.ts";
import { maxTurnRate, nextVelocity, bulletSpeed, BOT_RADIUS } from "./physics.ts";
import { orbitHeading } from "./drive.ts";
import { EnemyWave } from "./enemyWave.ts";
import { DangerModel, type Neighbor } from "./dangerModel.ts";
import { HitRateTracker } from "./hitRate.ts";

export interface MoveCommand {
  turn: number; // relative body turn, degrees CCW (setTurnLeft)
  drive: number; // signed distance to setForward
  maxSpeed: number;
}

/** One of our bullets in flight (for bullet-shadow computation). */
export interface MyBullet {
  fireTime: number;
  power: number;
  x: number;
  y: number;
  dir: number;
}

type ShadowInterval = [number, number]; // [loGF, hiGF]

interface Option {
  orbitDir: number;
  drive: number; // +1 forward, -1 backward, 0 stop
}

const OPTIONS: Option[] = [
  { orbitDir: 1, drive: 1 },
  { orbitDir: -1, drive: 1 },
  { orbitDir: 1, drive: 0 }, // stop
];

export class Surfer {
  private readonly danger = new DangerModel();
  private waves: EnemyWave[] = [];
  private lastOrbitDir = 1;
  private readonly enemyHitTracker: HitRateTracker;

  constructor(enemyHitTracker: HitRateTracker) {
    this.enemyHitTracker = enemyHitTracker;
  }

  onRoundStart(): void {
    this.waves = [];
  }

  /** Learn from a bullet that just hit us. */
  onHitByBullet(power: number, myX: number, myY: number, time: number): void {
    const w = this.matchWave(power, myX, myY, time);
    if (w) this.danger.logHit(w.features, w.gfOf(myX, myY));
  }

  private matchWave(power: number, myX: number, myY: number, time: number): EnemyWave | undefined {
    let best: EnemyWave | undefined;
    let bestErr = Infinity;
    for (const w of this.waves) {
      if (Math.abs(w.power - power) > 0.15) continue;
      const err = Math.abs(w.radiusAt(time) - dist(w.sourceX, w.sourceY, myX, myY));
      if (err < bestErr) {
        bestErr = err;
        best = w;
      }
    }
    return bestErr < 60 ? best : undefined;
  }

  /** Advance surfing and return this tick's movement command. */
  update(gs: GameState, myBullets: MyBullet[] = []): MoveCommand {
    const me = gs.me;
    const now = me.time;

    // 1. Detect enemy fire -> new wave from the enemy's previous position.
    if (gs.enemyJustFired && gs.prevEnemy) {
      this.waves.push(
        new EnemyWave(gs, gs.prevEnemy.x, gs.prevEnemy.y, gs.prevEnemy.time, gs.enemyFirePower),
      );
    }

    // 2. Drop waves that have passed us (log a flattener visit as they go).
    const stillActive: EnemyWave[] = [];
    for (const w of this.waves) {
      if (w.hasPassed(now, me.x, me.y)) {
        this.danger.logVisit(w.features, w.gfOf(me.x, me.y));
        this.enemyHitTracker.logShotPassed(w.power);
      } else {
        stillActive.push(w);
      }
    }
    this.waves = stillActive;

    // 3. Choose a move: surf the nearest incoming wave, else just orbit.
    const wave = this.nearestWave(gs);
    if (!wave) {
      return this.orbitCommand(gs, this.lastOrbitDir);
    }

    const neighbors = this.danger.neighbors(wave);
    // Turn the flattener up only when the enemy is landing hits on us.
    const flattener = clip(this.enemyHitTracker.getHitRate() / 0.11, 0, 1.2);
    // GF regions of this wave that our own bullets shadow (safe to sit in).
    const shadows = this.bulletShadows(gs, wave, myBullets);
    let best: Option = OPTIONS[0];
    let bestDanger = Infinity;
    for (const opt of OPTIONS) {
      const gf = this.predictInterceptGF(gs, wave, opt);
      let d = this.danger.danger(neighbors, gf, flattener);
      if (this.isShadowed(gf, shadows)) d *= 0.05; // a shot of ours guards this GF
      if (opt.drive === 0) d *= 1.3; // prefer to keep moving
      if (d < bestDanger) {
        bestDanger = d;
        best = opt;
      }
    }

    if (best.drive !== 0) this.lastOrbitDir = best.orbitDir;
    return this.orbitCommand(gs, best.orbitDir, best.drive);
  }

  private isShadowed(gf: number, shadows: ShadowInterval[]): boolean {
    for (const [lo, hi] of shadows) {
      if (gf >= lo && gf <= hi) return true;
    }
    return false;
  }

  /**
   * GF intervals of `wave` covered by "bullet shadows": where one of our own
   * in-flight bullets crosses the enemy's wavefront, the enemy can't have a
   * bullet (it would collide with ours), so those GFs are safe.
   */
  private bulletShadows(gs: GameState, wave: EnemyWave, bullets: MyBullet[]): ShadowInterval[] {
    const out: ShadowInterval[] = [];
    const now = gs.me.time;
    for (const b of bullets) {
      const bs = bulletSpeed(b.power);
      let prev = wave.radiusAt(now) - dist(wave.sourceX, wave.sourceY, b.x, b.y);
      for (let t = now + 1; t <= now + 120; t++) {
        const age = t - b.fireTime;
        const bx = b.x + Math.cos((b.dir * Math.PI) / 180) * bs * age;
        const by = b.y + Math.sin((b.dir * Math.PI) / 180) * bs * age;
        const cur = wave.radiusAt(t) - dist(wave.sourceX, wave.sourceY, bx, by);
        if (prev < 0 && cur >= 0) {
          // Our bullet is on the wavefront this tick -> it shadows this GF.
          const gf = wave.gfOf(bx, by);
          out.push([gf - 0.04, gf + 0.04]);
          break;
        }
        prev = cur;
        if (cur > 200) break; // wave has passed our bullet
      }
    }
    return out;
  }

  private nearestWave(gs: GameState): EnemyWave | undefined {
    const me = gs.me;
    let best: EnemyWave | undefined;
    let bestDist = Infinity;
    for (const w of this.waves) {
      const gap = dist(w.sourceX, w.sourceY, me.x, me.y) - w.radiusAt(me.time);
      if (gap > -BOT_RADIUS && gap < bestDist) {
        bestDist = gap;
        best = w;
      }
    }
    return best;
  }

  /** Precisely simulate an option until the wave passes; return intercept GF. */
  private predictInterceptGF(gs: GameState, wave: EnemyWave, opt: Option): number {
    const W = gs.arenaWidth;
    const H = gs.arenaHeight;
    const e = gs.enemy!;
    let x = gs.me.x;
    let y = gs.me.y;
    let heading = gs.me.direction;
    let vel = gs.me.speed;
    let t = gs.me.time;

    for (let step = 0; step < 130; step++) {
      const target = orbitHeading(x, y, e.x, e.y, opt.orbitDir, W, H);
      const turn = clip(normalizeRelative(target - heading), -maxTurnRate(vel), maxTurnRate(vel));
      heading = normalizeAbsolute(heading + turn);
      vel = nextVelocity(vel, opt.drive === 0 ? 0 : opt.drive);
      let nx = x + Math.cos((heading * Math.PI) / 180) * vel;
      let ny = y + Math.sin((heading * Math.PI) / 180) * vel;
      // Wall collision: clamp and stop.
      if (nx < BOT_RADIUS || nx > W - BOT_RADIUS || ny < BOT_RADIUS || ny > H - BOT_RADIUS) {
        nx = clip(nx, BOT_RADIUS, W - BOT_RADIUS);
        ny = clip(ny, BOT_RADIUS, H - BOT_RADIUS);
        vel = 0;
      }
      x = nx;
      y = ny;
      t++;
      if (wave.hasPassed(t, x, y)) break;
    }
    return wave.gfOf(x, y);
  }

  /**
   * Turn/drive command to orbit the enemy in the given direction. Mirrors the
   * predictor exactly (turn toward the orbit heading, drive forward) so the
   * danger we simulated is the danger we actually take.
   */
  private orbitCommand(gs: GameState, orbitDir: number, drive = 1): MoveCommand {
    const me = gs.me;
    const e = gs.enemy!;
    const target = orbitHeading(me.x, me.y, e.x, e.y, orbitDir, gs.arenaWidth, gs.arenaHeight);
    const turn = normalizeRelative(target - me.direction);
    return { turn, drive: drive * 100, maxSpeed: 8 };
  }
}
