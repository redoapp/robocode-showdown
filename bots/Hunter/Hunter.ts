/**
 * Hunter — a stronger reference bot to test your ideas against.
 *
 * It demonstrates three things that separate a competitive bot from SampleBot:
 *   1. Radar lock      — keep the radar glued to one enemy so you get a scan
 *                        EVERY turn instead of only when you happen to sweep past.
 *   2. Predictive aim  — lead the target based on its velocity so bullets land
 *                        where the enemy is GOING, not where it was.
 *   3. Adaptive power   — fire hard when close, soft when far.
 *
 * Read it, steal from it, beat it. This is a great baseline opponent for
 * testing your own bot during development.
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class Hunter extends Bot {
  private moveDirection = 1;

  static main() {
    new Hunter().start();
  }

  override run() {
    // Let the radar spin independently of the gun and body so it can search.
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);

    while (this.isRunning()) {
      // No enemy locked yet -> keep sweeping the radar to find one.
      this.turnRadarRight(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    // --- 1. RADAR LOCK ---------------------------------------------------
    // Turn the radar to point a little PAST the enemy's bearing. This
    // "infinite lock" keeps the target in the scan arc every turn.
    const radarBearing = this.radarBearingTo(e.x, e.y);
    this.setTurnRadarLeft(-radarBearing * 2);

    // --- 2. PREDICTIVE AIM ----------------------------------------------
    const distance = this.distanceTo(e.x, e.y);
    // Weaker/faster bullets when far away (more likely to connect), heavier
    // when close (more damage + energy back).
    const firepower = Math.min(3, Math.max(0.5, 500 / distance));
    const bulletSpeed = 20 - 3 * firepower;

    // Simple linear prediction: assume the enemy keeps its current heading
    // and speed while our bullet travels to it.
    const timeToHit = distance / bulletSpeed;
    const futureX = e.x + Math.cos((e.direction * Math.PI) / 180) * e.speed * timeToHit;
    const futureY = e.y + Math.sin((e.direction * Math.PI) / 180) * e.speed * timeToHit;

    const gunBearing = this.gunBearingTo(futureX, futureY);
    this.setTurnGunLeft(-gunBearing);

    // Only fire once the gun is roughly on target and the gun is cool.
    if (Math.abs(gunBearing) < 10 && this.getGunHeat() === 0) {
      this.setFire(firepower);
    }

    // --- 3. MOVEMENT -----------------------------------------------------
    // Strafe perpendicular to the enemy so we're a harder target, and flip
    // direction now and then to dodge.
    const bearing = this.bearingTo(e.x, e.y);
    this.setTurnRight(bearing + 90 - 30 * this.moveDirection);
    this.setForward(120 * this.moveDirection);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    // Got hit -> reverse strafe direction to throw off the enemy's aim.
    this.moveDirection = -this.moveDirection;
  }

  override onHitWall(e: HitWallEvent) {
    this.moveDirection = -this.moveDirection;
    this.setForward(80 * this.moveDirection);
  }
}

Hunter.main();
