/**
 * Tracks the evolving state of the battle: my tank and the (single, in 1v1)
 * enemy, with enough history to derive velocities and detect enemy fire.
 *
 * Later stages (KNN gun, wave surfing) build on the histories kept here.
 */
import { absoluteBearing, normalizeRelative } from "./geom.ts";
import { maxTurnRate } from "./physics.ts";

/** A snapshot of a bot at one turn. */
export interface Snapshot {
  x: number;
  y: number;
  energy: number;
  direction: number; // heading in degrees [0,360)
  speed: number; // signed velocity? Tank Royale reports speed >= 0
  time: number; // turn number
}

export interface MySnapshot {
  x: number;
  y: number;
  energy: number;
  direction: number;
  speed: number;
  gunHeat: number;
  time: number;
}

export class GameState {
  arenaWidth = 800;
  arenaHeight = 600;

  me!: MySnapshot;
  prevMe?: MySnapshot;

  enemy?: Snapshot;
  prevEnemy?: Snapshot;

  /** Full enemy scan history for this round (most recent last). */
  readonly enemyHistory: Snapshot[] = [];

  /** True on the turn we detect the enemy just fired (via energy drop). */
  enemyJustFired = false;
  /** Estimated power of the shot the enemy just fired (if enemyJustFired). */
  enemyFirePower = 0;
  /** Power of the most recent enemy shot we detected (persists across turns). */
  lastEnemyBulletPower = 0;

  onRoundStart(): void {
    this.prevMe = undefined;
    this.enemy = undefined;
    this.prevEnemy = undefined;
    this.enemyHistory.length = 0;
    this.enemyJustFired = false;
    this.enemyFirePower = 0;
  }

  updateMe(s: MySnapshot): void {
    this.prevMe = this.me;
    this.me = s;
  }

  updateEnemy(s: Snapshot): void {
    this.enemyJustFired = false;
    this.enemyFirePower = 0;

    if (this.enemy) {
      // Energy loss not explained by us can indicate the enemy fired a bullet.
      // (Collisions / bullet hits are handled elsewhere; this is a heuristic.)
      const drop = this.enemy.energy - s.energy;
      if (drop >= 0.09999 && drop <= 3.0001) {
        this.enemyJustFired = true;
        this.enemyFirePower = drop;
        this.lastEnemyBulletPower = drop;
      }
      this.prevEnemy = this.enemy;
    }
    this.enemy = s;
    this.enemyHistory.push(s);
    if (this.enemyHistory.length > 2000) this.enemyHistory.shift();
  }

  hasEnemy(): boolean {
    return this.enemy !== undefined;
  }

  /** Enemy angular velocity (deg/turn), clipped to a physically possible turn. */
  enemyTurnRate(): number {
    if (!this.enemy || !this.prevEnemy) return 0;
    const dt = this.enemy.time - this.prevEnemy.time;
    if (dt <= 0) return 0;
    const raw = normalizeRelative(this.enemy.direction - this.prevEnemy.direction) / dt;
    const cap = maxTurnRate(this.enemy.speed);
    return Math.max(-cap, Math.min(cap, raw));
  }

  /**
   * Enemy velocity component perpendicular to the line from the observer to the
   * enemy (lateral speed). Positive = moving counter-clockwise around observer.
   */
  enemyLateralSpeed(observerX: number, observerY: number): number {
    if (!this.enemy) return 0;
    const bearing = absoluteBearing(observerX, observerY, this.enemy.x, this.enemy.y);
    const dir = this.enemy.direction;
    return this.enemy.speed * Math.sin((dir - bearing) * (Math.PI / 180));
  }

  /** Enemy velocity component along the line from the observer to the enemy. */
  enemyAdvancingSpeed(observerX: number, observerY: number): number {
    if (!this.enemy) return 0;
    const bearing = absoluteBearing(observerX, observerY, this.enemy.x, this.enemy.y);
    const dir = this.enemy.direction;
    return this.enemy.speed * Math.cos((dir - bearing) * (Math.PI / 180));
  }
}
