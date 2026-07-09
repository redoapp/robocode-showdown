/**
 * jbosley-bot — a simple duelist. Drives back and forth, keeps the radar
 * spinning, and fires straight at the last place it saw the enemy.
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class JbosleyBot extends Bot {
  static main(): void {
    new JbosleyBot().start();
  }

  override run(): void {
    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);

    while (this.isRunning()) {
      this.setTurnRadarRight(360);
      this.forward(120);
      this.turnRight(70);
      this.back(80);
      this.turnLeft(40);
    }
  }

  override onScannedBot(e: ScannedBotEvent): void {
    // Point the gun straight at where the enemy is right now and shoot.
    const angle = (Math.atan2(e.y - this.getY(), e.x - this.getX()) * 180) / Math.PI;
    let delta = angle - this.getGunDirection();
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    this.turnGunLeft(delta);
    if (this.getGunHeat() === 0 && this.getEnergy() > 2) {
      this.fire(2);
    }
  }

  override onHitByBullet(_e: HitByBulletEvent): void {
    // Shake it off with a little zigzag.
    this.setTurnRight(45);
    this.setForward(100);
  }

  override onHitWall(_e: HitWallEvent): void {
    this.setBack(80);
    this.setTurnRight(90);
  }
}

JbosleyBot.main();
