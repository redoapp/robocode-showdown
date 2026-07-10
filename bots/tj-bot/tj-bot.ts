/**
 * tj-bot — hold fire until fired upon; dodge and study; taunt with a near-miss,
 * then snipe; on any miss, adapt the aiming math and spam while dodging.
 *
 * v3: GuessFactor gun (learns the enemy's real escape-angle distribution from
 * every shot we fire) + wave surfing (dodges toward the escape angles their
 * gun has historically NOT hit us at), with the v2 ray-dodge and circular
 * prediction as no-data fallbacks.
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
  BulletHitBotEvent,
  BotDeathEvent,
  DeathEvent,
  WonRoundEvent,
  Color,
} from "@robocode.dev/tank-royale-bot-api";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const BINS = 31; // odd => center bin is exactly GF 0 (head-on)
const MID = (BINS - 1) / 2;

interface Snapshot {
  turn: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
  energy: number;
}

/** A bullet the enemy fired at us (detected by energy drop). */
interface Wave {
  ox: number;
  oy: number;
  speed: number;
  fireTurn: number;
  aimAngle: number; // angle origin -> us at fire time (the head-on ray)
  maxEscape: number; // asin(8/speed), degrees
  latDir: 1 | -1; // our lateral direction sign at fire time
  segment: number; // surf-stat segment (by our lateral speed)
  reacted: boolean;
  reacted2: boolean;
  mode: number; // fallback dodge mode used on this wave (-1 = none yet)
}

/** A wave for GuessFactor learning — real bullets weigh more than virtual. */
interface GunWave {
  ox: number;
  oy: number;
  speed: number;
  fireTurn: number;
  directAngle: number; // angle us -> enemy at fire time
  maxEscape: number;
  latDir: 1 | -1; // enemy lateral direction sign at fire time
  segment: number;
  weight: number; // 5 = real bullet, 1 = virtual (every-turn training)
}

interface PendingShot {
  expectedHitTurn: number;
  factorIdx: number;
  countsForStats: boolean;
  isNearMiss: boolean;
  isProbe: boolean;
  resolved: boolean;
  hit: boolean;
}

type GunPhase = "HOLD" | "NEAR_MISS" | "PRECISE" | "SPAM";

/** Fallback lead factors: 1 = full prediction, 0 = shoot where they are. */
const LEAD_FACTORS = [1.0, 0.7, 0.4, 0.0];

class TjBot extends Bot {
  /** Learning state — persists across rounds. */
  private factorShots = LEAD_FACTORS.map(() => 0);
  private factorHits = LEAD_FACTORS.map(() => 0);
  private ritualDone = false;
  private gunGF: number[][] = []; // 9 segments x BINS, visit counts (decayed)
  private surfStats: number[][] = []; // 3 segments x BINS, hits on us
  private modeShots = [0, 0]; // dodge-mode bandit: 0 = ray-dodge, 1 = random
  private modeHits = [0, 0];
  private recentResults: number[] = []; // rolling real-shot outcomes (1/0)
  private surfEps = 0.22; // per-round personality: surf randomness rate
  private lastHitTakenTurn = -999;

  private history: Snapshot[] = [];
  private waves: Wave[] = [];
  private gunWaves: GunWave[] = [];
  private pending: PendingShot[] = [];
  private enemyFired = false;
  private gunPhase: GunPhase = "HOLD";
  private targetId: number | null = null;
  private lastScanTurn = -100;
  private damageDealtSinceScan = 0;
  private orbitDir: 1 | -1 = 1;
  private wallFlipCooldown = 0;
  private surfing = false; // true while surf logic is steering this turn
  private pressDist = 400; // creeping distance pressure (herd them wall-ward)

  // Free-for-all: distance + weave until it's a duel, then the 1v1 kit.
  private meleeMode = false;
  private meleeEnemies = new Map<
    number,
    {
      x: number;
      y: number;
      energy: number;
      direction: number;
      speed: number;
      turn: number;
    }
  >();
  private meleeWeavePhase = Math.random() * Math.PI * 2;
  private meleeSpeedTimer = 0;
  private meleeDestX = -1;
  private meleeDestY = -1;
  private meleeLastPlan = -999;

  constructor() {
    super();
    for (let s = 0; s < 9; s++) this.gunGF.push(new Array(BINS).fill(0));
    for (let s = 0; s < 3; s++) {
      // Seed the surf danger with the classic gun archetypes so we surf
      // intelligently from the very first wave instead of cold-starting.
      const buf = new Array(BINS).fill(0);
      buf[MID] += 1.2; // head-on
      buf[BINS - 1] += 0.7; // full linear lead
      buf[Math.round(0.75 * (BINS - 1))] += 0.35; // half lead
      this.surfStats.push(buf);
    }
  }

  static main() {
    new TjBot().start();
  }

  override run() {
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);
    this.setFireAssist(false); // we do our own lead — don't let the server re-aim

    this.setBodyColor(Color.fromRgb(0x10, 0x10, 0x10));
    this.setTurretColor(Color.fromRgb(0xd7, 0x26, 0x31));
    this.setRadarColor(Color.fromRgb(0xd7, 0x26, 0x31));
    this.setBulletColor(Color.fromRgb(0xff, 0x3b, 0x30));
    this.setScanColor(Color.fromRgb(0xff, 0x3b, 0x30));

