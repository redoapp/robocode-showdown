/**
 * landen-bot — good luck!
 *
 * See docs/API_CHEATSHEET.md for the most useful methods and events.
 * Boot it locally: start the server in the Robocode GUI, then run this bot
 * from the GUI's bot list (or ./landen-bot.sh from a terminal).
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class LandenBot extends Bot {
  private moveDirection = 1;

  static main() {
    new LandenBot().start();
  }

  override run() {
    this.moveDirection = 1;

    while (this.isRunning()) {
      this.forward(98);
      this.turnGunLeft(360);
      this.back(102);
      this.turnGunLeft(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    this.fire(1);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    this.moveDirection *= -1;
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(80 - bearing);
  }

  override onHitWall(e: HitWallEvent) {
    this.moveDirection *= -1;
    this.back(75);
    this.turnRight(45);
  }
}

LandenBot.main();
