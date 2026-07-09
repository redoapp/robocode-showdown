import { GameState } from "./state.ts";
import { DangerModel } from "./danger.ts";
import {
  absoluteBearing,
  normalizeRelative,
  normalizeAbsolute,
  dist,
  clamp,
  sign,
  project,
  distanceToWall,
  RAD,
} from "./geom.ts";
import { bulletSpeed, maxEscapeAngle, nextVelocity, maxTurnRate, MAX_SPEED, BOT_RADIUS } from "./physics.ts";

export interface EnemyWave {
  fireTime: number;
  originX: number;
  originY: number;
  power: number;
  bSpeed: number;
  refAngle: number; // absolute angle enemy(origin) -> me at fire time
  lateralDir: number; // my orbit direction around the enemy at fire time
  mea: number;
  distAtFire: number;
  features: number[]; // situation of ME when the enemy fired
  logged: boolean;
  /** GuessFactors the enemy's (mirrored) GF gun would have aimed this wave at. */
  mirrorGfs: number[] | null;
}

export interface MoveCommand {
  turn: number; // relative body turn (deg), CCW positive
  drive: number; // forward distance to request
  maxSpeed: number;
}

/** One of our bullets in flight — used to compute bullet shadows. */
export interface MyBullet {
  fireTime: number;
  power: number;
  x: number;
  y: number;
  dir: number; // absolute travel angle (deg)
}

type Shadow = [number, number]; // [loGF, hiGF] of a wave that our bullet guards

const DESIRED_DIST = 540;
const WALL_MARGIN = 40;
const MAX_LEAN = 24;

/**
 * My situation features at the enemy's fire time, for the danger model:
 * bullet flight time, lateral/advancing velocity, my speed, and how much room
 * I have along my orbit tangent in each direction (wall pressure).
 */
function myFeatures(gs: GameState, sourceX: number, sourceY: number, power: number): number[] {
  const me = gs.me;
  const absToMe = absoluteBearing(sourceX, sourceY, me.x, me.y);
  const relHeading = (me.direction - absToMe) * RAD;
  const lateral = me.speed * Math.sin(relHeading);
  const advancing = me.speed * Math.cos(relHeading);
  const d = dist(sourceX, sourceY, me.x, me.y);
  const bft = d / bulletSpeed(power);

  const od = lateral === 0 ? 1 : sign(lateral);
  const towardSource = absoluteBearing(me.x, me.y, sourceX, sourceY);
  const tangent = towardSource + od * 90;
  const wallFwd = distanceToWall(me.x, me.y, tangent, gs.arenaWidth, gs.arenaHeight);
  const wallRev = distanceToWall(me.x, me.y, tangent + 180, gs.arenaWidth, gs.arenaHeight);

  return [
    clamp(bft / 80, 0, 1.5),
    clamp(Math.abs(lateral) / MAX_SPEED, 0, 1),
    clamp((advancing + MAX_SPEED) / (2 * MAX_SPEED), 0, 1),
    clamp(Math.abs(me.speed) / MAX_SPEED, 0, 1),
    clamp(wallFwd / 500, 0, 1),
    clamp(wallRev / 500, 0, 1),
  ];
}

export class Surfer {
  private danger = new DangerModel();
  private waves: EnemyWave[] = [];
  private orbitDir = 1;
  private surfDir = 1; // committed surfing direction (hysteresis against thrashing)
  private timesHit = 0;
  private wavesFaced = 1;
  lastChosenDir = 1;
  lastDangers: { cw: number; ccw: number; stop: number } = { cw: 0, ccw: 0, stop: 0 };

  debug(): string {
    return `hitByEnemy=${this.timesHit} wavesFaced=${this.wavesFaced} dangerPts=${this.danger.size()}`;
  }
  hitCount(): number {
    return this.timesHit;
  }

  onRoundStart(): void {
    this.waves = [];
  }

  /** How hard to run the flattener: harder the more the enemy is landing hits. */
  private flattenerWeight(): number {
    const hitRate = this.timesHit / this.wavesFaced;
    return clamp(0.2 + hitRate * 1.2, 0.2, 0.6);
  }

