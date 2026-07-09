/**
 * manny-bot — radar lock, orbit movement with muzzle-flash dodging (enemy
 * energy drop = they fired), iterative wall-clamped predictive aim.
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent, HitBotEvent } from "@robocode.dev/tank-royale-bot-api";

const toRad = (deg: number) => (deg * Math.PI) / 180;

class MannyBot extends Bot {
  private orbitDir = 1;
  private enemyEnergy = new Map<number, number>();
  private enemyVel = new Map<number, { vx: number; vy: number }>();
  private targetId = -1;
  private targetDist = Infinity;
  private lastScanTurn = -1;

  static main() {
    new MannyBot().start();
  }

  override run() {
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);
    this.enemyEnergy.clear();
    this.enemyVel.clear();
    this.targetId = -1;
    this.targetDist = Infinity;
    this.lastScanTurn = -1;

    while (this.isRunning()) {
      // No lock (or lock lost) -> sweep to find someone.
      this.turnRadarRight(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    const dist = this.distanceTo(e.x, e.y);

    // Prefer the nearest enemy (melee); keep the current target unless a
    // clearly closer one appears or the lock went stale.
    const stale = this.lastScanTurn >= 0 && this.getTurnNumber() - this.lastScanTurn > 8;
    if (this.targetId === -1 || stale || e.scannedBotId === this.targetId || dist < this.targetDist * 0.8) {
      this.targetId = e.scannedBotId;
    }
    if (e.scannedBotId !== this.targetId) return;
    this.targetDist = dist;
    this.lastScanTurn = this.getTurnNumber();

    // Radar lock: overshoot the bearing so the target stays in the arc.
    this.setTurnRadarLeft(this.radarBearingTo(e.x, e.y) * 2);

    // Muzzle-flash dodge: an energy drop of 0.1–3.0 means they fired.
    const prev = this.enemyEnergy.get(e.scannedBotId);
    this.enemyEnergy.set(e.scannedBotId, e.energy);
    const drop = prev === undefined ? 0 : prev - e.energy;
    if (drop >= 0.1 && drop <= 3.0) {
      if (Math.random() < 0.15) this.orbitDir = -this.orbitDir;
      this.setMaxSpeed(4 + Math.random() * 4);
    } else if (Math.random() < 0.05) {
      this.setMaxSpeed(8);
    }

    // Orbit at mid range, spiraling in/out to hold the preferred distance.
    const bearing = this.bearingTo(e.x, e.y);
    let attackTilt = 0;
    if (dist > 320) attackTilt = 25;
    else if (dist < 180) attackTilt = -25;
    this.setTurnLeft(bearing - 90 + attackTilt * this.orbitDir);

    if (this.nearWallAhead()) this.orbitDir = -this.orbitDir;
    this.setForward(160 * this.orbitDir);

    // Firepower: heavy up close, light at range, stingy at low energy.
    const myEnergy = this.getEnergy();
    let power = dist < 140 ? 3 : Math.min(3, Math.max(1, 420 / dist));
    if (myEnergy < 15) power = Math.min(power, 1);
    if (myEnergy < 4) power = 0.5;
    const bulletSpeed = 20 - 3 * power;

    // EMA-smoothed velocity: oscillating movers average to ~0 (aim at body),
    // steady orbiters keep their true lead.
    const rawVx = Math.cos(toRad(e.direction)) * e.speed;
    const rawVy = Math.sin(toRad(e.direction)) * e.speed;
    const ema = this.enemyVel.get(e.scannedBotId) ?? { vx: rawVx, vy: rawVy };
    ema.vx = ema.vx * 0.7 + rawVx * 0.3;
    ema.vy = ema.vy * 0.7 + rawVy * 0.3;
    this.enemyVel.set(e.scannedBotId, ema);

    // Iterative prediction on the smoothed velocity, clamped to the arena.
    const minX = 18, minY = 18;
    const maxX = this.getArenaWidth() - 18;
    const maxY = this.getArenaHeight() - 18;
    let fx = e.x, fy = e.y;
    for (let i = 0; i < 8; i++) {
      const t = this.distanceTo(fx, fy) / bulletSpeed;
      fx = e.x + ema.vx * t;
      fy = e.y + ema.vy * t;
      fx = Math.min(maxX, Math.max(minX, fx));
      fy = Math.min(maxY, Math.max(minY, fy));
    }

    const gunBearing = this.gunBearingTo(fx, fy);
    this.setTurnGunLeft(gunBearing);

    // Fire once the gun is inside the target's angular width and cool.
    const aimTolerance = Math.max(1.5, (Math.atan2(16, dist) * 180) / Math.PI);
    if (Math.abs(gunBearing) < aimTolerance && this.getGunHeat() === 0 && myEnergy > 0.6) {
      this.setFire(power);
    }
  }

  override onHitByBullet(e: HitByBulletEvent) {
    // Their aim found us — break the pattern.
    if (Math.random() < 0.5) this.orbitDir = -this.orbitDir;
    this.setMaxSpeed(8);
  }

  override onHitWall(e: HitWallEvent) {
    this.orbitDir = -this.orbitDir;
    this.setForward(120 * this.orbitDir);
  }

  override onHitBot(e: HitBotEvent) {
    // Point-blank: unload, then shove off.
    const gb = this.gunBearingTo(e.x, e.y);
    this.setTurnGunLeft(gb);
    if (Math.abs(gb) < 20 && this.getGunHeat() === 0) this.setFire(3);
    this.setBack(100);
  }

  // True if continuing on the current heading runs us into a wall soon.
  private nearWallAhead(): boolean {
    const margin = 70;
    const heading = toRad(this.getDirection());
    const sign = this.getSpeed() >= 0 ? 1 : -1;
    const lookahead = 60;
    const nx = this.getX() + Math.cos(heading) * lookahead * sign;
    const ny = this.getY() + Math.sin(heading) * lookahead * sign;
    return (
      nx < margin || ny < margin ||
      nx > this.getArenaWidth() - margin ||
      ny > this.getArenaHeight() - margin
    );
  }
}

MannyBot.main();
