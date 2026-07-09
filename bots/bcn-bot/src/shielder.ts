/**
 * Bullet shielding (https://robowiki.net/wiki/Bullet_Shielding) — an optional
 * movement/gun MODE (alternative to wave surfing).
 *
 * Idea: sit still. A stationary target defeats linear/circular lead (zero
 * velocity => no lead), so simple guns all become head-on — their bullets fly
 * straight at us and are highly predictable. We then fire our own bullets to
 * intercept and destroy the incoming ones (bullet-hits-bullet), taking no
 * damage while spending little energy.
 *
 * This only beats *simple* shooters; against real GuessFactor/adaptive guns the
 * predicted heading is unreliable, so shielding is used situationally. It is a
 * full alternative to wave surfing (you shield OR you surf, never both).
 *
 * The Shielder returns ABSOLUTE targets; the entry converts them to turns.
 */
import { absoluteBearing, dist, normalizeRelative } from "./geom.ts";
import { GameState } from "./gameState.ts";
import { bulletSpeed, MAX_BULLET_SPEED, MIN_BULLET_SPEED } from "./physics.ts";

interface IncomingWave {
  sourceX: number;
  sourceY: number;
  fireTime: number;
  power: number;
  heading: number; // predicted absolute heading of the enemy bullet (deg)
  shielded: boolean;
}

export interface ShieldCommand {
  bodyAim: number; // absolute heading to face
  gunAim: number; // absolute gun aim
  fire: number; // firepower to fire this tick (0 = hold)
}

export class Shielder {
  private waves: IncomingWave[] = [];
  private offsetSum = 0; // mean observed offset of enemy bullets from head-on
  private offsetCount = 0;

  onRoundStart(): void {
    this.waves = [];
  }

  /** Learn the enemy's aiming offset from an observed bullet heading (deg). */
  learnBullet(gs: GameState, bulletHeadingDeg: number): void {
    if (!gs.prevEnemy) return;
    const headOn = absoluteBearing(gs.prevEnemy.x, gs.prevEnemy.y, gs.me.x, gs.me.y);
    this.offsetSum += normalizeRelative(bulletHeadingDeg - headOn);
    this.offsetCount++;
  }

  private predictedOffset(): number {
    return this.offsetCount === 0 ? 0 : this.offsetSum / this.offsetCount;
  }

  update(gs: GameState, gunHeat: number): ShieldCommand {
    const me = gs.me;
    const e = gs.enemy!;
    const now = me.time;

    if (gs.enemyJustFired && gs.prevEnemy) {
      const headOn = absoluteBearing(gs.prevEnemy.x, gs.prevEnemy.y, me.x, me.y);
      this.waves.push({
        sourceX: gs.prevEnemy.x,
        sourceY: gs.prevEnemy.y,
        fireTime: gs.prevEnemy.time,
        power: gs.enemyFirePower,
        heading: headOn + this.predictedOffset(),
        shielded: false,
      });
    }
    this.waves = this.waves.filter(
      (w) => (now - w.fireTime) * bulletSpeed(w.power) < dist(w.sourceX, w.sourceY, me.x, me.y) + 20,
    );

    const bodyAim = absoluteBearing(me.x, me.y, e.x, e.y) + 90; // perpendicular, stay put
    const enemyAim = absoluteBearing(me.x, me.y, e.x, e.y);

    const target = this.nextTarget(me.x, me.y, now);
    if (!target) {
      return { bodyAim, gunAim: enemyAim, fire: 0 };
    }

    const sol = this.interceptSolution(me.x, me.y, target, now);
    // Only fire when the gun is cool AND lined up on the intercept.
    const aligned = Math.abs(normalizeRelative(sol.aimDir - me.direction)) < 90; // gun ~ free
    return { bodyAim, gunAim: sol.aimDir, fire: gunHeat === 0 && aligned ? sol.power : 0 };
  }

  /** Nearest un-shielded incoming bullet (by gap to its wavefront). */
  private nextTarget(myX: number, myY: number, now: number): IncomingWave | undefined {
    let best: IncomingWave | undefined;
    let bestGap = Infinity;
    for (const w of this.waves) {
      if (w.shielded) continue;
      const gap = dist(w.sourceX, w.sourceY, myX, myY) - (now - w.fireTime) * bulletSpeed(w.power);
      if (gap > 0 && gap < bestGap) {
        bestGap = gap;
        best = w;
      }
    }
    return best;
  }

  /** Firepower + aim direction so our bullet meets the incoming bullet. */
  private interceptSolution(
    myX: number,
    myY: number,
    w: IncomingWave,
    now: number,
  ): { power: number; aimDir: number } {
    const eSpeed = bulletSpeed(w.power);
    const hr = (w.heading * Math.PI) / 180;
    for (let t = now + 1; t <= now + 60; t++) {
      const age = t - w.fireTime;
      const bx = w.sourceX + Math.cos(hr) * eSpeed * age;
      const by = w.sourceY + Math.sin(hr) * eSpeed * age;
      const d = dist(myX, myY, bx, by);
      const neededSpeed = d / (t - now + 0.5);
      if (neededSpeed > MIN_BULLET_SPEED && neededSpeed < MAX_BULLET_SPEED) {
        const power = Math.min((20 - neededSpeed) / 3, w.power);
        w.shielded = true;
        return { power: Math.max(0.1, power), aimDir: absoluteBearing(myX, myY, bx, by) };
      }
    }
    // No clean intercept: aim at the incoming bullet's current position, low power.
    const age = now - w.fireTime + 1;
    const bx = w.sourceX + Math.cos(hr) * eSpeed * age;
    const by = w.sourceY + Math.sin(hr) * eSpeed * age;
    return { power: 0.1, aimDir: absoluteBearing(myX, myY, bx, by) };
  }
}