  activeWaves(): EnemyWave[] {
    return this.waves;
  }
  dangerModelSize(): number {
    return this.danger.size();
  }

  /** Detect a fresh enemy shot from an energy drop and spawn a wave. */
  detectWave(gs: GameState, energyDropFromShot: number, mirrorGfs: number[] | null = null): void {
    if (energyDropFromShot < 0.09 || energyDropFromShot > 3.01) return;
    const power = clamp(energyDropFromShot, 0.1, 3.0);
    const bSpeed = bulletSpeed(power);
    const me = gs.me;
    // The bullet was fired one scan ago, from the enemy's PREVIOUS position — the
    // energy drop only shows up on the following scan. Using the current position
    // (off by one turn, up to 8px + one turn of flight) mis-times every dodge.
    const src = gs.prevEnemy ?? gs.enemy;
    const ox = src.x;
    const oy = src.y;
    const fireTime = src.time;
    this.waves.push({
      fireTime,
      originX: ox,
      originY: oy,
      power,
      bSpeed,
      refAngle: absoluteBearing(ox, oy, me.x, me.y),
      lateralDir: this.orbitDir,
      mea: maxEscapeAngle(bSpeed),
      distAtFire: dist(ox, oy, me.x, me.y),
      features: myFeatures(gs, ox, oy, power),
      logged: false,
      mirrorGfs,
    });
  }

  /** Record the GF where a bullet actually hit us (strong danger signal). */
  onHitByBullet(power: number, myX: number, myY: number, time: number): void {
    // Attribute the hit to the wave whose radius best matches our distance now.
    let best: EnemyWave | null = null;
    let bestErr = 1e9;
    for (const w of this.waves) {
      const radius = (time - w.fireTime) * w.bSpeed;
      const err = Math.abs(radius - dist(w.originX, w.originY, myX, myY));
      if (err < bestErr) {
        bestErr = err;
        best = w;
      }
    }
    if (best && bestErr < 50) {
      this.logWave(best, myX, myY, 3.0);
      best.logged = true;
      this.timesHit++;
    }
  }

  private gfOfPosition(w: EnemyWave, x: number, y: number): number {
    const angle = absoluteBearing(w.originX, w.originY, x, y);
    const offset = normalizeRelative(angle - w.refAngle) * RAD;
    return clamp((offset / w.mea) * w.lateralDir, -1, 1);
  }

  private logWave(w: EnemyWave, x: number, y: number, weight: number): void {
    this.danger.log(w.features, this.gfOfPosition(w, x, y), weight);
  }

  /**
   * Desired orbit heading around the enemy: perpendicular to the line of sight,
   * leaning out/in to hold DESIRED_DIST, wall-smoothed. Used both by prediction
   * and by the actual drive command so the two NEVER disagree.
   */
  private orbitHeading(x: number, y: number, ex: number, ey: number, od: number, W: number, H: number): number {
    const bearing = absoluteBearing(x, y, ex, ey);
    const d = dist(x, y, ex, ey);
    const lean = clamp((DESIRED_DIST - d) * 0.1, -MAX_LEAN, MAX_LEAN);
    return this.wallSmooth(x, y, bearing + od * (90 + lean), od, W, H);
  }

  /**
   * Simulate driving with orbit direction `od` (drive=0 → brake) around the
   * enemy, using the REAL game physics, until wave `w` intercepts us. Returns
   * the GuessFactor we'd be caught at plus the bot state at that moment, so a
   * second wave can be surfed FROM there (depth-2 surfing).
   */
  private predict(
    gs: GameState,
    w: EnemyWave,
    od: number,
    drive: number,
    start?: { x: number; y: number; heading: number; vel: number; time: number },
  ): { gf: number; end: { x: number; y: number; heading: number; vel: number; time: number } } {
    let x = start ? start.x : gs.me.x;
    let y = start ? start.y : gs.me.y;
    let heading = start ? start.heading : gs.me.direction;
    let vel = start ? start.vel : gs.me.speed;
    let time = start ? start.time : gs.me.time;
    const W = gs.arenaWidth;
    const H = gs.arenaHeight;

    for (let t = 1; t <= 130; t++) {
      const radius = (time + 1 - w.fireTime) * w.bSpeed;
      if (radius >= dist(w.originX, w.originY, x, y) - BOT_RADIUS) break;
      const desired = this.orbitHeading(x, y, gs.enemy.x, gs.enemy.y, od, W, H);
      const turn = clamp(normalizeRelative(desired - heading), -maxTurnRate(vel), maxTurnRate(vel));
      heading = normalizeAbsolute(heading + turn);
      vel = nextVelocity(vel, drive);
      x += Math.cos(heading * RAD) * vel;
      y += Math.sin(heading * RAD) * vel;
      if (x < BOT_RADIUS || x > W - BOT_RADIUS || y < BOT_RADIUS || y > H - BOT_RADIUS) {
        x = clamp(x, BOT_RADIUS, W - BOT_RADIUS);
        y = clamp(y, BOT_RADIUS, H - BOT_RADIUS);
        vel = 0; // wall stops us dead — model it honestly
      }
      time++;
    }
    return { gf: this.gfOfPosition(w, x, y), end: { x, y, heading, vel, time } };
  }

