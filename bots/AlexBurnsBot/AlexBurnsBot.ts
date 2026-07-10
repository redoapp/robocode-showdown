import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class AlexBurnsBot extends Bot {
  static main() {
    new AlexBurnsBot().start();
  }

  override run() {
    while (this.isRunning()) {
      this.forward(100);
      this.turnGunLeft(360);
      this.back(100);
      this.turnGunLeft(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    this.fire(1);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(90 - bearing);
  }

  override onHitWall(e: HitWallEvent) {
    this.back(50);
    this.turnRight(45);
  }
}

AlexBurnsBot.main();
