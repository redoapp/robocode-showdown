/**
 * Geometry helpers. Tank Royale uses absolute angles in DEGREES, measured
 * counter-clockwise from East (standard math convention), with the origin at
 * the bottom-left and +Y pointing up.
 */

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export const toRad = (deg: number): number => deg * RAD;
export const toDeg = (rad: number): number => rad * DEG;

/** Absolute direction (deg, 0..360) from (x1,y1) to (x2,y2). */
export function absoluteBearing(x1: number, y1: number, x2: number, y2: number): number {
  return normalizeAbsolute(Math.atan2(y2 - y1, x2 - x1) * DEG);
}

/** Normalize to [0, 360). */
export function normalizeAbsolute(angle: number): number {
  let a = angle % 360;
  if (a < 0) a += 360;
  return a;
}

/** Normalize to (-180, 180]. */
export function normalizeRelative(angle: number): number {
  let a = angle % 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a;
}

export function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Project a point `distance` px from (x,y) along absolute angle `angleDeg`. */
export function project(x: number, y: number, angleDeg: number, distance: number): { x: number; y: number } {
  const r = angleDeg * RAD;
  return { x: x + Math.cos(r) * distance, y: y + Math.sin(r) * distance };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const sign = (v: number): number => (v < 0 ? -1 : 1);

/** Distance from (x,y) along absolute heading `angleDeg` until leaving the arena. */
export function distanceToWall(x: number, y: number, angleDeg: number, w: number, h: number): number {
  const dx = Math.cos(angleDeg * RAD);
  const dy = Math.sin(angleDeg * RAD);
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (w - x) / dx);
  else if (dx < -1e-9) t = Math.min(t, -x / dx);
  if (dy > 1e-9) t = Math.min(t, (h - y) / dy);
  else if (dy < -1e-9) t = Math.min(t, -y / dy);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}
