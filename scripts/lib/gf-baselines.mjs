// Reference predictors and scoring for GuessFactor wave-outcome records.
// Shared by the training-data preflight and the trainer's offline evaluation
// so "does the model beat the baselines" always means the same computation.
//
// Records are schema-v2 wave outcomes: { features: number[], label: int,
// waveKind: "real"|"virtual", bulletSpeed: number } with features[0] being
// range normalized by the arena diagonal.

export const DEFAULT_ARENA_DIAGONAL = Math.hypot(800, 600);
const BOT_RADIUS = 18;

export function majorityBin(records, bins) {
  const counts = new Array(bins).fill(0);
  for (const record of records) counts[record.label] += 1;
  let best = Math.floor(bins / 2);
  for (let index = 0; index < counts.length; index += 1) if (counts[index] > counts[best]) best = index;
  return best;
}

// How many GuessFactor bins the target bot's body spans at this record's
// range and bullet speed. A prediction within this tolerance would hit.
export function toleranceBins(record, bins, arenaDiagonal = DEFAULT_ARENA_DIAGONAL) {
  const range = Math.max(record.features[0] * arenaDiagonal, BOT_RADIUS * 2);
  const maxEscapeAngle = Math.asin(Math.min(1, 8 / record.bulletSpeed));
  const botHalfWidth = Math.atan2(BOT_RADIUS, range);
  const binWidth = 2 / (bins - 1);
  return Math.max(1, Math.round(botHalfWidth / maxEscapeAngle / binWidth));
}

export function scorePredictions(predictions, records, bins, arenaDiagonal = DEFAULT_ARENA_DIAGONAL) {
  if (predictions.length !== records.length) throw new Error("predictions and records must align");
  let top1 = 0;
  let within1 = 0;
  let simulatedHits = 0;
  for (let index = 0; index < records.length; index += 1) {
    const error = Math.abs(predictions[index] - records[index].label);
    if (error === 0) top1 += 1;
    if (error <= 1) within1 += 1;
    if (error <= toleranceBins(records[index], bins, arenaDiagonal)) simulatedHits += 1;
  }
  const n = records.length;
  return Object.freeze({ top1: top1 / n, within1: within1 / n, simulatedHitRate: simulatedHits / n });
}

// Classic GF segmentation over stored features:
// [0]=range, [2]=lateral velocity, [4]=acceleration, [10]=wall ahead.
function segmentKey(features) {
  const lateral = Math.min(2, Math.floor(Math.abs(features[2]) * 3));
  const range = Math.min(2, Math.floor(features[0] * 4));
  const wall = features[10] < 0.15 ? 1 : 0;
  const acceleration = features[4] > 0.05 ? 2 : features[4] < -0.05 ? 0 : 1;
  return `${lateral}|${range}|${wall}|${acceleration}`;
}

export function trainSegmentedHistogram(records, bins) {
  const segments = new Map();
  const global = new Array(bins).fill(0);
  for (const record of records) {
    let histogram = segments.get(segmentKey(record.features));
    if (!histogram) {
      histogram = new Array(bins).fill(0);
      segments.set(segmentKey(record.features), histogram);
    }
    const weight = record.waveKind === "real" ? 3 : 1;
    for (let delta = -2; delta <= 2; delta += 1) {
      const bin = record.label + delta;
      if (bin >= 0 && bin < bins) {
        const smoothed = weight / (delta * delta + 1);
        histogram[bin] += smoothed;
        global[bin] += smoothed;
      }
    }
  }
  return { segments, global };
}

export function predictSegmentedHistogram(model, records) {
  return records.map((record) => {
    const histogram = model.segments.get(segmentKey(record.features)) ?? model.global;
    return histogram.indexOf(Math.max(...histogram));
  });
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function predictKnn(trainingRecords, records, bins, { k = 20, trainingCap = 4000, seed = 20260709 } = {}) {
  let pool = trainingRecords;
  if (pool.length > trainingCap) {
    const random = seededRandom(seed);
    pool = [...trainingRecords].sort(() => random() - 0.5).slice(0, trainingCap);
  }
  const features = pool.map((record) => record.features);
  const labels = pool.map((record) => record.label);
  const dimensions = features[0]?.length ?? 0;
  return records.map((query) => {
    const distances = new Array(features.length);
    for (let index = 0; index < features.length; index += 1) {
      let sum = 0;
      const candidate = features[index];
      for (let dim = 0; dim < dimensions; dim += 1) {
        const delta = query.features[dim] - candidate[dim];
        sum += delta * delta;
      }
      distances[index] = sum;
    }
    const nearest = distances.map((_, index) => index)
      .sort((left, right) => distances[left] - distances[right])
      .slice(0, k);
    const votes = new Array(bins).fill(0);
    for (const index of nearest) {
      const weight = 1 / (Math.sqrt(distances[index]) + 0.05);
      for (let delta = -1; delta <= 1; delta += 1) {
        const bin = labels[index] + delta;
        if (bin >= 0 && bin < bins) votes[bin] += weight / (delta * delta + 1);
      }
    }
    return votes.indexOf(Math.max(...votes));
  });
}

// Resample the training set to soften class imbalance and emphasize real
// waves. Each record's sampling weight is realWeight (for real waves) times
// inverse-square-root class frequency; we then draw the original count with
// replacement using a seeded RNG, so results are deterministic and the
// dataset size (and therefore batching) is unchanged.
export function balancedResample(records, bins, { seed = 20260709, realWeight = 3 } = {}) {
  if (records.length === 0) return [];
  const counts = new Array(bins).fill(0);
  for (const record of records) counts[record.label] += 1;
  const weights = records.map((record) =>
    (record.waveKind === "real" ? realWeight : 1) / Math.sqrt(counts[record.label]));
  const cumulative = new Array(weights.length);
  let total = 0;
  for (let index = 0; index < weights.length; index += 1) {
    total += weights[index];
    cumulative[index] = total;
  }
  const random = seededRandom(seed);
  const resampled = new Array(records.length);
  for (let draw = 0; draw < records.length; draw += 1) {
    const target = random() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) low = mid + 1;
      else high = mid;
    }
    resampled[draw] = records[low];
  }
  return resampled;
}
