import { Context } from "../context";
import { targetedEnemy } from "../enemy";
import { botVec, distance, inferredPosition, Vector } from "../geometry";
import { InputPlanner } from "../input";

const LAST_SEEN_THRESHOLD = 10;
const PREDICTION_ITERATIONS = 10;
const AIM_TOLERANCE = 16;

const BULLET_POWER_DISTANCE = {
  MAX: 50,
  MIN: 800,
};

const BULLET_POWER = {
  MIN: 0.1,
  MAX: 3,
};

export const createGunPlanner: () => InputPlanner = () => {
  return (context: Context) => {
    if (context.inputQueues.gun.isBusy()) {
      return;
    }

    const enemyPos = targetedEnemy({
      enemies: context.enemies,
      self: botVec(context.self),
      futureTurns: 0,
    });

    if (!enemyPos) {
      return;
    }

    const enemy = context?.enemies.get(enemyPos.id);

    if (!enemy) {
      return;
    }

    const enemyFreshness =
      context.self.getTurnNumber() - (enemy.at(-1)?.turnNumber ?? 0);
    if (enemyFreshness > LAST_SEEN_THRESHOLD) {
      return;
    }

    const power = bulletPower(enemyPos.distance);
    const bulletSpeed = bulletVelocity(power);

    let futurePos: Vector = enemyPos;
    for (let i = 0; i < PREDICTION_ITERATIONS; i++) {
      const distanceToTarget = distance(botVec(context.self), futurePos);
      const turnsToTarget = distanceToTarget / bulletSpeed;
      futurePos = inferredPosition(enemy, turnsToTarget) ?? futurePos;
    }
    const directValue = context.self.gunBearingTo(enemyPos.x, enemyPos.y);
    const predictedValue = context.self.gunBearingTo(futurePos.x, futurePos.y);

    const value = directValue + Math.random() * (predictedValue - directValue);

    if (canShoot(context) && withinAimTolerance(context, futurePos)) {
      context.self.setFire(power);
    }

    return {
      value,
      interrupt: true,
    };
  };
};

function bulletPower(distance: number) {
  if (distance < BULLET_POWER_DISTANCE.MAX) {
    return BULLET_POWER.MAX;
  }
  if (distance > BULLET_POWER_DISTANCE.MIN) {
    return BULLET_POWER.MIN;
  } else {
    const ratio =
      (distance - BULLET_POWER_DISTANCE.MAX) /
      (BULLET_POWER_DISTANCE.MIN - BULLET_POWER_DISTANCE.MAX);
    return BULLET_POWER.MAX - ratio * (BULLET_POWER.MAX - BULLET_POWER.MIN);
  }
}

function withinAimTolerance(context: Context, target: Vector) {
  const gunBearing = context.self.gunBearingTo(target.x, target.y);
  return Math.abs(gunBearing) < AIM_TOLERANCE;
}

function bulletVelocity(power: number) {
  return 20 - 3 * power;
}

function canShoot(context: Context) {
  return context.self.getGunHeat() === 0;
}
