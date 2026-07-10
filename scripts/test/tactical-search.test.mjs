import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TACTICAL_POLICY,
  bootstrapMeanDifferenceInterval,
  comparePolicyReports,
  generatePopulation,
} from "../lib/tactical-search.mjs";

function report(opponents, margins) {
  let candidateTotal = 0;
  let opponentTotal = 0;
  const opponent = opponents[0];
  const roundResults = margins.map((margin, index) => {
    opponentTotal += 100;
    candidateTotal += 100 + margin;
    return {
      roundNumber: index + 1,
      turnNumber: 50,
      results: [
        { name: "alee-bot", totalScore: candidateTotal, survival: 0, lastSurvivorBonus: 0, bulletDamage: candidateTotal, bulletKillBonus: 0, ramDamage: 0, ramKillBonus: 0, firstPlaces: 0 },
        { name: opponent, totalScore: opponentTotal, survival: 0, lastSurvivorBonus: 0, bulletDamage: opponentTotal, bulletKillBonus: 0, ramDamage: 0, ramKillBonus: 0, firstPlaces: 0 },
      ],
    };
  });
  return {
    participants: [{ name: "alee-bot" }, ...opponents.map((name) => ({ name }))],
    roundResults,
    processFailures: [],
  };
}

test("bounded population generation is deterministic", () => {
  const first = generatePopulation([DEFAULT_TACTICAL_POLICY], 4, { seed: 7, generation: 0 });
  const second = generatePopulation([DEFAULT_TACTICAL_POLICY], 4, { seed: 7, generation: 0 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, generatePopulation([DEFAULT_TACTICAL_POLICY], 4, { seed: 8, generation: 0 }));
  for (const policy of first) {
    assert.ok(policy.decisionInterval >= 8 && policy.decisionInterval <= 20);
    assert.ok(policy.preferredRange >= 180 && policy.preferredRange <= 500);
    assert.ok(policy.powerBias >= 0.7 && policy.powerBias <= 1.3);
  }
});

test("bootstrap score difference is deterministic and directional", () => {
  const first = bootstrapMeanDifferenceInterval([20, 20, 20], [0, 0, 0], { samples: 500, seed: 9 });
  const second = bootstrapMeanDifferenceInterval([20, 20, 20], [0, 0, 0], { samples: 500, seed: 9 });
  assert.deepEqual(first, second);
  assert.equal(first.meanDifference, 20);
  assert.equal(first.lower, 20);
});

test("retention requires statistical improvement including protected Bradley matchups", () => {
  const baseline = [report(["SampleBot"], [0, 0, 0, 0]), report(["bcn-bot"], [0, 0, 0, 0])];
  const winner = comparePolicyReports(
    [report(["SampleBot"], [20, 20, 20, 20]), report(["bcn-bot"], [10, 10, 10, 10])],
    baseline,
    { protectedOpponents: ["bcn-bot"], seed: 3 },
  );
  assert.equal(winner.retain, true);

  const bradleyRegression = comparePolicyReports(
    [report(["SampleBot"], [50, 50, 50, 50]), report(["bcn-bot"], [-5, -5, -5, -5])],
    baseline,
    { protectedOpponents: ["bcn-bot"], seed: 3 },
  );
  assert.equal(bradleyRegression.retain, false);
  assert.equal(bradleyRegression.protectedFailures.length, 1);
});
