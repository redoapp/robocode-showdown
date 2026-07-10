import { GameState } from "./state.ts";
import { clamp } from "./geom.ts";

/**
 * Pick bullet power. Philosophy for an anti-surfer: keep a fast, high-rate gun at
 * range (low power = faster bullets a surfer can't dodge as easily + quicker gun
 * cooling = more waves to learn from), hit hard up close, and never bleed below
 * the enemy's energy on a whim.
 */
export function selectPower(gs: GameState): number {
  const d = gs.distanceToEnemy();
  const myE = gs.me.energy;
  const enE = gs.enemy.energy;

  let power: number;
  if (d < 160) power = 3.0;
  else if (d < 350) power = 2.5;
  else if (d < 550) power = 2.0;
  else power = 1.7;

  // Finishing blow: don't overspend energy the enemy no longer has.
  if (enE < 16) power = Math.min(power, Math.max(0.5, enE / 4 + 0.1));

  // Conserve when we're low; taper firepower with our own energy.
  if (myE < 30) power = Math.min(power, Math.max(0.5, myE / 12));
  if (myE < 5) power = Math.min(power, myE / 5);

  return clamp(power, 0.1, 3.0);
}
