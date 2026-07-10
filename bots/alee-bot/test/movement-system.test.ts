import assert from "node:assert/strict";
import test from "node:test";
import { CombatState, SelfState } from "../src/combat-state.js";
import { MovementSystem } from "../src/movement-system.js";

const self: SelfState = {
  roundNumber: 1,
  turnNumber: 11,
  botId: 1,
  x: 400,
  y: 300,
  direction: 0,
  gunDirection: 0,
  radarDirection: 0,
  speed: 4,
  energy: 100,
  arenaWidth: 800,
  arenaHeight: 600,
  enemyCount: 1,
};

test("movement switches from orbit to wave surfing after inferred fire", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  combat.observeScan({ turnNumber: 10, scannedBotId: 7, energy: 100, x: 600, y: 300, direction: 180, speed: 0 }, 31, { ...self, turnNumber: 10 });
  const opponent = combat.observeScan({ turnNumber: 11, scannedBotId: 7, energy: 98, x: 600, y: 300, direction: 180, speed: 0 }, 31, self).opponent;
  const movement = new MovementSystem();
  const plan = movement.plan(self, opponent, combat);
  assert.equal(plan.mode, "wave-surf");
  assert.ok(Number.isFinite(plan.turnLeft));
  assert.ok(Number.isFinite(plan.forward));
  assert.ok(Number.isFinite(plan.danger));
});
