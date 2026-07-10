export function perRoundResults(report) {
  const previous = new Map();
  return report.roundResults.map((round) => {
    const results = round.results.map((result) => {
      const prior = previous.get(result.name) ?? {};
      const delta = {
        ...result,
        survival: result.survival - (prior.survival ?? 0),
        lastSurvivorBonus: result.lastSurvivorBonus - (prior.lastSurvivorBonus ?? 0),
        bulletDamage: result.bulletDamage - (prior.bulletDamage ?? 0),
        bulletKillBonus: result.bulletKillBonus - (prior.bulletKillBonus ?? 0),
        ramDamage: result.ramDamage - (prior.ramDamage ?? 0),
        ramKillBonus: result.ramKillBonus - (prior.ramKillBonus ?? 0),
        totalScore: result.totalScore - (prior.totalScore ?? 0),
        firstPlaces: result.firstPlaces - (prior.firstPlaces ?? 0),
      };
      previous.set(result.name, result);
      return delta;
    });
    return { roundNumber: round.roundNumber, turnNumber: round.turnNumber, results };
  });
}

export function candidateRoundMargins(report, candidateName = "alee-bot") {
  return perRoundResults(report).map((round) => {
    const candidate = round.results.find((result) => result.name === candidateName);
    if (!candidate) throw new Error(`round ${round.roundNumber} does not contain ${candidateName}`);
    const opponents = round.results.filter((result) => result.name !== candidateName);
    const strongestOpponent = Math.max(...opponents.map((result) => result.totalScore));
    return candidate.totalScore - strongestOpponent;
  });
}

export function candidateRoundScoreRatios(report, candidateName = "alee-bot") {
  return perRoundResults(report).map((round) => {
    const candidate = round.results.find((result) => result.name === candidateName);
    if (!candidate) throw new Error(`round ${round.roundNumber} does not contain ${candidateName}`);
    const opponentScore = round.results
      .filter((result) => result.name !== candidateName)
      .reduce((sum, result) => sum + result.totalScore, 0);
    return candidate.totalScore / Math.max(1, opponentScore);
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function bootstrapMeanInterval(values, { samples = 4000, confidence = 0.95, seed = 20260709 } = {}) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("bootstrap requires at least one value");
  const random = seededRandom(seed);
  const means = new Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(random() * values.length)];
    means[sample] = sum / values.length;
  }
  means.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  return Object.freeze({
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    lower: means[Math.floor(samples * tail)],
    upper: means[Math.min(samples - 1, Math.ceil(samples * (1 - tail)) - 1)],
    confidence,
    samples,
    observations: values.length,
  });
}

export function compareBattleReports(candidateReport, incumbentReport, candidateName = "alee-bot") {
  const candidateParticipants = candidateReport.participants.map((participant) => participant.name);
  const incumbentParticipants = incumbentReport.participants.map((participant) => participant.name);
  if (JSON.stringify(candidateParticipants) !== JSON.stringify(incumbentParticipants)) {
    throw new Error(`candidate/incumbent participants differ: ${candidateParticipants.join(",")} vs ${incumbentParticipants.join(",")}`);
  }
  const candidateRatios = candidateRoundScoreRatios(candidateReport, candidateName);
  const incumbentRatios = candidateRoundScoreRatios(incumbentReport, candidateName);
  if (candidateRatios.length !== incumbentRatios.length) {
    throw new Error(`candidate/incumbent round counts differ: ${candidateRatios.length} vs ${incumbentRatios.length}`);
  }
  const scoreRatioImprovements = candidateRatios.map((ratio, index) => ratio - incumbentRatios[index]);
  const candidateMargins = candidateRoundMargins(candidateReport, candidateName);
  const incumbentMargins = candidateRoundMargins(incumbentReport, candidateName);
  const marginImprovements = candidateMargins.map((margin, index) => margin - incumbentMargins[index]);
  return Object.freeze({
    participants: candidateParticipants,
    rounds: candidateRatios.length,
    candidateScoreRatio: candidateRatios.reduce((sum, ratio) => sum + ratio, 0) / candidateRatios.length,
    incumbentScoreRatio: incumbentRatios.reduce((sum, ratio) => sum + ratio, 0) / incumbentRatios.length,
    scoreRatioImprovementInterval: bootstrapMeanInterval(scoreRatioImprovements),
    marginImprovementInterval: bootstrapMeanInterval(marginImprovements),
  });
}

export function summarizeBattle(report, candidateName = "alee-bot") {
  const candidate = report.results.find((result) => result.name === candidateName);
  if (!candidate) throw new Error(`battle does not contain ${candidateName}`);
  const opponents = report.results.filter((result) => result.name !== candidateName);
  const opponentScore = opponents.reduce((sum, result) => sum + result.totalScore, 0);
  const margins = candidateRoundMargins(report, candidateName);
  return Object.freeze({
    participants: report.participants.map((participant) => participant.name),
    rounds: report.roundResults.length,
    candidate: {
      totalScore: candidate.totalScore,
      scoreShare: candidate.totalScore / Math.max(1, candidate.totalScore + opponentScore),
      firstPlaces: candidate.firstPlaces,
      firstPlaceRate: candidate.firstPlaces / Math.max(1, report.roundResults.length),
      survival: candidate.survival,
      bulletDamage: candidate.bulletDamage,
      ramDamage: candidate.ramDamage,
    },
    opponents: opponents.map((result) => ({ name: result.name, totalScore: result.totalScore, firstPlaces: result.firstPlaces })),
    marginInterval: bootstrapMeanInterval(margins),
    processFailures: report.processFailures,
  });
}
