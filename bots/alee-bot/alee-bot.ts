import {
  Bot,
  BotDeathEvent,
  BulletFiredEvent,
  BulletHitBotEvent,
  BulletHitBulletEvent,
  DeathEvent,
  GameEndedEvent,
  HitByBulletEvent,
  HitWallEvent,
  RoundEndedEvent,
  ScannedBotEvent,
} from "@robocode.dev/tank-royale-bot-api";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CombatState, SelfState } from "./src/combat-state.js";
import { GunSystem } from "./src/gun-system.js";
import type { GunPlan } from "./src/gun-system.js";
import { GUESS_FACTOR_BINS, LearningSystem } from "./src/learning-system.js";
import { MovementSystem } from "./src/movement-system.js";
import { TargetRadarSystem } from "./src/target-radar-system.js";
import { TacticalPolicy } from "./src/tactical-policy.js";
import { TelemetryCollector } from "./src/telemetry.js";

const BOT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TRAINING_DIRECTORY = join(BOT_DIRECTORY, "training");

type MutableRoundDiagnostics = {
  scans: number;
  gunCoolScans: number;
  gunAlignedScans: number;
  gunBearingAbsoluteSum: number;
  fireRequestsAccepted: number;
  bulletsFired: number;
  bulletHits: number;
  bulletDamage: number;
  enemyBulletHits: number;
  enemyBulletDamage: number;
  inferredEnemyWaves: number;
  matchedEnemyWaves: number;
  resolvedRealWaves: number;
  resolvedVirtualWaves: number;
  movementModes: Record<string, number>;
  selectedGuns: Record<string, number>;
};

const emptyDiagnostics = (): MutableRoundDiagnostics => ({
  scans: 0,
  gunCoolScans: 0,
  gunAlignedScans: 0,
  gunBearingAbsoluteSum: 0,
  fireRequestsAccepted: 0,
  bulletsFired: 0,
  bulletHits: 0,
  bulletDamage: 0,
  enemyBulletHits: 0,
  enemyBulletDamage: 0,
  inferredEnemyWaves: 0,
  matchedEnemyWaves: 0,
  resolvedRealWaves: 0,
  resolvedVirtualWaves: 0,
  movementModes: {},
  selectedGuns: {},
});

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

class AleeBot extends Bot {
  private readonly combat = new CombatState();
  private readonly learning = new LearningSystem();
  private readonly gun = new GunSystem(this.learning);
  private readonly movement = new MovementSystem();
  private readonly targetRadar = new TargetRadarSystem();
  private readonly tacticalPolicy = new TacticalPolicy();
  private readonly telemetry = new TelemetryCollector(TRAINING_DIRECTORY, process.env.GUESS_FACTOR_COLLECT === "1");
  private diagnostics = emptyDiagnostics();
  private pendingShot: GunPlan | undefined;

  static main() {
    new AleeBot().start();
  }

  override run() {
    this.combat.resetRound(this.getRoundNumber());
    this.movement.resetRound();
    this.targetRadar.resetRound();
    this.tacticalPolicy.resetRound();
    this.diagnostics = emptyDiagnostics();
    this.pendingShot = undefined;
    try {
      this.learning.loadChampion(BOT_DIRECTORY);
    } catch (error) {
      console.error(`AleeBot: champion rejected; using statistical fallback. ${String(error)}`);
    }
    try {
      this.tacticalPolicy.load();
    } catch (error) {
      console.error(`AleeBot: tactical policy rejected; using deterministic default. ${String(error)}`);
    }

    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);
    this.setMaxSpeed(8);

