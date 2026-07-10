/**
 * Win-probability bullet-power selection. Instead of a fixed distance
 * heuristic, it picks the power
 * that maximizes expected end-of-round score by estimating, for each candidate
 * power, the probability we win the round and the expected bullet damage.
 */
import { clip } from "./geom.ts";
import { bulletDamage, gunHeat } from "./physics.ts";
import { HitRateTracker } from "./hitRate.ts";

const GUN_COOLING_RATE = 0.1; // tournament game setup
const CANDIDATE_POWERS = [
  2.99, 2.75, 2.49, 2.3, 2.2, 2.1, 1.99, 1.9, 1.8, 1.7, 1.6, 1.49, 1.4, 1.3, 1.2, 1.1, 0.99, 0.95,
  0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.49, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.175, 0.15,
  0.125, 0.1,
];
const FULL_POWER_DISTANCE = 100;
const MIN_ENERGY = 0.05;
const POINTS_FOR_WIN = 60;
const BULLET_DAMAGE_BONUS = 0.2;

interface BulletPower {
  cooldown: number;
  damage: number; // per turn
  gain: number; // per turn
  loss: number; // per turn
  hitRate: number;
}

export class BulletPowerSelector {
  private readonly myEnergy: number;
  private readonly enemyEnergy: number;
  private readonly enemyPower: BulletPower;
  private readonly myTracker: HitRateTracker;
  private readonly enemyTracker: HitRateTracker;

  constructor(
    myTracker: HitRateTracker,
    enemyTracker: HitRateTracker,
    myEnergy: number,
    enemyEnergy: number,
    lastEnemyBulletPower: number,
  ) {
    this.myTracker = myTracker;
    this.enemyTracker = enemyTracker;
    this.myEnergy = myEnergy;
    this.enemyEnergy = enemyEnergy;
    const p = Math.min(enemyEnergy, lastEnemyBulletPower > 0 ? lastEnemyBulletPower : 1.5);
    this.enemyPower = this.makeBulletPower(p, false);
  }

  /** Best firepower for the current situation. */
  static best(
    myTracker: HitRateTracker,
    enemyTracker: HitRateTracker,
    myEnergy: number,
    enemyEnergy: number,
    distance: number,
    lastEnemyBulletPower: number,
    roundNum: number,
  ): number {
    const sel = new BulletPowerSelector(
      myTracker,
      enemyTracker,
      myEnergy,
      enemyEnergy,
      lastEnemyBulletPower,
    );
    const fullPower = distance < FULL_POWER_DISTANCE;

    let killEnergy = enemyEnergy;
    let minimumKillPower = killEnergy > 4 ? (killEnergy + 2) / 6 : killEnergy / 4;

    let bestPower: number;
    if (fullPower) {
      bestPower = 2.95;
    } else {
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const power of CANDIDATE_POWERS) {
        const score = sel.scorePower(power, roundNum <= 4);
        if (score > bestScore) {
          bestScore = score;
          bestPower = power;
        }
      }
      bestPower = bestPower!;
    }

