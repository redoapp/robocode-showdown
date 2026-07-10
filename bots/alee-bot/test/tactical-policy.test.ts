import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OpponentState, SelfState } from "../src/combat-state.ts";
import {
  DEFAULT_TACTICAL_POLICY,
  TacticalPolicy,
  validateTacticalPolicy,
} from "../src/tactical-policy.ts";

const self: SelfState = {
  roundNumber: 0,
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

const opponent: OpponentState = {
  id: 2,
  turnNumber: 10,
  energy: 100,
  x: 600,
  y: 300,
  direction: 180,
  speed: 0,
  acceleration: 0,
  turnRate: 0,
  timeSinceDirectionChange: 10,
  timeSinceVelocityChange: 10,
};

test("tactical policy validates the bounded artifact schema", () => {
  const validated = validateTacticalPolicy({ ...DEFAULT_TACTICAL_POLICY, policyId: "candidate", preferredRange: 500 });
  assert.equal(validated.policyId, "candidate");
  assert.ok(Object.isFrozen(validated));
  assert.throws(
    () => validateTacticalPolicy({ ...DEFAULT_TACTICAL_POLICY, decisionInterval: 7 }),
    /8..20/,
  );
  assert.throws(
    () => validateTacticalPolicy({ ...DEFAULT_TACTICAL_POLICY, powerBias: Number.NaN }),
    /power bias/,
  );
});

test("loaded tactical action is held for its bounded decision cadence", () => {
  const directory = mkdtempSync(join(tmpdir(), "alee-tactical-"));
  const path = join(directory, "policy.json");
  writeFileSync(path, JSON.stringify({ ...DEFAULT_TACTICAL_POLICY, policyId: "cadence", decisionInterval: 12 }));
  try {
    const policy = new TacticalPolicy();
    assert.equal(policy.load(path), true);
    const first = policy.decide(self, opponent);
    const cached = policy.decide({ ...self, turnNumber: 21, energy: 0 }, opponent);
    const refreshed = policy.decide({ ...self, turnNumber: 22, energy: 0 }, opponent);
    assert.equal(cached, first);
    assert.notEqual(refreshed, first);
    assert.ok(refreshed.preferredRange > first.preferredRange);
    policy.resetRound();
    assert.notEqual(policy.decide(self, opponent), refreshed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("no artifact leaves the deterministic runtime policy unchanged", () => {
  const policy = new TacticalPolicy();
  assert.equal(policy.load(""), false);
  assert.deepEqual(policy.getConfig(), DEFAULT_TACTICAL_POLICY);
});
