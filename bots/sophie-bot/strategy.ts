// Pure, unit-testable strategy logic for Reboot (no Tank Royale API imports).
// Angles: Tank Royale convention — deg, 0 = east (+x), CCW positive.

/** Max bot speed in units/turn (Tank Royale constant). */
export const MAX_BOT_SPEED = 8;

// A "strategy" is one choice from each dimension below. The bot cycles a random
// combination of (move, shoot, scan) whenever it decides to switch.

export const MOVEMENTS = [
  "antiGravity", // repelled by walls + enemy, hard to pattern-match
  "orbit", // strafe perpendicular to the enemy at a preferred distance
  "stopAndGo", // orbit but pulse start/stop to beat velocity-based aim
  "oscillator", // orbit with random-interval reversals + speed jitter
  "minRisk", // drive to the sampled point with the lowest enemy/wall risk
  "ram", // charge the enemy — good against low-energy / disabled foes
  "randomWalk", // wander on a re-rolled random heading — unpredictable
] as const;

export const TARGETINGS = [
  "headOn", // fire where the enemy currently is
  "linear", // lead assuming constant velocity
  "circular", // lead assuming constant velocity + turn rate
  "guessAngle", // spray inside the enemy's max-escape envelope
] as const;

export const RADARS = [
  "spin", // continuous full sweep — always reacquires
  "lock", // tight infinite-lock for max scan rate
  "sweepLock", // widened oscillating lock — robust if the enemy is fast
] as const;

export type Movement = (typeof MOVEMENTS)[number];
export type Targeting = (typeof TARGETINGS)[number];
export type Radar = (typeof RADARS)[number];

// Curated rotation pools — dominated choices excluded. `ram` is finisher-only;
// `spin` is melee-only, so duels rotate lock/sweepLock.
export const ROTATION_MOVEMENTS: Movement[] = [
  "antiGravity",
  "orbit",
  "stopAndGo",
  "oscillator",
  "minRisk",
  "randomWalk",
];
export const ROTATION_RADARS: Radar[] = ["lock", "sweepLock"];

export interface StrategyCombo {
  movement: Movement;
  targeting: Targeting;
  radar: Radar;
}

export type Rng = () => number;

function pick<T>(list: readonly T[], rng: Rng): T {
  return list[Math.floor(rng() * list.length)] as T;
}

/** Pick a fresh random (move, shoot, scan) combination. */
export function pickRandomCombo(rng: Rng = Math.random): StrategyCombo {
  return {
    movement: pick(ROTATION_MOVEMENTS, rng),
    targeting: pick(TARGETINGS, rng),
    radar: pick(ROTATION_RADARS, rng),
  };
}

export function combosEqual(a: StrategyCombo, b: StrategyCombo): boolean {
  return a.movement === b.movement && a.targeting === b.targeting && a.radar === b.radar;
}

/** New combo guaranteed to differ from `current` so a switch changes something. */
export function pickDifferentCombo(current: StrategyCombo, rng: Rng = Math.random): StrategyCombo {
  for (let i = 0; i < 10; i++) {
    const next = pickRandomCombo(rng);
    if (!combosEqual(next, current)) return next;
  }
  return { ...current, movement: pick(ROTATION_MOVEMENTS, rng) };
}

// --- Geometry helpers ------------------------------------------------------

export interface Vec {
  x: number;
  y: number;
}

export interface EnemySnapshot {
  x: number;
  y: number;
  direction: number;
  speed: number;
}

