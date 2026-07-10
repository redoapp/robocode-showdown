import assert from "node:assert/strict";
import test from "node:test";
import { CombatState } from "../src/combat-state.ts";
import type { OpponentState, SelfState } from "../src/combat-state.ts";
import { TargetRadarSystem } from "../src/target-radar-system.ts";

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

test("radar returns a positive left turn for a target counter-clockwise from east", () => {
  const combat = new CombatState();
  combat.resetRound(1);
  combat.observeScan({
    turnNumber: 10,
    scannedBotId: north.id,
    energy: north.energy,
    x: north.x,
    y: north.y,
    direction: north.direction,
    speed: north.speed,
  }, 31, self);
  const radar = new TargetRadarSystem();
  radar.selectTarget(combat, self);
  assert.equal(radar.radarTurn(self, north), 180);
});
