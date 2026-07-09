import { Color } from "@robocode.dev/tank-royale-bot-api";
import { Context } from "../context";
import { targetedEnemy } from "../enemy";
import { botVec } from "../geometry";
import { InputPlanner } from "../input";

const FULL_SCAN_RATE_TURNS = 150;
const FUTURE_TURNS = 3;
const OVERSHOOT = 1.8;
const MIN_ANGLE = 30;

export const createRadarPlanner: () => InputPlanner = () => {
  let lastFullScanTurn = -Infinity;

  return (context: Context) => {
    if (context.inputQueues.radar.isBusy()) {
      return;
    }

    const turn = context.self.getTurnNumber();

    const enemy = targetedEnemy({
      enemies: context.enemies,
      self: botVec(context.self),
      futureTurns: FUTURE_TURNS,
    });

    if (!enemy || turn - lastFullScanTurn > FULL_SCAN_RATE_TURNS) {
      lastFullScanTurn = turn;
      return {
        value: 360,
        interrupt: true,
      };
    }

    const bearing = context.self.radarBearingTo(enemy.x, enemy.y);
    const rawValue = bearing * OVERSHOOT;
    const value =
      rawValue < MIN_ANGLE && rawValue > -MIN_ANGLE
        ? (Math.sign(rawValue) || 1) * MIN_ANGLE
        : rawValue;

    return {
      value,
      interrupt: true,
    };
  };
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
