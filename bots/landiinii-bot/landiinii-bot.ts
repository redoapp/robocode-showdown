/**
 * landiinii-bot — competitive Tank Royale bot (1v1 + melee).
 *
 * 1v1 mode:
 *   - Radar lock, circular predictive aim, orbital strafing with wall
 *     smoothing, wave-dodge (flip on enemy fire) and orbit weaving.
 * Melee mode (2+ opponents):
 *   - Track every scanned enemy, focus fire on the nearest, and move by
 *     anti-gravity — repelled from enemies, walls and corners so we don't
 *     get surrounded or pinned.
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
} from "@robocode.dev/tank-royale-bot-api";

const DEG = Math.PI / 180;

interface Enemy {
  x: number;
  y: number;
  energy: number;
  dir: number;
  speed: number;
  lastDir: number;
  seenTick: number;
  lastEnergy: number;
}

class LandiiniiBot extends Bot {
  private moveDirection = 1;
  private tick = 0;
  private nextFlip = 20;
  private strafeSpeed = 8;
  // 1v1 tracking of the single opponent.
  private lastEnemyEnergy = 100;
  private lastEnemyDir: number | null = null;
  // Melee tracking of every opponent by id.
  private enemies = new Map<number, Enemy>();

  static main() {
    new LandiiniiBot().start();
  }

  override run() {
    this.lastEnemyEnergy = 100;
    this.lastEnemyDir = null;
    this.tick = 0;
    this.nextFlip = 20;
    this.enemies.clear();
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);

    while (this.isRunning()) {
      // Sweep to (re)acquire; onScannedBot locks the radar onto our target.
      this.turnRadarRight(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    this.tick++;

    // Update melee tracking table.
    const prev = this.enemies.get(e.scannedBotId);
    this.enemies.set(e.scannedBotId, {
      x: e.x,
      y: e.y,
      energy: e.energy,
      dir: e.direction,
      speed: e.speed,
      lastDir: prev ? prev.dir : e.direction,
      lastEnergy: prev ? prev.energy : e.energy,
      seenTick: this.tick,
    });

    if (this.getEnemyCount() <= 1) {
      this.duel(e);
    } else {
      this.melee(e);
    }
  }

  // ===================== 1v1 =====================
  private duel(e: ScannedBotEvent) {
    const myX = this.getX();
    const myY = this.getY();
    const distance = this.distanceTo(e.x, e.y);
    const arenaW = this.getArenaWidth();
    const arenaH = this.getArenaHeight();

    // --- WAVE DODGE: react to the enemy firing -------------------------
    const drop = this.lastEnemyEnergy - e.energy;
    if (drop >= 0.09 && drop <= 3.01) {
      this.moveDirection = -this.moveDirection;
      this.nextFlip = this.tick + 15 + Math.floor(Math.random() * 25);
    }
    this.lastEnemyEnergy = e.energy;
    if (this.tick >= this.nextFlip) {
      this.moveDirection = -this.moveDirection;
      this.nextFlip = this.tick + 15 + Math.floor(Math.random() * 30);
    }

    // --- RADAR LOCK ----------------------------------------------------
    const radarBearing = this.radarBearingTo(e.x, e.y);
    this.setTurnRadarLeft(-radarBearing * 2);

    // --- AIM + FIRE ----------------------------------------------------
    const firepower = this.firepowerFor(distance);
    this.aimAndFire(e, firepower, distance, arenaW, arenaH);

    // --- ORBITAL STRAFE with wall smoothing ----------------------------
    const absBearingToEnemy = this.norm360(
      Math.atan2(e.y - myY, e.x - myX) / DEG
    );
    const preferred = 360;
    let perp = 90;
    if (distance > preferred + 120) perp = 74;
    else if (distance < preferred - 60) perp = 106;

    const jitter = 15 * Math.sin(this.tick / 5);
    let driveHeading = this.norm360(
      absBearingToEnemy + this.moveDirection * (perp + jitter)
    );
    driveHeading = this.smoothWall(myX, myY, driveHeading, arenaW, arenaH);

    this.setTurnRight(this.calcBearing(driveHeading));
    this.setForward(100);
  }

  // ===================== MELEE =====================
  private melee(e: ScannedBotEvent) {
    const myX = this.getX();
    const myY = this.getY();
    const arenaW = this.getArenaWidth();
    const arenaH = this.getArenaHeight();
    this.pruneEnemies();

    // Predictive fire at whatever we just scanned — my accurate lead aim beats
    // spray-and-pray, and every bit of melee damage counts.
    const distToScanned = this.distanceTo(e.x, e.y);
    this.aimAndFire(e, this.firepowerFor(distToScanned), distToScanned, arenaW, arenaH);

    const nearest = this.nearestEnemy(myX, myY);
    const target = nearest ?? {
      x: e.x,
      y: e.y,
      id: e.scannedBotId,
      energy: e.energy,
      lastEnergy: e.energy,
    };
    const distance = Math.hypot(target.x - myX, target.y - myY);

    // Radar-lock the nearest threat for frequent, accurate scans.
    const radarBearing = this.radarBearingTo(target.x, target.y);
    this.setTurnRadarLeft(-radarBearing * 2);

    // Wave-dodge off the nearest threat's fire.
    const drop = target.lastEnergy - target.energy;
    if (drop >= 0.09 && drop <= 3.01) {
      this.moveDirection = -this.moveDirection;
      this.nextFlip = this.tick + 15 + Math.floor(Math.random() * 25);
    }
    if (this.tick >= this.nextFlip) {
      this.moveDirection = -this.moveDirection;
      this.nextFlip = this.tick + 18 + Math.floor(Math.random() * 28);
    }

    const absBearingToTarget = this.norm360(
      Math.atan2(target.y - myY, target.x - myX) / DEG
    );
    const preferred = 300;
    let perp = 90;
    if (distance > preferred + 150) perp = 78; // close the gap
    else if (distance < preferred - 60) perp = 108; // back off

    // Nudge the orbit away from the average enemy position (avoid the pack).
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const en of this.enemies.values()) {
      sx += en.x;
      sy += en.y;
      n++;
    }
    let packBias = 0;
    if (n > 0) {
      const packAngle = this.norm360(
        Math.atan2(sy / n - myY, sx / n - myX) / DEG
      );
      // If the pack centre is roughly ahead of our orbit heading, steepen the
      // turn away from it.
      const rel = this.normDelta(
        packAngle - (absBearingToTarget + this.moveDirection * perp)
      );
      packBias = -this.moveDirection * Math.max(0, 25 - Math.abs(rel) / 4);
    }

    const jitter = 12 * Math.sin(this.tick / 5);
    let driveHeading = this.norm360(
      absBearingToTarget + this.moveDirection * perp + packBias + jitter
    );
    driveHeading = this.smoothWall(myX, myY, driveHeading, arenaW, arenaH);

    this.setTurnRight(this.calcBearing(driveHeading));
    this.setForward(100);
  }

  // ===================== SHARED HELPERS =====================
  private firepowerFor(distance: number): number {
    const myEnergy = this.getEnergy();
    let firepower: number;
    if (distance < 150) firepower = 3;
    else if (distance < 400) firepower = 2.4;
    else if (distance < 650) firepower = 1.6;
    else firepower = 1;
    if (myEnergy < 25) firepower = Math.min(firepower, 1.2);
    if (myEnergy < 10) firepower = Math.min(firepower, 0.5);
    firepower = Math.min(firepower, Math.max(0.1, myEnergy - 0.2));
    return firepower;
  }

  // Circular predictive aim: project the enemy along its estimated turn arc
  // while the bullet flies, then fire if the gun is close and cool.
  private aimAndFire(
    e: ScannedBotEvent,
    firepower: number,
    distance: number,
    arenaW: number,
    arenaH: number
  ) {
    const bulletSpeed = 20 - 3 * firepower;
    const en = this.enemies.get(e.scannedBotId);
    let angVel = 0;
    if (en && en.lastDir !== undefined) {
      angVel = this.normDelta(e.direction - en.lastDir);
      if (angVel > 15) angVel = 15;
      if (angVel < -15) angVel = -15;
    }

    let predX = e.x;
    let predY = e.y;
    let hd = e.direction * DEG;
    const dav = angVel * DEG;
    for (let t = 1; t <= 120; t++) {
      hd += dav;
      predX += Math.cos(hd) * e.speed;
      predY += Math.sin(hd) * e.speed;
      predX = Math.max(18, Math.min(arenaW - 18, predX));
      predY = Math.max(18, Math.min(arenaH - 18, predY));
      if (this.distanceTo(predX, predY) <= bulletSpeed * t) break;
    }

    const gunBearing = this.gunBearingTo(predX, predY);
    this.setTurnGunLeft(-gunBearing);
    const aimTolerance = Math.max(4, 18 - distance / 60);
    if (Math.abs(gunBearing) < aimTolerance && this.getGunHeat() === 0) {
      this.setFire(firepower);
    }
  }

  private nearestEnemy(x: number, y: number): (Enemy & { id: number }) | null {
    let best: (Enemy & { id: number }) | null = null;
    let bestD = Infinity;
    for (const [id, en] of this.enemies) {
      const d = Math.hypot(en.x - x, en.y - y);
      if (d < bestD) {
        bestD = d;
        best = { ...en, id };
      }
    }
    return best;
  }

  private pruneEnemies() {
    for (const [id, en] of this.enemies) {
      if (this.tick - en.seenTick > 40) this.enemies.delete(id);
    }
  }

  override onHitByBullet(_e: HitByBulletEvent) {
    this.moveDirection = -this.moveDirection;
  }

  override onHitWall(_e: HitWallEvent) {
    this.moveDirection = -this.moveDirection;
  }

  override onHitBot(e: HitBotEvent) {
    if (!e.isRammed) this.moveDirection = -this.moveDirection;
  }

  // Bend a desired heading away from walls so we keep orbiting.
  private smoothWall(
    x: number,
    y: number,
    heading: number,
    w: number,
    h: number
  ): number {
    const margin = 60;
    const stick = 140;
    let adjusted = heading;
    for (let i = 0; i < 18; i++) {
      const hx = x + Math.cos(adjusted * DEG) * stick;
      const hy = y + Math.sin(adjusted * DEG) * stick;
      if (hx > margin && hx < w - margin && hy > margin && hy < h - margin) {
        break;
      }
      adjusted = this.norm360(adjusted + this.moveDirection * 10);
    }
    return adjusted;
  }

  private normDelta(angle: number): number {
    let a = angle % 360;
    if (a > 180) a -= 360;
    if (a < -180) a += 360;
    return a;
  }

  private norm360(angle: number): number {
    let a = angle % 360;
    if (a < 0) a += 360;
    return a;
  }
}

LandiiniiBot.main();
