import { distance, guessFactorToBin } from "./combat-state.ts";
import type { EnemyWave, Point, ResolvedEnemyWave } from "./combat-state.ts";

export const DANGER_BINS = 47;

export class DangerEstimator {
  private readonly global = new Map<number, number[]>();
  private readonly segmented = new Map<number, Map<string, number[]>>();

  observe(resolved: ResolvedEnemyWave, weight = 1) {
    const hitBin = guessFactorToBin(resolved.guessFactor, DANGER_BINS);
    const targets = [
      this.bins(this.global, resolved.wave.shooterId),
      this.segmentBins(resolved.wave.shooterId, this.segment(resolved.wave, resolved.position)),
    ];
    for (const bins of targets) {
      for (let index = 0; index < bins.length; index += 1) {
        const delta = index - hitBin;
        bins[index] += weight / (delta * delta + 1);
      }
    }
  }

  danger(shooterId: number, guessFactor: number, wave: EnemyWave, position: Point) {
    const bin = guessFactorToBin(guessFactor, DANGER_BINS);
    const global = this.bins(this.global, shooterId)[bin];
    const segmented = this.segmentBins(shooterId, this.segment(wave, position))[bin];
    return global * 0.35 + segmented * 0.65;
  }

  private segment(wave: EnemyWave, position: Point) {
    const powerBand = wave.bulletPower < 1 ? 0 : wave.bulletPower < 2 ? 1 : 2;
    const range = distance(wave.origin, position);
    const rangeBand = range < 220 ? 0 : range < 450 ? 1 : 2;
    return `${powerBand}:${rangeBand}`;
  }

  private segmentBins(shooterId: number, segment: string) {
    const segments = this.segmented.get(shooterId) ?? new Map<string, number[]>();
    this.segmented.set(shooterId, segments);
    const existing = segments.get(segment);
    if (existing) return existing;
    const bins = new Array<number>(DANGER_BINS).fill(0);
    segments.set(segment, bins);
    return bins;
  }

  private bins(map: Map<number, number[]>, shooterId: number) {
    const existing = map.get(shooterId);
    if (existing) return existing;
    const bins = new Array<number>(DANGER_BINS).fill(0);
    map.set(shooterId, bins);
    return bins;
  }
}
