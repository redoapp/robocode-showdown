import { Context } from "../context";
import { targetedEnemy } from "../enemy";
import { botVec, squareV, subtractV, Vector } from "../geometry";
import { InputPlanner } from "../input";

const REPOSITION_TURNS = 200;
const REPOSITION_TURNS_ALLOTTED = 100;
const WALL_BUFFER = 100;
const PROJECTION_DISTANCE = WALL_BUFFER * 0.8;

export const createRotationPlanner: () => InputPlanner = () => {
  let lastRepositionTurn = -Infinity;
  return (context: Context) => {
    if (context.inputQueues.rotate.isBusy()) {
      return;
    }

    let rawResult: {
      value: number;
      interrupt: boolean;
    };

    if (context.self.getTurnNumber() - lastRepositionTurn > REPOSITION_TURNS) {
      lastRepositionTurn = context.self.getTurnNumber();
      rawResult = repositionAwayFromEnemies(context);
    }

    if (
      context.self.getTurnNumber() - lastRepositionTurn <
      REPOSITION_TURNS_ALLOTTED
    ) {
      return;
    }

    const enemy = targetedEnemy({
      enemies: context.enemies,
      self: botVec(context.self),
      futureTurns: 0,
    });

    if (!enemy) {
      return;
    }

    let idealStrafeAngle = context.self.bearingTo(enemy.x, enemy.y) + 90;

    rawResult = {
      value: idealStrafeAngle,
      interrupt: true,
    };

    const botPos = botVec(context.self);

    let attempts = 0;
    while (
      !isInsideWallBuffer(
        context,
        projectedPosition(botPos, rawResult.value, PROJECTION_DISTANCE),
      )
    ) {
      rawResult.value += 10;
      if (++attempts > 36) {
        break;
      }
    }

    return rawResult;
  };
};

function degToRad(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function projectedPosition(botPos: Vector, angle: number, distance: number) {
  const rad = degToRad(angle);
  return {
    x: botPos.x + distance * Math.cos(rad),
    y: botPos.y + distance * Math.sin(rad),
  };
}

function repositionAwayFromEnemies(context: Context) {
  const forces = [...context.enemies.values()]
    .map((enemy) => {
      const enemyPos = enemy.at(-1);
      if (!enemyPos) {
        return { x: 0, y: 0 };
      }
      const force = squareV(subtractV(botVec(context.self), enemyPos));
      return force;
    })
    .reduce(
      (acc, force) => ({
        x: acc.x + force.x,
        y: acc.y + force.y,
      }),
      { x: 0, y: 0 },
    );

  const target = subtractV(botVec(context.self), forces);

  return {
    value: context.self.bearingTo(target.x, target.y),
    interrupt: true,
  };
}

function isInsideWallBuffer(context: Context, position: Vector) {
  const width = context.self.getArenaWidth();
  const height = context.self.getArenaHeight();

  return (
    position.x > WALL_BUFFER &&
    position.x < width - WALL_BUFFER &&
    position.y > WALL_BUFFER &&
    position.y < height - WALL_BUFFER
  );
}
