/**
 * SampleBot — the "hello world" of Robocode Tank Royale.
 *
 * This is a deliberately simple, heavily-commented starting point.
 * Copy it, rename it (use `npm run new-bot -- YourBotName` from the repo root),
 * and start experimenting.
 *
 * A bot is a tank with three independently-rotating parts:
 *   - body   (moves the tank, slowest to turn)
 *   - gun    (fires bullets, mounted on the body)
 *   - radar  (scans for enemies, mounted on the gun, fastest to turn)
 *
 * The game calls run() once at the start of each round. Everything else
 * happens in on<Event>() handlers that fire when things happen in the arena.
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class SampleBot extends Bot {
  // Entry point — the booter runs this file, which creates and starts the bot.
  static main() {
    new SampleBot().start();
  }

  // Called when a new round begins. Put your main loop here.
  override run() {
    // Loop until the round ends. If you leave run(), your bot can only
    // react via event handlers — so keep looping while isRunning() is true.
    while (this.isRunning()) {
      this.forward(100);
      this.turnGunLeft(360); // sweep the gun+radar all the way around to find enemies
      this.back(100);
      this.turnGunLeft(360);
    }
  }

  // Fires whenever our radar sweeps across an enemy. This is the ONLY time
  // we learn where an enemy is, so most bot logic lives here.
  override onScannedBot(e: ScannedBotEvent) {
    // fire(power): 0.1 (weak, fast, cheap) .. 3.0 (strong, slow, expensive).
    // Firing costs energy; hitting an enemy refunds 3x the power you spent.
    this.fire(1);
  }

  // Fires when an enemy bullet hits us — try to dodge by turning side-on.
  override onHitByBullet(e: HitByBulletEvent) {
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(90 - bearing);
  }

  // Fires when we drive into a wall — back away and turn so we don't get stuck.
  override onHitWall(e: HitWallEvent) {
    this.back(50);
    this.turnRight(45);
  }
}

SampleBot.main();
