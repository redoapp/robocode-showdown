import assert from "node:assert/strict";
import test from "node:test";
import {
  CombatState,
  absoluteBearing,
  bulletSpeed,
  maximumEscapeAngle,
} from "../src/combat-state.ts";
import type { SelfState, ScanObservation } from "../src/combat-state.ts";

const self = (overrides: Partial<SelfState> = {}): SelfState => ({
  roundNumber: 1,
  turnNumber: 11,
  botId: 1,
  x: 0,
  y: 0,
  direction: 90,
  gunDirection: 0,
  radarDirection: 0,
  speed: 8,
  energy: 100,
  arenaWidth: 800,
  arenaHeight: 600,
  enemyCount: 1,
  ...overrides,
});

const scan = (overrides: Partial<ScanObservation> = {}): ScanObservation => ({
  turnNumber: 10,
  scannedBotId: 7,
  energy: 100,
  x: 140,
  y: 0,
  direction: 90,
  speed: 8,
  ...overrides,
});

const waveInput = (overrides: Record<string, unknown> = {}) => ({
  kind: "virtual" as const,
  opponentId: 7,
  fireTurn: 10,
  origin: { x: 0, y: 0 },
  headOnBearing: 0,
  selectedAimAngle: 0,
  selectedGun: "test",
  collectForTraining: true,
  lateralDirection: 1 as const,
  bulletPower: 2,
  features: Array(18).fill(0),
  ...overrides,
});

test("wave radius uses game turns rather than scan count", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.observeScan(scan({ turnNumber: 10 }), 31);
  state.createFriendlyWave(waveInput());

  for (let index = 0; index < 20; index += 1) {
    const result = state.observeScan(scan({ turnNumber: 19 }), 31);
    assert.equal(result.resolvedWaves.length, 0);
  }
  const resolved = state.observeScan(scan({ turnNumber: 20 }), 31);
  assert.equal(resolved.resolvedWaves.length, 1);
  assert.equal(resolved.resolvedWaves[0].wave.fireTurn, 10);
});

test("melee waves resolve only against their intended opponent", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.createFriendlyWave(waveInput({ opponentId: 7 }));
  state.createFriendlyWave(waveInput({ opponentId: 8 }));

  const other = state.observeScan(scan({ turnNumber: 30, scannedBotId: 8 }), 31);
  assert.deepEqual(other.resolvedWaves.map((outcome) => outcome.wave.opponentId), [8]);
  assert.deepEqual(state.getPendingFriendlyWaves().map((wave) => wave.opponentId), [7]);
});

test("GuessFactor label is independent of the selected aim angle", () => {
  const resolveWithAim = (selectedAimAngle: number) => {
    const state = new CombatState();
    state.resetRound(1);
    const target = scan({ turnNumber: 10, x: 100, y: 100 });
    state.observeScan(target, 31);
    state.createFriendlyWave(waveInput({
      fireTurn: 10,
      headOnBearing: 0,
      selectedAimAngle,
    }));
    return state.observeScan({ ...target, turnNumber: 30 }, 31).resolvedWaves[0];
  };

  const headOn = resolveWithAim(0);
  const deliberatelyWrongAim = resolveWithAim(-35);
  assert.equal(headOn.label, deliberatelyWrongAim.label);
  assert.equal(headOn.guessFactor, deliberatelyWrongAim.guessFactor);
  const expected = Math.min(1, 45 / maximumEscapeAngle(bulletSpeed(2)));
  assert.ok(Math.abs(headOn.guessFactor - expected) < 1e-9);
});

test("wave resolution interpolates across a missed-scan interval", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.observeScan(scan({ turnNumber: 10, x: 100, y: 0 }), 31);
  state.createFriendlyWave(waveInput());
  const result = state.observeScan(scan({ turnNumber: 21, x: 100, y: 110 }), 31);
  assert.equal(result.resolvedWaves.length, 1);
  assert.ok(result.resolvedWaves[0].resolvedTurn > 19);
  assert.ok(result.resolvedWaves[0].resolvedTurn < 21);
});

test("opponent motion derivatives use elapsed game turns", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.observeScan(scan({ turnNumber: 10, direction: 0, speed: 2 }), 31);
  const update = state.observeScan(scan({ turnNumber: 14, direction: 20, speed: 6 }), 31);
  assert.equal(update.opponent.acceleration, 1);
  assert.equal(update.opponent.turnRate, 5);
  assert.equal(update.opponent.timeSinceDirectionChange, 0);
  assert.equal(update.opponent.timeSinceVelocityChange, 0);
});

test("Tank Royale bearing convention is east-zero and counter-clockwise", () => {
  assert.equal(absoluteBearing({ x: 0, y: 0 }, { x: 10, y: 0 }), 0);
  assert.equal(absoluteBearing({ x: 0, y: 0 }, { x: 0, y: 10 }), 90);
});

test("enemy energy drop infers a shooter-specific bullet wave", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.observeScan(scan({ turnNumber: 10, energy: 100, x: 100, y: 0 }), 31, self({ turnNumber: 10 }));
  const update = state.observeScan(scan({ turnNumber: 11, energy: 98, x: 100, y: 0 }), 31, self());
  assert.equal(update.inferredEnemyWaves.length, 1);
  assert.equal(update.inferredEnemyWaves[0].shooterId, 7);
  assert.ok(Math.abs(update.inferredEnemyWaves[0].bulletPower - 2) < 1e-9);
  assert.equal(state.activeEnemyWaves(self()).length, 1);
});

test("known bullet damage is not misclassified as enemy fire", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.observeScan(scan({ turnNumber: 10, energy: 100 }), 31, self({ turnNumber: 10 }));
  state.recordKnownEnergyLoss(7, 11, 2);
  const update = state.observeScan(scan({ turnNumber: 11, energy: 98 }), 31, self());
  assert.equal(update.inferredEnemyWaves.length, 0);
});

test("bullet hits match and remove the correct inferred enemy wave", () => {
  const state = new CombatState();
  state.resetRound(1);
  state.observeScan(scan({ turnNumber: 10, energy: 100, x: 140, y: 0 }), 31, self({ turnNumber: 10 }));
  state.observeScan(scan({ turnNumber: 11, energy: 98, x: 140, y: 0 }), 31, self());
  const resolved = state.resolveEnemyBullet(20, 7, 2, { x: 0, y: 0 });
  assert.ok(resolved);
  assert.equal(resolved.wave.shooterId, 7);
  assert.equal(state.activeEnemyWaves(self({ turnNumber: 20 })).length, 0);
});
