/**
 * Stage 1 gun: circular predictive targeting.
 *
 * Assumes the enemy keeps its current speed and turn rate, simulates its path
 * forward turn-by-turn, and finds the intercept point where a bullet fired now
 * would meet it. This already crushes head-on / linear-prediction bots.
 *
 * Stages 2+ replace this with a GuessFactor KNN gun; the interface (an aim
 * point + firepower) stays the same so the entry code doesn't change.
 */
import { clip, project, toRad, type Vec } from "./geom.ts";
import { bulletSpeed, BOT_RADIUS } from "./physics.ts";
import { GameState } from "./gameState.ts";

export interface AimSolution {
  aim: Vec; // point to aim the gun at
  power: number; // firepower to use
}

export class Aimer {
  /** Choose firepower from distance and energy considerations. */
  selectPower(distance: number, myEnergy: number, enemyEnergy: number): number {
    let power: number;
    if (distance < 150) power = 3;
    else if (distance < 400) power = 2.4;
    else if (distance < 600) power = 1.9;
    else power = 1.5;

    // Don't spend energy we can't afford; ease off when low.
    if (myEnergy < 15) power = Math.min(power, 1);
    if (myEnergy < 6) power = Math.min(power, myEnergy / 6);
    // No need to over-kill: never fire more than enough to finish the enemy.
    power = Math.min(power, enemyEnergy / 4 + 0.1);

    return clip(power, 0.1, 3);
  }

  /** Compute the circular-prediction intercept point for a shot fired now. */
  solve(gs: GameState, gunX: number, gunY: number): AimSolution {
    const e = gs.enemy!;
    const distance = Math.hypot(e.x - gunX, e.y - gunY);
    const power = this.selectPower(distance, gs.me.energy, e.energy);
    const speed = bulletSpeed(power);
    const turnRate = gs.enemyTurnRate();

    let px = e.x;
    let py = e.y;
    let dir = e.direction;
    const v = e.speed;

    const maxX = gs.arenaWidth - BOT_RADIUS;
    const maxY = gs.arenaHeight - BOT_RADIUS;

    // Advance the enemy forward until a bullet fired now could reach it.
    for (let t = 1; t <= 160; t++) {
      dir += turnRate;
      const r = toRad(dir);
      px = clip(px + Math.cos(r) * v, BOT_RADIUS, maxX);
      py = clip(py + Math.sin(r) * v, BOT_RADIUS, maxY);
      if (Math.hypot(px - gunX, py - gunY) <= speed * t) break;
    }

    return { aim: { x: px, y: py }, power };
  }

  /** Fallback: aim straight at the enemy's current position. */
  directAim(gs: GameState): Vec {
    const e = gs.enemy!;
    return project(e.x, e.y, 0, 0);
  }
}
