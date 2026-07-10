/**
 * brett-bot — Tank Royale contender.
 *
 * Design notes (all conventions verified empirically against the v1.0.2 API):
 *   - Angles: 0° = east, counter-clockwise positive, y axis points up.
 *     turnLeft(+x) INCREASES getDirection(). So to aim at an absolute angle A:
 *     setTurnGunLeft(normalizeRelativeAngle(A - getGunDirection())).
 *   - TickEvent priority is lowered below ScannedBotEvent so the whole decision
 *     pipeline runs in onTick with this turn's scan already recorded.
 *   - Fire assist is disabled: the server would otherwise redirect bullets at
 *     the scanned bot's current position, defeating predictive aim.
 *
 * Subsystems:
 *   - Radar: width-2 lock in 1v1 (rescan every turn), full-speed sweep in melee
 *     or when the lock slips.
 *   - Gun: virtual-gun array — head-on, iterative linear, iterative circular
 *     (both wall-clamped), and a segmented GuessFactor gun learning from waves
 *     fired every turn. Best scoring gun takes the real shot.
 *   - Movement: orbit the target at a preferred range with wall smoothing.
 *     Enemy shots are detected from energy drops (corrected for damage we dealt,
 *     energy they regained by hitting us, and ram losses); each incoming wave
 *     triggers a randomized dodge (hold / reverse / brake) that defeats head-on,
 *     linear and circular targeting alike. Melee uses minimum-risk point picking.
 *   - Energy management: distance-based fire power, capped so we never waste
 *     energy on kill shots or fire ourselves into disability.
 */
import {
  Bot,
  Color,
  TickEvent,
  ScannedBotEvent,
  HitByBulletEvent,
  BulletHitBotEvent,
  HitBotEvent,
  HitWallEvent,
} from "@robocode.dev/tank-royale-bot-api";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const PREFERRED_DIST = 475; // orbit range sweet spot
const WALL_MARGIN = 32; // stay this far from walls (bot radius 18 + slack)
const BINS = 31; // GuessFactor bins
const MID_BIN = (BINS - 1) / 2;
const REAL_WAVE_WEIGHT = 5; // real bullets teach the GF gun harder
const GUN_DECAY = 0.985; // virtual-gun rolling score decay per wave
const GUN_REWARD = 0.045;
// Initial virtual-gun scores: bias toward lead guns until data says otherwise.
const GUN_INIT = [0.3, 0.38, 0.42, 0.33, 0.4]; // [head-on, linear, circular, GF, damped-circular]
const DEBUG = !!process.env.DEBUG_BRETT;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Snap {
  turn: number;
  x: number;
  y: number;
  dir: number; // deg
  speed: number;
  energy: number;
}

interface Track {
  id: number;
  cur: Snap | null;
  prev: Snap | null;
  latDir: number; // last non-zero lateral direction (±1)
  lastAbsLatVel: number; // for acceleration segmentation
  turnRate: number; // deg/turn estimate
  emaSpeed: number; // damped velocity estimates for erratic movers
  emaTurnRate: number;
}

/** A bullet wave fired by us (real or virtual) used for GF stats + gun scoring. */
interface Wave {
  fireTurn: number;
  x: number;
  y: number;
  speed: number;
  absBearing: number; // to target at fire time
  latDir: number;
  maxEsc: number; // deg
  seg: number;
  weight: number;
  aims: number[]; // absolute aim angle per virtual gun
  targetId: number;
}

/** An incoming enemy bullet wave inferred from an energy drop. */
interface EnemyWave {
  fireTurn: number;
  x: number;
  y: number;
  speed: number;
  absBearing: number; // from the enemy's fire position to me at fire time
  latDirAtFire: number; // my lateral direction relative to the wave origin at fire time
  maxEsc: number; // deg
}

class BrettBot extends Bot {
  static main() {
    new BrettBot().start();
  }

  // --- learning state: persists across rounds (verified: one process per battle)
  private gfBins: Float64Array[] = Array.from({ length: 28 }, () => new Float64Array(BINS)); // 27 segments + [27] aggregate
  private gunScore = [...GUN_INIT];
  private enemies = new Map<number, Track>();
  // Where enemy bullets hit us, as guess factors. Seeded with head-on (GF 0)
  // and linear-lead (GF +1, half-lead +0.5) priors so we dodge those from shot
  // one; real hits sharpen it into that opponent's actual gun profile.
  private surfDanger: Float64Array = (() => {
    const bins = new Float64Array(BINS);
    const seed = (gf: number, w: number) => {
      const idx = Math.round(((gf + 1) / 2) * (BINS - 1));
      for (let i = Math.max(0, idx - 2); i <= Math.min(BINS - 1, idx + 2); i++) {
        bins[i] += w * (1 - Math.abs(i - idx) / 3);
      }
    };
    seed(0, 1.2);
    seed(1, 0.7);
    seed(0.5, 0.35);
    return bins;
  })();

