/**
 * tj-bot — hold fire until fired upon; dodge and study; taunt with a near-miss,
 * then snipe; on any miss, adapt the lead math and spam while dodging.
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
  BulletHitBotEvent,
  DeathEvent,
  WonRoundEvent,
  Color,
} from "@robocode.dev/tank-royale-bot-api";

const DEG = Math.PI / 180;

interface Snapshot {
  turn: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
  energy: number;
}

interface Wave {
  ox: number;
  oy: number;
  speed: number;
  fireTurn: number;
  reacted: boolean;
}

interface PendingShot {
  expectedHitTurn: number;
  factorIdx: number;
  countsForStats: boolean;
  isNearMiss: boolean;
  resolved: boolean;
  hit: boolean;
}

type GunPhase = "HOLD" | "NEAR_MISS" | "PRECISE" | "SPAM";

/** Lead-factor candidates: 1 = full pattern prediction, 0 = shoot where they are. */
const LEAD_FACTORS = [1.0, 0.7, 0.4, 0.0];

class TjBot extends Bot {
  /** Learning state — persists across rounds. */
  private factorShots = LEAD_FACTORS.map(() => 0);
  private factorHits = LEAD_FACTORS.map(() => 0);
  private ritualDone = false;

  private history: Snapshot[] = [];
  private waves: Wave[] = [];
  private pending: PendingShot[] = [];
  private enemyFired = false;
  private gunPhase: GunPhase = "HOLD";
  private targetId: number | null = null;
  private lastScanTurn = -100;
  private damageDealtSinceScan = 0;
  private orbitDir: 1 | -1 = 1;
  private wallFlipCooldown = 0;

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
    this.pending = [];
    this.enemyFired = false;
    this.gunPhase = this.ritualDone ? "PRECISE" : "HOLD";
    this.targetId = null;
    this.lastScanTurn = -100;
    this.damageDealtSinceScan = 0;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.wallFlipCooldown = 0;

