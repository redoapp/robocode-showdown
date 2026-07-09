import { absoluteBearing, normalizeRelative, dist, sign, RAD } from "./geom.ts";

export interface Snapshot {
  x: number;
  y: number;
  energy: number;
  direction: number;
  speed: number;
  time: number;
}

/**
 * Shared world model. Holds the latest known state of both tanks plus a short
 * history of the enemy so the gun and the surfer can read lateral velocity,
 * acceleration, and "time since the enemy last changed its mind".
 */
export class GameState {
  arenaWidth = 800;
  arenaHeight = 600;

  me: Snapshot = { x: 0, y: 0, energy: 100, direction: 0, speed: 0, time: 0 };
  enemy: Snapshot = { x: 0, y: 0, energy: 100, direction: 0, speed: 0, time: 0 };
  enemyGunHeat = 0; // best-effort estimate of enemy gun heat

  lastEnemyEnergy = 100;
  lastEnemyBulletPower = 1.9;
  prevEnemy: Snapshot | null = null; // enemy state one scan ago (the firing position)
  seenEnemy = false;

  /** Lateral direction of the enemy around ME: +1 = CCW, -1 = CW. */
  enemyLateralDir = 1;
  /** Enemy speed component perpendicular to my line of sight (px/turn). */
  enemyLateralSpeed = 0;
  /** Enemy speed component along my line of sight (+ = approaching). */
  enemyAdvancingSpeed = 0;
  /** Turns since the enemy's lateral velocity last flipped sign (accel proxy). */
  timeSinceDirChange = 0;
  /** Enemy body turn rate (deg/turn, CCW+), from the last two scans. */
  enemyTurnRate = 0;

  onRoundStart(): void {
    this.prevEnemy = null;
    this.seenEnemy = false;
    this.lastEnemyEnergy = 100;
    this.enemyGunHeat = 3; // guns start hot at round start
    this.timeSinceDirChange = 0;
  }

  updateMe(s: Snapshot): void {
    this.me = s;
    if (this.enemyGunHeat > 0) this.enemyGunHeat = Math.max(0, this.enemyGunHeat - 0.1);
  }

  updateEnemy(s: Snapshot): void {
    this.seenEnemy = true;
    const me = this.me;
    // Absolute angle from me to enemy.
    const absToEnemy = absoluteBearing(me.x, me.y, s.x, s.y);
    // Decompose enemy velocity vector relative to my line of sight.
    const relHeading = (s.direction - absToEnemy) * RAD;
    const lateral = s.speed * Math.sin(relHeading);
    const advancing = -s.speed * Math.cos(relHeading);
    const newDir = lateral === 0 ? this.enemyLateralDir : sign(lateral);

    if (newDir !== this.enemyLateralDir && lateral !== 0) {
      this.timeSinceDirChange = 0;
      this.enemyLateralDir = newDir;
    } else {
      this.timeSinceDirChange++;
    }
    this.enemyLateralSpeed = lateral;
    this.enemyAdvancingSpeed = advancing;

    // Body turn rate for circular targeting (clamped to the game's max).
    if (this.seenEnemy && this.enemy.time > 0) {
      const dt = Math.max(1, s.time - this.enemy.time);
      const dh = normalizeRelative(s.direction - this.enemy.direction) / dt;
      this.enemyTurnRate = Math.max(-10, Math.min(10, dh));
    }

    this.prevEnemy = this.enemy;
    this.enemy = s;
  }

  distanceToEnemy(): number {
    return dist(this.me.x, this.me.y, this.enemy.x, this.enemy.y);
  }

  /** Fraction (0..1) of how close the enemy is to the nearest wall. */
  enemyWallProximity(): number {
    const m = 40;
    const nx = Math.min(this.enemy.x, this.arenaWidth - this.enemy.x);
    const ny = Math.min(this.enemy.y, this.arenaHeight - this.enemy.y);
    return 1 - Math.min(1, Math.min(nx, ny) / (Math.min(this.arenaWidth, this.arenaHeight) / 2 - m));
  }
}
