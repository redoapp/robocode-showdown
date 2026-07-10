import { clamp } from "./geom.ts";

const BINS = 47;
const MID = (BINS - 1) / 2;
export const gfToBin = (gf: number): number => clamp(Math.round(gf * MID + MID), 0, BINS - 1);
export const binToGf = (i: number): number => (i - MID) / MID;

interface DangerPoint {
  features: number[];
  gf: number;
  weight: number;
}

const FEATURE_W = [3.0, 3.0, 1.5, 1.5, 2.0, 1.0];

function fdist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += FEATURE_W[i] * Math.abs(a[i] - b[i]);
  }
  return s;
}

/**
 * Models where the ENEMY's bullets are likely to be, in GuessFactor terms, so
 * the surfer can move to the least-dangerous spot. Real hits are weighted heavily;
 * a low-weight "flattener" stream logs every wave that passes us so a statistical
 * enemy gun can never settle on our favourite angle.
 */
export class DangerModel {
  private points: DangerPoint[] = [];

  log(features: number[], gf: number, weight: number): void {
    this.points.push({ features, gf, weight });
    if (this.points.length > 2500) this.points.shift();
  }

  /**
   * K nearest past situations, pre-weighted by feature similarity. Compute once
   * per wave, then probe many candidate GFs cheaply with dangerAt().
   */
  neighbors(features: number[]): { gf: number; w: number }[] {
    const n = this.points.length;
    if (n === 0) return [];
    const k = Math.max(6, Math.min(60, Math.round(2 * Math.sqrt(n))));
    const scored = this.points.map((p) => ({ p, d: fdist(features, p.features) }));
    scored.sort((a, b) => a.d - b.d);
    const kk = Math.min(k, n);
    const scale = Math.max(1e-6, scored[kk - 1].d);
    const out: { gf: number; w: number }[] = [];
    for (let i = 0; i < kk; i++) {
      out.push({ gf: scored[i].p.gf, w: scored[i].p.weight * Math.exp((-scored[i].d / scale) * 2) });
    }
    return out;
  }

  /** Danger at `gf` given precomputed neighbors (exponential GF kernel). */
  dangerAt(neighbors: { gf: number; w: number }[], gf: number): number {
    let sum = 0;
    for (const nb of neighbors) {
      sum += nb.w * Math.exp(-Math.abs(nb.gf - gf) * 12);
    }
    return sum;
  }

  /** Danger of being at `gf` given the situation `features`, via KNN kernel. */
  danger(features: number[], gf: number): number {
    return this.dangerAt(this.neighbors(features), gf);
  }

  size(): number {
    return this.points.length;
  }
}
