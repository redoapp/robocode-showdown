import {
  Bot,
  Color,
  HitByBulletEvent,
  ScannedBotEvent,
} from "@robocode.dev/tank-royale-bot-api";
import { type Context, initContext } from "./context.ts";
import { dequeueInputs, enqueueInputs } from "./input.ts";

const ENEMY_HISTORY_LENGTH = 5;
const ENEMY_HISTORY_MAX_AGE = 200;

class JoshmoodyBot extends Bot {
  static main() {
    new JoshmoodyBot().start();
  }

  private context: Context | null = null;

  // Runs once at the start of each round. Your main loop goes here.
  override run() {
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustGunForBodyTurn(true);
    this.setBodyColor(Color.DARK_GREEN);
    this.setTurretColor(Color.DARK_OLIVE_GREEN);
    this.setGunColor(Color.YELLOW_GREEN);
    this.setRadarColor(Color.MEDIUM_SEA_GREEN);
    this.setBulletColor(Color.LIGHT_GOLDENROD_YELLOW);
    this.setScanColor(Color.LIGHT_BLUE);
    const context = initContext(this);
    this.context = context;
    while (this.isRunning()) {
      context.graphics = this.getGraphics();
      enqueueInputs(context);
      dequeueInputs(context.inputQueues);
      this.go();
    }
  }

  // Fires when the radar sweeps across an enemy — this is when you shoot.
  override onScannedBot(e: ScannedBotEvent) {
    const oldEventHistory = this.context?.enemies.get(e.scannedBotId) ?? [];
    const truncatedOldEventHistory =
      oldEventHistory.length >= ENEMY_HISTORY_LENGTH
        ? oldEventHistory.slice(
            oldEventHistory.length - ENEMY_HISTORY_LENGTH + 1,
          )
        : oldEventHistory;
    const eventHistory = [...truncatedOldEventHistory, e].filter(
      (e) => this.getTurnNumber() - e.turnNumber < ENEMY_HISTORY_MAX_AGE,
    );
    this.context?.enemies.set(e.scannedBotId, eventHistory);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    if (this.context) this.context.hitByBullet = true;
  }
}

JoshmoodyBot.main();
