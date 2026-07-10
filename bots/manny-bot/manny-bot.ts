/**
 * manny-bot — duel: wave surfing (hit stats + mirrored enemy visit-GF stats)
 * with a rolling GuessFactor gun. Melee: orbit + predictive gun.
 */
import {
  Bot,
  Color,
  ScannedBotEvent,
  HitByBulletEvent,
  BulletHitBotEvent,
  HitBotEvent,
  HitWallEvent,
  BotDeathEvent,
} from "@robocode.dev/tank-royale-bot-api";

const BINS = 31;
const MID = (BINS - 1) / 2;
const GF_ROLL_N = 32;
const SURF_DIST = 480;
const WALL_STICK = 150;
const WALL_MARGIN = 40;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const normAbs = (a: number) => ((a % 360) + 360) % 360;
const normRel = (a: number) => {
  let x = ((a % 360) + 360) % 360;
  if (x >= 180) x -= 360;
  return x;
};
const absBearing = (x1: number, y1: number, x2: number, y2: number) =>
  normAbs(Math.atan2(y2 - y1, x2 - x1) * RAD);

interface Enemy {
  id: number;
  x: number;
  y: number;
  energy: number;
  direction: number;
  speed: number;
  omega: number;
  turn: number;
}

interface EnemyWave {
  originX: number;
  originY: number;
  fireTime: number;
  bulletSpeed: number;
  initialTargetAngle: number;
  maxEscape: number;
  direction: number;
  surfSeg: number;
  mirrorSeg: number;
}

interface GunWave {
  originX: number;
  originY: number;
  fireTime: number;
  bulletSpeed: number;
  directAngle: number;
  maxEscape: number;
  lateralDir: number;
  segment: number;
}

class MannyBot extends Bot {
  private enemies = new Map<number, Enemy>();
  private lockedId = -1;
  private lastLockTurn = -999;

  // Learning persists across rounds (only per-round wave lists reset).
  private surfStats: number[][] = [];
  private mirrorStats: number[][] = [];
  private gunGF: number[][] = [];

  private enemyWaves: EnemyWave[] = [];
  private gunWaves: GunWave[] = [];
  private surfDir = 1;
  private lastFlip = -999;
  private dmgDealtSinceScan = 0;
  private meleeOrbitDir = 1;

  constructor() {
    super();
    for (let s = 0; s < 3; s++) {
      const buf = new Array(BINS).fill(0);
      buf[MID] = 0.4;
      buf[BINS - 1] = 0.25;
      buf[BINS - 2] = 0.25;
      this.surfStats.push(buf);
    }
    for (let s = 0; s < 9; s++) this.mirrorStats.push(new Array(BINS).fill(0));
    for (let s = 0; s < 9; s++) this.gunGF.push(new Array(BINS).fill(0));
  }

  static main() {
    new MannyBot().start();
  }

  override run() {
    this.setBodyColor(Color.fromRgb(0x8b, 0x00, 0x00));
    this.setTurretColor(Color.fromRgb(0xff, 0x45, 0x00));
    this.setRadarColor(Color.fromRgb(0xff, 0xd7, 0x00));
    this.setBulletColor(Color.fromRgb(0xff, 0x45, 0x00));

    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustRadarForBodyTurn(true);

    this.enemies.clear();
    this.enemyWaves = [];
    this.gunWaves = [];
    this.surfDir = Math.random() < 0.5 ? 1 : -1;
    this.lastFlip = -999;
    this.dmgDealtSinceScan = 0;

    this.setRadarTurnRate(45);

    while (this.isRunning()) {
      const t = this.getTurnNumber();
      const duel = this.getEnemyCount() <= 1;
      this.crossWaves(t);
      this.updateGunWaves(t);
      this.updateRadar(t);
      if (duel) this.surfMove(t);
      else this.meleeMove();
      this.updateGun(duel);
      this.go();
    }
  }

  // ------------------------------------------------------------------ radar
  private updateRadar(turn: number) {
    const target = this.target();
    if (target && turn - this.lastLockTurn <= 3) {
      const rb = this.radarBearingTo(target.x, target.y);
      this.setRadarTurnRate(rb + (rb >= 0 ? 1 : -1) * 12);
    } else {
      this.setRadarTurnRate(45);
    }
  }