    this.history = [];
    this.waves = [];
    this.gunWaves = [];
    this.pending = [];
    this.enemyFired = this.ritualDone;
    this.gunPhase = this.ritualDone ? "PRECISE" : "HOLD";
    this.targetId = null;
    this.lastScanTurn = -100;
    this.damageDealtSinceScan = 0;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.wallFlipCooldown = 0;
    this.surfing = false;
    // Round personalities: rotate the distance band and randomness rate so
    // persistent cross-round learners keep training on a bot we no longer are.
    {
      const r = this.getRoundNumber() % 3;
      this.pressDist = [400, 340, 450][r];
      this.surfEps = [0.22, 0.3, 0.15][r];
    }
    this.lastHitTakenTurn = -999;
    this.meleeEnemies.clear();
    this.meleeMode = this.getEnemyCount() > 1;

    while (this.isRunning()) {
      if (this.meleeMode && this.getEnemyCount() <= 1) {
        // The field thinned out to a duel: engage the 1v1 kit. The survivor
        // has been firing all match — the truce never applied to them.
        this.meleeMode = false;
        this.history = [];
        this.waves = [];
        this.gunWaves = [];
        this.targetId = null;
        this.lastScanTurn = -100;
        this.enemyFired = true;
      }
      this.updateWavesAndShots();
      this.updateGunWaves();
      this.doRadar();
      this.doMovement();
      this.doGun();
      this.go();
    }
  }

  // ------------------------------------------------------------- events

  override onScannedBot(e: ScannedBotEvent) {
    this.meleeEnemies.set(e.scannedBotId, {
      x: e.x,
      y: e.y,
      energy: e.energy,
      direction: e.direction,
      speed: e.speed,
      turn: e.turnNumber,
    });
    if (this.meleeMode) return; // FFA: just map the field, no duel bookkeeping

    // Stick to one target so movement analysis isn't polluted (1v1 anyway).
    if (this.targetId === null) this.targetId = e.scannedBotId;
    if (e.scannedBotId !== this.targetId) {
      if (e.turnNumber - this.lastScanTurn < 20) return;
      this.targetId = e.scannedBotId;
      this.history = [];
    }

    const prev = this.history[this.history.length - 1];
    if (prev) {
      // Energy drop not explained by our hits => they fired a bullet.
      const drop = prev.energy - e.energy - this.damageDealtSinceScan;
      if (drop >= 0.09 && drop <= 3.01) {
        this.enemyFired = true;
        const speed = 20 - 3 * drop;
        const aimAngle = this.angleFrom(prev.x, prev.y, this.getX(), this.getY());
        const latVel =
          this.getSpeed() *
          Math.sin((this.getDirection() - aimAngle) * DEG);
        this.waves.push({
          ox: prev.x,
          oy: prev.y,
          speed,
          fireTurn: prev.turn,
          aimAngle,
          maxEscape: Math.asin(Math.min(1, 8 / speed)) * RAD,
          latDir: latVel >= 0 ? 1 : -1,
          segment: this.surfSeg(Math.abs(latVel)),
          reacted: false,
          reacted2: false,
          mode: -1,
        });
      }
    }
    this.damageDealtSinceScan = 0;

    this.history.push({
      turn: e.turnNumber,
      x: e.x,
      y: e.y,
      direction: e.direction,
      speed: e.speed,
      energy: e.energy,
    });
    if (this.history.length > 60) this.history.shift();
    this.lastScanTurn = e.turnNumber;
  }

  override onHitByBullet(e: HitByBulletEvent) {
    this.enemyFired = true;
    this.lastHitTakenTurn = this.getTurnNumber();
    this.pressDist = Math.min(420, this.pressDist + 50);
    // Find the wave that matches this bullet and record the hit GF bin, so
    // surfing learns which escape angles their gun punishes.
    const t = this.getTurnNumber();
    const mx = this.getX();
    const my = this.getY();
    let bestIdx = -1;
    let bestErr = Infinity;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      if (Math.abs(w.speed - e.bullet.speed) > 0.8) continue;
      const traveled = (t - w.fireTurn) * w.speed;
      const err = Math.abs(traveled - Math.hypot(w.ox - mx, w.oy - my));
      if (err < bestErr) {
        bestErr = err;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const w = this.waves[bestIdx];
      // Rolling decay: recent hits matter most, but knowledge must persist.
      const buf = this.surfStats[w.segment];
      for (let b = 0; b < BINS; b++) buf[b] *= 0.9;
      buf[this.binFor(w, mx, my)] += 1;
      if (w.mode >= 0) {
        this.modeShots[w.mode]++;
        this.modeHits[w.mode]++;
      }
      this.waves.splice(bestIdx, 1);
    }
    this.orbitDir = this.orbitDir === 1 ? -1 : 1;
  }

  override onBulletHit(e: BulletHitBotEvent) {
    this.damageDealtSinceScan += e.damage;
    const shot = this.pending.find((s) => !s.resolved);
    if (shot) {
      shot.resolved = true;
      shot.hit = true;
      if (shot.countsForStats) this.factorHits[shot.factorIdx]++;
      if (!shot.isProbe) this.recordShotResult(1);
    }
  }

  private recordShotResult(hit: number) {
    this.recentResults.push(hit);
    if (this.recentResults.length > 20) this.recentResults.shift();
  }

  override onHitBot(e: HitBotEvent) {
    this.enemyFired = true; // rammer: the truce is over even if they never fired
    this.setBack(80);
  }

  override onHitWall(e: HitWallEvent) {
    this.orbitDir = this.orbitDir === 1 ? -1 : 1;
    this.wallFlipCooldown = 12;
  }

  override onBotDeath(e: BotDeathEvent) {
    this.meleeEnemies.delete(e.victimId);
  }

  override onDeath(e: DeathEvent) {
    this.ritualDone = true;
  }

  override onWonRound(e: WonRoundEvent) {
    this.setTurnLeft(360 * 5);
  }

  // -------------------------------------------------------------- radar

  /** Radar: sweep until found, then hard-lock with overshoot. */
  private doRadar() {
    if (this.meleeMode) {
      // FFA: keep the full map fresh — continuous 360° sweep.
      this.setTurnRadarLeft(45);
      return;
    }
    const turn = this.getTurnNumber();
    const en = this.history[this.history.length - 1];
    if (!en || turn - this.lastScanTurn > 2) {
      this.setTurnRadarLeft(45);
      return;
    }
    let bearing = this.normalizeRelativeAngle(
      this.directionTo(en.x, en.y) - this.getRadarDirection(),
    );
    if (bearing === 0) bearing = 2;
    this.setTurnRadarLeft(bearing * 2);
  }

  // ----------------------------------------------------------- movement

  private doMovement() {
    if (this.wallFlipCooldown > 0) this.wallFlipCooldown--;
    if (this.meleeMode) {
      this.moveMelee();
      return;
    }
    const en = this.history[this.history.length - 1];
    if (!en) return;

    const dirToEnemy = this.directionTo(en.x, en.y);

    if (!this.enemyFired) {
      // HOLD: statue mode, pre-aligned perpendicular so the first dodge is instant.
      const face = this.normalizeRelativeAngle(
        dirToEnemy + this.orbitDir * 90 - this.getDirection(),
      );
      this.setTurnLeft(face);
      this.setForward(0);
      return;
    }

    // Wave surfing when we have learned danger data for the incoming wave.
    // Creeping pressure: shrink the preferred range a hair each turn.
    // Distance-keepers retreat from it until the wall eats their dodge room.
    this.pressDist = Math.max(240, this.pressDist - 0.35);

    const wave = this.nearestIncomingWave();
    if (wave && this.hasData(this.surfStats[wave.segment])) {
      this.surfing = true;
      const scored = [-1, 0, 1]
        .map((choice) => ({ choice, danger: this.simDanger(wave, en, choice) }))
        .sort((a, b) => a.danger - b.danger);
      // A deterministic surfer is itself learnable: sometimes take the
      // runner-up escape route when it isn't meaningfully more dangerous.
      let bestChoice = scored[0].choice;
      if (
        Math.random() < this.surfEps &&
        scored[1].danger < scored[0].danger * 2.0 + 0.02
      ) {
        bestChoice = scored[1].choice;
      }
      if (bestChoice === 0) {
        // Brake, but stay aligned to the orbit for an instant restart.
        this.driveOrbit(en, this.orbitDir, 0);
      } else {
        this.orbitDir = bestChoice as 1 | -1;
        // Speed jitter: never hold identical speed two scans running —
        // stability-gated guns (axiom) wait for exactly that to fire.
        this.driveOrbit(en, this.orbitDir, 7.2 + Math.random() * 0.8);
      }
      return;
    }
    this.surfing = false;

    // Fallback (no surf data): mode-bandit between ray-dodge and random dodge.
    const turn = this.getTurnNumber();
    for (const w of this.waves) {
      const traveled = (turn - w.fireTurn) * w.speed;
      const dToUs = Math.hypot(this.getX() - w.ox, this.getY() - w.oy);
      if (!w.reacted && traveled > dToUs * 0.45) {
        w.reacted = true;
        w.mode = this.pickDodgeMode();
        if (w.mode === 1) {
          // Random: flatten our escape-angle profile against learning guns.
          if (this.wallFlipCooldown === 0 && Math.random() < 0.5) {
            this.orbitDir = this.orbitDir === 1 ? -1 : 1;
          }
          this.setMaxSpeed(2 + Math.random() * 6);
        } else {
          // Ray-dodge: steer AWAY from the head-on aim ray.
          // orbitDir = +1 decreases our angle around the origin, -1 increases it.
          const nowDir = this.angleFrom(w.ox, w.oy, this.getX(), this.getY());
          const delta = this.normalizeRelativeAngle(nowDir - w.aimAngle);
          if (this.wallFlipCooldown === 0) {
            if (Math.abs(delta) < 1) {
              this.orbitDir = Math.random() < 0.5 ? 1 : -1;
            } else {
              this.orbitDir = delta > 0 ? -1 : 1;
            }
          }
          this.setMaxSpeed(6 + Math.random() * 2);
        }
      }
      if (w.mode === 1 && !w.reacted2 && traveled > dToUs * 0.8) {
        // Second scramble late in the flight — smears the landing distribution.
        w.reacted2 = true;
        if (this.wallFlipCooldown === 0 && Math.random() < 0.35) {
          this.orbitDir = this.orbitDir === 1 ? -1 : 1;
        }
        this.setMaxSpeed(2 + Math.random() * 6);
      }
    }
    // Random jitter only between volleys — never while a bullet is in flight.
    if (
      this.waves.length === 0 &&
      Math.random() < 0.04 &&
      this.wallFlipCooldown === 0
    ) {
      this.orbitDir = this.orbitDir === 1 ? -1 : 1;
    }
    // Between volleys, keep the speed unstable so fire-gated guns stay shut.
    if (this.waves.length === 0) this.setMaxSpeed(6 + Math.random() * 2);

    this.driveOrbit(en, this.orbitDir, -1);
  }

  /**
   * FFA survival: min-risk destination movement. Commit to a point far from
   * every living tank and stride there at full speed; replan on arrival (or
   * timeout). Long strides beat per-turn dithering; randomness in sampling
   * plus a light weave keeps the path erratic enough to spoil predictors.
   */
  private moveMelee() {
    const turn = this.getTurnNumber();
    for (const [id, e] of this.meleeEnemies) {
      if (turn - e.turn > 60) this.meleeEnemies.delete(id);
    }

    const reached =
      this.meleeDestX >= 0 &&
      Math.hypot(this.getX() - this.meleeDestX, this.getY() - this.meleeDestY) < 40;
    if (this.meleeDestX < 0 || reached || turn - this.meleeLastPlan > 24) {
      this.planMeleeDestination();
      this.meleeLastPlan = turn;
    }

    // Light weave on top of the stride so the leg isn't a clean line.
    const weave = Math.sin(turn * 0.3 + this.meleeWeavePhase) * 10;
    const travelDir =
      this.angleFrom(this.getX(), this.getY(), this.meleeDestX, this.meleeDestY) +
      weave;
    if (--this.meleeSpeedTimer <= 0) {
      this.setMaxSpeed(6.5 + Math.random() * 1.5);
      this.meleeSpeedTimer = 10 + Math.floor(Math.random() * 12);
    }

    // Drive forward or backward, whichever needs less body turning.
    let bodyTurn = this.normalizeRelativeAngle(travelDir - this.getDirection());
    let drive = 1;
    if (Math.abs(bodyTurn) > 90) {
      bodyTurn = this.normalizeRelativeAngle(bodyTurn + 180);
      drive = -1;
    }
    this.setTurnLeft(bodyTurn);
    this.setForward(drive * 100);
  }

  private planMeleeDestination() {
    const aw = this.getArenaWidth();
    const ah = this.getArenaHeight();
    const px = this.getX();
    const py = this.getY();
    const candidates: { x: number; y: number; risk: number }[] = [];
    const baseAngle = Math.random() * 360;

    for (let i = 0; i < 20; i++) {
      const ang = (baseAngle + (i * 360) / 20) * DEG;
      const radius = 150 + Math.random() * 150;
      const x = Math.max(60, Math.min(aw - 60, px + Math.cos(ang) * radius));
      const y = Math.max(60, Math.min(ah - 60, py + Math.sin(ang) * radius));

      let risk = 0;
      for (const e of this.meleeEnemies.values()) {
        const d2 = Math.max((x - e.x) ** 2 + (y - e.y) ** 2, 400);
        risk += (e.energy + 60) / d2;
      }
      // Never corner ourselves: penalize wall closeness, dread corners.
      let nearWalls = 0;
      for (const dw of [x, aw - x, y, ah - y]) {
        if (dw < 100) {
          risk += ((100 - dw) / 100) ** 2 * 0.003;
          nearWalls++;
        }
      }
      if (nearWalls >= 2) risk += 0.008;
      // Barely moving = easy target; encourage real strides.
      if (Math.hypot(x - px, y - py) < 80) risk += 0.002;
      candidates.push({ x, y, risk });
    }

    candidates.sort((a, b) => a.risk - b.risk);
    // Occasionally take the runner-up so the pattern never fully settles.
    const pick =
      candidates.length > 1 && Math.random() < 0.15 ? candidates[1] : candidates[0];
    this.meleeDestX = pick.x;
    this.meleeDestY = pick.y;
  }

  /** A tank parked near two walls has nowhere to dodge — free damage. */
  private isCornered(e: { x: number; y: number }): boolean {
    const m = 170;
    const nearX = e.x < m || e.x > this.getArenaWidth() - m;
    const nearY = e.y < m || e.y > this.getArenaHeight() - m;
    return nearX && nearY;
  }

  /** Epsilon-greedy over fallback dodge modes by observed enemy hit rate. */
  private pickDodgeMode(): number {
    if (Math.random() < 0.1) return Math.random() < 0.5 ? 0 : 1;
    const rate = (m: number) => (this.modeHits[m] + 1) / (this.modeShots[m] + 4);
    return rate(0) <= rate(1) ? 0 : 1;
  }

  /**
   * Drive along the orbit around the enemy. maxSpeed 0 = brake in place,
   * -1 = leave current max speed untouched.
   */
  private driveOrbit(en: Snapshot, dir: number, maxSpeed: number) {
    const dist = this.distanceTo(en.x, en.y);
    const dirToEnemy = this.directionTo(en.x, en.y);
    // Tilt the orbit in/out to hold a fighting distance band around ~400.
    // Close distance gently (12 deg max) — a radial charge kills the
    // angular velocity that makes us hard to hit. Retreat can be steeper.
    const tilt = Math.max(-35, Math.min(12, (dist - this.pressDist) / 10));
    let travelDir = dirToEnemy + dir * (90 - tilt);

    if (!this.travelIsSafe(travelDir)) {
      const flipped = dirToEnemy - dir * (90 - tilt);
      if (this.travelIsSafe(flipped) && this.wallFlipCooldown === 0) {
        this.orbitDir = (dir === 1 ? -1 : 1) as 1 | -1;
        travelDir = flipped;
        this.wallFlipCooldown = 8;
      } else {
        // Cornered: wall-smooth — rotate the heading until it clears, keeping
        // lateral motion. Never charge the center (that's a radial gift).
        let smoothed = travelDir;
        let found = false;
        for (let i = 1; i <= 22; i++) {
          smoothed = travelDir + dir * 15 * i;
          if (this.travelIsSafe(smoothed)) {
            found = true;
            break;
          }
        }
        travelDir = found
          ? smoothed
          : this.directionTo(this.getArenaWidth() / 2, this.getArenaHeight() / 2);
      }
    }

    // Drive forward or backward, whichever needs less body turning.
    let bodyTurn = this.normalizeRelativeAngle(travelDir - this.getDirection());
    let drive = 1;
    if (Math.abs(bodyTurn) > 90) {
      bodyTurn = this.normalizeRelativeAngle(bodyTurn + 180);
      drive = -1;
    }
    this.setTurnLeft(bodyTurn);
    if (maxSpeed === 0) {
      this.setForward(0);
    } else {
      if (maxSpeed > 0) this.setMaxSpeed(maxSpeed);
      this.setForward(drive * 100);
    }
  }

  private travelIsSafe(travelDirDeg: number): boolean {
    const margin = 70;
    const lookahead = 130;
    const nx = this.getX() + Math.cos(travelDirDeg * DEG) * lookahead;
    const ny = this.getY() + Math.sin(travelDirDeg * DEG) * lookahead;
    return (
      nx > margin &&
      ny > margin &&
      nx < this.getArenaWidth() - margin &&
      ny < this.getArenaHeight() - margin
    );
  }

  // ------------------------------------------------------- wave surfing

  private nearestIncomingWave(): Wave | null {
    const t = this.getTurnNumber();
    const mx = this.getX();
    const my = this.getY();
    let best: Wave | null = null;
    let bestTime = Infinity;
    for (const w of this.waves) {
      const front = (t - w.fireTurn) * w.speed;
      const d = Math.hypot(w.ox - mx, w.oy - my);
      const timeToHit = (d - front) / w.speed;
      if (timeToHit > -1 && timeToHit < bestTime) {
        bestTime = timeToHit;
        best = w;
      }
    }
    return best;
  }

  /**
   * Forward-simulate our motion under `choice` (-1 reverse orbit, 0 stop,
   * +1 keep orbit) until the wave front reaches us; score the landing bin
   * against learned hit danger.
   */
  private simDanger(w: Wave, en: Snapshot, choice: number): number {
    const aw = this.getArenaWidth();
    const ah = this.getArenaHeight();
    let px = this.getX();
    let py = this.getY();
    let head = this.getDirection();
    let vel = this.getSpeed();
    let t = this.getTurnNumber();

    for (let step = 0; step < 120; step++) {
      if (choice === 0) {
        vel += Math.max(-2, Math.min(1, 0 - vel));
      } else {
        const dirToEnemy = this.angleFrom(px, py, en.x, en.y);
        const dist = Math.hypot(en.x - px, en.y - py);
        // Close distance gently (12 deg max) — a radial charge kills the
    // angular velocity that makes us hard to hit. Retreat can be steeper.
    const tilt = Math.max(-35, Math.min(12, (dist - this.pressDist) / 10));
        let travel = dirToEnemy + choice * (90 - tilt);
        // Cheap wall handling in-sim: rotate travel inward if unsafe.
        for (let i = 0; i < 12; i++) {
          const nx = px + Math.cos(travel * DEG) * 130;
          const ny = py + Math.sin(travel * DEG) * 130;
          if (nx > 40 && ny > 40 && nx < aw - 40 && ny < ah - 40) break;
          travel += choice * 15;
        }
        let bearing = this.normalizeRelativeAngle(travel - head);
        let target = 8;
        if (Math.abs(bearing) > 90) {
          bearing = this.normalizeRelativeAngle(bearing + 180);
          target = -8;
        }
        const maxTurn = 10 - 0.75 * Math.min(Math.abs(vel), 8);
        head += Math.max(-maxTurn, Math.min(maxTurn, bearing));
        vel += Math.max(-2, Math.min(1, target - vel));
      }
      px += Math.cos(head * DEG) * vel;
      py += Math.sin(head * DEG) * vel;
      px = Math.max(18, Math.min(aw - 18, px));
      py = Math.max(18, Math.min(ah - 18, py));
      t++;
      const front = (t - w.fireTurn) * w.speed;
      if (Math.hypot(px - w.ox, py - w.oy) <= front) break;
    }

    let danger = this.smoothedStat(this.surfStats[w.segment], this.binFor(w, px, py));
    // Slight preference for keeping distance.
    const endDist = Math.hypot(px - en.x, py - en.y);
    if (endDist < this.pressDist) danger += (this.pressDist - endDist) * 0.002;
    return danger;
  }

  private binFor(w: Wave, x: number, y: number): number {
    const ang = this.angleFrom(w.ox, w.oy, x, y);
    const offset = this.normalizeRelativeAngle(ang - w.aimAngle);
    const factor = Math.max(-1, Math.min(1, (offset / w.maxEscape) * w.latDir));
    return Math.round(((factor + 1) / 2) * (BINS - 1));
  }

  private surfSeg(absLatVel: number): number {
    return absLatVel < 2 ? 0 : absLatVel < 6 ? 1 : 2;
  }

  private hasData(buf: number[]): boolean {
    for (let i = 0; i < BINS; i++) if (buf[i] > 0) return true;
    return false;
  }

  private smoothedStat(buf: number[], bin: number): number {
    let d = 0;
    for (let i = 0; i < BINS; i++) {
      const x = i - bin;
      d += buf[i] / (x * x + 1);
    }
    return d;
  }

  private angleFrom(x1: number, y1: number, x2: number, y2: number): number {
    return Math.atan2(y2 - y1, x2 - x1) * RAD;
  }

  // ------------------------------------------------------------------ gun

  private doGun() {
    if (this.meleeMode) {
      this.doMeleeGun();
      return;
    }
    const en = this.history[this.history.length - 1];
    if (!en) return;
    const turn = this.getTurnNumber();
    const dist = this.distanceTo(en.x, en.y);

    // Hold fire until we have data AND they've fired (or a long-standoff failsafe).
    const analysisReady =
      this.history.length >= 12 && (this.enemyFired || turn > 120);

    if (this.gunPhase === "HOLD" && analysisReady) {
      this.gunPhase = "PRECISE";
      this.ritualDone = true;
    }

    // A miss on the snipe flips us into spam mode.
    for (const s of this.pending) {
      if (!s.resolved && turn > s.expectedHitTurn) {
        s.resolved = true;
        if (!s.isNearMiss) this.gunPhase = "SPAM";
        if (!s.isProbe && !s.isNearMiss) this.recordShotResult(0);
      }
    }

    // Virtual training wave EVERY turn the scan is fresh, firing or not —
    // the gun studies constantly instead of one lesson per bullet.
    if (turn - this.lastScanTurn <= 1) {
      const vDirect = this.directionTo(en.x, en.y);
      const vLatVel = en.speed * Math.sin((en.direction - vDirect) * DEG);
      const vSpeed = 20 - 3 * Math.max(0.5, this.choosePower(dist));
      this.gunWaves.push({
        ox: this.getX(),
        oy: this.getY(),
        speed: vSpeed,
        fireTurn: turn,
        directAngle: vDirect,
        maxEscape: Math.asin(Math.min(1, 8 / vSpeed)) * RAD,
        latDir: vLatVel >= 0 ? 1 : -1,
        segment: this.gunSeg(dist, Math.abs(vLatVel)),
        weight: 1,
      });
    }

    if (this.gunPhase === "HOLD") return;

    const directAngle = this.directionTo(en.x, en.y);
    const latVel = en.speed * Math.sin((en.direction - directAngle) * DEG);
    const latDir: 1 | -1 = latVel >= 0 ? 1 : -1;
    const seg = this.gunSeg(dist, Math.abs(latVel));

    // Scatter-shot probing: while the GF histogram for this segment is thin,
    // spend 0.1-power bullets (the fastest in the game) as pure sensors —
    // every wave records how they dodge, whatever it was aimed at.
    const dataMass = this.gunGF[seg].reduce((a, b) => a + b, 0);
    const probing = this.gunPhase === "SPAM" && dataMass < 3;

    const power = probing ? 0.1 : this.choosePower(dist);
    if (power <= 0) return;
    const bulletSpeed = 20 - 3 * power;
    const maxEscape = Math.asin(Math.min(1, 8 / bulletSpeed)) * RAD;

    // GuessFactor aim when we have data; else priors / circular+bandit.
    let aimDir: number;
    let factorIdx = 0;
    let usedGF = false;
    let usedPrior = false;
    if (probing) {
      if (Math.abs(latVel) > 1) {
        // Moving target with a cold histogram: probe the negative-GF zone —
        // seeded surfers dodge the classic (positive) leads and back into it.
        const gf = -0.65 + Math.random() * 0.5;
        aimDir = directAngle + gf * maxEscape * latDir;
      } else {
        // Stationary: uniform scatter.
        aimDir = directAngle + (Math.random() * 2 - 1) * maxEscape * latDir;
      }
    } else if (this.hasData(this.gunGF[seg])) {
      const bin = this.bestBin(this.gunGF[seg]);
      const factor = (bin / (BINS - 1)) * 2 - 1;
      aimDir = directAngle + factor * maxEscape * latDir;
      usedGF = true;
    } else if (Math.abs(latVel) > 2) {
      // No data yet on a laterally-moving target: negative-GF prior beats
      // both seeded surfers and plain orbiters more often than full lead.
      aimDir = directAngle - 0.55 * maxEscape * latDir;
      usedPrior = true;
    } else {
      if (this.gunPhase === "SPAM") factorIdx = this.pickLeadFactor();
      const predicted = this.predictPosition(bulletSpeed);
      const dirPredicted = this.directionTo(predicted.x, predicted.y);
      const lead = this.normalizeRelativeAngle(dirPredicted - directAngle);
      aimDir = directAngle + lead * LEAD_FACTORS[factorIdx];
    }

    const gunTurn = this.normalizeRelativeAngle(aimDir - this.getGunDirection());
    this.setTurnGunLeft(gunTurn);

    // Fire gate scales with range: the angle subtended by a half-tank (18px).
    const tol = Math.atan2(18, Math.max(dist, 1)) / DEG + 0.7;
    const aligned = Math.abs(gunTurn) < (this.gunPhase === "SPAM" ? tol : 2);
    if (!aligned || this.getGunHeat() > 0) return;

    const firePower = power;
    if (this.setFire(firePower)) {
      const isNearMiss = false;
      const countsForStats =
        this.gunPhase === "SPAM" && !usedGF && !probing && !usedPrior;
      if (countsForStats) this.factorShots[factorIdx]++;
      const fireSpeed = 20 - 3 * firePower;
      this.gunWaves.push({
        ox: this.getX(),
        oy: this.getY(),
        speed: fireSpeed,
        fireTurn: turn,
        directAngle,
        maxEscape: Math.asin(Math.min(1, 8 / fireSpeed)) * RAD,
        latDir,
        segment: this.gunSeg(dist, Math.abs(latVel)),
        weight: 5,
      });
      this.pending.push({
        expectedHitTurn: turn + Math.ceil(dist / fireSpeed) + 10,
        factorIdx,
        countsForStats,
        isNearMiss,
        isProbe: probing,
        resolved: false,
        hit: false,
      });
    }
  }

  /**
   * FFA gun: opportunistic linear-lead shots at the nearest tank while the
   * movement keeps its distance. Banks damage points without committing —
   * and never touches the duel GF stats.
   */
  private doMeleeGun() {
    const turn = this.getTurnNumber();
    let target: {
      x: number;
      y: number;
      energy: number;
      direction: number;
      speed: number;
    } | null = null;
    let bestD = Infinity;
    let targetCornered = false;
    for (const e of this.meleeEnemies.values()) {
      if (turn - e.turn > 8) continue; // stale scan — can't aim at a ghost
      const d = this.distanceTo(e.x, e.y);
      const cornered = this.isCornered(e);
      // Cornered tanks jump the queue: nowhere to dodge, whittle them down.
      if (cornered && !targetCornered) {
        bestD = d;
        target = e;
        targetCornered = true;
      } else if (cornered === targetCornered && d < bestD) {
        bestD = d;
        target = e;
      }
    }
    if (!target) return;

    const energy = this.getEnergy();
    // Survival first: only spend energy when we have a cushion — but a
    // cornered target is close to free damage, so commit harder.
    if (energy < (targetCornered ? 15 : 25)) return;
    let power = bestD < 300 ? 1.9 : bestD < 600 ? 1.2 : 0.8;
    if (targetCornered) power = bestD < 300 ? 2.4 : bestD < 600 ? 1.7 : 1.1;
    if (energy < 45) power = Math.min(power, targetCornered ? 1.4 : 1);
    // Don't overkill a nearly-dead tank.
    if (target.energy < 16) {
      power = Math.min(power, Math.max(target.energy / 4 + 0.1, 0.1));
    }
    const bulletSpeed = 20 - 3 * power;

    // Linear lead: walk the target forward until a bullet could reach it.
    let tx = target.x;
    let ty = target.y;
    for (let t = 1; t <= 60; t++) {
      tx += Math.cos(target.direction * DEG) * target.speed;
      ty += Math.sin(target.direction * DEG) * target.speed;
      tx = Math.max(18, Math.min(this.getArenaWidth() - 18, tx));
      ty = Math.max(18, Math.min(this.getArenaHeight() - 18, ty));
      if (Math.hypot(tx - this.getX(), ty - this.getY()) <= bulletSpeed * t) {
        break;
      }
    }

    const gunTurn = this.normalizeRelativeAngle(
      this.directionTo(tx, ty) - this.getGunDirection(),
    );
    this.setTurnGunLeft(gunTurn);
    const tol = Math.atan2(18, Math.max(bestD, 1)) / DEG + 0.5;
    if (Math.abs(gunTurn) < tol && this.getGunHeat() === 0) {
      this.setFire(power);
    }
  }

  /** Record where the enemy actually was when each of our waves crossed them. */
  private updateGunWaves() {
    if (this.gunWaves.length === 0) return;
    const en = this.history[this.history.length - 1];
    if (!en) return;
    const t = this.getTurnNumber();
    for (let i = this.gunWaves.length - 1; i >= 0; i--) {
      const w = this.gunWaves[i];
      const traveled = (t - w.fireTurn) * w.speed;
      const d = Math.hypot(w.ox - en.x, w.oy - en.y);
      if (traveled >= d) {
        const ang = this.angleFrom(w.ox, w.oy, en.x, en.y);
        const offset = this.normalizeRelativeAngle(ang - w.directAngle);
        const factor = Math.max(
          -1,
          Math.min(1, (offset / w.maxEscape) * w.latDir),
        );
        const bin = Math.round(((factor + 1) / 2) * (BINS - 1));
        const buf = this.gunGF[w.segment];
        // Weighted rolling update: real bullets teach 5x harder than virtual
        // waves, and decay scales with weight so the firehose doesn't flush
        // the histogram.
        const decay = 1 - w.weight / 110;
        for (let b = 0; b < BINS; b++) buf[b] *= decay;
        buf[bin] += w.weight;
        this.gunWaves.splice(i, 1);
      } else if (t - w.fireTurn > 150) {
        this.gunWaves.splice(i, 1);
      }
    }
  }

  private bestBin(buf: number[]): number {
    let best = MID;
    let bestVal = -1;
    for (let i = 0; i < BINS; i++) {
      const s = this.smoothedStat(buf, i);
      if (s > bestVal) {
        bestVal = s;
        best = i;
      }
    }
    return best;
  }

  private gunSeg(dist: number, absLatVel: number): number {
    const db = dist < 250 ? 0 : dist < 600 ? 1 : 2;
    const lb = absLatVel < 1 ? 0 : absLatVel < 5 ? 1 : 2;
    return db * 3 + lb;
  }

  private choosePower(dist: number): number {
    const energy = this.getEnergy();
    if (energy < 1) return 0;
    let power = dist < 150 ? 3 : dist < 400 ? 2.0 : 1.5;
    // Attrition discipline: when we're not connecting, cheaper faster
    // bullets win the energy war (and are harder to surf).
    const n = this.recentResults.length;
    if (n >= 8) {
      const rate = this.recentResults.reduce((a, b) => a + b, 0) / n;
      // Only throttle when their gun is actually punishing us — against a
      // cold opponent, keep spending: points now beat energy later.
      const punished = this.getTurnNumber() - this.lastHitTakenTurn < 80;
      if (punished && dist > 220 && rate < 0.25) power = Math.min(power, 1.5);
      // Vampire mode: above ~33% hit rate every shot is energy-POSITIVE
      // (hits refund 3x power) — so when the gun is locked in, go heavy.
      if (rate > 0.45 && dist < 500 && energy > 20) {
        power = Math.max(power, 2.6);
      }
    }
    // A cornered duel opponent has no dodge room: heavy shots are near-free.
    const en = this.history[this.history.length - 1];
    if (en && this.isCornered(en) && energy > 15) {
      power = Math.max(power, dist < 300 ? 3 : 2.2);
    }
    if (energy < 15) power = Math.min(power, 1);
    if (energy < 5) power = Math.min(power, 0.5);
    return Math.min(power, Math.max(0.1, energy - 0.5));
  }

  /** Epsilon-greedy bandit over lead factors — "adjust the mathematics". */
  private pickLeadFactor(): number {
    if (Math.random() < 0.15) {
      return Math.floor(Math.random() * LEAD_FACTORS.length);
    }
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < LEAD_FACTORS.length; i++) {
      const score = (this.factorHits[i] + 1) / (this.factorShots[i] + 2);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /** Circular prediction: average recent turn rate + speed, simulate forward until the bullet arrives. */
  private predictPosition(bulletSpeed: number): { x: number; y: number } {
    const h = this.history;
    const en = h[h.length - 1];
    let turnRate = 0;
    let speed = en.speed;
    const n = Math.min(h.length - 1, 10);
    if (n >= 2) {
      let rateSum = 0;
      let speedSum = 0;
      for (let i = h.length - n; i < h.length; i++) {
        const dt = h[i].turn - h[i - 1].turn;
        if (dt <= 0) continue;
        rateSum +=
          this.normalizeRelativeAngle(h[i].direction - h[i - 1].direction) / dt;
        speedSum += h[i].speed;
      }
      turnRate = rateSum / n;
      speed = speedSum / n;
    }

    let px = en.x;
    let py = en.y;
    let dir = en.direction;
    for (let t = 1; t < 80; t++) {
      dir += turnRate;
      px += Math.cos(dir * DEG) * speed;
      py += Math.sin(dir * DEG) * speed;
      px = Math.max(18, Math.min(this.getArenaWidth() - 18, px));
      py = Math.max(18, Math.min(this.getArenaHeight() - 18, py));
      if (Math.hypot(px - this.getX(), py - this.getY()) <= bulletSpeed * t) {
        break;
      }
    }
    return { x: px, y: py };
  }

  // -------------------------------------------------------- housekeeping

  private updateWavesAndShots() {
    const turn = this.getTurnNumber();
    this.waves = this.waves.filter((w) => {
      const traveled = (turn - w.fireTurn) * w.speed;
      const dToUs = Math.hypot(this.getX() - w.ox, this.getY() - w.oy);
      if (traveled >= dToUs + 60) {
        if (w.mode >= 0) this.modeShots[w.mode]++;
        return false;
      }
      return true;
    });
    for (const s of this.pending) {
      if (!s.resolved && turn > s.expectedHitTurn + 5) s.resolved = true;
    }
    if (this.pending.length > 30) {
      this.pending = this.pending.filter((s) => !s.resolved);
    }
  }
}

TjBot.main();
