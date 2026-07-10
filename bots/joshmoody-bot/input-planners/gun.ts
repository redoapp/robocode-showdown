import type { Context } from "../context.ts";
import { targetedEnemy } from "../enemy.ts";
import { botVec, distance, inferredPosition, type Vector } from "../geometry.ts";
import type { InputPlanner } from "../input.ts";

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
    const direct = context.self.gunBearingTo(enemyPos.x, enemyPos.y);
    const predicted = context.self.gunBearingTo(futurePos.x, futurePos.y);

    const value = herp({
      direct,
      predicted,
      distance: distance(botVec(context.self), futurePos),
    });

    if (canShoot(context) && withinAimTolerance(context, futurePos)) {
      context.self.setFire(power);
    }

    return {
      value,
      interrupt: true,
    };
  };
};

const lerp = (start: number, end: number, amt: number) =>
  (1 - amt) * start + amt * end;

// heuristically interpolate
function herp({
  direct,
  predicted,
  distance,
}: {
  direct: number;
  predicted: number;
  distance: number;
}) {
  return lerp(predicted, direct, Math.sqrt(Math.random()));
}

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
