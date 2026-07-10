import assert from "node:assert/strict";
import test from "node:test";
import { CombatState } from "../src/combat-state.ts";
import type { OpponentState, SelfState } from "../src/combat-state.ts";
import { GunSystem } from "../src/gun-system.ts";
import { LearningSystem } from "../src/learning-system.ts";

const self: SelfState = {
  roundNumber: 1,
  turnNumber: 10,
  botId: 1,
  x: 400,
  y: 300,
  direction: 0,
  gunDirection: 0,
  radarDirection: 0,
  speed: 0,
  energy: 100,
  arenaWidth: 800,
  arenaHeight: 600,
  enemyCount: 1,
};

const north: OpponentState = {
  id: 2,
  turnNumber: 10,
  energy: 100,
  x: 400,
  y: 500,
  direction: 0,
  speed: 0,
  acceleration: 0,
  turnRate: 0,
  timeSinceDirectionChange: 0,
  timeSinceVelocityChange: 0,
};

test("gun plan returns the API's positive left turn toward a northern target", () => {
  const learning = new LearningSystem();
  const gun = new GunSystem(learning);
  const combat = new CombatState();
  combat.resetRound(1);
  const plan = gun.plan(combat, self, north);
  assert.equal(plan.headOnBearing, 90);
  assert.equal(plan.gunBearing, 90);
  learning.dispose();
});

test("real wave starts from actual BulletFired geometry", () => {
  const learning = new LearningSystem();
  const gun = new GunSystem(learning);
  const combat = new CombatState();
  combat.resetRound(1);
  const plan = gun.plan(combat, self, north);
  const input = gun.actualWaveInput(plan, self, north, {
    turnNumber: 12,
    x: 402,
    y: 303,
    direction: 88,
    power: 2,
  });
  assert.equal(input.fireTurn, 12);
  assert.deepEqual(input.origin, { x: 402, y: 303 });
  assert.equal(input.selectedAimAngle, 88);
  assert.equal(input.bulletPower, 2);
  learning.dispose();
});
