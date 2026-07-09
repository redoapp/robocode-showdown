import { Bot, ScannedBotEvent } from "@robocode.dev/tank-royale-bot-api";
import { distance, inferredPosition, Vector } from "./geometry";

export type Enemy = ScannedBotEvent[];
export type Enemies = Map<number, Enemy>;

export const ALIVENESS_THRESHOLD = 30;

export function createEnemiesProxy(rawEnemies: Enemies, self: Bot): Enemies {
  const isAlive = (history: Enemy) =>
    history.length > 0 &&
    self.getTurnNumber() - (history.at(-1)?.turnNumber ?? 0) <
      ALIVENESS_THRESHOLD;

  return new Proxy(rawEnemies, {
    get(target, prop, receiver) {
      if (prop === "values")
        return () => [...target.values()].filter(isAlive).values();
      if (prop === "entries")
        return () =>
          [...target.entries()].filter(([, h]) => isAlive(h)).values();
      if (prop === "forEach")
        return (cb: (v: Enemy, k: number, m: Enemies) => void) =>
          target.forEach((h, k) => isAlive(h) && cb(h, k, receiver));
      if (prop === "size") return [...target.values()].filter(isAlive).length;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function targetedEnemy({
  enemies,
  self,
  futureTurns,
}: {
  enemies: Enemies;
  self: Vector;
  futureTurns?: number;
}): {
  x: number;
  y: number;
  id: number;
  distance: number;
} | null {
  const enemyDistances = [...enemies.values()].map((history) => {
    const latest = history.at(-1)!;
    return {
      id: latest.scannedBotId,
      distance: distance(
        self,
        inferredPosition(history, futureTurns ?? 0) ?? latest,
      ),
      x: latest.x,
      y: latest.y,
    };
  });

  if (!enemyDistances.length) return null;
  return enemyDistances.reduce((current, acc) =>
    current.distance > acc.distance ? acc : current,
  );
}
