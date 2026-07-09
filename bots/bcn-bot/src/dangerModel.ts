/**
 * Danger model for wave surfing. Learns, per movement situation (features about
 * us at the enemy's fire time), the GuessFactors where the enemy's bullets have
 * actually hit us (strong signal) plus every GF we've been seen at (a light
 * "flattener" so we don't cluster predictably). To evaluate a candidate surf
 * position we take the K most similar past situations and sum a smoothing
 * kernel over their GFs — higher = more likely to be shot there.
 */
import { EnemyWave, SURF_FEATURE_WEIGHTS } from "./enemyWave.ts";

interface DangerPoint {
  features: number[];
  gf: number;
  weight: number;
  isVisit: boolean;
}

const MAX_POINTS = 8000;
// GF-space kernel: exp(-|dGF| * INV_BANDWIDTH). ~0.08 GF bandwidth accounts for
// the real angular width of a bullet vs. our tank.
const INV_BANDWIDTH = 12;
const HIT_WEIGHT = 4.0;
const VISIT_WEIGHT = 0.5; // gated by the adaptive flattener strength at query time
const BASELINE = 0.02;

export interface Neighbor {
  gf: number;
  weight: number;
  isVisit: boolean;
}

export class DangerModel {
  private readonly points: DangerPoint[] = [];

  /** Log a real bullet hit at guessfactor `gf` (heavily weighted). */
  logHit(features: number[], gf: number): void {
    this.add(features, gf, HIT_WEIGHT, false);
  }

  /** Log that a wave passed while we sat at guessfactor `gf` (flattener). */
  logVisit(features: number[], gf: number): void {
    this.add(features, gf, VISIT_WEIGHT, true);
  }

  private add(features: number[], gf: number, weight: number, isVisit: boolean): void {
    this.points.push({ features, gf, weight, isVisit });
    if (this.points.length > MAX_POINTS) this.points.shift();
  }

  /** K nearest past situations to this wave's features. */
  neighbors(wave: EnemyWave): Neighbor[] {
    const n = this.points.length;
    if (n === 0) return [];
    const k = Math.max(6, Math.min(60, Math.round(2 * Math.sqrt(n))));
    const q = wave.features;

    const scored = new Array<{ d: number; gf: number; w: number; isVisit: boolean }>(n);
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const f = p.features;
      let d = 0;
      for (let j = 0; j < q.length; j++) {
        d += SURF_FEATURE_WEIGHTS[j] * Math.abs(q[j] - f[j]);
      }
      scored[i] = { d, gf: p.gf, w: p.weight, isVisit: p.isVisit };
    }
    scored.sort((a, b) => a.d - b.d);

    const kk = Math.min(k, n);
    const scale = Math.max(1e-6, scored[kk - 1].d);
    const out: Neighbor[] = new Array(kk);
    for (let i = 0; i < kk; i++) {
      out[i] = {
        gf: scored[i].gf,
        weight: scored[i].w * Math.exp((-scored[i].d / scale) * 2),
        isVisit: scored[i].isVisit,
      };
    }
    return out;
  }

  /**
   * Danger of being at guessfactor `gf`. `flattener` (0..1) scales how much the
   * visit-based flattener contributes — the surfer turns it up only when the
   * enemy is actually landing hits (a sign of an adaptive gun).
   */
  danger(neighbors: Neighbor[], gf: number, flattener = 1): number {
    let d = BASELINE;
    for (const nb of neighbors) {
      const w = nb.isVisit ? nb.weight * flattener : nb.weight;
      d += w * Math.exp(-Math.abs(gf - nb.gf) * INV_BANDWIDTH);
    }
    return d;
  }
}
