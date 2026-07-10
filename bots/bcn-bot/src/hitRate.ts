/**
 * Tracks a bot's bullet hit rate and damage, with priors so early estimates are
 * sane. Used by the bullet-power selector to estimate win probability.
 */
import { bulletSpeed } from "./physics.ts";

const PRIOR_HITS = 1;
const PRIOR_SHOTS = 12;

/** Simple max escape angle (radians) for a bullet of the given power. */
function simpleMAE(power: number): number {
  return Math.asin(Math.min(1, 8 / bulletSpeed(power)));
}

export class HitRateTracker {
  private hits = 0;
  private shotsPassed = 0;
  private damage = 0;
  private damageThisRound = 0;
  private totalWeight = 0;
  private approximateScore = 0;

  initRound(): void {
    this.damageThisRound = 0;
  }

  /** A fired bullet has reached (passed) the target — count it toward the rate. */
  logShotPassed(power: number): void {
    this.shotsPassed++;
    this.totalWeight += simpleMAE(power);
  }

  logHit(bulletDamage: number): void {
    this.hits++;
    this.damage += bulletDamage;
    this.damageThisRound += bulletDamage;
  }

  getDamageThisRound(): number {
    return this.damageThisRound;
  }

  getApproximateScore(): number {
    return this.approximateScore;
  }

  getHitRate(): number {
    return this.hits / Math.max(1, this.shotsPassed);
  }

  /** Hit-rate estimate for a candidate power, normalized by max escape angle. */
  estimateHitRate(power: number): number {
    const hitRate = (this.hits + PRIOR_HITS) / (this.shotsPassed + PRIOR_SHOTS);
    const correction =
      this.shotsPassed === 0 ? 1 : this.totalWeight / this.shotsPassed / simpleMAE(power);
    return Math.max(0.001, Math.min(0.999, hitRate * correction));
  }

  onRoundEnd(won: boolean): void {
    // https://robowiki.net/wiki/Robocode/Scoring
    this.approximateScore += this.damageThisRound * (won ? 1.2 : 1) + (won ? 60 : 0);
  }
}