    while (this.isRunning()) {
      this.updateWavesAndShots();
      this.doRadar();
      this.doMovement();
      this.doGun();
      this.go();
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
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
        this.waves.push({
          ox: prev.x,
          oy: prev.y,
          speed: 20 - 3 * drop,
          fireTurn: prev.turn,
          reacted: false,
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
    if (this.waves.length > 0) this.waves.shift();
    this.orbitDir = this.orbitDir === 1 ? -1 : 1;
  }

  override onBulletHit(e: BulletHitBotEvent) {
    this.damageDealtSinceScan += e.damage;
    const shot = this.pending.find((s) => !s.resolved);
    if (shot) {
      shot.resolved = true;
      shot.hit = true;
      if (shot.countsForStats) this.factorHits[shot.factorIdx]++;
    }
  }

  override onHitBot(e: HitBotEvent) {
    this.enemyFired = true; // rammer: the truce is over even if they never fired
    this.setBack(80);
  }

  override onHitWall(e: HitWallEvent) {
    this.orbitDir = this.orbitDir === 1 ? -1 : 1;
    this.wallFlipCooldown = 12;
  }

  override onDeath(e: DeathEvent) {
    this.ritualDone = true;
  }

  override onWonRound(e: WonRoundEvent) {
    this.setTurnLeft(360 * 5);
  }

  /** Radar: sweep until found, then hard-lock with overshoot. */
  private doRadar() {
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

  private doMovement() {
    if (this.wallFlipCooldown > 0) this.wallFlipCooldown--;
    const en = this.history[this.history.length - 1];
    if (!en) return;

    const dist = this.distanceTo(en.x, en.y);
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

    const turn = this.getTurnNumber();
    for (const w of this.waves) {
      const traveled = (turn - w.fireTurn) * w.speed;
      const dToUs = Math.hypot(this.getX() - w.ox, this.getY() - w.oy);
      if (!w.reacted && traveled > dToUs * 0.45) {
        // Bullet is halfway here — a direction change NOW is what makes it miss.
        w.reacted = true;
        if (Math.random() < 0.6 && this.wallFlipCooldown === 0) {
          this.orbitDir = this.orbitDir === 1 ? -1 : 1;
        }
        this.setMaxSpeed(5 + Math.random() * 3);
      }
    }
    if (Math.random() < 0.04 && this.wallFlipCooldown === 0) {
      this.orbitDir = this.orbitDir === 1 ? -1 : 1;
    }

    // Tilt the orbit in/out to hold a fighting distance band around ~330.
    const tilt = Math.max(-25, Math.min(25, (dist - 330) / 6));
    let travelDir = dirToEnemy + this.orbitDir * (90 - tilt);

    if (!this.travelIsSafe(travelDir)) {
      const flipped = dirToEnemy - this.orbitDir * (90 - tilt);
      if (this.travelIsSafe(flipped) && this.wallFlipCooldown === 0) {
        this.orbitDir = this.orbitDir === 1 ? -1 : 1;
        travelDir = flipped;
        this.wallFlipCooldown = 8;
      } else {
        travelDir = this.directionTo(
          this.getArenaWidth() / 2,
          this.getArenaHeight() / 2,
        );
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
    this.setForward(drive * 100);
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

  private doGun() {
    const en = this.history[this.history.length - 1];
    if (!en) return;
    const turn = this.getTurnNumber();
    const dist = this.distanceTo(en.x, en.y);

    // Hold fire until we have data AND they've fired (or a long-standoff failsafe).
    const analysisReady =
      this.history.length >= 12 && (this.enemyFired || turn > 120);

    if (this.gunPhase === "HOLD" && analysisReady) this.gunPhase = "NEAR_MISS";

    // A miss on the taunt or the snipe flips us into spam mode.
    for (const s of this.pending) {
      if (!s.resolved && turn > s.expectedHitTurn) {
        s.resolved = true;
        if (!s.isNearMiss) this.gunPhase = "SPAM";
      }
    }

    if (this.gunPhase === "HOLD") return;

    let factorIdx = 0;
    if (this.gunPhase === "SPAM") factorIdx = this.pickLeadFactor();

    const power = this.choosePower(dist);
    if (power <= 0) return;
    const bulletSpeed = 20 - 3 * power;

    const predicted = this.predictPosition(bulletSpeed);
    const dirNow = this.directionTo(en.x, en.y);
    const dirPredicted = this.directionTo(predicted.x, predicted.y);
    const lead = this.normalizeRelativeAngle(dirPredicted - dirNow);
    let aimDir = dirNow + lead * LEAD_FACTORS[factorIdx];

    if (this.gunPhase === "NEAR_MISS") {
      // Aim a hair behind their direction of travel: a whiff they can see.
      const latSign = Math.sign(
        Math.sin((en.direction - dirNow) * DEG) * en.speed,
      );
      aimDir += (latSign !== 0 ? -latSign : 1) * 6;
    }

    const gunTurn = this.normalizeRelativeAngle(aimDir - this.getGunDirection());
    this.setTurnGunLeft(gunTurn);

    const aligned = Math.abs(gunTurn) < (this.gunPhase === "SPAM" ? 5 : 2);
    if (!aligned || this.getGunHeat() > 0) return;

    const firePower =
      this.gunPhase === "NEAR_MISS" ? Math.min(1, power) : power;
    if (this.setFire(firePower)) {
      const isNearMiss = this.gunPhase === "NEAR_MISS";
      const countsForStats = this.gunPhase === "SPAM";
      if (countsForStats) this.factorShots[factorIdx]++;
      this.pending.push({
        expectedHitTurn: turn + Math.ceil(dist / (20 - 3 * firePower)) + 10,
        factorIdx,
        countsForStats,
        isNearMiss,
        resolved: false,
        hit: false,
      });
      if (isNearMiss) {
        this.gunPhase = "PRECISE";
        this.ritualDone = true;
      }
    }
  }

  private choosePower(dist: number): number {
    const energy = this.getEnergy();
    if (energy < 1) return 0;
    let power = dist < 150 ? 3 : dist < 400 ? 2.2 : 1.6;
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

  private updateWavesAndShots() {
    const turn = this.getTurnNumber();
    this.waves = this.waves.filter((w) => {
      const traveled = (turn - w.fireTurn) * w.speed;
      const dToUs = Math.hypot(this.getX() - w.ox, this.getY() - w.oy);
      return traveled < dToUs + 60;
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
