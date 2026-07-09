/**
 * GuessFactor bins with an exponential visit kernel.
 * See https://robowiki.net/wiki/Visit_Count_Stats.
 *
 * A GuessFactor (GF) is in [-1, 1]: -1 = enemy went the maximum it could against
 * our orbit direction, +1 = maximum with it, 0 = head-on. We accumulate weighted
 * "visits" into bins with a smoothing kernel, then aim at the densest bin.
 */
export class GFBins {
  readonly nBins: number;
  readonly binWidth: number;
  readonly midPoint: number[];
  private readonly bins: number[];

  constructor(nBins: number) {
    this.nBins = nBins;
    this.binWidth = 2.0 / nBins;
    this.midPoint = new Array(nBins);
    this.bins = new Array(nBins).fill(0);
    for (let i = 0; i < nBins; i++) {
      this.midPoint[i] = (i + 0.5) * this.binWidth - 1;
    }
  }

  reset(): void {
    this.bins.fill(0);
  }

  getBin(gf: number): number {
    const b = Math.round((gf + 1) / this.binWidth - 0.5);
    return b < 0 ? 0 : b >= this.nBins ? this.nBins - 1 : b;
  }

  private expKernelWidth(lambda: number): number {
    // how many bins until the kernel gives less than 2% weight
    return Math.round(-Math.log(0.02) / (lambda * this.binWidth));
  }

  /** Add a smoothed visit at guessfactor `gf` with the given weight. */
  addVisit(gf: number, lambda: number, weight: number): void {
    const bin = this.getBin(gf);
    const maxBinDiff = this.expKernelWidth(lambda);
    const lo = Math.max(0, bin - maxBinDiff);
    const hi = Math.min(this.nBins - 1, bin + maxBinDiff);
    for (let i = lo; i <= hi; i++) {
      this.bins[i] += weight * Math.exp(-Math.abs(this.midPoint[i] - gf) * lambda);
    }
  }

  /** GuessFactor at the densest bin. */
  bestGF(): number {
    let best = 0;
    let bestIdx = Math.floor(this.nBins / 2);
    for (let i = 0; i < this.nBins; i++) {
      if (this.bins[i] > best) {
        best = this.bins[i];
        bestIdx = i;
      }
    }
    return this.midPoint[bestIdx];
  }
}
