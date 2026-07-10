import { Bot } from "@robocode.dev/tank-royale-bot-api";
import type { Context } from "./context.ts";

export const InputType = {
  Radar: "radar",
  Gun: "gun",
  Move: "move",
  Rotate: "rotate",
} as const;

export type InputType = (typeof InputType)[keyof typeof InputType];

export interface InputQueue {
  enqueue: (n: number) => void;
  dequeue: () => number | undefined;
  interrupt: (n?: number) => void;
  isBusy: () => boolean;
}

const queue = (
  maxSize: number,
  isBusyRaw: () => number,
  act: (n: number) => void,
): InputQueue => {
  const q: number[] = [];
  return {
    enqueue: (n) => (q.length < maxSize ? q.push(n) : undefined),
    dequeue: () => {
      const next = q.shift();
      if (next !== undefined) {
        act(next);
      }
    },
    interrupt: (n) => ((q.length = 0), n !== undefined && q.push(n)),
    isBusy: () => !!isBusyRaw(),
  };
};

export const initQueues = (self: Bot) => ({
  [InputType.Radar]: queue(
    1,
    self.getRadarTurnRemaining.bind(self),
    self.setTurnRadarLeft.bind(self),
  ),
  [InputType.Gun]: queue(
    1,
    self.getGunTurnRemaining.bind(self),
    self.setTurnGunLeft.bind(self),
  ),
  [InputType.Move]: queue(
    3,
    self.getDistanceRemaining.bind(self),
    self.setForward.bind(self),
  ),
  [InputType.Rotate]: queue(
    2,
    self.getTurnRemaining.bind(self),
    self.setTurnLeft.bind(self),
  ),
});

export const dequeueInputs = (qs: Record<InputType, InputQueue>) =>
  Object.values(qs).forEach((q) => !q.isBusy() && q.dequeue());

export const enqueueInputs = (context: Context) =>
  Object.entries(context.inputPlanners)
    .map(([type, planner]) => ({
      type: type as InputType,
      plan: planner(context),
    }))
    .forEach(
      (p) => p.plan && context.inputQueues[p.type].enqueue(p.plan.value),
    );

export type InputPlanner = (context: Context) =>
  | {
      value: number;
      interrupt: boolean;
    }
  | undefined;
