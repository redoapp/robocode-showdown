/**
 * Feature extraction for the GuessFactor KNN gun (and, later, the surfing
 * danger model). Given the current game state, produces the wave geometry
 * (absolute bearing to the enemy, orbit direction, max escape angle) plus a
 * normalized feature vector describing the enemy's movement situation.
 *
 * The feature set covers bullet flight time, lateral/advancing
 * velocity, acceleration, "time since ..." timers, recent displacement, and
 * wall restriction. These segment the enemy's behaviour well enough for KNN to
 * find similar past situations and predict where it will go.
 */
import { absoluteBearing, clip, dist, distanceToWall, nonzeroSign, normalizeRelative, toRad } from "./geom.ts";
import { GameState, type Snapshot } from "./gameState.ts";
import { bulletSpeed, MAX_SPEED } from "./physics.ts";

/** Per-feature weights for the KNN distance metric (parallel to the vectors). */
export const FEATURE_WEIGHTS: number[] = [
  4.0, // bft (bullet flight time)
  3.0, // |lateral velocity|
  1.6, // advancing velocity
  3.0, // acceleration
  1.6, // |velocity|
  2.6, // dir-change timer
  2.0, // decel timer
  1.0, // velocity-change timer
  1.6, // displacement last 10
  1.6, // displacement last 20
  2.2, // wall ahead (orbit direction)
  1.0, // wall reverse
];

export interface WaveSetup {
  sourceX: number;
  sourceY: number;
  absBearing: number; // absolute bearing from source to enemy (deg)
  orbitDir: number; // +1 / -1: which way the enemy orbits us
  mae: number; // simple max escape angle (deg)
  distance: number;
  features: number[];
}

/** Simple max escape angle in degrees for a given bullet power. */
export function maxEscapeAngle(power: number): number {
  const ratio = Math.min(1, MAX_SPEED / bulletSpeed(power));
  return (Math.asin(ratio) * 180) / Math.PI;
}

/**
 * Build the wave geometry + normalized feature vector for firing "now".
 * `lastOrbitDir` is used when the enemy is momentarily stationary.
 */
export function extractWaveSetup(gs: GameState, power: number, lastOrbitDir: number): WaveSetup {
  const hist = gs.enemyHistory;
  const e = gs.enemy!;
  const me = gs.me;
  const sourceX = me.x;
  const sourceY = me.y;

  const absBearing = absoluteBearing(sourceX, sourceY, e.x, e.y);
  const distance = dist(sourceX, sourceY, e.x, e.y);
  const speed = bulletSpeed(power);
  const bft = distance / speed;

  // Lateral / advancing velocity relative to the line from us to the enemy.
  const relHeadingRad = toRad(e.direction - absBearing);
  const latVel = e.speed * Math.sin(relHeadingRad);
  const advVel = e.speed * Math.cos(relHeadingRad);

  const orbitDir = latVel === 0 ? nonzeroSign(lastOrbitDir) : nonzeroSign(latVel);
  const moveDir = e.speed === 0 ? 0 : nonzeroSign(e.speed);

  // Acceleration: signed by whether |speed| grew or shrank.
  const n = hist.length;
  const prev: Snapshot = n >= 2 ? hist[n - 2] : e;
  const accel = Math.abs(e.speed - prev.speed) * (Math.abs(e.speed) < Math.abs(prev.speed) ? -1 : 1);

  // Timers: ticks since the enemy last changed velocity / direction / decelerated.
  let vChangeTimer = n;
  let dirChangeTimer = n;
  let decelTimer = n;
  let md = moveDir;
  for (let i = 1; i < Math.min(72, n); i++) {
    const cur = hist[n - i];
    const before = hist[n - i - 1];
    if (vChangeTimer === n && Math.abs(cur.speed - before.speed) > 0.01) vChangeTimer = i - 1;
    if (cur.speed !== 0) {
      if (md === 0) md = nonzeroSign(cur.speed);
      else if (dirChangeTimer === n && nonzeroSign(cur.speed) !== md) dirChangeTimer = i - 1;
    }
    if (decelTimer === n && md !== 0 && before.speed * md > cur.speed * md) decelTimer = i - 1;
  }

  const idx10 = Math.max(0, n - 1 - 10);
  const idx20 = Math.max(0, n - 1 - 20);
  const distanceLast10 = dist(e.x, e.y, hist[idx10].x, hist[idx10].y);
  const distanceLast20 = dist(e.x, e.y, hist[idx20].x, hist[idx20].y);

  // Wall restriction: how far the enemy can travel (along its orbit tangent)
  // before hitting a wall, in the forward and reverse orbit directions.
  const tangent = absBearing + orbitDir * 90;
  const wallFwd = distanceToWall(e.x, e.y, tangent, gs.arenaWidth, gs.arenaHeight);
  const wallRev = distanceToWall(e.x, e.y, tangent + 180, gs.arenaWidth, gs.arenaHeight);

  const timerNorm = (t: number) => clip(Math.min(t, 60) / Math.max(bft, 8), 0, 1);

  const features: number[] = [
    clip(bft / 80, 0, 1.5),
    clip(Math.abs(latVel) / MAX_SPEED, 0, 1),
    clip((advVel + MAX_SPEED) / (2 * MAX_SPEED), 0, 1),
    clip((accel + 2) / 3, 0, 1),
    clip(Math.abs(e.speed) / MAX_SPEED, 0, 1),
    timerNorm(dirChangeTimer),
    timerNorm(decelTimer),
    timerNorm(vChangeTimer),
    clip(distanceLast10 / 80, 0, 1),
    clip(distanceLast20 / 160, 0, 1),
    clip(wallFwd / 500, 0, 1),
    clip(wallRev / 500, 0, 1),
  ];

  return { sourceX, sourceY, absBearing, orbitDir, mae: maxEscapeAngle(power), distance, features };
}

/** GuessFactor of a target point relative to a wave. */
export function guessFactor(
  sourceX: number,
  sourceY: number,
  absBearing: number,
  orbitDir: number,
  mae: number,
  targetX: number,
  targetY: number,
): number {
  const bearing = absoluteBearing(sourceX, sourceY, targetX, targetY);
  const offset = normalizeRelative(bearing - absBearing);
  return clip((offset / mae) * orbitDir, -1, 1);
}

/** Absolute firing bearing (deg) that corresponds to a given GuessFactor. */
export function bearingForGF(absBearing: number, orbitDir: number, mae: number, gf: number): number {
  return absBearing + gf * orbitDir * mae;
}
