import assert from "node:assert/strict";
import test from "node:test";
import { CombatState, EnemyWave, SelfState } from "../src/combat-state.js";
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
  const update = combat.observeScan({ turnNumber: 11, scannedBotId: 7, energy: 97, x: 600, y: 300, direction: 180, speed: 0 }, 31, self);
  const movement = new MovementSystem();
  movement.plan({ ...self, turnNumber: 10 }, update.opponent, combat);
  movement.observeEnemyFire(update.inferredEnemyWaves[0]);
  const plan = movement.plan(self, update.opponent, combat);
  assert.equal(plan.mode, "wave-surf");
  assert.ok(Number.isFinite(plan.turnLeft));
  assert.ok(Number.isFinite(plan.forward));
  assert.ok(Number.isFinite(plan.danger));
});

const opponent = {
  id: 7,
  turnNumber: 11,
  energy: 100,
  x: 600,
  y: 300,
  direction: 180,
  speed: 0,
  acceleration: 0,
  turnRate: 0,
  timeSinceDirectionChange: 0,
  timeSinceVelocityChange: 0,
};

const enemyWave = (bulletPower: number): EnemyWave => ({
  id: 1,
  shooterId: opponent.id,
  fireTurn: 10,
  origin: { x: opponent.x, y: opponent.y },
  directAngle: 180,
  lateralDirection: 1,
  bulletPower,
  bulletSpeed: 20 - 3 * bulletPower,
  maxEscapeAngle: 35,
});

test("one-on-one movement probes the opening shot and rejects a mismatched signature", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  const movement = new MovementSystem();

  assert.equal(movement.plan(self, opponent, combat).mode, "signature-counter");
  movement.observeEnemyFire(enemyWave(2.99));
  assert.equal(movement.plan({ ...self, turnNumber: 32 }, opponent, combat).mode, "orbit");
});

test("nearby but non-matching firepower does not trigger the counter", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  const movement = new MovementSystem();

  movement.plan(self, opponent, combat);
  movement.observeEnemyFire(enemyWave(1.84));

  assert.equal(movement.plan({ ...self, turnNumber: 110 }, { ...opponent, x: 560 }, combat).mode, "orbit");
});

test("matching opening fire enables the counter across rounds", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  const movement = new MovementSystem();

  movement.plan(self, opponent, combat);
  movement.observeEnemyFire(enemyWave(1.9));
  movement.resetRound();

  const plan = movement.plan({ ...self, roundNumber: 2, turnNumber: 5, direction: 90 }, opponent, combat);
  assert.equal(plan.mode, "signature-counter");
  assert.equal(plan.forward, 0);
  assert.equal(plan.turnLeft, -90);
});

test("the low-power stationary opener enables the counter", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  const movement = new MovementSystem();

  movement.plan(self, opponent, combat);
  movement.observeEnemyFire(enemyWave(1));
  const plan = movement.plan({ ...self, turnNumber: 35 }, opponent, combat);

  assert.equal(plan.mode, "signature-counter");
  movement.resetRound();
  assert.equal(movement.plan({ ...self, roundNumber: 2 }, opponent, combat).mode, "signature-counter");
});

test("the moving-target opener enables the counter", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  const movement = new MovementSystem();

  movement.plan(self, opponent, combat);
  movement.observeEnemyFire(enemyWave(1.8));

  assert.equal(movement.plan({ ...self, turnNumber: 35 }, opponent, combat).mode, "signature-counter");
});

test("a round that starts as melee never activates the one-on-one probe", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  const movement = new MovementSystem();

  assert.equal(movement.plan({ ...self, enemyCount: 2 }, opponent, combat).mode, "orbit");
  assert.equal(movement.plan({ ...self, enemyCount: 1, turnNumber: 30 }, opponent, combat).mode, "orbit");
});
