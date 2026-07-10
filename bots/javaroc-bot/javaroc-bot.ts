// javaroc-bot — see docs/API_CHEATSHEET.md for the useful methods and events.
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent, BotDeathEvent, Color, GameStartedEvent } from "@robocode.dev/tank-royale-bot-api";

// Range at which we're close enough to unload our big shot.
const CLOSE_RANGE = 120;
// Firepower for the big shot (max is 3.0).
const BIG_SHOT = 3.0;
// How far past the last-seen spot the radar sweeps on each pass (max turn is 45).
const SWEEP_ARC = 30;
// Missed sweeps over the last-seen spot before we give up and spin 360 again.
const MAX_MISSED_SWEEPS = 2;

class JavarocBot extends Bot {

  // The bot we've committed to hunting; undefined until we spot our first enemy.
  private targetId: number | undefined;

  // Where we last saw the target, so we can keep sweeping the radar over it.
  private lastSeenX: number | undefined;
  private lastSeenY: number | undefined;

  // Alternates each sweep so the radar oscillates back and forth over the spot.
  private sweepSign = 1;

  // Consecutive sweeps over the last-seen spot with no re-scan.
  private missedSweeps = 0;

  static main() {
    new JavarocBot().start();
  }

  // Runs once at the start of each round. Your main loop goes here.
  override run() {
    this.setGunColor(Color.fromRgba(50, 50, 50, 1));
    this.setBodyColor(Color.fromRgba(0, 120, 40, 1));
    this.setScanColor(Color.fromRgba(0, 120, 40, 1))
    this.setRadarColor(Color.fromRgba(0, 120, 40, 1))
    this.setTracksColor(Color.fromRgba(0, 120, 40, 1))
    this.setTurretColor(Color.fromRgba(0, 120, 40, 1));

    // Decouple radar, gun, and body so each turns on its own heading.
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);

    this.targetId = undefined;
    this.lastSeenX = undefined;
    this.lastSeenY = undefined;
    this.missedSweeps = 0;

    while (this.isRunning()) {
      if (this.lastSeenX === undefined || this.lastSeenY === undefined) {
        // No fix yet: spin the radar all the way around to find someone.
        this.turnRadarRight(360);
      } else {
        // Sweep back and forth across the last-seen spot so we re-acquire it.
        this.missedSweeps++;
        const bearing = this.radarBearingTo(this.lastSeenX, this.lastSeenY);
        this.turnRadarRight(bearing + this.sweepSign * SWEEP_ARC);
        this.sweepSign = -this.sweepSign;
        // A re-scan during the sweep resets the counter; if it didn't, we've
        // lost the target for too long — drop the fix and spin 360 again.
        if (this.missedSweeps >= MAX_MISSED_SWEEPS) {
          this.lastSeenX = undefined;
          this.lastSeenY = undefined;
        }
      }
    }
  }


  // Fires when the radar sweeps across an enemy — this is when we act.
  override onScannedBot(e: ScannedBotEvent) {
    // Commit to the first bot we ever see; ignore everyone else after that.
    if (this.targetId === undefined) {
      this.targetId = e.scannedBotId;
    }
    if (e.scannedBotId !== this.targetId) {
      return;
    }

    // Remember where we saw it; the main loop sweeps the radar over this spot.
    this.lastSeenX = e.x;
    this.lastSeenY = e.y;
    this.missedSweeps = 0;

    // Gun: aim at the target, independent of the tank's heading.
    const gunBearing = this.gunBearingTo(e.x, e.y);
    this.setTurnGunLeft(-gunBearing);

    // Body: turn toward the target and close the distance.
    const distance = this.distanceTo(e.x, e.y);
    this.setTurnLeft(-this.bearingTo(e.x, e.y));
    if (distance > CLOSE_RANGE) {
      this.setForward(distance - CLOSE_RANGE);
    }

    // Fire the big shot only once we're close, lined up, and the gun is cool.
    if (distance <= CLOSE_RANGE && Math.abs(gunBearing) < 8 && this.getGunHeat() === 0) {
      this.setFire(BIG_SHOT);
    }
  }

  // If our target dies, forget it so we go hunting for a fresh one.
  override onBotDeath(e: BotDeathEvent) {
    if (e.victimId === this.targetId) {
      this.targetId = undefined;
      this.lastSeenX = undefined;
      this.lastSeenY = undefined;
    }
  }

  // Fires when an enemy bullet hits you — dodge!
  override onHitByBullet(e: HitByBulletEvent) {
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(90 - bearing);
  }

  // Fires when you drive into a wall.
  override onHitWall(e: HitWallEvent) {
    // Get current X and Y
    // If either is > 80% or < 20%, aim for 20%

    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    const target = {
      x: Math.min(w*.8, Math.max(w*.2, this.getX())),
      y: Math.min(h*.2, Math.max(h*.2, this.getY())),
    }

    this.turnRight(this.calcDeltaAngle(this.directionTo(target.x, target.y), this.getDirection()));
    this.forward(this.distanceTo(target.x, target.y))
  }
}

JavarocBot.main();
