import type { Context } from "../context.ts";
import type { InputPlanner } from "../input.ts";

const STOP_TURNS = 10;
// MOVE_TURNS shouldn't need to exist, but any rewrite that removes it makes performance worse in benchmarks. Doesn't make any sense, might be a fluke of the bots I'm testing against
const MOVE_TURNS = 10;
const MOVE_AMOUNT = {
  MIN: 100,
  MAX: 300,
};
const TOGGLE_DIRECTION_PROBABILITY = 0.33;

export const createMovementPlanner: () => InputPlanner = () => {
  let lastStopTurn = -Infinity;

  return (context: Context) => {
    if (context.inputQueues.move.isBusy()) {
      return;
    }

    const turn = context.self.getTurnNumber();

    if (turn - lastStopTurn < STOP_TURNS) {
      return;
    }

    if (context.self.getTurnNumber() - lastStopTurn > STOP_TURNS + MOVE_TURNS) {
      lastStopTurn = context.self.getTurnNumber();
      return;
    }

    const psychOut =
      context.hitByBullet || Math.random() < TOGGLE_DIRECTION_PROBABILITY;
    context.hitByBullet = false;

    const moveSpeed = randomBetween(MOVE_AMOUNT.MIN, MOVE_AMOUNT.MAX);

    const value = moveSpeed * (psychOut ? -1 : 1);

    return {
      value,
      interrupt: true,
    };
  };
};

function randomBetween(min: number, max: number) {
  return Math.random() * (max - min) + min;
}
