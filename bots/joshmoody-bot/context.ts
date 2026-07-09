import { Bot, Color, IGraphics } from "@robocode.dev/tank-royale-bot-api";
import { initQueues, InputPlanner, InputQueue, InputType } from "./input";
import { createRadarPlanner } from "./input-planners/radar";
import { createEnemiesProxy, Enemies } from "./enemy";
import { createGunPlanner } from "./input-planners/gun";
import { createRotationPlanner } from "./input-planners/rotation";
import { createMovementPlanner } from "./input-planners/movement";

export interface Context {
  self: Bot;
  enemies: Enemies;
  inputQueues: Record<InputType, InputQueue>;
  inputPlanners: Record<InputType, InputPlanner>;
  graphics: IGraphics;
}

export function initContext(self: Bot): Context {
  const inputQueues = initQueues(self);

  const graphics = self.getGraphics();
  graphics.setStrokeColor(Color.RED);
  graphics.setStrokeWidth(4);

  const inputPlanners: Record<InputType, InputPlanner> = {
    [InputType.Radar]: createRadarPlanner(),
    [InputType.Gun]: createGunPlanner(),
    [InputType.Move]: createMovementPlanner(),
    [InputType.Rotate]: createRotationPlanner(),
  };

  return {
    self,
    enemies: createEnemiesProxy(new Map(), self),
    inputQueues,
    inputPlanners,
    graphics,
  };
}
