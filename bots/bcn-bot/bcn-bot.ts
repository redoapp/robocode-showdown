/**
 * bcn-bot — a Robocode Tank Royale bot.
 *
 * A GuessFactor / wave-surfing tank bot for Robocode Tank Royale:
 *   - perfect radar lock (this file)
 *   - GuessFactor KNN gun with a virtual-gun array (knnGun/features/gfbins)
 *   - wave-surfing movement w/ KNN danger + adaptive flattener + bullet shadows
 *     (surfer/enemyWave/dangerModel/drive)
 *   - win-probability bullet-power selection (bulletPower/hitRate)
 *   - optional bullet-shielding mode (shielder; off by default, BCN_SHIELD=1)
 *
 * Control convention (Tank Royale):
 *   - angles are absolute degrees, CCW from East.
 *   - to aim any turret at an absolute target angle T, turn LEFT (CCW) by
 *     normalizeRelative(T - currentAngle). setTurnLeft(+) is CCW.
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent, HitBotEvent, BulletHitBotEvent, WonRoundEvent, DeathEvent } from "@robocode.dev/tank-royale-bot-api";
import { absoluteBearing, dist, normalizeRelative, toDeg } from "./src/geom.ts";
import { bulletSpeed } from "./src/physics.ts";
import { GameState } from "./src/gameState.ts";
import { Aimer } from "./src/aimer.ts";
import { KnnGun } from "./src/knnGun.ts";
import { Surfer } from "./src/surfer.ts";
import { HitRateTracker } from "./src/hitRate.ts";
import { BulletPowerSelector } from "./src/bulletPower.ts";
import { Shielder } from "./src/shielder.ts";

interface RealShot {
  fireTime: number;
  power: number;
  x: number;
  y: number;
  dir: number; // absolute bearing the bullet travels
}

class BcnBot extends Bot {
  // Bullet shielding is a situational alternative mode; surfing is the default
  // (and beats the simple shooters shielding would target, so it stays off).
  // Enable experimentally with the BCN_SHIELD=1 env var.
  private static readonly SHIELD_MODE =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.BCN_SHIELD === "1";

  private readonly gs = new GameState();
  private readonly aimer = new Aimer();
  private readonly gun = new KnnGun();
  private readonly myHit = new HitRateTracker();
  private readonly enemyHit = new HitRateTracker();
  private readonly surfer = new Surfer(this.enemyHit);
  private readonly shielder = new Shielder();
  private myShots: RealShot[] = [];

  static main(): void {
    new BcnBot().start();
  }

  override run(): void {
    // Body, gun and radar should move independently.
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);

    this.gs.arenaWidth = this.getArenaWidth();
    this.gs.arenaHeight = this.getArenaHeight();
    this.gs.onRoundStart();
    this.gun.onRoundStart();
    this.surfer.onRoundStart();
    this.myHit.initRound();
    this.enemyHit.initRound();
    this.shielder.onRoundStart();
    this.myShots = [];

    // Reacquire: keep sweeping the radar whenever we don't have a live lock.
    // While we can see the enemy, onScannedBot fires every turn and overrides
    // this with a tight lock, so this loop only runs when we've lost sight.
    while (this.isRunning()) {
      this.setMaxRadarTurnRate(45);
      this.turnRadarLeft(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent): void {
    // --- update world model ------------------------------------------------
    this.gs.arenaWidth = this.getArenaWidth();
    this.gs.arenaHeight = this.getArenaHeight();
    this.gs.updateMe({
      x: this.getX(),
      y: this.getY(),
      energy: this.getEnergy(),
      direction: this.getDirection(),
      speed: this.getSpeed(),
      gunHeat: this.getGunHeat(),
      time: this.getTurnNumber(),
    });
    this.gs.updateEnemy({
      x: e.x,
      y: e.y,
      energy: e.energy,
      direction: e.direction,
      speed: e.speed,
      time: this.getTurnNumber(),
    });

    const myX = this.getX();
    const myY = this.getY();
    const distance = dist(myX, myY, e.x, e.y);

    // Resolve our in-flight bullets that have reached the enemy (for hit rate).
    this.resolveMyShots(e.x, e.y);

    // --- radar: tight lock (overshoot the enemy so we re-cross it) ----------
    const radarAbs = absoluteBearing(myX, myY, e.x, e.y);
    const radarDelta = normalizeRelative(radarAbs - this.getRadarDirection());
    this.setTurnRadarLeft(radarDelta * 2);

    // --- bullet-shielding mode (alternative to surfing) --------------------
    if (BcnBot.SHIELD_MODE) {
      const s = this.shielder.update(this.gs, this.getGunHeat());
      this.setTurnLeft(normalizeRelative(s.bodyAim - this.getDirection()));
      this.setTurnGunLeft(normalizeRelative(s.gunAim - this.getGunDirection()));
      this.setForward(0);
      if (s.fire > 0 && this.getEnergy() > s.fire) this.setFire(s.fire);
      return;
    }

    // --- gun: GuessFactor KNN aim (circular gun as warm-up fallback) --------
    const power = BulletPowerSelector.best(
      this.myHit,
      this.enemyHit,
      this.getEnergy(),
      e.energy,
      distance,
      this.gs.lastEnemyBulletPower,
      this.getRoundNumber(),
    );
    // Always advance the KNN gun's learning; use its prediction once warmed up.
    const knnBearing = this.gun.aim(this.gs, power);
    let gunAbs: number;
    if (this.gun.hasData()) {
      gunAbs = knnBearing;
    } else {
      const solution = this.aimer.solve(this.gs, myX, myY);
      gunAbs = absoluteBearing(myX, myY, solution.aim.x, solution.aim.y);
    }
    const gunDelta = normalizeRelative(gunAbs - this.getGunDirection());
    this.setTurnGunLeft(gunDelta);

    const aimTolerance = toDeg(Math.atan2(18, Math.max(distance, 1)));
    if (this.getGunHeat() === 0 && this.getEnergy() > power && Math.abs(gunDelta) < aimTolerance) {
      if (this.setFire(power)) {
        this.myShots.push({ fireTime: this.getTurnNumber(), power, x: myX, y: myY, dir: gunAbs });
      }
    }

    // --- movement: wave surfing (bullet shadows from our in-flight shots) ---
    const cmd = this.surfer.update(this.gs, this.myShots);
    this.setMaxSpeed(cmd.maxSpeed);
    this.setTurnLeft(cmd.turn);
    this.setForward(cmd.drive);
  }

  /** Count our bullets that have reached the enemy toward our hit rate. */
  private resolveMyShots(enemyX: number, enemyY: number): void {
    const now = this.getTurnNumber();
    const remaining: RealShot[] = [];
    for (const s of this.myShots) {
      const radius = (now - s.fireTime) * bulletSpeed(s.power);
      if (radius >= dist(s.x, s.y, enemyX, enemyY)) {
        this.myHit.logShotPassed(s.power);
      } else {
        remaining.push(s);
      }
    }
    this.myShots = remaining;
  }

  override onBulletHitBot(e: BulletHitBotEvent): void {
    // Our bullet hit the enemy.
    this.myHit.logHit(e.damage);
  }

  override onHitByBullet(e: HitByBulletEvent): void {
    this.enemyHit.logHit(e.damage);
    this.surfer.onHitByBullet(e.bullet.power, this.getX(), this.getY(), this.getTurnNumber());
    // Learn the enemy's true bullet heading for the shielder's predictor.
    this.shielder.learnBullet(this.gs, e.bullet.direction);
  }

  override onWonRound(_e: WonRoundEvent): void {
    this.myHit.onRoundEnd(true);
    this.enemyHit.onRoundEnd(false);
  }

  override onDeath(_e: DeathEvent): void {
    this.myHit.onRoundEnd(false);
    this.enemyHit.onRoundEnd(true);
  }

  override onHitWall(_e: HitWallEvent): void {
    // Wall smoothing should prevent this; nothing extra to do.
  }

  override onHitBot(_e: HitBotEvent): void {
    // Surfing keeps distance; no special handling needed.
  }
}

BcnBot.main();
