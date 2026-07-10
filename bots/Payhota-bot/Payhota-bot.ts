/**
 * Payhota-bot — a point-blank rammer.
 *
 * Strategy: get in the enemy's face and never leave. At close range you almost
 * can't miss, so we fire the HEAVIEST bullets (max damage + max energy back on
 * hit) and add ram damage on top by driving into the target.
 *
 *   1. Radar lock     — glue the radar to the target for a scan every turn.
 *   2. Evasive close  — cross the arena in a wide arc (mostly lateral) so a
 *                       leading gun can't lead us and a no-lead gun can't hit a
 *                       straight charge, flipping the arc so it's unpredictable.
 *   3. Wall smoothing — never commit a heading that drives us into a wall (an
 *                       unsmoothed rammer gets pinned in a corner and dies).
 *   4. Hold fire      — energy is health; don't bleed it on long-range misses,
 *                       only fire once we're close enough to connect.
 *   5. Ram            — up close, drive INTO the enemy with the NEAREST end
 *                       (reverse if they're behind us rather than spending ~18
 *                       turns spinning around) so WE deal the ram damage.
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
} from "@robocode.dev/tank-royale-bot-api";

// Distance (px) at which we consider ourselves point-blank.
const POINT_BLANK = 120;
// Angle (deg) off the straight line to the enemy that we drive while closing.
// Some lateral motion dodges a leading gun, but we bias toward closing FAST:
// the less time we spend crossing the arena, the less chip damage we take.
const APPROACH_ANGLE = 70;
// Flip the approach arc this often (turns) so our lateral motion isn't a
// predictable straight line the enemy's gun can lead.
const FLIP_PERIOD = 20;
// Only fire inside this range. Energy is health for a rammer — firing at long
// range mostly misses (oscillating enemies beat linear lead) and just bleeds
// us out before we arrive. Hold fire until we're close enough to connect.
const FIRE_RANGE = 160;

class PayhotaBot extends Bot {
  private orbitSign = 1;
  private t = 0;

  static main() {
    new PayhotaBot().start();
  }

  override run() {
    // Let the three parts turn independently so the radar can stay locked
    // while the body chases and the gun tracks.
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);

    while (this.isRunning()) {
      // No target yet -> sweep to find one.
      this.turnRadarRight(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    const distance = this.distanceTo(e.x, e.y);

    // --- 1. RADAR LOCK ---------------------------------------------------
    // Point the radar just past the enemy so it stays in the scan arc.
    this.setTurnRadarLeft(-this.radarBearingTo(e.x, e.y) * 2);

    // --- 2. HEAVY, ENERGY-SAFE FIRE -------------------------------------
    // Max power when point-blank (we can't miss); taper with distance.
    let firepower: number;
    if (distance < POINT_BLANK) firepower = 3;
    else if (distance < 250) firepower = 2;
    else firepower = 1;
    // Never fire so hard it could disable us; leave a small energy buffer.
    firepower = Math.min(firepower, this.getEnergy() - 0.5);

    // Light predictive lead — matters at range, harmless up close.
    const bulletSpeed = 20 - 3 * Math.max(firepower, 0.1);
    const timeToHit = distance / bulletSpeed;
    const futureX = e.x + Math.cos((e.direction * Math.PI) / 180) * e.speed * timeToHit;
    const futureY = e.y + Math.sin((e.direction * Math.PI) / 180) * e.speed * timeToHit;

    const gunBearing = this.gunBearingTo(futureX, futureY);
    this.setTurnGunLeft(-gunBearing);

    // Fire when lined up and cool. Aim tolerance widens as we close in,
    // because a nearby enemy fills a much wider arc.
    const aimTolerance = distance < POINT_BLANK ? 20 : 8;
    if (
      distance < FIRE_RANGE &&
      firepower >= 0.1 &&
      Math.abs(gunBearing) < aimTolerance &&
      this.getGunHeat() === 0
    ) {
      this.setFire(firepower);
    }

    // --- 3. MOVEMENT -----------------------------------------------------
    this.setMaxSpeed(8);
    // Periodically flip the arc so our lateral motion isn't predictable.
    if (++this.t % FLIP_PERIOD === 0) this.orbitSign = -this.orbitSign;

    // Absolute heading from us to the enemy.
    const absToEnemy = (Math.atan2(e.y - this.getY(), e.x - this.getX()) * 180) / Math.PI;
    // Straight in for the point-blank brawl; a wide arc while approaching so a
    // linear-prediction gun can't lead us. Then SMOOTH the heading off the
    // walls so we never drive into one and get pinned.
    const raw = distance < POINT_BLANK ? absToEnemy : absToEnemy + this.orbitSign * APPROACH_ANGLE;
    const desired = this.wallSmooth(raw);

    // Drive the NEAREST end toward that heading: if it's behind us, reverse
    // rather than spend ~18 turns spinning 180° while the enemy rams our tail.
    const bodyBearing = this.calcBearing(desired);
    const reversed = Math.abs(bodyBearing) > 90;
    const turn = reversed ? bodyBearing - Math.sign(bodyBearing) * 180 : bodyBearing;
    const drive = distance < POINT_BLANK ? Math.max(distance, 60) : 100;
    this.setTurnRight(turn);
    if (reversed) this.setBack(drive);
    else this.setForward(drive);
  }

  /**
   * Rotate a desired absolute heading so it doesn't drive us into a wall.
   * Looks a short distance ahead along the heading; if that point is outside
   * the safe inner box, fan out left/right until we find a heading that stays
   * in bounds. This is what keeps a rammer from getting pinned in a corner.
   */
  private wallSmooth(heading: number): number {
    const margin = 70;
    const look = 90;
    const x = this.getX();
    const y = this.getY();
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    for (let off = 0; off <= 180; off += 15) {
      for (const sign of off === 0 ? [1] : [1, -1]) {
        const a = ((heading + sign * off) * Math.PI) / 180;
        const nx = x + Math.cos(a) * look;
        const ny = y + Math.sin(a) * look;
        if (nx > margin && nx < w - margin && ny > margin && ny < h - margin) {
          return heading + sign * off;
        }
      }
    }
    return heading;
  }

  override onHitBot(e: HitBotEvent) {
    // Contact! This is where ram damage happens. Keep pushing into them and
    // punch a heavy shot in point-blank.
    const bearing = this.bearingTo(e.x, e.y);
    const reversed = Math.abs(bearing) > 90;
    const turn = reversed ? bearing - Math.sign(bearing) * 180 : bearing;
    this.setTurnRight(turn);
    if (reversed) this.setBack(60);
    else this.setForward(60);
    const gunBearing = this.gunBearingTo(e.x, e.y);
    this.setTurnGunLeft(-gunBearing);
    if (this.getGunHeat() === 0) {
      this.setFire(Math.min(3, this.getEnergy() - 0.5));
    }
  }

  override onHitByBullet(e: HitByBulletEvent) {
    // Reverse the orbit direction to throw off the enemy's aim.
    this.orbitSign = -this.orbitSign;
  }

  override onHitWall(e: HitWallEvent) {
    // Backstop if smoothing ever fails: drive back toward the arena centre so
    // we can't stay pinned in a corner.
    const cx = this.getArenaWidth() / 2;
    const cy = this.getArenaHeight() / 2;
    const toCenter = (Math.atan2(cy - this.getY(), cx - this.getX()) * 180) / Math.PI;
    this.setTurnRight(this.calcBearing(toCenter));
    this.setForward(100);
    this.orbitSign = -this.orbitSign;
  }
}

PayhotaBot.main();
