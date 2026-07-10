/**
 * Geometry / angle helpers in Tank Royale conventions.
 *
 * Tank Royale uses a standard math coordinate system:
 *   - origin (0,0) at the bottom-left, X grows right, Y grows up
 *   - angles in DEGREES, measured counter-clockwise from East (+X)
 *   - 0° = East, 90° = North, 180° = West, 270° = South
 *   - a point at distance d and direction θ from (x,y) is
 *       (x + cos θ · d, y + sin θ · d)
 *
 * "Left" turns are counter-clockwise (increasing heading); this matches
 * setTurnLeft()/setTurnGunLeft()/setTurnRadarLeft() taking a positive value.
 */

export interface Vec {
  x: number;
  y: number;
}

export const PI = Math.PI;
export const toRad = (deg: number): number => (deg * PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / PI;

/** Normalize an angle to [-180, 180). */
export function normalizeRelative(deg: number): number {
  let a = deg % 360;
  if (a >= 180) a -= 360;
  else if (a < -180) a += 360;
  return a;
}

/** Normalize an angle to [0, 360). */
export function normalizeAbsolute(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** Project a point from (x,y) at an absolute direction (deg) and distance. */
export function project(x: number, y: number, dirDeg: number, dist: number): Vec {
  const r = toRad(dirDeg);
  return { x: x + Math.cos(r) * dist, y: y + Math.sin(r) * dist };
}

/** Absolute direction (deg, [0,360)) pointing from (x1,y1) to (x2,y2). */
export function absoluteBearing(x1: number, y1: number, x2: number, y2: number): number {
  return normalizeAbsolute(toDeg(Math.atan2(y2 - y1, x2 - x1)));
}

/** Euclidean distance. */
export function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function clip(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Sign, returning 0 for 0. */
export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Sign that never returns 0 (0 -> +1). */
export function nonzeroSign(v: number): number {
  return v < 0 ? -1 : 1;
}

/**
 * Distance from (x,y) along absolute heading `dirDeg` until it exits the field
 * [0,width] x [0,height]. Used to see how far a bot can travel before a wall.
 */
export function distanceToWall(
  x: number,
  y: number,
  dirDeg: number,
  width: number,
  height: number,
): number {
  const r = toRad(dirDeg);
  const cx = Math.cos(r);
  const cy = Math.sin(r);
  let best = Infinity;
  if (cx > 1e-9) best = Math.min(best, (width - x) / cx);
  else if (cx < -1e-9) best = Math.min(best, (0 - x) / cx);
  if (cy > 1e-9) best = Math.min(best, (height - y) / cy);
  else if (cy < -1e-9) best = Math.min(best, (0 - y) / cy);
  return Number.isFinite(best) ? Math.max(0, best) : 0;
}
