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
  return inferredFromVelocityAlone;
  // const deltaTimeBC = b.turnNumber - c.turnNumber;
  // if (deltaTimeBC > MAX_USABLE_DELTA_TIME) {
  //   return inferredFromVelocityAlone;
  // }
  // const velocityBC = derivative(c, b, deltaTimeBC);
  // const accelerationAB = derivative(velocityBC, velocityAB, deltaTimeAB);
  // const futureTurnsSquared = futureTurns * futureTurns;
  // return addV(
  //   inferredFromVelocityAlone,
  //   multiplyV(multiplyV({ x: 0.5, y: 0.5 }, accelerationAB), {
  //     x: futureTurnsSquared,
  //     y: futureTurnsSquared,
  //   }),
  // );
}
