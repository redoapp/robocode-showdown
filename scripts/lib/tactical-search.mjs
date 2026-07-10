import { readFileSync } from "node:fs";
import { candidateRoundMargins } from "./evaluation.mjs";

const LIMITS = Object.freeze({
  decisionInterval: [8, 20],
  preferredRange: [180, 500],
  dangerAversion: [0.5, 2],
  antiRamDistance: [80, 180],
  powerBias: [0.7, 1.3],
});

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clamp(value, [minimum, maximum]) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function validateSearchPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("policy must be an object");
  if (policy.schemaVersion !== 1 || typeof policy.policyId !== "string" || policy.policyId.length === 0) {
    throw new Error("invalid policy identity");
  }
  for (const [field, limits] of Object.entries(LIMITS)) {
    const value = policy[field];
    if (!Number.isFinite(value) || value < limits[0] || value > limits[1]) {
      throw new Error(`${field} is outside the tactical search space`);
    }
  }
  if (!Number.isSafeInteger(policy.decisionInterval)) throw new Error("decisionInterval must be an integer");
  return Object.freeze({
    schemaVersion: 1,
    policyId: policy.policyId,
    decisionInterval: policy.decisionInterval,
    preferredRange: policy.preferredRange,
    dangerAversion: policy.dangerAversion,
    antiRamDistance: policy.antiRamDistance,
    powerBias: policy.powerBias,
  });
}

export const DEFAULT_TACTICAL_POLICY = validateSearchPolicy(JSON.parse(readFileSync(
  new URL("../../bots/alee-bot/config/tactical-default.json", import.meta.url),
  "utf8",
)));

export function generatePopulation(parents, count, { seed = 20260709, generation = 0 } = {}) {
  if (!Array.isArray(parents) || parents.length === 0) throw new Error("population requires at least one parent");
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error("population size must be 1..64");
  const validParents = parents.map(validateSearchPolicy);
  const random = seededRandom((seed + Math.imul(generation + 1, 0x9e3779b1)) >>> 0);
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const parent = validParents[index % validParents.length];
    const signed = (amplitude) => (random() * 2 - 1) * amplitude;
    return validateSearchPolicy({
      schemaVersion: 1,
      policyId: `tactical-g${generation + 1}-p${String(index + 1).padStart(2, "0")}`,
      decisionInterval: Math.round(clamp(parent.decisionInterval + signed(4), LIMITS.decisionInterval)),
      preferredRange: Math.round(clamp(parent.preferredRange + signed(100), LIMITS.preferredRange)),
      dangerAversion: round(clamp(parent.dangerAversion + signed(0.4), LIMITS.dangerAversion), 3),
      antiRamDistance: Math.round(clamp(parent.antiRamDistance + signed(40), LIMITS.antiRamDistance)),
      powerBias: round(clamp(parent.powerBias + signed(0.2), LIMITS.powerBias), 3),
    });
  }));
}

export function bootstrapMeanDifferenceInterval(
  candidateValues,
  baselineValues,
  { samples = 4000, confidence = 0.95, seed = 20260709 } = {},
) {
  if (!Array.isArray(candidateValues) || candidateValues.length === 0) throw new Error("candidate values are required");
  if (!Array.isArray(baselineValues) || baselineValues.length === 0) throw new Error("baseline values are required");
  const random = seededRandom(seed);
  const differences = new Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let candidateTotal = 0;
    let baselineTotal = 0;
    for (let index = 0; index < candidateValues.length; index += 1) {
      candidateTotal += candidateValues[Math.floor(random() * candidateValues.length)];
    }
    for (let index = 0; index < baselineValues.length; index += 1) {
      baselineTotal += baselineValues[Math.floor(random() * baselineValues.length)];
    }
    differences[sample] = candidateTotal / candidateValues.length - baselineTotal / baselineValues.length;
  }
  differences.sort((left, right) => left - right);
  const candidateMean = candidateValues.reduce((sum, value) => sum + value, 0) / candidateValues.length;
  const baselineMean = baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length;
  const tail = (1 - confidence) / 2;
  return Object.freeze({
    meanDifference: candidateMean - baselineMean,
    lower: differences[Math.floor(samples * tail)],
    upper: differences[Math.min(samples - 1, Math.ceil(samples * (1 - tail)) - 1)],
    candidateMean,
    baselineMean,
    confidence,
    samples,
    candidateObservations: candidateValues.length,
    baselineObservations: baselineValues.length,
  });
}

function opponentKey(report) {
  return report.participants
    .map((participant) => participant.name)
    .filter((name) => name !== "alee-bot")
    .sort()
    .join("+");
}

export function comparePolicyReports(candidateReports, baselineReports, {
  protectedOpponents = [],
  seed = 20260709,
} = {}) {
  if (candidateReports.length !== baselineReports.length || candidateReports.length === 0) {
    throw new Error("candidate and baseline must contain the same non-empty league");
  }
  const matchups = candidateReports.map((candidate, index) => {
    const baseline = baselineReports[index];
    const key = opponentKey(candidate);
    if (key !== opponentKey(baseline)) throw new Error(`league mismatch at matchup ${index + 1}`);
    return Object.freeze({
      opponents: key.split("+").filter(Boolean),
      interval: bootstrapMeanDifferenceInterval(
        candidateRoundMargins(candidate),
        candidateRoundMargins(baseline),
        { seed: seed + index + 1 },
      ),
    });
  });
  const aggregate = bootstrapMeanDifferenceInterval(
    candidateReports.flatMap((report) => candidateRoundMargins(report)),
    baselineReports.flatMap((report) => candidateRoundMargins(report)),
    { seed },
  );
  const processFailures = [...candidateReports, ...baselineReports].flatMap((report) => report.processFailures ?? []);
  const statisticallyWorseMatchups = matchups.filter((matchup) => matchup.interval.upper < 0);
  const protectedComparisons = matchups.filter((matchup) =>
    matchup.opponents.some((opponent) => protectedOpponents.includes(opponent)));
  const protectedFailures = protectedComparisons.filter((matchup) => matchup.interval.lower <= 0);
  const retain = processFailures.length === 0
    && aggregate.lower > 0
    && statisticallyWorseMatchups.length === 0
    && protectedFailures.length === 0;
  return Object.freeze({
    aggregate,
    matchups,
    processFailures,
    protectedOpponents: Object.freeze([...protectedOpponents]),
    statisticallyWorseMatchups,
    protectedFailures,
    retain,
  });
}
