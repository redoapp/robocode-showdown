/**
 * A bullet wave from OUR gun's perspective, used to learn where the enemy moves.
 * Each tick we launch one of these (a "virtual" wave when we don't actually
 * fire); when its expanding radius reaches the enemy we record the GuessFactor
 * the enemy ended up at, together with the features captured at launch time.
 */
import { dist } from "./geom.ts";
import { guessFactor, type WaveSetup } from "./features.ts";

export class GunWave {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly fireTime: number;
  readonly speed: number;
  readonly absBearing: number;
  readonly orbitDir: number;
  readonly mae: number;
  readonly features: number[];

  constructor(setup: WaveSetup, fireTime: number, speed: number) {
    this.sourceX = setup.sourceX;
    this.sourceY = setup.sourceY;
    this.fireTime = fireTime;
    this.speed = speed;
    this.absBearing = setup.absBearing;
    this.orbitDir = setup.orbitDir;
    this.mae = setup.mae;
    this.features = setup.features;
  }

  radiusAt(time: number): number {
    return (time - this.fireTime) * this.speed;
  }

  /** Has the wave's leading edge reached the given point yet? */
  hasReached(time: number, x: number, y: number): boolean {
    return this.radiusAt(time) >= dist(this.sourceX, this.sourceY, x, y);
  }

  /** GuessFactor of a point relative to this wave. */
  gfOf(x: number, y: number): number {
    return guessFactor(this.sourceX, this.sourceY, this.absBearing, this.orbitDir, this.mae, x, y);
  }
}
