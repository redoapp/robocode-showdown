import { Bot, Color, type IGraphics } from "@robocode.dev/tank-royale-bot-api";
import {
  initQueues,
  InputType,
  type InputPlanner,
  type InputQueue,
} from "./input.ts";
import { createRadarPlanner } from "./input-planners/radar.ts";
import { createEnemiesProxy, type Enemies } from "./enemy.ts";
import { createGunPlanner } from "./input-planners/gun.ts";
import { createRotationPlanner } from "./input-planners/rotation.ts";
import { createMovementPlanner } from "./input-planners/movement.ts";

export interface Context {
  self: Bot;
  enemies: Enemies;
  inputQueues: Record<InputType, InputQueue>;
  inputPlanners: Record<InputType, InputPlanner>;
  graphics: IGraphics;
  hitByBullet: boolean; // hacky global state
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
    hitByBullet: false,
  };
}