  // --- per-round state
  private waves: Wave[] = [];
  private enemyWaves: EnemyWave[] = [];
  private orbitDir = 1;
  private dodge: { wave: EnemyWave | null; dir: number; speed: number } = { wave: null, dir: 1, speed: 8 };
  private lastScanTurn = -99;
  private lastRadarSign = 1;
  private meleeDest: { x: number; y: number } | null = null;
  // rolling per-turn energy accounting for enemy-fire detection
  private dmgDealt = new Map<number, Map<number, number>>(); // turn -> victimId -> damage
  private energyGains = new Map<number, Map<number, number>>(); // turn -> botId -> energy gained by hitting me
  private rams = new Map<number, Set<number>>(); // turn -> ids rammed with

  override run() {
    // Full setup every round — intent flags are cheap to re-send.
    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setFireAssist(false);
    // Run onTick AFTER onScannedBot (default: Tick 130 > Scanned 20) so the
    // decision pipeline always sees this turn's scan.
    this.setEventPriority("TickEvent", 15);
    this.setBodyColor(Color.fromRgb(20, 20, 24));
    this.setTurretColor(Color.fromRgb(230, 60, 60));
    this.setRadarColor(Color.fromRgb(255, 210, 60));
    this.setBulletColor(Color.fromRgb(255, 90, 90));
    this.setTracksColor(Color.fromRgb(80, 80, 90));
    this.setGunColor(Color.fromRgb(240, 240, 240));

    // Reset per-round state; keep cross-round learning.
    this.waves = [];
    this.enemyWaves = [];
    this.dodge = { wave: null, dir: 1, speed: 8 };
    this.lastScanTurn = -99;
    this.meleeDest = null;
    this.dmgDealt.clear();
    this.energyGains.clear();
    this.rams.clear();
    for (const t of this.enemies.values()) {
      t.cur = null;
      t.prev = null;
    }

    while (this.isRunning()) {
      this.go();
    }
  }

  // -------------------------------------------------------------------------
  // Event recording (all run before onTick within the same turn)
  // -------------------------------------------------------------------------

  override onScannedBot(e: ScannedBotEvent) {
    try {
      let t = this.enemies.get(e.scannedBotId);
      if (!t) {
        t = { id: e.scannedBotId, cur: null, prev: null, latDir: 1, lastAbsLatVel: 0, turnRate: 0, emaSpeed: 0, emaTurnRate: 0 };
        this.enemies.set(e.scannedBotId, t);
      }
      const snap: Snap = { turn: e.turnNumber, x: e.x, y: e.y, dir: e.direction, speed: e.speed, energy: e.energy };
      t.prev = t.cur;
      t.cur = snap;
      this.lastScanTurn = e.turnNumber;

      if (t.prev && snap.turn > t.prev.turn) {
        const dt = snap.turn - t.prev.turn;
        t.turnRate = clamp(this.normalizeRelativeAngle(snap.dir - t.prev.dir) / dt, -10, 10);
        t.emaSpeed = t.emaSpeed * 0.75 + snap.speed * 0.25;
        t.emaTurnRate = t.emaTurnRate * 0.75 + t.turnRate * 0.25;
        // lateral velocity relative to me, for GF segmentation / latDir
        const absB = this.directionTo(snap.x, snap.y);
        const latVel = snap.speed * Math.sin(toRad(snap.dir - absB));
        if (Math.abs(latVel) > 0.3) t.latDir = latVel > 0 ? 1 : -1;

        // ---- enemy fire detection via energy bookkeeping over (prev.turn, turn]
        if (dt <= 4) {
          let drop = t.prev.energy - snap.energy;
          for (let turn = t.prev.turn + 1; turn <= snap.turn; turn++) {
            drop -= this.dmgDealt.get(turn)?.get(t.id) ?? 0; // damage we did isn't gunfire
            drop += this.energyGains.get(turn)?.get(t.id) ?? 0; // they regained by hitting us
            if (this.rams.get(turn)?.has(t.id)) drop -= 0.6;
          }
          if (drop >= 0.09 && drop <= 3.01) {
            const origin = t.prev;
            const bulletSpeed = 20 - 3 * clamp(drop, 0.1, 3);
            const absBearing = toDeg(Math.atan2(this.getY() - origin.y, this.getX() - origin.x));
            // My lateral direction relative to the wave origin at fire time.
            const myLat = this.getSpeed() * Math.sin(toRad(this.getDirection() - absBearing));
            this.enemyWaves.push({
              fireTurn: snap.turn - 1,
              x: origin.x,
              y: origin.y,
              speed: bulletSpeed,
              absBearing,
              latDirAtFire: myLat >= 0 ? 1 : -1,
              maxEsc: toDeg(Math.asin(clamp(8 / bulletSpeed, 0, 1))),
            });
            if (this.enemyWaves.length > 24) this.enemyWaves.shift();
            if (DEBUG) this.dbg.wavesDetected++;
          }
        }
      }
    } catch (err) {
      if (DEBUG) console.error("[brett] onScannedBot error:", err);
    }
  }

