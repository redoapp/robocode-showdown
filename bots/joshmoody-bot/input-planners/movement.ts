import { Context } from "../context";
import { InputPlanner } from "../input";

const STOP_TURNS = 10;
const MOVE_TURNS = 10;
const MOVE_SPEED = 150;
const TOGGLE_DIRECTION_PROBABILITY = 0.1;

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

    const psychOut = Math.random() < TOGGLE_DIRECTION_PROBABILITY;

    const value = MOVE_SPEED * (psychOut ? -1 : 1);

    return {
      value,
      interrupt: true,
    };
  };
};