    while (this.isRunning()) this.turnRadarRight(360);
  }

  override onScannedBot(event: ScannedBotEvent) {
    this.diagnostics.scans += 1;
    const self = this.selfState(event.turnNumber);
    const update = this.combat.observeScan({
      turnNumber: event.turnNumber,
      scannedBotId: event.scannedBotId,
      energy: event.energy,
      x: event.x,
      y: event.y,
      direction: event.direction,
      speed: event.speed,
    }, GUESS_FACTOR_BINS, self);
    this.diagnostics.inferredEnemyWaves += update.inferredEnemyWaves.length;

    for (const outcome of update.resolvedWaves) {
      this.gun.observeOutcome(outcome);
      if (outcome.wave.kind === "real") this.diagnostics.resolvedRealWaves += 1;
      else this.diagnostics.resolvedVirtualWaves += 1;
      if (outcome.wave.collectForTraining) this.telemetry.record(self.roundNumber, outcome);
    }

    const targetId = this.targetRadar.selectTarget(this.combat, self);
    this.setTurnRadarLeft(this.targetRadar.radarTurn(self, update.opponent));
    if (targetId !== update.opponent.id) return;

    const tactic = this.tacticalPolicy.decide(self, update.opponent);
    const gunPlan = this.gun.plan(this.combat, self, update.opponent, tactic.powerBias);
    increment(this.diagnostics.selectedGuns, gunPlan.selectedGun);
    this.diagnostics.gunBearingAbsoluteSum += Math.abs(gunPlan.gunBearing);
    if (this.getGunHeat() === 0) this.diagnostics.gunCoolScans += 1;
    if (Math.abs(gunPlan.gunBearing) < 7) this.diagnostics.gunAlignedScans += 1;
    this.setTurnGunLeft(gunPlan.gunBearing);
    // A virtual wave on every target scan provides dense, correctly framed data.
    for (const wave of this.gun.virtualWaveInputs(gunPlan, self)) this.combat.createFriendlyWave(wave);
    if (this.gun.shouldFire(self, gunPlan, this.getGunHeat()) && this.setFire(gunPlan.bulletPower)) {
      this.pendingShot = gunPlan;
      this.diagnostics.fireRequestsAccepted += 1;
    }

    const movementPlan = this.movement.plan(self, update.opponent, this.combat, tactic);
    increment(this.diagnostics.movementModes, movementPlan.mode);
    this.setTurnLeft(movementPlan.turnLeft);
    this.setForward(movementPlan.forward);
  }

  override onBulletFired(event: BulletFiredEvent) {
    this.diagnostics.bulletsFired += 1;
    const plan = this.pendingShot;
    this.pendingShot = undefined;
    if (!plan) return;
    const opponent = this.combat.getOpponent(plan.opponentId);
    if (!opponent) return;
    const self = this.selfState(event.turnNumber);
    this.combat.createFriendlyWave(this.gun.actualWaveInput(plan, self, opponent, {
      turnNumber: event.turnNumber,
      x: event.bullet.x,
      y: event.bullet.y,
      direction: event.bullet.direction,
      power: event.bullet.power,
    }));
  }

  override onHitByBullet(event: HitByBulletEvent) {
    const resolved = this.combat.resolveEnemyBullet(
      event.turnNumber,
      event.bullet.ownerId,
      event.bullet.power,
      { x: event.bullet.x, y: event.bullet.y },
    );
    this.diagnostics.enemyBulletHits += 1;
    this.diagnostics.enemyBulletDamage += event.damage;
    if (resolved) {
      this.diagnostics.matchedEnemyWaves += 1;
      this.movement.observeEnemyWaveHit(resolved);
    }
    this.movement.onHitByBullet();
  }

  override onBulletHitBullet(event: BulletHitBulletEvent) {
    const enemyBullet = event.bullet.ownerId === this.getMyId() ? event.hitBullet : event.bullet;
    if (enemyBullet.ownerId === this.getMyId()) return;
    const resolved = this.combat.resolveEnemyBullet(
      event.turnNumber,
      enemyBullet.ownerId,
      enemyBullet.power,
      { x: enemyBullet.x, y: enemyBullet.y },
    );
    if (resolved) {
      this.diagnostics.matchedEnemyWaves += 1;
      this.movement.observeEnemyWaveHit(resolved, 0.5);
    }
  }

  override onBulletHitBot(event: BulletHitBotEvent) {
    if (event.bullet.ownerId === this.getMyId()) {
      this.diagnostics.bulletHits += 1;
      this.diagnostics.bulletDamage += event.damage;
      this.combat.recordKnownEnergyLoss(event.victimId, event.turnNumber, event.damage);
    }
  }

  override onHitWall(_event: HitWallEvent) {
    this.movement.onHitWall();
    this.setForward(-80);
  }

  override onBotDeath(event: BotDeathEvent) {
    this.combat.removeOpponent(event.victimId);
    this.gun.removeOpponent(event.victimId);
    this.movement.removeOpponent(event.victimId);
    this.targetRadar.removeOpponent(event.victimId);
  }

  override onRoundEnded(event: RoundEndedEvent) {
    this.telemetry.recordRound({
      roundNumber: event.roundNumber,
      endTurn: event.turnNumber,
      ...this.diagnostics,
    });
    this.telemetry.flush();
  }

  override onDeath(_event: DeathEvent) {
    this.telemetry.flush();
  }

  override onGameEnded(_event: GameEndedEvent) {
    this.telemetry.flush();
    this.learning.dispose();
  }

  private selfState(turnNumber: number): SelfState {
    return Object.freeze({
      roundNumber: this.getRoundNumber(),
      turnNumber,
      botId: this.getMyId(),
      x: this.getX(),
      y: this.getY(),
      direction: this.getDirection(),
      gunDirection: this.getGunDirection(),
      radarDirection: this.getRadarDirection(),
      speed: this.getSpeed(),
      energy: this.getEnergy(),
      arenaWidth: this.getArenaWidth(),
      arenaHeight: this.getArenaHeight(),
      enemyCount: this.getEnemyCount(),
    });
  }
}

AleeBot.main();