  override onBulletHitBot(e: BulletHitBotEvent) {
    const m = this.dmgDealt.get(e.turnNumber) ?? new Map<number, number>();
    m.set(e.victimId, (m.get(e.victimId) ?? 0) + e.damage);
    this.dmgDealt.set(e.turnNumber, m);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    const m = this.energyGains.get(e.turnNumber) ?? new Map<number, number>();
    m.set(e.bullet.ownerId, (m.get(e.bullet.ownerId) ?? 0) + 3 * e.bullet.power);
    this.energyGains.set(e.turnNumber, m);

    // Teach the surf histogram: which guess factor did this bullet hit us at?
    try {
      let best: EnemyWave | null = null;
      let bestErr = 55;
      for (const w of this.enemyWaves) {
        const radius = w.speed * (e.turnNumber - w.fireTurn);
        const err = Math.abs(radius - Math.hypot(this.getX() - w.x, this.getY() - w.y));
        if (err < bestErr) {
          bestErr = err;
          best = w;
        }
      }
      if (best) {
        const actual = toDeg(Math.atan2(this.getY() - best.y, this.getX() - best.x));
        const offset = this.normalizeRelativeAngle(actual - best.absBearing);
        const gf = clamp((offset / best.maxEsc) * best.latDirAtFire, -1, 1);
        const idx = Math.round(((gf + 1) / 2) * (BINS - 1));
        for (let i = Math.max(0, idx - 2); i <= Math.min(BINS - 1, idx + 2); i++) {
          this.surfDanger[i] += 3 * (1 - Math.abs(i - idx) / 3);
        }
        if (DEBUG) {
          this.dbg.hits++;
          console.error(
            `[brett] HIT turn=${e.turnNumber} gf=${gf.toFixed(2)} dmg=${e.damage.toFixed(1)} plannedDir=${this.dodge.dir} plannedSpd=${this.dodge.speed} myLat=${(this.getSpeed() * Math.sin(toRad(this.getDirection() - actual))).toFixed(1)}`
          );
        }
      } else if (DEBUG) {
        this.dbg.unmatched++;
        console.error(`[brett] HIT turn=${e.turnNumber} NO matching wave (waves=${this.enemyWaves.length})`);
      }
    } catch (err) {
      if (DEBUG) console.error("[brett] surf record error:", err);
    }
  }

  override onHitBot(e: HitBotEvent) {
    const s = this.rams.get(e.turnNumber) ?? new Set<number>();
    s.add(e.victimId);
    this.rams.set(e.turnNumber, s);
  }

  override onHitWall(e: HitWallEvent) {
    // Wall smoothing should prevent this; if it happens, break out of the corner
    // (rate-limited so repeated wall events don't thrash the orbit direction).
    if (e.turnNumber - this.lastFlipTurn > 12) {
      this.orbitDir = -this.orbitDir;
      this.lastFlipTurn = e.turnNumber;
    }
    if (DEBUG) console.error(`[brett] hit wall at (${this.getX().toFixed(0)},${this.getY().toFixed(0)})`);
  }

  override onSkippedTurn(e: { turnNumber: number }) {
    if (DEBUG) console.error(`[brett] skipped turn ${e.turnNumber}`);
  }

  private dbg = { hits: 0, unmatched: 0, flips: 0, wavesDetected: 0, picks: { ccw: 0, cw: 0, brake: 0 } };

  override onRoundEnded(_e: unknown) {
    if (DEBUG) {
      const s = this.gunScore.map((v) => v.toFixed(2)).join("/");
      console.error(
        `[brett] round end — guns HO/LIN/CIRC/GF/DAMP: ${s} | hits=${this.dbg.hits} unmatched=${this.dbg.unmatched} waves=${this.dbg.wavesDetected} flips=${this.dbg.flips} picks=${JSON.stringify(this.dbg.picks)}`
      );
      this.dbg = { hits: 0, unmatched: 0, flips: 0, wavesDetected: 0, picks: { ccw: 0, cw: 0, brake: 0 } };
    }
  }

  // -------------------------------------------------------------------------
  // Decision pipeline — runs once per turn, after all other events
  // -------------------------------------------------------------------------

