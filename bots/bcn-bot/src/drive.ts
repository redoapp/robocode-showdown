/**
 * Shared orbit + wall-smoothing helpers, used both to actually drive and to
 * predict our future motion while wave surfing (so prediction matches reality).
 */
import { absoluteBearing, clip, dist, normalizeAbsolute, project } from "./geom.ts";

const PREFERRED_DISTANCE = 500;
const STICK = 130; // wall-smoothing look-ahead

/**
 * Desired absolute heading to orbit the enemy at (ex,ey) in `orbitDir`
 * (+1 / -1), leaning outward when too close and inward when too far, then
 * wall-smoothed so we glide along walls instead of ramming them.
 */
export function orbitHeading(
  mx: number,
  my: number,
  ex: number,
  ey: number,
  orbitDir: number,
  width: number,
  height: number,
): number {
  const bearing = absoluteBearing(mx, my, ex, ey);
  const d = dist(mx, my, ex, ey);
  // lean > 0 when closer than preferred -> point further from enemy (move out)
  const lean = clip((PREFERRED_DISTANCE - d) * 0.1, -30, 30);
  const heading = bearing + orbitDir * (90 + lean);
  return wallSmooth(mx, my, heading, orbitDir, width, height);
}

/**
 * Return a heading close to `heading` whose short look-ahead stays inside the
 * field. Prefers to keep turning in the orbit direction, but will smooth the
 * other way if that's nearer, and always falls back to heading toward center —
 * so the bot never pins itself against a wall.
 */
export function wallSmooth(
  x: number,
  y: number,
  heading: number,
  orbitDir: number,
  width: number,
  height: number,
  margin = 40,
): number {
  const safe = (h: number): boolean => {
    const p = project(x, y, h, STICK);
    return p.x > margin && p.x < width - margin && p.y > margin && p.y < height - margin;
  };
  if (safe(heading)) return normalizeAbsolute(heading);
  for (let a = 5; a <= 175; a += 5) {
    if (safe(heading + orbitDir * a)) return normalizeAbsolute(heading + orbitDir * a);
    if (safe(heading - orbitDir * a)) return normalizeAbsolute(heading - orbitDir * a);
  }
  // Truly cornered: head for the middle of the field.
  return absoluteBearing(x, y, width / 2, height / 2);
}
