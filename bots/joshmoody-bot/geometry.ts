import { Bot } from "@robocode.dev/tank-royale-bot-api";
import { Enemy } from "./enemy";

export interface Vector {
  x: number;
  y: number;
}

export function derivative(oldPos: Vector, newPos: Vector, t: number): Vector {
  return {
    x: (newPos.x - oldPos.x) / t,
    y: (newPos.y - oldPos.y) / t,
  };
}

export function addV(a: Vector, b: Vector) {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
  };
}

export function subtractV(a: Vector, b: Vector) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

export function multiplyV(a: Vector, b: Vector) {
  return {
    x: a.x * b.x,
    y: a.y * b.y,
  };
}

export function distance(a: Vector, b: Vector) {
  const deltaX = Math.abs(b.x - a.x);
  const deltaY = Math.abs(b.y - a.y);
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

export function squareV(a: Vector) {
  return {
    x: a.x * a.x,
    y: a.y * a.y,
  };
}

export function botVec(bot: Bot): Vector {
  return {
    x: bot.getX(),
    y: bot.getY(),
  };
}

const clamp = (val: number, min: number, max: number) =>
  Math.min(Math.max(val, min), max);

export function clampV(vec: Vector, min: number, max: number) {
  return {
    x: clamp(vec.x, min, max),
    y: clamp(vec.y, min, max),
  };
}

const ACCEL_TURN_LIMIT = 20;
const ACCEL_LIMIT = 0.5;

export function inferredPosition(
  enemy: Enemy,
  futureTurns: number,
): Vector | null {
  const [c, b, a] = enemy.slice(-3);
  if (!a) {
    return null;
  }
  if (!b) {
    return a;
  }
  const MAX_USABLE_DELTA_TIME = 60;
  const deltaTimeAB = a.turnNumber - b.turnNumber;
  if (deltaTimeAB > MAX_USABLE_DELTA_TIME) {
    return a;
  }
  const velocityAB = derivative(b, a, deltaTimeAB);
  const inferredFromVelocityAlone = addV(
    a,
    multiplyV(velocityAB, { x: futureTurns, y: futureTurns }),
  );
  if (!c) {
    return inferredFromVelocityAlone;
  }
  const deltaTimeBC = b.turnNumber - c.turnNumber;
  if (deltaTimeBC > MAX_USABLE_DELTA_TIME) {
    return inferredFromVelocityAlone;
  }
  const velocityBC = derivative(c, b, deltaTimeBC);
  const accelerationAB = clampV(
    derivative(velocityBC, velocityAB, deltaTimeAB),
    -ACCEL_LIMIT,
    ACCEL_LIMIT,
  );
  const futureTurnsSquared = clamp(
    futureTurns * futureTurns,
    0,
    ACCEL_TURN_LIMIT,
  );
  return addV(
    inferredFromVelocityAlone,
    multiplyV(multiplyV({ x: 0.5, y: 0.5 }, accelerationAB), {
      x: futureTurnsSquared,
      y: futureTurnsSquared,
    }),
  );
}
