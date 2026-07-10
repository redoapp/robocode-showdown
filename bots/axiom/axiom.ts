// Axiom — research duelist: lock radar, virtual guns (exact-sim / GF / fast-GF),
// wave surfing with gun-mirroring, hypothesis dodge rays, argmax movement.
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  BulletHitBotEvent,
} from "@robocode.dev/tank-royale-bot-api";

const WALL_MARGIN = 60;
const BOT_RADIUS = 18;
const MIN_DIST = 180;
const BINS = 31;
const MID = Math.floor(BINS / 2);
const MAX_BULLETS = 32;
const MAX_WAVES = 24;
const MAX_MY_WAVES = 40;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const zeros = (n: number) => new Array<number>(n).fill(0);
const seg3d = () =>
  Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => zeros(BINS)));

class Axiom extends Bot {
  arenaW = 0;
  arenaH = 0;

  haveEnemy = false;
  scanTurn = -1;
  ex = 0; ey = 0; eDir = 0; eSpeed = 0; eEnergy = 0;
  eTurnRate = 0; eTurnRateSmooth = 0;
  eAccel = 0;
  stableSpeedTurns = 0;
  eStationaryTurns = 0;

  myPrevX = 0; myPrevY = 0; myPrevVx = 0; myPrevVy = 0; myPrevTurnDelta = 0;
  lastDir = 0;
  damageDealtSinceScan = 0;
  myVisitBins = zeros(BINS);
  myVisitSeg = seg3d();

  recentHits = 0;

  bOx = zeros(MAX_BULLETS); bOy = zeros(MAX_BULLETS);
  bDirX = zeros(MAX_BULLETS); bDirY = zeros(MAX_BULLETS);
  bSpeed = zeros(MAX_BULLETS); bFiredTurn = zeros(MAX_BULLETS);
  numBullets = 0;

  wOx = zeros(MAX_WAVES); wOy = zeros(MAX_WAVES); wSpeed = zeros(MAX_WAVES);
  wBaseline = zeros(MAX_WAVES); wLatSign = zeros(MAX_WAVES);
  wFiredTurn = zeros(MAX_WAVES); wMyLat = zeros(MAX_WAVES); wMyDist = zeros(MAX_WAVES);
  numWaves = 0;

  surfBins = zeros(BINS);
  onModelHits = 0;
  offModelHits = 0;
  statisticalLatched = false;

  mOx = zeros(MAX_MY_WAVES); mOy = zeros(MAX_MY_WAVES); mSpeed = zeros(MAX_MY_WAVES);
  mBaseline = zeros(MAX_MY_WAVES); mLatSign = zeros(MAX_MY_WAVES);
  mFiredTurn = zeros(MAX_MY_WAVES);
  mAimA = zeros(MAX_MY_WAVES); mAimB = zeros(MAX_MY_WAVES); mAimC = zeros(MAX_MY_WAVES);
  mSegLat = zeros(MAX_MY_WAVES); mSegDist = zeros(MAX_MY_WAVES);
  numMyWaves = 0;

  gfBins = seg3d();
  fastBins = zeros(BINS);
  gunScoreA = 0;
  gunScoreB = 0;
  gunScoreC = 0;
  wavesSeen = 0;

  committedHeading = Number.NaN;

  static main() {
    new Axiom().start();
  }