  /** Rotate a desired heading away from walls so we never smear along them. */
  private wallSmooth(x: number, y: number, heading: number, od: number, W: number, H: number): number {
    const safe = (h: number): boolean => {
      const ahead = project(x, y, h, 140);
      return ahead.x > WALL_MARGIN && ahead.x < W - WALL_MARGIN && ahead.y > WALL_MARGIN && ahead.y < H - WALL_MARGIN;
    };
    if (safe(heading)) return normalizeAbsolute(heading);
    for (let a = 6; a <= 174; a += 6) {
      if (safe(heading + od * a)) return normalizeAbsolute(heading + od * a);
      if (safe(heading - od * a)) return normalizeAbsolute(heading - od * a);
    }
    // Cornered — head for the centre.
    return absoluteBearing(x, y, W / 2, H / 2);
  }

  /** Advance waves; flatten (low-weight log) any wave that just passed us. */
  update(gs: GameState, myBullets: MyBullet[] = []): MoveCommand {
    const me = gs.me;
    // Refresh orbit direction from our current motion around the enemy.
    const absToMe = absoluteBearing(gs.enemy.x, gs.enemy.y, me.x, me.y);
    const rel = (me.direction - absToMe) * RAD;
    const lat = me.speed * Math.sin(rel);
    if (Math.abs(lat) > 0.3) this.orbitDir = sign(lat);

    // Retire passed waves; log a flattener sample as each clears us.
    const flatW = this.flattenerWeight();
    const remaining: EnemyWave[] = [];
    for (const w of this.waves) {
      const radius = (me.time - w.fireTime) * w.bSpeed;
      const d = dist(w.originX, w.originY, me.x, me.y);
      if (radius >= d + BOT_RADIUS) {
        this.wavesFaced++;
        if (!w.logged) this.logWave(w, me.x, me.y, flatW); // flattener
      } else {
        remaining.push(w);
      }
    }
    this.waves = remaining;

    // The two most imminent waves, by time to reach us.
    const upcoming = this.waves
      .map((w) => ({
        w,
        timeLeft: (dist(w.originX, w.originY, me.x, me.y) - (me.time - w.fireTime) * w.bSpeed) / w.bSpeed,
      }))
      .filter((e) => e.timeLeft >= -1)
      .sort((a, b) => a.timeLeft - b.timeLeft);

    if (upcoming.length === 0) {
      // No incoming fire — orbit smoothly in our committed direction.
      this.lastChosenDir = this.surfDir;
      this.lastDangers = { cw: 0, ccw: 0, stop: 0 };
      return this.orbitCommand(gs, this.surfDir, 1);
    }

    const w1 = upcoming[0].w;
    const w2 = upcoming.length > 1 ? upcoming[1].w : null;

    const shadows = this.bulletShadows(gs, w1, myBullets);
    const nb1 = this.danger.neighbors(w1.features);
    const nb2 = w2 ? this.danger.neighbors(w2.features) : null;

    const shadowFactor = (gf: number): number => {
      for (const [lo, hi] of shadows) if (gf >= lo && gf <= hi) return 0.05;
      return 1;
    };

    // Danger spikes at the exact GFs a mirrored statistical gun predicts for
    // this wave — dodging the enemy's aim, not just historical averages.
    const mirrorDanger = (w: EnemyWave, gf: number): number => {
      if (!w.mirrorGfs) return 0;
      let d = 0;
      for (let i = 0; i < w.mirrorGfs.length; i++) {
        const flavorW = i === 0 ? 1.0 : 0.7; // all-data flavor is the usual default
        d += flavorW * Math.exp(-Math.abs(gf - w.mirrorGfs[i]) * 14);
      }
      d += 0.4 * Math.exp(-Math.abs(gf) * 14); // the ever-present head-on flavor
      return d;
    };

    // Depth-2 surfing: for each first-wave option, ALSO simulate the best
    // continuation against the second wave from where option one leaves us.
    // bcn (and most surfers) only look one wave deep — this is our edge.
    const evalOpt = (od: number, drive: number, penalty: number): number => {
      const r1 = this.predict(gs, w1, od, drive);
      let d =
        (this.danger.dangerAt(nb1, r1.gf) + 2.0 * mirrorDanger(w1, r1.gf)) * shadowFactor(r1.gf) * penalty;
      if (w2 && nb2) {
        let best2 = Infinity;
        for (const [od2, dr2] of [
          [od, 1],
          [-od, 1],
          [od, 0],
        ] as const) {
          const r2 = this.predict(gs, w2, od2, dr2, r1.end);
          const d2 = this.danger.dangerAt(nb2, r2.gf) + 2.0 * mirrorDanger(w2, r2.gf);
          if (d2 < best2) best2 = d2;
        }
        d += 0.6 * best2;
      }
      return d;
    };

    const cur = this.surfDir;
    const dKeep = evalOpt(cur, 1, 1.0);
    const dFlip = evalOpt(-cur, 1, 1.0);
    const dStop = evalOpt(cur, 0, 1.2); // slight bias for staying mobile
    this.lastDangers = { cw: cur > 0 ? dFlip : dKeep, ccw: cur > 0 ? dKeep : dFlip, stop: dStop };

    let drive = 1;
    if (dFlip < dKeep && dFlip < dStop) {
      this.surfDir = -cur;
    } else if (dStop < dKeep && dStop < dFlip) {
      drive = 0;
    }
    this.lastChosenDir = drive === 0 ? 0 : this.surfDir;

    return this.orbitCommand(gs, this.surfDir, drive);
  }

