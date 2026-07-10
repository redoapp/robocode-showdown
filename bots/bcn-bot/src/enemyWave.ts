/**
 * One of the enemy's bullet waves, tracked for wave surfing. Created when we
 * detect the enemy fired (an unexplained energy drop). Carries features about
 * US (as the enemy's target) captured at fire time, so the danger model can
 * find similar past situations and predict where their bullets tend to land.
 */
import { absoluteBearing, clip, dist, nonzeroSign, normalizeRelative, toRad } from "./geom.ts";
import { GameState } from "./gameState.ts";
import { bulletSpeed, MAX_SPEED } from "./physics.ts";
import { maxEscapeAngle } from "./features.ts";
import { distanceToWall } from "./geom.ts";

/** Per-feature weights for the danger KNN (parallel to `features`). */
export const SURF_FEATURE_WEIGHTS = [3.0, 3.0, 1.5, 1.5, 2.0, 1.0];

export class EnemyWave {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly fireTime: number;
  readonly power: number;
  readonly speed: number;
  readonly refBearing: number; // bearing from source to us at fire time
  readonly orbitDir: number; // which way we were orbiting
  readonly mae: number;
  readonly features: number[];

  constructor(gs: GameState, sourceX: number, sourceY: number, fireTime: number, power: number) {
    const me = gs.me;
    this.sourceX = sourceX;
    this.sourceY = sourceY;
    this.fireTime = fireTime;
    this.power = power;
    this.speed = bulletSpeed(power);
    this.mae = maxEscapeAngle(power);

    this.refBearing = absoluteBearing(sourceX, sourceY, me.x, me.y);
    const distance = dist(sourceX, sourceY, me.x, me.y);
    const bft = distance / this.speed;

    const relRad = toRad(me.direction - this.refBearing);
    const latVel = me.speed * Math.sin(relRad);
    const advVel = me.speed * Math.cos(relRad);
    this.orbitDir = latVel === 0 ? 1 : nonzeroSign(latVel);

    // Our orbit tangent (which way along the orbit we can travel).
    const towardSource = absoluteBearing(me.x, me.y, sourceX, sourceY);
    const tangent = towardSource + this.orbitDir * 90;
    const wallFwd = distanceToWall(me.x, me.y, tangent, gs.arenaWidth, gs.arenaHeight);
    const wallRev = distanceToWall(me.x, me.y, tangent + 180, gs.arenaWidth, gs.arenaHeight);

    this.features = [
      clip(bft / 80, 0, 1.5),
      clip(Math.abs(latVel) / MAX_SPEED, 0, 1),
      clip((advVel + MAX_SPEED) / (2 * MAX_SPEED), 0, 1),
      clip(Math.abs(me.speed) / MAX_SPEED, 0, 1),
      clip(wallFwd / 500, 0, 1),
      clip(wallRev / 500, 0, 1),
    ];
  }

  radiusAt(time: number): number {
    return (time - this.fireTime) * this.speed;
  }

  /** Has the wave reached point (x,y) by `time`? */
  hasPassed(time: number, x: number, y: number): boolean {
    return this.radiusAt(time) >= dist(this.sourceX, this.sourceY, x, y);
  }

  /** GuessFactor of a point relative to this wave (orbit-normalized). */
  gfOf(x: number, y: number): number {
    const bearing = absoluteBearing(this.sourceX, this.sourceY, x, y);
    const offset = normalizeRelative(bearing - this.refBearing);
    return clip((offset / this.mae) * this.orbitDir, -1, 1);
  }
}