  private target(): Enemy | undefined {
    let best: Enemy | undefined;
    let bestD = Infinity;
    const turn = this.getTurnNumber();
    for (const e of this.enemies.values()) {
      const d = this.distanceTo(e.x, e.y) + (turn - e.turn) * 30;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  // ------------------------------------------------------- movement: surfing
  private surfMove(t: number) {
    const e = this.target();
    if (!e) {
      this.setTurnRate(0);
      this.setTargetSpeed(4);
      return;
    }

    const wave = this.nearestWave(t);
    if (!wave) {
      // No bullet in the air: hold a perpendicular orbit, flip occasionally.
      if (t - this.lastFlip > 40) {
        this.surfDir = -this.surfDir;
        this.lastFlip = t;
      }
      this.driveTravel(this.orbitHeadingAround(this.getX(), this.getY(), e.x, e.y, this.surfDir), 8);
      return;
    }

    let bestDir = this.surfDir;
    let bestDanger = Infinity;
    for (const dir of [-1, 0, 1]) {
      const d = this.evalDanger(wave, e, dir);
      if (d < bestDanger) {
        bestDanger = d;
        bestDir = dir;
      }
    }
    if (bestDir === 0) {
      this.driveTravel(this.orbitHeadingAround(this.getX(), this.getY(), e.x, e.y, this.surfDir), 0);
    } else {
      this.surfDir = bestDir;
      this.driveTravel(this.orbitHeadingAround(this.getX(), this.getY(), e.x, e.y, bestDir), 8);
    }
  }

  // Project our motion until the wave reaches us; score the landing bin.
  private evalDanger(wave: EnemyWave, e: Enemy, orbitDir: number): number {
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    let px = this.getX();
    let py = this.getY();
    let head = this.getDirection();
    let vel = this.getSpeed();
    let t = this.getTurnNumber();

    for (let step = 0; step < 160; step++) {
      if (orbitDir === 0) {
        vel += clamp(0 - vel, -2, 1);
      } else {
        const travel = this.orbitHeadingAround(px, py, e.x, e.y, orbitDir);
        const bearing = normRel(travel - head);
        const forward = Math.abs(bearing) <= 90;
        const bodyGoal = forward ? travel : normAbs(travel + 180);
        const maxT = 10 - 0.75 * Math.min(Math.abs(vel), 8);
        head = normAbs(head + clamp(normRel(bodyGoal - head), -maxT, maxT));
        vel += clamp((forward ? 8 : -8) - vel, -2, 1);
      }
      px += Math.cos(head * DEG) * vel;
      py += Math.sin(head * DEG) * vel;
      px = clamp(px, 18, w - 18);
      py = clamp(py, 18, h - 18);
      t++;
      const dx = px - wave.originX;
      const dy = py - wave.originY;
      const front = wave.bulletSpeed * (t - wave.fireTime);
      if (dx * dx + dy * dy <= front * front) break;
    }

    const bin = this.binFor(wave, px, py);
    // Danger = where it has actually hit us + where its GF gun would aim next.
    let danger = this.smoothedStat(this.surfStats[wave.surfSeg], bin) * 1.0;
    danger += this.smoothedStat(this.mirrorStats[wave.mirrorSeg], bin) * 1.5;
    const endDist = Math.hypot(px - e.x, py - e.y);
    if (endDist < SURF_DIST) danger += (SURF_DIST - endDist) * 0.002;
    return danger;
  }

  private binFor(wave: EnemyWave, px: number, py: number): number {
    const ang = absBearing(wave.originX, wave.originY, px, py);
    const offset = normRel(ang - wave.initialTargetAngle);
    const factor = clamp((offset / wave.maxEscape) * wave.direction, -1, 1);
    return Math.round(((factor + 1) / 2) * (BINS - 1));
  }

  private smoothedStat(buf: number[], bin: number): number {
    let d = 0;
    for (let i = 0; i < BINS; i++) {
      const x = i - bin;
      d += buf[i] / (x * x + 1);
    }
    return d;
  }

  private nearestWave(t: number): EnemyWave | null {
    const mx = this.getX();
    const my = this.getY();
    let best: EnemyWave | null = null;
    let bestTime = Infinity;
    for (const wv of this.enemyWaves) {
      const front = wv.bulletSpeed * (t - wv.fireTime);
      const d = Math.hypot(wv.originX - mx, wv.originY - my);
      const timeToHit = (d - front) / wv.bulletSpeed;
      if (timeToHit > -1 && timeToHit < bestTime) {
        bestTime = timeToHit;
        best = wv;
      }
    }
    return best;
  }

  // Waves that passed us feed the mirror of the enemy's visit-GF gun stats.
  private crossWaves(t: number) {
    const mx = this.getX();
    const my = this.getY();
    for (let i = this.enemyWaves.length - 1; i >= 0; i--) {
      const wv = this.enemyWaves[i];
      const front = wv.bulletSpeed * (t - wv.fireTime);
      const d = Math.hypot(wv.originX - mx, wv.originY - my);
      if (front >= d) {
        const bin = this.binFor(wv, mx, my);
        const buf = this.mirrorStats[wv.mirrorSeg];
        const decay = 1 - 1 / GF_ROLL_N;
        for (let b = 0; b < BINS; b++) buf[b] *= decay;
        buf[bin] += 1;
        if (front > d + 40) this.enemyWaves.splice(i, 1);
      }
    }
  }

  private orbitHeadingAround(px: number, py: number, ex: number, ey: number, orbitDir: number): number {
    const eb = absBearing(ex, ey, px, py);
    const d = Math.hypot(ex - px, ey - py);
    let offset = 90;
    offset -= ((SURF_DIST - d) / SURF_DIST) * 25;
    offset = clamp(offset, 55, 125);
    const desired = normAbs(eb + orbitDir * offset);
    return this.wallSmooth(px, py, desired, orbitDir === 0 ? 1 : orbitDir);
  }

  private wallSmooth(px: number, py: number, desired: number, rotDir: number): number {
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    for (let i = 0; i < 30; i++) {
      const r = desired * DEG;
      const ax = px + Math.cos(r) * WALL_STICK;
      const ay = py + Math.sin(r) * WALL_STICK;
      if (ax > WALL_MARGIN && ax < w - WALL_MARGIN && ay > WALL_MARGIN && ay < h - WALL_MARGIN) {
        return desired;
      }
      desired = normAbs(desired + rotDir * 12);
    }
    return absBearing(px, py, w / 2, h / 2);
  }

  private driveTravel(travel: number, maxSpeed: number) {
    const bearing = normRel(travel - this.getDirection());
    if (Math.abs(bearing) <= 90) {
      this.setTurnRate(clamp(bearing, -10, 10));
      this.setTargetSpeed(maxSpeed);
    } else {
      this.setTurnRate(clamp(normRel(bearing - 180), -10, 10));
      this.setTargetSpeed(-maxSpeed);
    }
  }

  // ------------------------------------------------------- movement: melee
  private meleeMove() {
    const e = this.target();
    if (!e) {
      this.setTurnRate(0);
      this.setTargetSpeed(4);
      return;
    }
    const d = this.distanceTo(e.x, e.y);
    const eb = absBearing(e.x, e.y, this.getX(), this.getY());
    let offset = 90;
    if (d > 320) offset = 55;
    else if (d < 160) offset = 120;
    const desired = normAbs(eb + this.meleeOrbitDir * offset);
    this.driveTravel(this.wallSmooth(this.getX(), this.getY(), desired, this.meleeOrbitDir), 8);
  }

  // -------------------------------------------------------------------- gun
  private updateGun(duel: boolean) {
    const e = this.target();
    if (!e) {
      this.setGunTurnRate(0);
      return;
    }

    const dist = this.distanceTo(e.x, e.y);
    const power = this.selectPower(dist, e.energy);
    const bulletSpeed = 20 - 3 * power;

    let aimAbs: number;
    if (duel) {
      aimAbs = this.aimGF(e, dist, bulletSpeed);
    } else {
      const p = this.predict(e, bulletSpeed);
      aimAbs = this.directionTo(p.x, p.y);
    }

    const gunBearing = normRel(aimAbs - this.getGunDirection());
    this.setGunTurnRate(clamp(gunBearing, -20, 20));

    const tol = (Math.atan2(18, Math.max(dist, 1)) / DEG) * 1.1 + 0.5;
    if (this.getGunHeat() === 0 && Math.abs(gunBearing) <= tol && this.getEnergy() > power + 0.2) {
      if (this.setFire(power) && duel) this.recordGunWave(e, dist, bulletSpeed);
    }
  }

  private aimGF(e: Enemy, dist: number, bulletSpeed: number): number {
    const direct = this.directionTo(e.x, e.y);
    const maxEscape = Math.asin(8 / bulletSpeed) * RAD;
    const latVel = e.speed * Math.sin((e.direction - direct) * DEG);
    const lateralDir = latVel >= 0 ? 1 : -1;
    const seg = this.gunSeg(dist, Math.abs(latVel));

    if (this.hasData(this.gunGF[seg])) {
      let best = MID;
      let bestVal = -1;
      for (let i = 0; i < BINS; i++) {
        const s = this.smoothedStat(this.gunGF[seg], i);
        if (s > bestVal) {
          bestVal = s;
          best = i;
        }
      }
      const factor = (best / (BINS - 1)) * 2 - 1;
      return normAbs(direct + factor * maxEscape * lateralDir);
    }
    const p = this.predict(e, bulletSpeed);
    return this.directionTo(p.x, p.y);
  }

  private hasData(buf: number[]): boolean {
    for (let i = 0; i < BINS; i++) if (buf[i] > 0) return true;
    return false;
  }

  private recordGunWave(e: Enemy, dist: number, bulletSpeed: number) {
    const direct = this.directionTo(e.x, e.y);
    const latVel = e.speed * Math.sin((e.direction - direct) * DEG);
    this.gunWaves.push({
      originX: this.getX(),
      originY: this.getY(),
      fireTime: this.getTurnNumber(),
      bulletSpeed,
      directAngle: direct,
      maxEscape: Math.asin(8 / bulletSpeed) * RAD,
      lateralDir: latVel >= 0 ? 1 : -1,
      segment: this.gunSeg(dist, Math.abs(latVel)),
    });
  }

  private updateGunWaves(t: number) {
    if (this.gunWaves.length === 0) return;
    const e = this.target();
    if (!e) return;
    for (let i = this.gunWaves.length - 1; i >= 0; i--) {
      const wv = this.gunWaves[i];
      const traveled = wv.bulletSpeed * (t - wv.fireTime);
      const d = Math.hypot(wv.originX - e.x, wv.originY - e.y);
      if (traveled >= d) {
        const ang = absBearing(wv.originX, wv.originY, e.x, e.y);
        const offset = normRel(ang - wv.directAngle);
        const factor = clamp((offset / wv.maxEscape) * wv.lateralDir, -1, 1);
        const bin = Math.round(((factor + 1) / 2) * (BINS - 1));
        const buf = this.gunGF[wv.segment];
        const decay = 1 - 1 / GF_ROLL_N;
        for (let b = 0; b < BINS; b++) buf[b] *= decay;
        buf[bin] += 1;
        this.gunWaves.splice(i, 1);
      }
    }
  }

  private gunSeg(d: number, absLatVel: number): number {
    const db = d < 250 ? 0 : d < 600 ? 1 : 2;
    const lb = absLatVel < 1 ? 0 : absLatVel < 5 ? 1 : 2;
    return db * 3 + lb;
  }

  private surfSeg(absLatVel: number): number {
    return absLatVel < 2 ? 0 : absLatVel < 6 ? 1 : 2;
  }

  private selectPower(dist: number, targetEnergy: number): number {
    let p: number;
    if (dist < 150) p = 3;
    else if (dist > 450) p = 1.5;
    else p = 2 + (1 - (dist - 150) / 300) * 0.5;

    const myE = this.getEnergy();
    if (myE < 20) p = Math.min(p, 1 + (myE / 20) * 1.5);
    if (myE < 8) p = Math.min(p, 0.6);
    if (targetEnergy < 16) p = Math.min(p, Math.max(targetEnergy / 4 + 0.1, 0.1));
    p = Math.min(p, myE - 0.2);
    return clamp(p, 0.1, 3);
  }

  private predict(e: Enemy, bulletSpeed: number): { x: number; y: number } {
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    if (Math.abs(e.speed) < 0.3) return { x: e.x, y: e.y };
    let heading = e.direction * DEG;
    const omega = (Math.abs(e.omega) > 0.1 ? e.omega : 0) * DEG;
    let tx = e.x;
    let ty = e.y;
    for (let step = 1; step <= 110; step++) {
      heading += omega;
      tx = clamp(tx + Math.cos(heading) * e.speed, 18, w - 18);
      ty = clamp(ty + Math.sin(heading) * e.speed, 18, h - 18);
      if (Math.hypot(tx - this.getX(), ty - this.getY()) <= bulletSpeed * step) break;
    }
    return { x: tx, y: ty };
  }

  // ------------------------------------------------------------------ events
  override onScannedBot(e: ScannedBotEvent) {
    const prev = this.enemies.get(e.scannedBotId);
    const turn = this.getTurnNumber();
    const duel = this.getEnemyCount() <= 1;

    let omega = 0;
    if (prev) {
      const dt = turn - prev.turn;
      if (dt > 0 && dt <= 8) omega = normRel(e.direction - prev.direction) / dt;

      if (duel) {
        const drop = prev.energy - e.energy - this.dmgDealtSinceScan;
        if (drop >= 0.09 && drop <= 3.05) {
          const bs = 20 - 3 * clamp(drop, 0.1, 3);
          const mx = this.getX();
          const my = this.getY();
          const eb = absBearing(e.x, e.y, mx, my);
          const ourLat = this.getSpeed() * Math.sin((this.getDirection() - eb) * DEG);
          // mirrorSeg mimics a visit-GF gun's segmentation of US at fire time.
          this.enemyWaves.push({
            originX: e.x,
            originY: e.y,
            fireTime: turn - 1,
            bulletSpeed: bs,
            initialTargetAngle: eb,
            maxEscape: Math.asin(8 / bs) * RAD,
            direction: ourLat >= 0 ? 1 : -1,
            surfSeg: this.surfSeg(Math.abs(ourLat)),
            mirrorSeg: this.gunSeg(Math.hypot(e.x - mx, e.y - my), Math.abs(ourLat)),
          });
        }
      }
    }
    this.dmgDealtSinceScan = 0;

    this.enemies.set(e.scannedBotId, {
      id: e.scannedBotId,
      x: e.x,
      y: e.y,
      energy: e.energy,
      direction: e.direction,
      speed: e.speed,
      omega,
      turn,
    });
    this.lastLockTurn = turn;
    this.lockedId = e.scannedBotId;
  }

  override onHitByBullet(e: HitByBulletEvent) {
    const t = this.getTurnNumber();
    const mx = this.getX();
    const my = this.getY();
    let bestIdx = -1;
    let bestErr = Infinity;
    for (let i = 0; i < this.enemyWaves.length; i++) {
      const wv = this.enemyWaves[i];
      if (Math.abs(wv.bulletSpeed - e.bullet.speed) > 0.6) continue;
      const traveled = wv.bulletSpeed * (t - wv.fireTime);
      const err = Math.abs(traveled - Math.hypot(wv.originX - mx, wv.originY - my));
      if (err < bestErr) {
        bestErr = err;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const wv = this.enemyWaves[bestIdx];
      this.surfStats[wv.surfSeg][this.binFor(wv, mx, my)] += 1;
      this.enemyWaves.splice(bestIdx, 1);
    }
  }

  override onBulletHitBot(e: BulletHitBotEvent) {
    this.dmgDealtSinceScan += e.damage;
  }

  override onHitBot(e: HitBotEvent) {
    if (e.isRammed) this.surfDir = -this.surfDir;
    this.meleeOrbitDir = -this.meleeOrbitDir;
  }

  override onHitWall(_e: HitWallEvent) {
    this.surfDir = -this.surfDir;
    this.meleeOrbitDir = -this.meleeOrbitDir;
  }

  override onBotDeath(e: BotDeathEvent) {
    this.enemies.delete(e.victimId);
  }
}

MannyBot.main();
