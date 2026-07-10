/**
 * landen-bot — good luck!
 *
 * See docs/API_CHEATSHEET.md for the most useful methods and events.
 * Boot it locally: start the server in the Robocode GUI, then run this bot
 * from the GUI's bot list (or ./landen-bot.sh from a terminal).
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

const FIELD_MARGIN = 42;
const WALL_MARGIN = 95;
const MAX_FIREPOWER = 3;
const MIN_FIREPOWER = 1.1;

const normalizeRelative = (angle: number) => {
  let normalized = ((angle + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
};

const toRadians = (degrees: number) => degrees * Math.PI / 180;

const toDegrees = (radians: number) => radians * 180 / Math.PI;

const absoluteBearing = (fromX: number, fromY: number, toX: number, toY: number) => {
  const angle = toDegrees(Math.atan2(toY - fromY, toX - fromX));
  return (angle + 360) % 360;
};

const distance = (fromX: number, fromY: number, toX: number, toY: number) => {
  return Math.hypot(toX - fromX, toY - fromY);
};

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

class LandenBot extends Bot {
  private moveDirection = 1;
  private scans = 0;
  private lastEnemyEnergy = 100;

  static main() {
    new LandenBot().start();
  }

  override run() {
    this.moveDirection = 1;
    this.scans = 0;
    this.lastEnemyEnergy = 100;

    while (this.isRunning()) {
      this.forward(109);
      this.turnGunLeft(360);
      this.back(90);
      this.turnGunLeft(360);
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    this.scans++;
    this.fire(0.95);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    this.moveDirection *= -1;
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(70 - bearing);
    this.forward(120 * this.moveDirection);
  }

  override onHitWall(e: HitWallEvent) {
    this.moveDirection *= -1;
    this.back(90);
    this.turnRight(55);
  }

  private orbit(enemyBearing: number, enemyDistance: number) {
    const nearWall = this.x < WALL_MARGIN ||
      this.x > this.arenaWidth - WALL_MARGIN ||
      this.y < WALL_MARGIN ||
      this.y > this.arenaHeight - WALL_MARGIN;
    const preferredOffset = enemyDistance < 190 ? 118 : enemyDistance > 520 ? 58 : 88;
    const orbitDirection = this.moveDirection > 0 ? preferredOffset : -preferredOffset;
    const targetHeading = nearWall
      ? absoluteBearing(this.x, this.y, this.arenaWidth / 2, this.arenaHeight / 2)
      : (enemyBearing + orbitDirection + 360) % 360;
    const turn = normalizeRelative(targetHeading - this.direction);

    if (turn >= 0) {
      this.turnLeft(turn);
    } else {
      this.turnRight(-turn);
    }

    this.forward(nearWall ? 150 : 92);
  }

}

LandenBot.main();