  override run() {
    this.arenaW = this.getArenaWidth();
    this.arenaH = this.getArenaHeight();

    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setFireAssist(false);

    this.haveEnemy = false;
    this.committedHeading = Number.NaN;
    this.scanTurn = -1;
    this.eTurnRate = 0;
    this.damageDealtSinceScan = 0;
    this.numBullets = 0;
    this.numWaves = 0;
    this.numMyWaves = 0;
    this.recentHits = 0;
    this.surfBins[MID] = Math.max(this.surfBins[MID], 4);
    const lead = MID + Math.round(0.9 * MID);
    this.surfBins[lead] = Math.max(this.surfBins[lead], 2);
    this.myPrevX = this.getX();
    this.myPrevY = this.getY();
    this.myPrevVx = 0;
    this.myPrevVy = 0;

    while (this.isRunning()) {
      const t = this.getTurnNumber();
      this.recentHits *= 0.995;
      this.expireBullets(t);
      this.expireEnemyWaves(t);
      this.processMyWaves(t);
      this.doRadar(t);
      this.doMovement(t);
      this.doGun(t);
      const x = this.getX();
      const y = this.getY();
      const dir = this.getDirection();
      const rad = toRad(dir);
      const vx = this.getSpeed() * Math.cos(rad);
      const vy = this.getSpeed() * Math.sin(rad);
      this.go();
      this.myPrevX = x;
      this.myPrevY = y;
      this.myPrevVx = vx;
      this.myPrevVy = vy;
      this.myPrevTurnDelta = this.normalizeRelativeAngle(dir - this.lastDir);
      this.lastDir = dir;
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    const t = this.getTurnNumber();
    const newEnergy = e.energy;

    if (this.haveEnemy && t - this.scanTurn >= 1 && t - this.scanTurn <= 2) {
      const drop = this.eEnergy - this.damageDealtSinceScan - newEnergy;
      const wallStop =
        Math.abs(e.speed) < 0.01 &&
        Math.abs(this.eSpeed) >= 2 &&
        this.nearWall(e.x, e.y, 24);
      if (!wallStop && drop >= 0.09 && drop <= 3.01) {
        this.addEnemyBullet(t, drop);
        this.addEnemyWave(t, drop);
      }
      if (t - this.scanTurn === 1) {
        this.eTurnRate = this.normalizeRelativeAngle(e.direction - this.eDir);
        this.eTurnRateSmooth = this.eTurnRateSmooth * 0.7 + this.eTurnRate * 0.3;
        this.eAccel = e.speed - this.eSpeed;
        this.stableSpeedTurns = Math.abs(this.eAccel) < 0.01 ? this.stableSpeedTurns + 1 : 0;
      }
    } else {
      this.eTurnRate = 0;
      this.eTurnRateSmooth = 0;
      this.eAccel = 0;
      this.stableSpeedTurns = 0;
    }

    this.eStationaryTurns = Math.abs(e.speed) < 0.01 ? this.eStationaryTurns + 1 : 0;

    this.haveEnemy = true;
    this.scanTurn = t;
    this.ex = e.x;
    this.ey = e.y;
    this.eDir = e.direction;
    this.eSpeed = e.speed;
    this.eEnergy = newEnergy;
    this.damageDealtSinceScan = 0;
  }

  override onBulletHit(e: BulletHitBotEvent) {
    this.damageDealtSinceScan += e.damage;
  }

  override onHitByBullet(e: HitByBulletEvent) {
    this.recentHits += 1;
    const bulletDir = e.bullet.direction;
    let bestRayErr = 180;
    for (let i = 0; i < this.numBullets; i++) {
      const rayDir = toDeg(Math.atan2(this.bDirY[i], this.bDirX[i]));
      const err = Math.abs(this.normalizeRelativeAngle(rayDir - bulletDir));
      if (err < bestRayErr) bestRayErr = err;
    }
    if (bestRayErr < 4) this.onModelHits++;
    else this.offModelHits++;
    if (this.offModelHits > this.onModelHits + 2) this.statisticalLatched = true;
    this.recordSurfHit(e.bullet.power);
  }

  doRadar(t: number) {
    if (!this.haveEnemy || t - this.scanTurn > 2) {
      this.setRadarTurnRate(45);
      return;
    }
    const offset = this.normalizeRelativeAngle(
      this.directionTo(this.ex, this.ey) - this.getRadarDirection(),
    );
    let margin = (t & 1) === 0 ? 15 : -15;
    if (offset > 1) margin = 15;
    else if (offset < -1) margin = -15;
    this.setRadarTurnRate(offset + margin);
  }

  doMovement(t: number) {
    if (!this.haveEnemy) {
      this.drive(this.directionTo(this.arenaW / 2, this.arenaH / 2), 8);
      return;
    }

    let targetDist = 330 + Math.min(220, this.recentHits * 35);
    if (this.getRoundNumber() <= 3 && this.wavesSeen < 80
        && this.offModelHits + this.onModelHits < 4) {
      targetDist = Math.max(targetDist, 430);
    }
    if (this.hardToHit() && this.recentHits < 1.0 && this.offModelHits < 6) targetDist = 260;
    if (this.getEnergy() - this.eEnergy > 40) targetDist = 220;
    if (this.eEnergy < 0.2 && Math.abs(this.eSpeed) < 0.01) targetDist = 120;

    let bestHeading = 0;
    let bestScore = -1e18;
    for (let c = 0; c < 72; c++) {
      const heading = c * 5;
      const score = this.scoreHeading(t, heading, targetDist);
      if (score > bestScore) {
        bestScore = score;
        bestHeading = heading;
      }
    }
    const brakeScore = this.scoreBrake(t, targetDist);
    if (brakeScore > bestScore + 100) {
      this.committedHeading = Number.NaN;
      this.setTurnRate(0);
      this.setTargetSpeed(0);
      return;
    }
    if (!Number.isNaN(this.committedHeading)) {
      const committedScore = this.scoreHeading(t, this.committedHeading, targetDist);
      if (committedScore >= bestScore - 250) {
        this.drive(this.committedHeading, 8);
        return;
      }
    }
    this.committedHeading = bestHeading;
    this.drive(bestHeading, 8);
  }

  scoreBrake(t: number, targetDist: number): number {
    const velDir = this.getSpeed() >= 0 ? this.getDirection() : this.getDirection() + 180;
    const rad = toRad(velDir);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let px = this.getX();
    let py = this.getY();
    let speed = Math.abs(this.getSpeed());

    let score = 0;
    let wallPenalty = 0;
    let minBulletMargin = 1e9;
    let waveDanger = 0;
    const waveDone = new Array<boolean>(this.numWaves).fill(false);

    for (let k = 1; k <= 45; k++) {
      speed = Math.max(0, speed - 2);
      px += speed * cos;
      py += speed * sin;
      if (k <= 10) {
        const depth =
          Math.max(0, WALL_MARGIN - px) + Math.max(0, px - (this.arenaW - WALL_MARGIN)) +
          Math.max(0, WALL_MARGIN - py) + Math.max(0, py - (this.arenaH - WALL_MARGIN));
        wallPenalty += depth * (12 - k);
        if (this.rayMode()) {
          for (let i = 0; i < this.numBullets; i++) {
            const traveled = this.bSpeed[i] * (t + k - this.bFiredTurn[i]);
            const bx = this.bOx[i] + this.bDirX[i] * traveled;
            const by = this.bOy[i] + this.bDirY[i] * traveled;
            const gap = Math.hypot(px - bx, py - by) - this.bSpeed[i];
            if (gap < minBulletMargin) minBulletMargin = gap;
          }
        }
      }
      for (let i = 0; i < this.numWaves; i++) {
        if (waveDone[i]) continue;
        const traveled = this.wSpeed[i] * (t + k - this.wFiredTurn[i]);
        if (traveled >= Math.hypot(px - this.wOx[i], py - this.wOy[i])) {
          waveDone[i] = true;
          const gf = this.gfOf(this.wOx[i], this.wOy[i], this.wBaseline[i],
            this.wSpeed[i], this.wLatSign[i], px, py);
          waveDanger += (this.dangerAt(i, gf) * 300.0) / (3 + k);
        }
      }
    }
    score -= wallPenalty * 1000;
    score -= waveDanger * (100 + this.recentHits * 40);
    if (minBulletMargin < 1e9) {
      score += Math.min(minBulletMargin, 120) * 40;
    }
    const endDist = Math.hypot(px - this.ex, py - this.ey);
    score -= Math.abs(endDist - targetDist) * 3;
    return score;
  }

  scoreHeading(t: number, heading: number, targetDist: number): number {
    let velDir: number;
    if (Math.abs(this.getSpeed()) > 0.5) {
      velDir = this.getSpeed() >= 0 ? this.getDirection() : this.getDirection() + 180;
    } else {
      velDir = Number.isNaN(this.committedHeading) ? this.getDirection() : this.committedHeading;
    }
    let turnNeeded = Math.abs(this.normalizeRelativeAngle(heading - velDir));
    const reversed = turnNeeded > 90;
    if (reversed) turnNeeded = 180 - turnNeeded;

    const rad = toRad(heading);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let px = this.getX();
    let py = this.getY();
    let speed = reversed ? Math.max(0, Math.abs(this.getSpeed()) - 2) : Math.abs(this.getSpeed());

    let score = 0;
    let wallPenalty = 0;
    let minBulletMargin = 1e9;
    let waveDanger = 0;
    const waveDone = new Array<boolean>(this.numWaves).fill(false);

    for (let k = 1; k <= 45; k++) {
      if (k <= 10) {
        speed = Math.min(8, speed + 1);
        const eff = speed * Math.max(0.2, Math.cos(toRad(Math.min(turnNeeded, 80))));
        turnNeeded = Math.max(0, turnNeeded - 8);
        px += eff * cos;
        py += eff * sin;
        const depth =
          Math.max(0, WALL_MARGIN - px) + Math.max(0, px - (this.arenaW - WALL_MARGIN)) +
          Math.max(0, WALL_MARGIN - py) + Math.max(0, py - (this.arenaH - WALL_MARGIN));
        const hardDepth =
          Math.max(0, BOT_RADIUS - px) + Math.max(0, px - (this.arenaW - BOT_RADIUS)) +
          Math.max(0, BOT_RADIUS - py) + Math.max(0, py - (this.arenaH - BOT_RADIUS));
        wallPenalty += (depth + hardDepth * 50) * (12 - k);
        if (this.rayMode()) {
          for (let i = 0; i < this.numBullets; i++) {
            const traveled = this.bSpeed[i] * (t + k - this.bFiredTurn[i]);
            const bx = this.bOx[i] + this.bDirX[i] * traveled;
            const by = this.bOy[i] + this.bDirY[i] * traveled;
            const gap = Math.hypot(px - bx, py - by) - this.bSpeed[i];
            if (gap < minBulletMargin) minBulletMargin = gap;
          }
        }
      } else {
        px += 8 * cos;
        py += 8 * sin;
        px = Math.max(BOT_RADIUS, Math.min(this.arenaW - BOT_RADIUS, px));
        py = Math.max(BOT_RADIUS, Math.min(this.arenaH - BOT_RADIUS, py));
      }
      for (let i = 0; i < this.numWaves; i++) {
        if (waveDone[i]) continue;
        const traveled = this.wSpeed[i] * (t + k - this.wFiredTurn[i]);
        if (traveled >= Math.hypot(px - this.wOx[i], py - this.wOy[i])) {
          waveDone[i] = true;
          const gf = this.gfOf(this.wOx[i], this.wOy[i], this.wBaseline[i],
            this.wSpeed[i], this.wLatSign[i], px, py);
          waveDanger += (this.dangerAt(i, gf) * 300.0) / (3 + k);
        }
      }
    }
    score -= wallPenalty * 1000;
    score -= waveDanger * (100 + this.recentHits * 40);

    if (minBulletMargin < 1e9) {
      score += Math.min(minBulletMargin, 120) * 40;
    }

    const bearing = this.directionTo(this.ex, this.ey);
    const lateral = Math.abs(Math.sin(toRad(heading - bearing)));
    score += lateral * 500;

    const endDist = Math.hypot(px - this.ex, py - this.ey);
    score -= Math.abs(endDist - targetDist) * 3;

    const curDist = this.distanceTo(this.ex, this.ey);
    if (curDist < MIN_DIST) {
      score += (endDist - curDist) * 30;
    }

    score -= reversed ? 60 : 0;
    return score;
  }

  drive(heading: number, speed: number) {
    let offset = this.normalizeRelativeAngle(heading - this.getDirection());
    if (Math.abs(offset) > 90) {
      offset = this.normalizeRelativeAngle(offset + 180);
      speed = -speed;
    }
    this.setTurnRate(offset);
    this.setTargetSpeed(speed);
  }

  doGun(t: number) {
    if (!this.haveEnemy) return;

    const firepower = this.choosePower();
    const bulletSpeed = 20 - 3 * firepower;
    const dist = this.distanceTo(this.ex, this.ey);

    const aimA = this.exactSimAim(t, firepower);
    const aimB = this.gfAim(bulletSpeed, dist);
    const aimC = this.gfAimFast(bulletSpeed);
    let aim = aimA;
    let topScore = this.gunScoreA;
    let statistical = false;
    if (this.gunScoreB > topScore + 0.5) {
      aim = aimB;
      topScore = this.gunScoreB;
      statistical = true;
    }
    if (this.gunScoreC > topScore + 0.5) {
      aim = aimC;
      statistical = true;
    }
    const useB = statistical;

    const offset = this.normalizeRelativeAngle(aim - this.getGunDirection());
    this.setGunTurnRate(offset);

    const tolerance = toDeg(Math.atan2(BOT_RADIUS * 0.7, dist));
    const fresh = t - this.scanTurn <= 1;
    const energyOk = this.getEnergy() - firepower > 2.0 || this.wouldKill(firepower);

    let gate: boolean;
    const flightTurns = dist / bulletSpeed;
    const pressing = this.getEnergy() - this.eEnergy > 40;
    if (this.hardToHit() && !pressing && this.getEnergy() > this.eEnergy + 25
        && !this.wouldKill(firepower)) {
      gate = flightTurns <= 15;
    } else if (pressing) {
      gate = flightTurns <= 25;
    } else if (useB) {
      gate = flightTurns <= 40;
    } else {
      const parked = this.eStationaryTurns >= 30;
      const pausing = Math.abs(this.eSpeed) < 0.01 && this.eStationaryTurns >= 1 && flightTurns <= 12;
      const steadySegment = Math.abs(this.eSpeed) > 0.01 && this.stableSpeedTurns >= 2 && flightTurns <= 24;
      const accelPhase = Math.abs(this.eAccel) >= 0.01 && flightTurns <= 10;
      gate = parked || pausing || steadySegment || accelPhase;
    }
    const lowEnergyCareful = this.getEnergy() >= 25
      || (Math.abs(this.eSpeed) < 0.01 && flightTurns <= 10)
      || this.wouldKill(firepower);

    let fired = false;
    if (fresh && gate && lowEnergyCareful
        && this.getGunHeat() === 0 && Math.abs(offset) < tolerance && energyOk) {
      fired = this.setFire(firepower);
    }
    if (fresh && (fired || (t & 1) === 0)) {
      this.addMyWave(t, bulletSpeed, dist, aimA, aimB, aimC);
    }
  }

  gfAimFast(bulletSpeed: number): number {
    const baseline = this.directionTo(this.ex, this.ey);
    const latSign = this.enemyLatSign(baseline);
    let best = MID;
    for (let i = 0; i < BINS; i++) {
      if (this.fastBins[i] > this.fastBins[best]) best = i;
    }
    const gf = (best - MID) / MID;
    const mea = toDeg(Math.asin(8 / bulletSpeed));
    return baseline + gf * mea * latSign;
  }

  exactSimAim(t: number, firepower: number): number {
    const bulletSpeed = 20 - 3 * firepower;
    let px = this.ex;
    let py = this.ey;
    for (let i = 0; i < 20; i++) {
      const time = Math.hypot(px - this.getX(), py - this.getY()) / bulletSpeed;
      const p = this.predictEnemy(t, time);
      px = p[0];
      py = p[1];
    }
    return this.directionTo(px, py);
  }

  predictEnemy(t: number, bulletFlightTurns: number): [number, number] {
    let px = this.ex;
    let py = this.ey;
    let dir = this.eDir;
    let speed = this.eSpeed;
    const steps = Math.ceil(bulletFlightTurns + (t - this.scanTurn) + 1);
    for (let i = 0; i < steps; i++) {
      if (Math.abs(this.eAccel) >= 0.01) {
        let next = speed + this.eAccel;
        if (next * this.eSpeed <= 0 && Math.abs(this.eSpeed) > 0.01) next = 0;
        speed = Math.max(-8, Math.min(8, next));
      }
      dir += this.rayMode() ? this.eTurnRate : this.eTurnRateSmooth;
      const rad = toRad(dir);
      px += speed * Math.cos(rad);
      py += speed * Math.sin(rad);
      px = Math.max(BOT_RADIUS, Math.min(this.arenaW - BOT_RADIUS, px));
      py = Math.max(BOT_RADIUS, Math.min(this.arenaH - BOT_RADIUS, py));
    }
    return [px, py];
  }

  gfAim(bulletSpeed: number, dist: number): number {
    const baseline = this.directionTo(this.ex, this.ey);
    const latSign = this.enemyLatSign(baseline);
    const bins = this.gfBins[this.latBucket()][this.distBucket(dist)];
    let best = MID;
    for (let i = 0; i < BINS; i++) {
      if (bins[i] > bins[best]) best = i;
    }
    const gf = (best - MID) / MID;
    const mea = toDeg(Math.asin(8 / bulletSpeed));
    return baseline + gf * mea * latSign;
  }

  choosePower(): number {
    const d = this.distanceTo(this.ex, this.ey);
    let fp = d < 140 ? 3.0 : d < 300 ? 2.4 : d < 450 ? 1.9 : 1.2;

    const toKill = this.eEnergy <= 4 ? this.eEnergy / 4 : (this.eEnergy + 2) / 6;
    if (toKill + 0.02 < fp) fp = Math.max(0.1, toKill + 0.02);

    const myEnergy = this.getEnergy();
    if (myEnergy < 15 && !this.wouldKill(fp)) fp = Math.min(fp, Math.max(0.1, myEnergy / 20));
    return fp;
  }

  wouldKill(fp: number): boolean {
    const damage = fp <= 1 ? 4 * fp : 6 * fp - 2;
    return damage >= this.eEnergy;
  }

  hardToHit(): boolean {
    return this.wavesSeen > 40
      && Math.max(this.gunScoreA, Math.max(this.gunScoreB, this.gunScoreC)) < 12;
  }

  addMyWave(t: number, bulletSpeed: number, dist: number,
            aimA: number, aimB: number, aimC: number) {
    if (this.numMyWaves >= MAX_MY_WAVES) return;
    const i = this.numMyWaves++;
    this.mAimC[i] = aimC;
    this.mOx[i] = this.getX();
    this.mOy[i] = this.getY();
    this.mSpeed[i] = bulletSpeed;
    this.mBaseline[i] = this.directionTo(this.ex, this.ey);
    this.mLatSign[i] = this.enemyLatSign(this.mBaseline[i]);
    this.mFiredTurn[i] = t;
    this.mAimA[i] = aimA;
    this.mAimB[i] = aimB;
    this.mSegLat[i] = this.latBucket();
    this.mSegDist[i] = this.distBucket(dist);
  }

  processMyWaves(t: number) {
    if (!this.haveEnemy) return;
    let j = 0;
    for (let i = 0; i < this.numMyWaves; i++) {
      const traveled = this.mSpeed[i] * (t - this.mFiredTurn[i]);
      const distNow = Math.hypot(this.ex - this.mOx[i], this.ey - this.mOy[i]);
      if (traveled >= distNow) {
        this.wavesSeen++;
        const gf = this.gfOf(this.mOx[i], this.mOy[i], this.mBaseline[i],
          this.mSpeed[i], this.mLatSign[i], this.ex, this.ey);
        this.addBin(this.gfBins[this.mSegLat[i]][this.mSegDist[i]], gf, 1.0);
        for (let b = 0; b < BINS; b++) this.fastBins[b] *= 0.9;
        this.addBin(this.fastBins, gf, 1.0);
        const hitWidth = toDeg(Math.atan2(BOT_RADIUS, distNow));
        const angleToEnemy = toDeg(Math.atan2(this.ey - this.mOy[i], this.ex - this.mOx[i]));
        this.gunScoreA = this.gunScoreA * 0.985 +
          (Math.abs(this.normalizeRelativeAngle(this.mAimA[i] - angleToEnemy)) < hitWidth ? 1 : 0);
        this.gunScoreB = this.gunScoreB * 0.985 +
          (Math.abs(this.normalizeRelativeAngle(this.mAimB[i] - angleToEnemy)) < hitWidth ? 1 : 0);
        this.gunScoreC = this.gunScoreC * 0.985 +
          (Math.abs(this.normalizeRelativeAngle(this.mAimC[i] - angleToEnemy)) < hitWidth ? 1 : 0);
      } else if (traveled < distNow + 100 && t - this.mFiredTurn[i] < 120) {
        if (i !== j) this.copyMyWave(i, j);
        j++;
      }
    }
    this.numMyWaves = j;
  }

  copyMyWave(i: number, j: number) {
    this.mOx[j] = this.mOx[i]; this.mOy[j] = this.mOy[i];
    this.mSpeed[j] = this.mSpeed[i]; this.mBaseline[j] = this.mBaseline[i];
    this.mLatSign[j] = this.mLatSign[i]; this.mFiredTurn[j] = this.mFiredTurn[i];
    this.mAimA[j] = this.mAimA[i]; this.mAimB[j] = this.mAimB[i]; this.mAimC[j] = this.mAimC[i];
    this.mSegLat[j] = this.mSegLat[i]; this.mSegDist[j] = this.mSegDist[i];
  }

  latBucket(): number {
    const baseline = this.directionTo(this.ex, this.ey);
    const latVel = Math.abs(this.eSpeed * Math.sin(toRad(this.eDir - baseline)));
    return latVel < 0.5 ? 0 : latVel < 3.5 ? 1 : latVel < 6.5 ? 2 : 3;
  }

  distBucket(d: number): number {
    return d < 200 ? 0 : d < 350 ? 1 : d < 500 ? 2 : 3;
  }

  enemyLatSign(baseline: number): number {
    const latVel = this.eSpeed * Math.sin(toRad(this.eDir - baseline));
    return latVel >= 0 ? 1 : -1;
  }

  addEnemyWave(t: number, firepower: number) {
    if (this.numWaves >= MAX_WAVES) return;
    const i = this.numWaves++;
    this.wOx[i] = this.ex;
    this.wOy[i] = this.ey;
    this.wSpeed[i] = 20 - 3 * firepower;
    this.wBaseline[i] = toDeg(Math.atan2(this.myPrevY - this.ey, this.myPrevX - this.ex));
    const latVel =
      this.myPrevVx * -Math.sin(toRad(this.wBaseline[i])) +
      this.myPrevVy * Math.cos(toRad(this.wBaseline[i]));
    this.wLatSign[i] = latVel >= 0 ? 1 : -1;
    this.wFiredTurn[i] = t - 1;
    const absLat = Math.abs(latVel);
    this.wMyLat[i] = absLat < 0.5 ? 0 : absLat < 3.5 ? 1 : absLat < 6.5 ? 2 : 3;
    const d = Math.hypot(this.myPrevX - this.ex, this.myPrevY - this.ey);
    this.wMyDist[i] = d < 200 ? 0 : d < 350 ? 1 : d < 500 ? 2 : 3;
  }

  expireEnemyWaves(t: number) {
    let j = 0;
    for (let i = 0; i < this.numWaves; i++) {
      const traveled = this.wSpeed[i] * (t - this.wFiredTurn[i]);
      const distToMe = Math.hypot(this.getX() - this.wOx[i], this.getY() - this.wOy[i]);
      if (traveled >= distToMe && traveled < distToMe + this.wSpeed[i]) {
        const gf = this.gfOf(this.wOx[i], this.wOy[i], this.wBaseline[i],
          this.wSpeed[i], this.wLatSign[i], this.getX(), this.getY());
        for (let b = 0; b < BINS; b++) this.myVisitBins[b] *= 0.985;
        this.addBin(this.myVisitBins, gf, 1.0);
        const seg = this.myVisitSeg[this.wMyLat[i]][this.wMyDist[i]];
        for (let b = 0; b < BINS; b++) seg[b] *= 0.99;
        this.addBin(seg, gf, 1.0);
      }
      if (traveled < distToMe + 60) {
        if (i !== j) {
          this.wOx[j] = this.wOx[i]; this.wOy[j] = this.wOy[i];
          this.wSpeed[j] = this.wSpeed[i]; this.wBaseline[j] = this.wBaseline[i];
          this.wLatSign[j] = this.wLatSign[i]; this.wFiredTurn[j] = this.wFiredTurn[i];
          this.wMyLat[j] = this.wMyLat[i]; this.wMyDist[j] = this.wMyDist[i];
        }
        j++;
      }
    }
    this.numWaves = j;
  }

  recordSurfHit(power: number) {
    const t = this.getTurnNumber();
    const bulletSpeed = 20 - 3 * power;
    let best = -1;
    let bestErr = 80;
    for (let i = 0; i < this.numWaves; i++) {
      if (Math.abs(this.wSpeed[i] - bulletSpeed) > 0.5) continue;
      const traveled = this.wSpeed[i] * (t - this.wFiredTurn[i]);
      const err = Math.abs(traveled - Math.hypot(this.getX() - this.wOx[i], this.getY() - this.wOy[i]));
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (best < 0) return;
    const gf = this.gfOf(this.wOx[best], this.wOy[best], this.wBaseline[best],
      this.wSpeed[best], this.wLatSign[best], this.getX(), this.getY());
    this.addBin(this.surfBins, gf, 1.0);
  }

  gfOf(ox: number, oy: number, baseline: number, speed: number, latSign: number,
       px: number, py: number): number {
    const angle = toDeg(Math.atan2(py - oy, px - ox));
    const mea = toDeg(Math.asin(8 / speed));
    const gf = (this.normalizeRelativeAngle(angle - baseline) / mea) * latSign;
    return Math.max(-1, Math.min(1, gf));
  }

  addBin(bins: number[], gf: number, weight: number) {
    let idx = Math.round(gf * MID) + MID;
    idx = Math.max(0, Math.min(BINS - 1, idx));
    bins[idx] += weight;
    if (idx > 0) bins[idx - 1] += weight * 0.45;
    if (idx < BINS - 1) bins[idx + 1] += weight * 0.45;
    if (idx > 1) bins[idx - 2] += weight * 0.15;
    if (idx < BINS - 2) bins[idx + 2] += weight * 0.15;
  }

  dangerAt(wi: number, gf: number): number {
    let v = this.binValue(this.surfBins, gf);
    if (!this.rayMode()) {
      const seg = this.myVisitSeg[this.wMyLat[wi]][this.wMyDist[wi]];
      v += this.binValue(seg, gf) * 0.6;
      let idx = Math.round(gf * MID) + MID;
      idx = Math.max(0, Math.min(BINS - 1, idx));
      let pk = 0;
      for (let b = 1; b < BINS; b++) {
        if (seg[b] > seg[pk]) pk = b;
      }
      if (Math.abs(idx - pk) <= 1 && seg[pk] > 0.5) v += seg[pk] * 0.9;
    }
    return v;
  }

  binValue(bins: number[], gf: number): number {
    let idx = Math.round(gf * MID) + MID;
    idx = Math.max(0, Math.min(BINS - 1, idx));
    return bins[idx];
  }

  addEnemyBullet(t: number, firepower: number) {
    const bulletSpeed = 20 - 3 * firepower;
    const headOn = toDeg(Math.atan2(this.myPrevY - this.ey, this.myPrevX - this.ex));
    this.addRay(t, bulletSpeed, headOn);

    let px = this.myPrevX;
    let py = this.myPrevY;
    for (let k = 0; k < 10; k++) {
      const time = Math.hypot(px - this.ex, py - this.ey) / bulletSpeed;
      px = this.myPrevX + this.myPrevVx * time;
      py = this.myPrevY + this.myPrevVy * time;
      px = Math.max(BOT_RADIUS, Math.min(this.arenaW - BOT_RADIUS, px));
      py = Math.max(BOT_RADIUS, Math.min(this.arenaH - BOT_RADIUS, py));
    }
    this.addRay(t, bulletSpeed, toDeg(Math.atan2(py - this.ey, px - this.ex)));

    if (Math.abs(this.myPrevTurnDelta) > 0.5) {
      const speed = Math.hypot(this.myPrevVx, this.myPrevVy);
      const velDir = toDeg(Math.atan2(this.myPrevVy, this.myPrevVx));
      let cx = this.myPrevX;
      let cy = this.myPrevY;
      for (let k = 0; k < 10; k++) {
        const flight = Math.ceil(Math.hypot(cx - this.ex, cy - this.ey) / bulletSpeed);
        cx = this.myPrevX;
        cy = this.myPrevY;
        let d = velDir;
        for (let s = 0; s < flight; s++) {
          d += this.myPrevTurnDelta;
          cx += speed * Math.cos(toRad(d));
          cy += speed * Math.sin(toRad(d));
        }
        cx = Math.max(BOT_RADIUS, Math.min(this.arenaW - BOT_RADIUS, cx));
        cy = Math.max(BOT_RADIUS, Math.min(this.arenaH - BOT_RADIUS, cy));
      }
      this.addRay(t, bulletSpeed, toDeg(Math.atan2(cy - this.ey, cx - this.ex)));
    }
  }

  rayMode(): boolean {
    return !this.statisticalLatched;
  }

  addRay(t: number, bulletSpeed: number, dirDeg: number) {
    if (this.numBullets >= MAX_BULLETS) return;
    const i = this.numBullets++;
    this.bOx[i] = this.ex;
    this.bOy[i] = this.ey;
    this.bDirX[i] = Math.cos(toRad(dirDeg));
    this.bDirY[i] = Math.sin(toRad(dirDeg));
    this.bSpeed[i] = bulletSpeed;
    this.bFiredTurn[i] = t - 1;
  }

  expireBullets(t: number) {
    const maxDim = Math.hypot(this.arenaW, this.arenaH);
    let j = 0;
    for (let i = 0; i < this.numBullets; i++) {
      if (this.bSpeed[i] * (t - this.bFiredTurn[i]) <= maxDim) {
        if (i !== j) {
          this.bOx[j] = this.bOx[i]; this.bOy[j] = this.bOy[i];
          this.bDirX[j] = this.bDirX[i]; this.bDirY[j] = this.bDirY[i];
          this.bSpeed[j] = this.bSpeed[i]; this.bFiredTurn[j] = this.bFiredTurn[i];
        }
        j++;
      }
    }
    this.numBullets = j;
  }

  nearWall(x: number, y: number, margin: number): boolean {
    return x < BOT_RADIUS + margin || x > this.arenaW - BOT_RADIUS - margin
      || y < BOT_RADIUS + margin || y > this.arenaH - BOT_RADIUS - margin;
  }
}

Axiom.main();
