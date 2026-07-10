/**
 * axiom — good luck!
 *
 * See docs/API_CHEATSHEET.md for the most useful methods and events.
 * Boot it locally: start the server in the Robocode GUI, then run this bot
 * from the GUI's bot list (or ./axiom.sh from a terminal).
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class Axiom extends Bot {
  static main() {
    new Axiom().start();
  }

  // Runs once at the start of each round. Your main loop goes here.
  override run() {
    while (this.isRunning()) {
      this.forward(100);
      this.turnGunLeft(360);
      this.back(100);
      this.turnGunLeft(360);
    }
  }

  // Fires when the radar sweeps across an enemy — this is when you shoot.
  override onScannedBot(e: ScannedBotEvent) {
    this.fire(1);
  }

  // Fires when an enemy bullet hits you — dodge!
  override onHitByBullet(e: HitByBulletEvent) {
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(90 - bearing);
  }

  // Fires when you drive into a wall.
  override onHitWall(e: HitWallEvent) {
    this.back(50);
    this.turnRight(45);
  }
}

Axiom.main();