export interface Arena {
  width: number;
  height: number;
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const BOT_RADIUS = 18;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clampToArena(p: Vec, arena: Arena): Vec {
  return {
    x: clamp(p.x, BOT_RADIUS, arena.width - BOT_RADIUS),
    y: clamp(p.y, BOT_RADIUS, arena.height - BOT_RADIUS),
  };
}

/** Absolute bearing (deg) from `from` to `to` (0 = east, CCW positive). */
export function angleTo(from: Vec, to: Vec): number {
  return Math.atan2(to.y - from.y, to.x - from.x) * DEG;
}

export function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Normalize an angle to (-180, 180]. */
export function normalizeRelative(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

// --- Targeting -------------------------------------------------------------

/** Firepower for a shot: closer + healthier hits harder; low energy throttles
 *  spending. Clamped to the legal [0.1, 3] range. */
export function selectFirepower(distanceToEnemy: number, energy: number): number {
  let power =
    distanceToEnemy < 120
      ? 3
      : distanceToEnemy < 300
        ? 2.4
        : distanceToEnemy < 500
          ? 1.6
          : distanceToEnemy < 750
            ? 1.1
            : 0.7;
  if (energy < 20) power = Math.min(power, 1.2);
  if (energy < 10) power = Math.min(power, 0.6);
  if (energy < 4) power = Math.min(power, 0.2);
  return clamp(power, 0.1, 3);
}

/** Bullet speed for a firepower (Tank Royale: 20 - 3*power). */
export function bulletSpeed(firepower: number): number {
  return 20 - 3 * firepower;
}

/** Enemy's max escape angle (deg) vs a bullet of the given speed. */
export function maxEscapeAngleDeg(speedOfBullet: number): number {
  return Math.asin(clamp(MAX_BOT_SPEED / speedOfBullet, -1, 1)) * DEG;
}

/** Linear intercept: aim assuming constant enemy velocity. Iterates the flight-
 *  time fixed point and clamps the aim point into the arena. */
export function predictLinear(
  shooter: Vec,
  enemy: EnemySnapshot,
  speedOfBullet: number,
  arena: Arena,
): Vec {
  const vx = enemy.speed * Math.cos(enemy.direction * RAD);
  const vy = enemy.speed * Math.sin(enemy.direction * RAD);
  let aim: Vec = { x: enemy.x, y: enemy.y };
  for (let i = 0; i < 12; i++) {
    const t = distance(shooter, aim) / speedOfBullet;
    aim = clampToArena({ x: enemy.x + vx * t, y: enemy.y + vy * t }, arena);
  }
  return aim;
}

/** Circular intercept: steps the enemy's arc (turn rate `angularVelocity`)
 *  forward until the bullet arrives. Reduces to linear when angularVelocity 0. */
export function predictCircular(
  shooter: Vec,
  enemy: EnemySnapshot,
  angularVelocity: number,
  speedOfBullet: number,
  arena: Arena,
): Vec {
  let heading = enemy.direction;
  let p: Vec = { x: enemy.x, y: enemy.y };
  for (let step = 1; step <= 80; step++) {
    heading += angularVelocity;
    p = clampToArena(
      { x: p.x + enemy.speed * Math.cos(heading * RAD), y: p.y + enemy.speed * Math.sin(heading * RAD) },
      arena,
    );
    if (step * speedOfBullet >= distance(shooter, p)) break;
  }
  return p;
}

/** Absolute aim angle (deg) offset from head-on toward the enemy's lateral
 *  motion by a random fraction of its escape angle — sprays the envelope. */
export function guessAngle(
  shooter: Vec,
  enemy: EnemySnapshot,
  speedOfBullet: number,
  rng: Rng = Math.random,
): number {
  const direct = angleTo(shooter, enemy);
  const vx = enemy.speed * Math.cos(enemy.direction * RAD);
  const vy = enemy.speed * Math.sin(enemy.direction * RAD);
  const toEnemyX = enemy.x - shooter.x;
  const toEnemyY = enemy.y - shooter.y;
  const lateral = Math.sign(toEnemyX * vy - toEnemyY * vx) || 1;
  const fraction = 0.35 + rng() * 0.65;
  return direct + lateral * fraction * maxEscapeAngleDeg(speedOfBullet);
}

// --- Strategy-switching (health tracking) ----------------------------------

export interface WindowState {
  elapsedMs: number;
  myEnergyStart: number;
  myEnergyNow: number;
  oppEnergyStart: number;
  oppEnergyNow: number;
  scannedThisWindow: boolean;
}

/** Window ends after `minMs` held OR `lossFraction` of starting health lost,
 *  whichever comes first. */
export function windowComplete(
  state: Pick<WindowState, "elapsedMs" | "myEnergyStart" | "myEnergyNow">,
  minMs: number,
  lossFraction: number,
): boolean {
  const lost = state.myEnergyStart - state.myEnergyNow;
  const lostFraction = state.myEnergyStart > 0 ? lost / state.myEnergyStart : 0;
  return state.elapsedMs >= minMs || lostFraction >= lossFraction;
}

/** Losing the exchange: our energy dropping faster than the opponent's. If we
 *  never scanned the enemy this window, any self-damage counts as losing. */
export function losingTheTrade(state: WindowState): boolean {
  const myLoss = state.myEnergyStart - state.myEnergyNow;
  if (!state.scannedThisWindow) return myLoss > 0;
  const elapsedSec = Math.max(state.elapsedMs / 1000, 1e-3);
  const myRate = myLoss / elapsedSec;
  const oppRate = (state.oppEnergyStart - state.oppEnergyNow) / elapsedSec;
  return myRate > oppRate;
}

export interface RiskEnemy extends Vec {
  energy: number;
}

/** Minimum-risk movement: sample points around `me` and return the one with the
 *  lowest total risk (enemy energy over distance², plus wall-margin penalty). */
export function lowestRiskPoint(
  me: Vec,
  enemies: RiskEnemy[],
  arena: Arena,
  rng: Rng = Math.random,
): Vec {
  const margin = 60;
  let best: Vec = me;
  let bestRisk = Infinity;
  for (let i = 0; i < 16; i++) {
    const angle = ((i + rng()) / 16) * 2 * Math.PI;
    const reach = 90 + rng() * 110;
    const p: Vec = {
      x: clamp(me.x + Math.cos(angle) * reach, margin, arena.width - margin),
      y: clamp(me.y + Math.sin(angle) * reach, margin, arena.height - margin),
    };
    let risk = 0;
    for (const e of enemies) {
      const d = Math.max(distance(p, e), 30);
      risk += Math.max(e.energy, 5) / (d * d);
    }
    const wallDist = Math.min(p.x, p.y, arena.width - p.x, arena.height - p.y);
    risk += 0.4 / Math.max(wallDist, 20) + rng() * 1e-6;
    if (risk < bestRisk) {
      bestRisk = risk;
      best = p;
    }
  }
  return best;
}

/** Melee: true when we're bleeding faster than every tracked enemy — we're the
 *  one being ganged up on, so the current plan isn't protecting us. */
export function worstLossInField(myLossRate: number, enemyLossRates: number[]): boolean {
  return enemyLossRates.length > 0 && enemyLossRates.every((r) => myLossRate > r);
}

/** Melee: true when we're bleeding slower than every tracked enemy — we're
 *  winning the room and should keep pressing. */
export function bestLossInField(myLossRate: number, enemyLossRates: number[]): boolean {
  return enemyLossRates.length > 0 && enemyLossRates.every((r) => myLossRate < r);
}