    bestPower = clip(bestPower, 0.1, Math.max(0.1, minimumKillPower));
    bestPower = Math.min(bestPower, myEnergy - MIN_ENERGY);
    if (fullPower) {
      bestPower = Math.max(bestPower, 0.1);
    } else if (myEnergy < 5 && myEnergy > enemyEnergy) {
      // don't give up an energy lead when low on energy
      bestPower = Math.min(myEnergy - enemyEnergy - 0.11, bestPower);
    }
    return clip(bestPower, 0.1, 3);
  }

  private makeBulletPower(power: number, isMine: boolean): BulletPower {
    const cooldown = Math.max(1, Math.floor(gunHeat(power) / GUN_COOLING_RATE));
    const enemyHitRate = Math.min(0.15, this.enemyTracker.estimateHitRate(power));
    const hitRate = isMine
      ? Math.max(enemyHitRate, this.myTracker.estimateHitRate(power))
      : enemyHitRate;
    return {
      cooldown,
      damage: bulletDamage(power) / cooldown,
      gain: (3 * power) / cooldown,
      loss: power / cooldown,
      hitRate,
    };
  }

  private scorePower(power: number, ratio: boolean): number {
    const myPower = this.makeBulletPower(power, true);
    const ticksLeft = this.estimateTicksLeft(myPower, myPower.hitRate, this.enemyPower.hitRate);
    const myDamage = this.myTracker.getDamageThisRound() + myPower.damage * myPower.hitRate * ticksLeft;
    const enemyDamage =
      this.enemyTracker.getDamageThisRound() +
      this.enemyPower.damage * this.enemyPower.hitRate * ticksLeft;
    const winProb = this.estimateWinProb(power);
    const myScore = myDamage * (1 + BULLET_DAMAGE_BONUS * winProb) + POINTS_FOR_WIN * winProb;
    const enemyScore =
      enemyDamage * (1 + BULLET_DAMAGE_BONUS * (1 - winProb)) + POINTS_FOR_WIN * (1 - winProb);
    if (ratio) {
      const myTotal = this.myTracker.getApproximateScore() + myScore;
      return myTotal / (myTotal + this.enemyTracker.getApproximateScore() + enemyScore);
    }
    return myScore - enemyScore;
  }

  private estimateWinProb(power: number): number {
    const myPower = this.makeBulletPower(power, true);
    const a = this.myEnergy * myPower.damage + this.enemyEnergy * myPower.gain;
    const b = this.enemyEnergy * this.enemyPower.damage + this.myEnergy * this.enemyPower.gain;
    let lambda =
      this.enemyEnergy * myPower.loss -
      this.myEnergy * this.enemyPower.loss -
      myPower.hitRate * a +
      this.enemyPower.hitRate * b;
    lambda /= a * a + b * b;
    const myNeededHR = lambda * a + myPower.hitRate;
    const enemyNeededHR = -lambda * b + this.enemyPower.hitRate;
    if (myNeededHR <= 0 || enemyNeededHR >= 1) return 1;
    if (myNeededHR >= 1 || enemyNeededHR <= 0) return 0;
    const ticksLeft = this.estimateTicksLeft(myPower, myNeededHR, enemyNeededHR);
    return Math.sqrt(
      (1 - probAboveHR(myPower, myNeededHR, ticksLeft)) *
        probAboveHR(this.enemyPower, enemyNeededHR, ticksLeft),
    );
  }

  private estimateTicksLeft(myPower: BulletPower, myHitRate: number, enemyHitRate: number): number {
    const myLoss = Math.max(
      this.enemyPower.damage * enemyHitRate - myPower.gain * myHitRate + myPower.loss,
      0.0001,
    );
    const enemyLoss = Math.max(
      myPower.damage * myHitRate - this.enemyPower.gain * enemyHitRate + this.enemyPower.loss,
      0.0001,
    );
    return Math.min(this.myEnergy / myLoss, this.enemyEnergy / enemyLoss);
  }
}

function probAboveHR(bp: BulletPower, targetHR: number, ticks: number): number {
  const shots = ticks / bp.cooldown;
  const expectedHits = bp.hitRate * shots;
  const targetHits = targetHR * shots;
  const variance = Math.max(1e-9, bp.hitRate * (1 - bp.hitRate) * shots);
  return phi((targetHits - expectedHits) / Math.sqrt(variance));
}

// https://en.wikipedia.org/wiki/Error_function#Approximation_with_elementary_functions
function erf(z: number): number {
  const t = 1.0 / (1.0 + 0.5 * Math.abs(z));
  // prettier-ignore
  const poly = 1.00002368 + t*(0.37409196 + t*(0.09678418 + t*(-0.18628806 + t*(0.27886807 + t*(-1.13520398 + t*(1.48851587 + t*(-0.82215223 + t*0.17087277)))))));
  const ans = 1 - t * Math.exp(-z * z - 1.26551223 + t * poly);
  return z > 0 ? ans : -ans;
}

function phi(x: number): number {
  return (1.0 + erf(x / Math.sqrt(2.0))) / 2.0;
}
