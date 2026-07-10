import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResolvedFriendlyWave } from "../src/combat-state.js";
import { FEATURE_COUNT } from "../src/learning-system.js";
import { TelemetryCollector } from "../src/telemetry.js";

test("telemetry buffers schema-v2 outcomes until an explicit flush", () => {
  const root = mkdtempSync(join(tmpdir(), "alee-telemetry-"));
  const previousRunId = process.env.ALEE_RUN_ID;
  process.env.ALEE_RUN_ID = "test-run";
  try {
    const collector = new TelemetryCollector(root, true);
    const outcome: ResolvedFriendlyWave = {
      wave: {
        id: 1,
        schemaVersion: 2,
        kind: "virtual",
        opponentId: 7,
        fireTurn: 10,
        origin: { x: 0, y: 0 },
        headOnBearing: 0,
        selectedAimAngle: 15,
        selectedGun: "test",
        collectForTraining: true,
        lateralDirection: 1,
        bulletPower: 2,
        bulletSpeed: 14,
        maxEscapeAngle: 34.8,
        features: Array(FEATURE_COUNT).fill(0),
      },
      resolvedTurn: 20,
      target: { x: 140, y: 0 },
      guessFactor: 0,
      label: 15,
    };
    collector.record(1, outcome);
    const output = join(root, "runs", "test-run", "wave-outcomes-000.jsonl");
    assert.equal(existsSync(output), false);
    collector.flush();
    const record = JSON.parse(readFileSync(output, "utf8").trim());
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.headOnBearing, 0);
    assert.equal(record.selectedAimAngle, 15);
    assert.equal(record.features.length, FEATURE_COUNT);

    collector.recordRound({
      roundNumber: 1,
      endTurn: 40,
      scans: 30,
      gunCoolScans: 12,
      gunAlignedScans: 8,
      gunBearingAbsoluteSum: 120,
      fireRequestsAccepted: 3,
      bulletsFired: 3,
      bulletHits: 1,
      bulletDamage: 4,
      enemyBulletHits: 2,
      enemyBulletDamage: 8,
      inferredEnemyWaves: 3,
      matchedEnemyWaves: 2,
      resolvedRealWaves: 2,
      resolvedVirtualWaves: 20,
      movementModes: { "wave-surf": 12 },
      selectedGuns: { "head-on": 30 },
    });
    collector.flush();
    const diagnostics = JSON.parse(readFileSync(
      join(root, "runs", "test-run", "round-diagnostics.jsonl"),
      "utf8",
    ).trim());
    assert.equal(diagnostics.recordType, "round-diagnostics");
    assert.equal(diagnostics.bulletsFired, 3);
    assert.equal(diagnostics.selectedGuns["head-on"], 30);
  } finally {
    if (previousRunId === undefined) delete process.env.ALEE_RUN_ID;
    else process.env.ALEE_RUN_ID = previousRunId;
    rmSync(root, { recursive: true, force: true });
  }
});