  override onTick(e: TickEvent) {
    try {
      this.pruneAccounting(e.turnNumber);
      this.updateWaves(e.turnNumber);
      this.updateEnemyWaves(e.turnNumber);

      const target = this.pickTarget(e.turnNumber);
      const melee = this.getEnemyCount() > 1;

      this.steerRadar(target, melee, e.turnNumber);
      if (melee) this.moveMelee(e.turnNumber);
      else this.moveDuel(target, e.turnNumber);
      this.runGun(target, e.turnNumber);
    } catch (err) {
      if (DEBUG) console.error("[brett] onTick error:", err);
      // Fallback: stay a moving target and keep the radar spinning.
      this.setTurnRadarLeft(45);
      this.setMaxSpeed(8);
      this.setForward(100);
      this.setTurnLeft(20);
    }
  }

  // --- target selection ------------------------------------------------------

  private pickTarget(turn: number): Track | null {
    let best: Track | null = null;
    let bestScore = Infinity;
    for (const t of this.enemies.values()) {
      if (!t.cur) continue;
      const age = turn - t.cur.turn;
      if (age > 45) continue;
      const score = this.distanceTo(t.cur.x, t.cur.y) + age * 40; // prefer close & fresh
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  // --- radar -----------------------------------------------------------------

  private steerRadar(target: Track | null, melee: boolean, turn: number) {
    if (melee) {
      // Melee: keep sweeping — 8 turns for a full picture of the field.
      this.setTurnRadarLeft(this.lastRadarSign * 45);
      return;
    }
    const scanAge = turn - this.lastScanTurn;
    if (target?.cur && scanAge <= 2) {
      // Width-2 lock; never let the beam width collapse to zero.
      const bearing = this.radarBearingTo(target.cur.x, target.cur.y);
      let sweep = bearing * 2;
      if (Math.abs(sweep) < 6) sweep = (turn % 2 === 0 ? 1 : -1) * 6;
      else this.lastRadarSign = sweep > 0 ? 1 : -1;
      this.setTurnRadarLeft(sweep);
    } else if (target?.cur && scanAge <= 8) {
      // Slipped: swing hard toward where they were last seen.
      const bearing = this.radarBearingTo(target.cur.x, target.cur.y);
      this.lastRadarSign = bearing >= 0 ? 1 : -1;
      this.setTurnRadarLeft(this.lastRadarSign * 45);
    } else {
      this.setTurnRadarLeft(this.lastRadarSign * 45);
    }
  }

  // --- movement: 1v1 ----------------------------------------------------------

  private moveDuel(target: Track | null, turn: number) {
    if (!target?.cur) {
      // No target yet: drift toward the center so the radar can find someone.
      const cx = this.getArenaWidth() / 2;
      const cy = this.getArenaHeight() / 2;
      if (this.distanceTo(cx, cy) > 60) {
        this.driveAlong(this.directionTo(cx, cy), 8);
      } else {
        this.setMaxSpeed(0);
        this.setForward(0);
      }
      return;
    }
    const en = target.cur;
    const dist = this.distanceTo(en.x, en.y);
    const theta = this.directionTo(en.x, en.y);

    // Anti-ram: if they're charging in close, break away hard.
    const closing =
      target.prev != null &&
      Math.hypot(en.x - this.getX(), en.y - this.getY()) <
        Math.hypot(target.prev.x - this.getX(), target.prev.y - this.getY());
    if (dist < 130 && closing && en.speed > 2) {
      this.driveAlong(this.wallSmooth(theta + 180 + this.orbitDir * 25, turn), 8);
      return;
    }

    // Occasional unpredictability even when they hold fire.
    if (this.enemyWaves.length === 0 && Math.random() < 0.03) this.orbitDir = -this.orbitDir;

    // Orbit with distance control: >90° drifts out, <90° closes in.
    const attack = clamp((dist - PREFERRED_DIST) * 0.08, -32, 32);

    // Wave surfing: simulate our real 2-D motion for each option and score the
    // learned danger across ALL inbound waves (imminence-weighted). Scoring
    // waves one at a time is a trap: each fresh wave relabels "reverse" as the
    // zero-danger side, and the resulting flip-flop resonates with the enemy's
    // fire cadence, parking us at zero lateral speed — head-on food.
    const inbound = this.enemyWaves.filter((w) => {
      const radius = w.speed * (turn - w.fireTurn);
      return radius < Math.hypot(this.getX() - w.x, this.getY() - w.y);
    });
    if (inbound.length > 0) {
      const options = [
        { dir: 1, speed: 8 },
        { dir: -1, speed: 8 },
        { dir: this.orbitDir, speed: 0 },
      ];
      let bestDanger = Infinity;
      let bestOpt = options[0];
      for (const opt of options) {
        const path = this.simSelf(opt.dir, opt.speed, en.x, en.y);
        let danger = 0;
        for (const w of inbound) {
          const { gf, steps } = this.waveCrossing(w, path, turn);
          const idx = Math.round(((gf + 1) / 2) * (BINS - 1));
          let d = 0;
          for (let i = Math.max(0, idx - 2); i <= Math.min(BINS - 1, idx + 2); i++) {
            d += this.surfDanger[i] * (1 - Math.abs(i - idx) / 3);
          }
          danger += d / Math.max(steps, 1); // imminent waves dominate
        }
        if (opt.dir === this.dodge.dir && opt.speed === this.dodge.speed) {
          danger *= 0.9; // hysteresis carries ACROSS waves, or the flapping returns
        }
        if (danger < bestDanger) {
          bestDanger = danger;
          bestOpt = opt;
        }
      }
      if (DEBUG && bestOpt.dir !== this.dodge.dir) this.dbg.flips++;
      if (DEBUG) this.dbg.picks[bestOpt.speed === 0 ? "brake" : bestOpt.dir > 0 ? "ccw" : "cw"]++;
      this.dodge = { wave: null, dir: bestOpt.dir, speed: bestOpt.speed };
      this.orbitDir = bestOpt.dir;
      const travel = this.wallSmooth(theta + this.orbitDir * (90 - attack), turn);
      this.driveAlong(travel, bestOpt.speed);
      return;
    }

    this.dodge = { wave: null, dir: this.orbitDir, speed: 8 };
    const travel = this.wallSmooth(theta + this.orbitDir * (90 - attack), turn);
    this.driveAlong(travel, 8);
  }

  /**
   * Simulate our own movement (the same orbit + driveAlong policy) for ~55
   * turns with the game's accel(1)/decel(2) and speed-dependent body turn
   * limits. Returns the future positions, index = turns from now.
   */
  private simSelf(dir: number, targetSpeed: number, ex: number, ey: number): Array<{ x: number; y: number }> {
    const W = this.getArenaWidth();
    const H = this.getArenaHeight();
    let x = this.getX();
    let y = this.getY();
    let bodyDir = this.getDirection();
    let s = this.getSpeed();
    const path: Array<{ x: number; y: number }> = [{ x, y }];
    for (let step = 1; step <= 55; step++) {
      const theta = toDeg(Math.atan2(ey - y, ex - x));
      const dist = Math.hypot(ex - x, ey - y);
      const attack = clamp((dist - PREFERRED_DIST) * 0.08, -32, 32);
      const desired = this.smoothPure(x, y, theta + dir * (90 - attack), dir);
      const delta = this.normalizeRelativeAngle(desired - bodyDir);
      const maxTurn = 10 - 0.75 * Math.abs(s);
      let targetS: number;
      if (Math.abs(delta) <= 90) {
        bodyDir += clamp(delta, -maxTurn, maxTurn);
        targetS = targetSpeed;
      } else {
        bodyDir += clamp(this.normalizeRelativeAngle(delta + 180), -maxTurn, maxTurn);
        targetS = -targetSpeed;
      }
      if (s < targetS) s = Math.min(s + (s < 0 ? 2 : 1), targetS);
      else if (s > targetS) s = Math.max(s - (s > 0 ? 2 : 1), targetS);
      x = clamp(x + Math.cos(toRad(bodyDir)) * s, 18, W - 18);
      y = clamp(y + Math.sin(toRad(bodyDir)) * s, 18, H - 18);
      path.push({ x, y });
    }
    return path;
  }

  /** Where on this wave does the simulated path get hit, and in how many turns? */
  private waveCrossing(w: EnemyWave, path: Array<{ x: number; y: number }>, turn: number): { gf: number; steps: number } {
    let k = path.length - 1;
    for (let step = 0; step < path.length; step++) {
      const radius = w.speed * (turn + step - w.fireTurn);
      if (radius + w.speed >= Math.hypot(path[step].x - w.x, path[step].y - w.y)) {
        k = step;
        break;
      }
    }
    const p = path[k];
    const actual = toDeg(Math.atan2(p.y - w.y, p.x - w.x));
    const offset = this.normalizeRelativeAngle(actual - w.absBearing);
    return { gf: clamp((offset / w.maxEsc) * w.latDirAtFire, -1, 1), steps: Math.max(k, 1) };
  }

  /** Non-mutating wall smoothing for simulation: rotate toward the cheaper exit. */
  private smoothPure(x: number, y: number, travelDeg: number, dirSign: number): number {
    const W = this.getArenaWidth();
    const H = this.getArenaHeight();
    const stick = 120;
    const ok = (a: number) => {
      const px = x + Math.cos(toRad(a)) * stick;
      const py = y + Math.sin(toRad(a)) * stick;
      return px > WALL_MARGIN && px < W - WALL_MARGIN && py > WALL_MARGIN && py < H - WALL_MARGIN;
    };
    if (ok(travelDeg)) return travelDeg;
    for (let k = 1; k <= 40; k++) {
      if (ok(travelDeg + dirSign * 5 * k)) return travelDeg + dirSign * 5 * k;
      if (ok(travelDeg - dirSign * 5 * k)) return travelDeg - dirSign * 5 * k;
    }
    return toDeg(Math.atan2(H / 2 - y, W / 2 - x));
  }

  /** Closest enemy wave that hasn't passed us yet (the one to dodge). */
  private nearestEnemyWave(turn: number): EnemyWave | null {
    let best: EnemyWave | null = null;
    let bestEta = Infinity;
    for (const w of this.enemyWaves) {
      const radius = w.speed * (turn - w.fireTurn);
      const eta = (Math.hypot(this.getX() - w.x, this.getY() - w.y) - radius) / w.speed;
      if (eta > -1 && eta < bestEta) {
        bestEta = eta;
        best = w;
      }
    }
    return best;
  }

  private updateEnemyWaves(turn: number) {
    this.enemyWaves = this.enemyWaves.filter((w) => {
      const radius = w.speed * (turn - w.fireTurn);
      return radius < Math.hypot(this.getX() - w.x, this.getY() - w.y) + 60;
    });
  }

  // --- movement: melee --------------------------------------------------------

  private moveMelee(turn: number) {
    const W = this.getArenaWidth();
    const H = this.getArenaHeight();
    const reached = this.meleeDest && this.distanceTo(this.meleeDest.x, this.meleeDest.y) < 30;
    if (!this.meleeDest || reached || turn % 14 === 0) {
      let best: { x: number; y: number } | null = null;
      let bestRisk = Infinity;
      for (let i = 0; i < 24; i++) {
        const ang = toRad((i / 24) * 360);
        const r = 110 + Math.random() * 140;
        const px = clamp(this.getX() + Math.cos(ang) * r, WALL_MARGIN + 20, W - WALL_MARGIN - 20);
        const py = clamp(this.getY() + Math.sin(ang) * r, WALL_MARGIN + 20, H - WALL_MARGIN - 20);
        let risk = 0;
        for (const t of this.enemies.values()) {
          if (!t.cur || turn - t.cur.turn > 45) continue;
          const d2 = (px - t.cur.x) ** 2 + (py - t.cur.y) ** 2;
          risk += (t.cur.energy + 25) / Math.max(d2, 400);
        }
        const dw = Math.min(px, W - px, py, H - py);
        risk += 18 / Math.max(dw * dw, 400); // don't hug walls
        risk += Math.random() * 0.00005; // tie-break jitter
        if (risk < bestRisk) {
          bestRisk = risk;
          best = { x: px, y: py };
        }
      }
      this.meleeDest = best;
    }
    if (this.meleeDest) this.driveAlong(this.directionTo(this.meleeDest.x, this.meleeDest.y), 8);
  }

  // --- shared drive helpers ----------------------------------------------------

  /** Head along an absolute travel angle at the given speed, going backwards when faster. */
  private driveAlong(travelDeg: number, speed: number) {
    const delta = this.normalizeRelativeAngle(travelDeg - this.getDirection());
    if (Math.abs(delta) <= 90) {
      this.setTurnLeft(delta);
      this.setMaxSpeed(speed);
      this.setForward(speed > 0 ? 1000 : 0);
    } else {
      this.setTurnLeft(this.normalizeRelativeAngle(delta + 180));
      this.setMaxSpeed(speed);
      this.setForward(speed > 0 ? -1000 : 0);
    }
  }

  /**
   * Rotate a travel angle away from walls. Tries both rotation directions and
   * takes the markedly cheaper one — flipping orbitDir when the cheap way out
   * is against the current orbit (corner escape). May mutate this.orbitDir.
   */
  private lastFlipTurn = -99;

  private wallSmooth(travelDeg: number, turn: number): number {
    const W = this.getArenaWidth();
    const H = this.getArenaHeight();
    const x = this.getX();
    const y = this.getY();
    const stick = 110 + Math.abs(this.getSpeed()) * 14;
    const ok = (a: number) => {
      const px = x + Math.cos(toRad(a)) * stick;
      const py = y + Math.sin(toRad(a)) * stick;
      return px > WALL_MARGIN && px < W - WALL_MARGIN && py > WALL_MARGIN && py < H - WALL_MARGIN;
    };
    // Already pinned inside the margin: run straight for open field.
    if (x < WALL_MARGIN + 6 || x > W - WALL_MARGIN - 6 || y < WALL_MARGIN + 6 || y > H - WALL_MARGIN - 6) {
      return this.directionTo(W / 2, H / 2) + this.orbitDir * 15;
    }
    if (ok(travelDeg)) return travelDeg;
    let withCost = Infinity;
    let againstCost = Infinity;
    for (let k = 1; k <= 40 && withCost === Infinity; k++) if (ok(travelDeg + this.orbitDir * 4 * k)) withCost = k;
    for (let k = 1; k <= 40 && againstCost === Infinity; k++) if (ok(travelDeg - this.orbitDir * 4 * k)) againstCost = k;
    if (againstCost === Infinity && withCost === Infinity) return this.directionTo(W / 2, H / 2);
    if (againstCost * 2 < withCost && turn - this.lastFlipTurn > 12) {
      // The exit is markedly cheaper behind us relative to the orbit — reverse it.
      const exit = travelDeg - this.orbitDir * 4 * againstCost;
      this.orbitDir = -this.orbitDir;
      this.lastFlipTurn = turn;
      return exit;
    }
    if (withCost <= againstCost * 2) return travelDeg + this.orbitDir * 4 * withCost;
    return travelDeg - this.orbitDir * 4 * againstCost;
  }

  // --- gun: virtual gun array ---------------------------------------------------

  private runGun(target: Track | null, turn: number) {
    if (!target?.cur) return;
    const en = target.cur;
    const dist = this.distanceTo(en.x, en.y);
    const melee = this.getEnemyCount() > 1;

    const power = this.pickPower(dist, en.energy, melee);
    const bulletSpeed = 20 - 3 * power;

    // Segment once per turn (latDir/accel are per-turn deltas; computing this
    // twice would corrupt both the recorded segment and the accel bucket).
    const absB = this.directionTo(en.x, en.y);
    const absLat = Math.abs(en.speed * Math.sin(toRad(en.dir - absB)));
    const latB = absLat < 1 ? 0 : absLat < 4 ? 1 : 2;
    const distB = dist < 300 ? 0 : dist < 550 ? 1 : 2;
    const accB = absLat - target.lastAbsLatVel > 0.2 ? 2 : absLat - target.lastAbsLatVel < -0.2 ? 0 : 1;
    const seg = latB * 9 + distB * 3 + accB;
    target.lastAbsLatVel = absLat;

    // Candidate aims (absolute angles).
    const aims = [
      absB, // 0: head-on
      this.aimLinear(target, bulletSpeed), // 1: linear w/ wall clamp
      this.aimCircular(target, bulletSpeed, en.speed, toRad(target.turnRate)), // 2: circular w/ wall clamp
      this.aimGuessFactor(target, bulletSpeed, seg, absB), // 3: GF stats
      this.aimCircular(target, bulletSpeed, target.emaSpeed, toRad(target.emaTurnRate)), // 4: damped circular (EMA velocity)
    ];

    // Best gun takes the shot.
    let gun = 0;
    for (let i = 1; i < this.gunScore.length; i++) if (this.gunScore[i] > this.gunScore[gun]) gun = i;
    const aim = aims[gun];

    const gunError = this.normalizeRelativeAngle(aim - this.getGunDirection());
    this.setTurnGunLeft(gunError);

    const scanAge = turn - en.turn;
    const tolerance = Math.max(1.2, toDeg(Math.atan(12 / dist)));
    let fired = false;
    if (this.getGunHeat() === 0 && Math.abs(gunError) < tolerance && this.getEnergy() > power + 0.1 && scanAge <= 3) {
      fired = this.setFire(power);
    }

    // Wave every turn (while the scan is fresh): real shots teach harder,
    // virtual shots keep learning and keep scoring the guns between shots.
    if (scanAge <= 2) {
      this.waves.push({
        fireTurn: turn,
        x: this.getX(),
        y: this.getY(),
        speed: bulletSpeed,
        absBearing: absB,
        latDir: target.latDir,
        maxEsc: toDeg(Math.asin(clamp(8 / bulletSpeed, 0, 1))),
        seg,
        weight: fired ? REAL_WAVE_WEIGHT : 1,
        aims,
        targetId: target.id,
      });
      if (this.waves.length > 120) this.waves.shift();
    }
  }

  /** Advance our waves; when one reaches its target, record GF + score the guns. */
  private updateWaves(turn: number) {
    const keep: Wave[] = [];
    for (const w of this.waves) {
      const t = this.enemies.get(w.targetId);
      if (!t?.cur || turn - t.cur.turn > 12) continue; // lost track — discard (melee sweep is 8 turns)
      const radius = w.speed * (turn - w.fireTurn);
      const d = Math.hypot(t.cur.x - w.x, t.cur.y - w.y);
      if (radius < d) {
        if (turn - w.fireTurn < 130) keep.push(w);
        continue;
      }
      // Wave broke on the target: learn.
      const actual = toDeg(Math.atan2(t.cur.y - w.y, t.cur.x - w.x));
      const offset = this.normalizeRelativeAngle(actual - w.absBearing);
      const gf = clamp((offset / w.maxEsc) * w.latDir, -1, 1);
      const idx = Math.round(((gf + 1) / 2) * (BINS - 1));
      for (const bins of [this.gfBins[w.seg], this.gfBins[27]]) {
        for (let i = Math.max(0, idx - 2); i <= Math.min(BINS - 1, idx + 2); i++) {
          bins[i] += w.weight * (1 - Math.abs(i - idx) / 3);
        }
      }
      // Score each virtual gun: would its aim have hit the (bot-width) target?
      const halfWidth = toDeg(Math.atan(18 / Math.max(d, 30)));
      for (let g = 0; g < w.aims.length; g++) {
        const hit = Math.abs(this.normalizeRelativeAngle(w.aims[g] - actual)) <= halfWidth * 1.05;
        this.gunScore[g] = this.gunScore[g] * GUN_DECAY + (hit ? GUN_REWARD : 0);
      }
    }
    this.waves = keep;
  }

  private aimLinear(t: Track, bulletSpeed: number): number {
    const en = t.cur!;
    const W = this.getArenaWidth();
    const H = this.getArenaHeight();
    let fx = en.x;
    let fy = en.y;
    for (let i = 0; i < 16; i++) {
      const time = this.distanceTo(fx, fy) / bulletSpeed;
      fx = clamp(en.x + Math.cos(toRad(en.dir)) * en.speed * time, 18, W - 18);
      fy = clamp(en.y + Math.sin(toRad(en.dir)) * en.speed * time, 18, H - 18);
    }
    return this.directionTo(fx, fy);
  }

  private aimCircular(t: Track, bulletSpeed: number, speed: number, turnRateRad: number): number {
    const en = t.cur!;
    const W = this.getArenaWidth();
    const H = this.getArenaHeight();
    let hx = en.x;
    let hy = en.y;
    let heading = toRad(en.dir);
    for (let step = 1; step <= 90; step++) {
      heading += turnRateRad;
      hx = clamp(hx + Math.cos(heading) * speed, 18, W - 18);
      hy = clamp(hy + Math.sin(heading) * speed, 18, H - 18);
      if (step * bulletSpeed >= this.distanceTo(hx, hy)) break;
    }
    return this.directionTo(hx, hy);
  }

  private aimGuessFactor(t: Track, bulletSpeed: number, seg: number, absB: number): number {
    let bins = this.gfBins[seg];
    let sum = 0;
    for (let i = 0; i < BINS; i++) sum += bins[i];
    if (sum < 3) {
      bins = this.gfBins[27]; // aggregate fallback
      sum = 0;
      for (let i = 0; i < BINS; i++) sum += bins[i];
    }
    if (sum < 3) return absB; // no data at all yet: head-on
    let best = MID_BIN;
    for (let i = 0; i < BINS; i++) if (bins[i] > bins[best]) best = i;
    const gf = (best / (BINS - 1)) * 2 - 1;
    const maxEsc = toDeg(Math.asin(clamp(8 / bulletSpeed, 0, 1)));
    return absB + gf * maxEsc * t.latDir;
  }

  // --- fire power ---------------------------------------------------------------

  private pickPower(dist: number, enemyEnergy: number, melee: boolean): number {
    let p: number;
    if (dist < 140) p = 3;
    else p = clamp(3 - (dist - 140) / 260, 1.15, 3);
    if (melee) p = Math.min(p, 2.2);
    // Don't overkill: exact damage needed is 4p (p<=1) or 6p-2 (p>1).
    if (enemyEnergy <= 16) {
      const needed = enemyEnergy > 4 ? (enemyEnergy + 2) / 6 : enemyEnergy / 4;
      p = Math.min(p, needed + 0.05);
    }
    // Conserve when running low — a disabled bot loses the round on its own.
    const my = this.getEnergy();
    if (my < 20) p = Math.min(p, Math.max(0.15, my / 12));
    return clamp(p, 0.1, 3);
  }

  // --- misc -----------------------------------------------------------------------

  private pruneAccounting(turn: number) {
    for (const m of [this.dmgDealt, this.energyGains, this.rams] as Map<number, unknown>[]) {
      for (const k of m.keys()) if (turn - k > 12) m.delete(k);
    }
  }
}

BrettBot.main();
