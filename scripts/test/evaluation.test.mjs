import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapMeanInterval,
  candidateRoundMargins,
  candidateRoundScoreRatios,
  compareBattleReports,
  perRoundResults,
} from "../lib/evaluation.mjs";

const report = {
  participants: [{ name: "alee-bot" }, { name: "Hunter" }],
  roundResults: [
    { roundNumber: 1, turnNumber: 20, results: [
      { name: "alee-bot", totalScore: 100, survival: 50, lastSurvivorBonus: 10, bulletDamage: 40, bulletKillBonus: 0, ramDamage: 0, ramKillBonus: 0, firstPlaces: 1 },
      { name: "Hunter", totalScore: 60, survival: 0, lastSurvivorBonus: 0, bulletDamage: 60, bulletKillBonus: 0, ramDamage: 0, ramKillBonus: 0, firstPlaces: 0 },
    ] },
    { roundNumber: 2, turnNumber: 30, results: [
      { name: "Hunter", totalScore: 180, survival: 50, lastSurvivorBonus: 10, bulletDamage: 120, bulletKillBonus: 0, ramDamage: 0, ramKillBonus: 0, firstPlaces: 1 },
      { name: "alee-bot", totalScore: 130, survival: 50, lastSurvivorBonus: 10, bulletDamage: 70, bulletKillBonus: 0, ramDamage: 0, ramKillBonus: 0, firstPlaces: 1 },
    ] },
  ],
};

test("cumulative observer results are converted to per-round deltas", () => {
  const rounds = perRoundResults(report);
  assert.equal(rounds[0].results.find((result) => result.name === "alee-bot").totalScore, 100);
  assert.equal(rounds[1].results.find((result) => result.name === "alee-bot").totalScore, 30);
  assert.equal(rounds[1].results.find((result) => result.name === "Hunter").totalScore, 120);
  assert.deepEqual(candidateRoundMargins(report), [40, -90]);
});

test("bootstrap interval is deterministic for a fixed seed", () => {
  const first = bootstrapMeanInterval([1, 2, 3, 4], { samples: 1000, seed: 7 });
  const second = bootstrapMeanInterval([1, 2, 3, 4], { samples: 1000, seed: 7 });
  assert.deepEqual(first, second);
  assert.equal(first.mean, 2.5);
  assert.ok(first.lower <= first.mean && first.upper >= first.mean);
});

test("candidate/incumbent comparison uses paired per-round score-ratio improvements", () => {
  const incumbent = structuredClone(report);
  incumbent.roundResults[0].results.find((result) => result.name === "alee-bot").totalScore = 80;
  incumbent.roundResults[1].results.find((result) => result.name === "alee-bot").totalScore = 100;
  assert.deepEqual(candidateRoundScoreRatios(report), [100 / 60, 30 / 120]);
  const comparison = compareBattleReports(report, incumbent);
  assert.equal(comparison.rounds, 2);
  assert.ok(comparison.scoreRatioImprovementInterval.mean > 0);
  assert.ok(comparison.marginImprovementInterval.mean > 0);
});

test("candidate/incumbent comparison refuses incomparable participant sets", () => {
  const incumbent = structuredClone(report);
  incumbent.participants[1].name = "SampleBot";
  assert.throws(() => compareBattleReports(report, incumbent), /participants differ/);
});