  /**
   * GF intervals of `wave` covered by our own in-flight bullets. Where our bullet
   * crosses the enemy's future wavefront, the enemy cannot have a bullet there
   * (they'd collide), so that slice of the wave is safe to surf into.
   */
  private bulletShadows(gs: GameState, wave: EnemyWave, bullets: MyBullet[]): Shadow[] {
    const out: Shadow[] = [];
    const now = gs.me.time;
    for (const b of bullets) {
      const bs = bulletSpeed(b.power);
      let prev = (now - wave.fireTime) * wave.bSpeed - dist(wave.originX, wave.originY, b.x, b.y);
      for (let t = now + 1; t <= now + 110; t++) {
        const age = t - b.fireTime;
        const bx = b.x + Math.cos(b.dir * RAD) * bs * age;
        const by = b.y + Math.sin(b.dir * RAD) * bs * age;
        const cur = (t - wave.fireTime) * wave.bSpeed - dist(wave.originX, wave.originY, bx, by);
        if (prev < 0 && cur >= 0) {
          const gf = this.gfOfPosition(wave, bx, by);
          out.push([gf - 0.05, gf + 0.05]);
          break;
        }
        prev = cur;
        if (cur > 220) break;
      }
    }
    return out;
  }

  /** Actuate EXACTLY what predict() simulates: turn toward the orbit heading, drive forward or brake. */
  private orbitCommand(gs: GameState, od: number, drive: number): MoveCommand {
    const me = gs.me;
    const desired = this.orbitHeading(me.x, me.y, gs.enemy.x, gs.enemy.y, od, gs.arenaWidth, gs.arenaHeight);
    const turn = normalizeRelative(desired - me.direction);
    return { turn, drive: drive * 100, maxSpeed: MAX_SPEED };
  }
}
