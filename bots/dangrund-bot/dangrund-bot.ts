import {
  Bot,
  BotDeathEvent,
  BulletFiredEvent,
  BulletHitBotEvent,
  HitBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  RoundEndedEvent,
  ScannedBotEvent,
} from "@robocode.dev/tank-royale-bot-api";

const WALL_MARGIN = 55;
const MOVE_PROJECTION = 140;
const GUN_BINS = 31;
const GUN_MIDDLE = (GUN_BINS - 1) / 2;
const DISTANCE_SEGMENTS = 3;
const LATERAL_SEGMENTS = 3;
const LEARNING_FIREPOWER = 1.55;
const GUN_ROLLING_WINDOW = 32;
const SURF_BINS = 47;
const SURF_MIDDLE = (SURF_BINS - 1) / 2;
const SURF_ROLLING_WINDOW = 32;

type GunBuffer = number[];

interface GunWave {
  sourceX: number;
  sourceY: number;
  fireTurn: number;
  bulletSpeed: number;
  directBearing: number;
  lateralDirection: number;
  maxEscapeAngle: number;
  buffer: GunBuffer;
}

interface EnemyWave {
  sourceX: number;
  sourceY: number;
  fireTurn: number;
  bulletSpeed: number;
  directBearing: number;
  lateralDirection: number;
  maxEscapeAngle: number;
}

interface MeleeEnemy {
  id: number;
  x: number;
  y: number;
  energy: number;
  direction: number;
  speed: number;
  turnRate: number;
  seenTurn: number;
}

const normalizeBearing = (angle: number) => {
  let normalized = angle % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
};

const clamp = (minimum: number, value: number, maximum: number) =>
  Math.max(minimum, Math.min(value, maximum));

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

const directionTo = (fromX: number, fromY: number, toX: number, toY: number) =>
  toDegrees(Math.atan2(toY - fromY, toX - fromX));

const newGunStats = (): GunBuffer[][][][] =>
  Array.from({ length: DISTANCE_SEGMENTS }, () =>
    Array.from({ length: LATERAL_SEGMENTS }, () =>
      Array.from({ length: LATERAL_SEGMENTS }, () =>
        Array.from({ length: GUN_BINS }, () => 0),
      ),
    ),
  );

class DangrundBot extends Bot {
  private moveDirection = 1;
  private lastDirectionChange = -100;
  private previousEnemyDirection?: number;
  private enemyTurnRate = 0;
  private stationaryScans = 0;
  private movingScans = 0;
  private turningScans = 0;
  private firedDuringStop = false;
  private lastStationaryShot = -100;
  private shots = 0;
  private hits = 0;
  private hitsTaken = 0;
  private lastShotTurn = 0;
  private lastEnemyLateralSpeed = 0;
  private lateralDirection = 1;
  private gunStats = newGunStats();
  private gunWaves: GunWave[] = [];
  private nextDirectionChange = 55;
  private previousEnemyEnergy?: number;
  private previousEnemyX?: number;
  private previousEnemyY?: number;
  private surfDirections: number[] = [];
  private surfBearings: number[] = [];
  private enemyWaves: EnemyWave[] = [];
  private surfStats = Array.from({ length: SURF_BINS }, () => 0);
  private meleeMode = false;
  private meleeEnemies = new Map<number, MeleeEnemy>();
  private meleeDestinationX = 400;
  private meleeDestinationY = 300;
  private meleePlanTurn = -100;

  static main() {
    new DangrundBot().start();
  }

  override run() {
    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);

    while (this.isRunning()) {
      if (this.getEnemyCount() > 1 || this.meleeMode) {
        this.meleeMode = true;
        this.runMeleeTurn();
        this.go();
      } else {
        this.turnRadarRight(360);
      }
    }
  }

  override onScannedBot(event: ScannedBotEvent) {
    if (this.getEnemyCount() > 1 || this.meleeMode) {
      this.meleeMode = true;
      this.recordMeleeScan(event);
      return;
    }

    this.updateGunWaves(event);
    this.trackEnemyFire(event);
    this.updateEnemyWaves(event.turnNumber);

    if (this.previousEnemyDirection !== undefined) {
      const observedTurnRate = normalizeBearing(
        event.direction - this.previousEnemyDirection,
      );
      if (Math.abs(observedTurnRate) > 0.5) this.turningScans += 1;
      this.enemyTurnRate = this.enemyTurnRate * 0.7 + observedTurnRate * 0.3;
    }
    this.previousEnemyDirection = event.direction;

    if (Math.abs(event.speed) < 0.5) {
      this.stationaryScans += 1;
    } else {
      this.movingScans += 1;
      this.firedDuringStop = false;
    }
    const distance = this.distanceTo(event.x, event.y);
    const radarBearing = this.radarBearingTo(event.x, event.y);
    this.setTurnRadarLeft(radarBearing * 2);

    this.moveAround(event, distance);
    this.aimAndFire(event, distance);
  }

  override onHitByBullet(event: HitByBulletEvent) {
    this.hitsTaken += 1;
    if (this.meleeMode) {
      this.meleePlanTurn = -100;
      return;
    }
    this.recordSurfHit(event);
    if (!this.isAdvancedTarget()) this.reverseDirection(event.turnNumber);
  }

  override onHitWall(event: HitWallEvent) {
    if (this.meleeMode) {
      this.meleePlanTurn = -100;
      this.meleeDestinationX = this.getArenaWidth() / 2;
      this.meleeDestinationY = this.getArenaHeight() / 2;
    }
    this.reverseDirection(event.turnNumber);
    this.setForward(160 * this.moveDirection);
  }

  override onHitBot(_event: HitBotEvent) {
    if (this.meleeMode) this.meleePlanTurn = -100;
    this.setForward(120 * this.moveDirection);
  }

  override onBulletFired(event: BulletFiredEvent) {
    this.shots += 1;
    this.lastShotTurn = event.turnNumber;
  }

  override onBulletHitBot(event: BulletHitBotEvent) {
    this.hits += 1;
    if (this.meleeMode) {
      const enemy = this.meleeEnemies.get(event.victimId);
      if (enemy !== undefined) enemy.energy = event.energy;
      return;
    }
    this.previousEnemyEnergy = event.energy;
  }

  override onBotDeath(event: BotDeathEvent) {
    this.meleeEnemies.delete(event.victimId);
  }

  override onRoundEnded(_event: RoundEndedEvent) {
    this.shots = 0;
    this.hits = 0;
    this.hitsTaken = 0;
    this.stationaryScans = 0;
    this.movingScans = 0;
    this.turningScans = 0;
    this.firedDuringStop = false;
    this.lastStationaryShot = -100;
    this.previousEnemyDirection = undefined;
    this.enemyTurnRate = 0;
    this.lastShotTurn = 0;
    this.lastEnemyLateralSpeed = 0;
    this.lateralDirection = 1;
    this.gunWaves = [];
    this.nextDirectionChange = 35 + Math.floor(Math.random() * 45);
    this.lastDirectionChange = -100;
    this.previousEnemyEnergy = undefined;
    this.previousEnemyX = undefined;
    this.previousEnemyY = undefined;
    this.surfDirections = [];
    this.surfBearings = [];
    this.enemyWaves = [];
    this.meleeMode = false;
    this.meleeEnemies.clear();
    this.meleeDestinationX = this.getArenaWidth() / 2;
    this.meleeDestinationY = this.getArenaHeight() / 2;
    this.meleePlanTurn = -100;
  }

  private reverseDirection(turnNumber: number) {
    if (turnNumber - this.lastDirectionChange < 45) return;
    this.moveDirection *= -1;
    this.lastDirectionChange = turnNumber;
  }

  private moveAround(event: ScannedBotEvent, distance: number) {
    const absoluteBearing = toDegrees(
      Math.atan2(event.y - this.getY(), event.x - this.getX()),
    );
    const stopAndGoTarget = this.isStopAndGoTarget();
    const advancedTarget = this.observationCount() >= 20 && !stopAndGoTarget;

    if (advancedTarget && event.turnNumber >= this.nextDirectionChange) {
      this.reverseDirection(event.turnNumber);
      this.nextDirectionChange =
        event.turnNumber + 38 + Math.floor(Math.random() * 55);
    }

    const surfWave = advancedTarget ? this.closestSurfableWave() : undefined;
    if (surfWave !== undefined) {
      this.driveAtAngle(this.surfAngle(surfWave), 220);
      return;
    }

    const preferredDistance = stopAndGoTarget
      ? this.hitsTaken >= 3
        ? 300
        : 105
      : 520;
    const distanceCorrection = Math.max(
      -25,
      Math.min(50, (distance - preferredDistance) / 6),
    );
    let velocityAngle = this.isTargetingStalled()
      ? absoluteBearing
      : absoluteBearing + this.moveDirection * (90 - distanceCorrection);
    velocityAngle = this.wallSmoothedAngle(velocityAngle, this.moveDirection);
    this.driveAtAngle(velocityAngle, 220);
  }

  private driveAtAngle(velocityAngle: number, distance: number) {
    let turn = normalizeBearing(velocityAngle - this.getDirection());
    let driveDistance = distance;
    if (Math.abs(turn) > 90) {
      turn = normalizeBearing(turn + 180);
      driveDistance *= -1;
    }
    this.setTurnLeft(turn);
    this.setForward(driveDistance);
    this.setMaxSpeed(Math.abs(turn) > 35 ? 5.5 : 8);
  }

  private recordMeleeScan(event: ScannedBotEvent) {
    const previous = this.meleeEnemies.get(event.scannedBotId);
    const elapsed = Math.max(
      1,
      event.turnNumber - (previous?.seenTurn ?? event.turnNumber - 1),
    );
    const observedTurnRate =
      previous === undefined
        ? 0
        : normalizeBearing(event.direction - previous.direction) / elapsed;
    const turnRate =
      previous === undefined
        ? 0
        : previous.turnRate * 0.65 + observedTurnRate * 0.35;
    this.meleeEnemies.set(event.scannedBotId, {
      id: event.scannedBotId,
      x: event.x,
      y: event.y,
      energy: event.energy,
      direction: event.direction,
      speed: event.speed,
      turnRate,
      seenTurn: event.turnNumber,
    });
  }

  private runMeleeTurn() {
    const turn = this.getTurnNumber();
    for (const [id, enemy] of this.meleeEnemies) {
      if (turn - enemy.seenTurn > 45) this.meleeEnemies.delete(id);
    }

    this.setTurnRadarLeft(45);
    const enemies = [...this.meleeEnemies.values()];
    if (enemies.length === 0) {
      this.setTurnLeft(8);
      this.setForward(120);
      return;
    }

    if (
      turn - this.meleePlanTurn >= 10 ||
      this.distanceTo(this.meleeDestinationX, this.meleeDestinationY) < 45
    ) {
      this.planMeleeDestination(enemies);
      this.meleePlanTurn = turn;
    }

    this.driveAtAngle(
      directionTo(
        this.getX(),
        this.getY(),
        this.meleeDestinationX,
        this.meleeDestinationY,
      ),
      180,
    );
    this.aimMeleeGun(enemies);
  }

  private planMeleeDestination(enemies: MeleeEnemy[]) {
    const margin = 65;
    const width = this.getArenaWidth();
    const height = this.getArenaHeight();
    const baseAngle = Math.random() * 360;
    let bestRisk = Number.POSITIVE_INFINITY;

    for (let i = 0; i < 24; i += 1) {
      const angle = baseAngle + i * 15;
      const radius = 150 + Math.random() * 110;
      const x = clamp(
        margin,
        this.getX() + Math.cos(toRadians(angle)) * radius,
        width - margin,
      );
      const y = clamp(
        margin,
        this.getY() + Math.sin(toRadians(angle)) * radius,
        height - margin,
      );
      let risk = 0;

      for (const enemy of enemies) {
        const distanceSquared = Math.max(
          900,
          (x - enemy.x) ** 2 + (y - enemy.y) ** 2,
        );
        risk += (enemy.energy + 75) / distanceSquared;
        if (distanceSquared < 170 ** 2) {
          risk += (170 ** 2 - distanceSquared) / 200000;
        }
      }

      const wallDistance = Math.min(x, y, width - x, height - y);
      risk += 8 / Math.max(20, wallDistance) ** 2;
      const centerDistanceSquared =
        (x - width / 2) ** 2 + (y - height / 2) ** 2;
      risk += 12 / Math.max(10000, centerDistanceSquared);

      if (risk < bestRisk) {
        bestRisk = risk;
        this.meleeDestinationX = x;
        this.meleeDestinationY = y;
      }
    }
  }

  private aimMeleeGun(enemies: MeleeEnemy[]) {
    const turn = this.getTurnNumber();
    const target = enemies.reduce((best, enemy) => {
      const score =
        this.distanceTo(enemy.x, enemy.y) +
        enemy.energy * 3 +
        (turn - enemy.seenTurn) * 25;
      const bestScore =
        this.distanceTo(best.x, best.y) +
        best.energy * 3 +
        (turn - best.seenTurn) * 25;
      return score < bestScore ? enemy : best;
    });
    const distance = this.distanceTo(target.x, target.y);
    if (turn - target.seenTurn > 8 || distance > 760) return;

    const power = this.meleeFirepower(distance, target.energy);
    const bulletSpeed = 20 - 3 * power;
    let x = target.x;
    let y = target.y;
    let heading = target.direction;
    for (let tick = 1; tick <= 70; tick += 1) {
      heading += target.turnRate;
      x = clamp(
        18,
        x + Math.cos(toRadians(heading)) * target.speed,
        this.getArenaWidth() - 18,
      );
      y = clamp(
        18,
        y + Math.sin(toRadians(heading)) * target.speed,
        this.getArenaHeight() - 18,
      );
      if (tick * bulletSpeed >= this.distanceTo(x, y)) break;
    }

    const gunBearing = normalizeBearing(
      directionTo(this.getX(), this.getY(), x, y) - this.getGunDirection(),
    );
    this.setTurnGunLeft(gunBearing);
    const tolerance = toDegrees(Math.atan2(18, Math.max(1, distance))) + 0.5;
    if (
      this.getGunHeat() === 0 &&
      Math.abs(gunBearing) <= tolerance &&
      this.getEnergy() > power + 0.5
    ) {
      this.setFire(power);
    }
  }

  private meleeFirepower(distance: number, targetEnergy: number) {
    let power = distance < 180 ? 3 : distance < 500 ? 2.3 : 1.4;
    if (this.getEnergy() < 25) power = Math.min(power, 1);
    if (this.getEnergy() < 10) power = Math.min(power, 0.4);
    if (targetEnergy < 10) power = Math.min(power, targetEnergy / 4 + 0.1);
    return clamp(0.1, power, 3);
  }

  private trackEnemyFire(event: ScannedBotEvent) {
    const bearingEnemyToMe = directionTo(
      event.x,
      event.y,
      this.getX(),
      this.getY(),
    );
    const lateralSpeed =
      this.getSpeed() *
      Math.sin(toRadians(this.getDirection() - bearingEnemyToMe));
    this.surfDirections.unshift(lateralSpeed < 0 ? -1 : 1);
    this.surfBearings.unshift(bearingEnemyToMe);
    this.surfDirections.length = Math.min(this.surfDirections.length, 8);
    this.surfBearings.length = Math.min(this.surfBearings.length, 8);

    if (
      this.previousEnemyEnergy !== undefined &&
      this.previousEnemyX !== undefined &&
      this.previousEnemyY !== undefined
    ) {
      const firepower = this.previousEnemyEnergy - event.energy;
      if (
        firepower >= 0.1 &&
        firepower <= 3.01 &&
        this.surfDirections.length > 2
      ) {
        const bulletSpeed = 20 - 3 * firepower;
        this.enemyWaves.push({
          sourceX: this.previousEnemyX,
          sourceY: this.previousEnemyY,
          fireTurn: Math.max(0, event.turnNumber - 1),
          bulletSpeed,
          directBearing: this.surfBearings[2],
          lateralDirection: this.surfDirections[2],
          maxEscapeAngle: toDegrees(Math.asin(8 / bulletSpeed)),
        });
      }
    }

    this.previousEnemyEnergy = event.energy;
    this.previousEnemyX = event.x;
    this.previousEnemyY = event.y;
  }

  private updateEnemyWaves(turnNumber: number) {
    this.enemyWaves = this.enemyWaves.filter((wave) => {
      const traveled = (turnNumber - wave.fireTurn) * wave.bulletSpeed;
      return (
        traveled <=
        Math.hypot(this.getX() - wave.sourceX, this.getY() - wave.sourceY) + 55
      );
    });
  }

  private closestSurfableWave() {
    let closest: EnemyWave | undefined;
    let closestRemaining = Number.POSITIVE_INFINITY;
    for (const wave of this.enemyWaves) {
      const traveled =
        (this.getTurnNumber() - wave.fireTurn) * wave.bulletSpeed;
      const remaining =
        Math.hypot(this.getX() - wave.sourceX, this.getY() - wave.sourceY) -
        traveled;
      if (
        remaining > wave.bulletSpeed &&
        remaining < closestRemaining
      ) {
        closest = wave;
        closestRemaining = remaining;
      }
    }
    return closest;
  }

  private surfAngle(wave: EnemyWave) {
    const leftDanger = this.surfDanger(wave, -1);
    const rightDanger = this.surfDanger(wave, 1);
    const direction = leftDanger < rightDanger ? -1 : 1;
    const bearing = directionTo(
      wave.sourceX,
      wave.sourceY,
      this.getX(),
      this.getY(),
    );
    return this.wallSmoothedAngle(bearing + direction * 90, direction);
  }

  private surfDanger(wave: EnemyWave, direction: number) {
    const predicted = this.predictSurfPosition(wave, direction);
    return this.surfStats[this.surfFactorIndex(wave, predicted.x, predicted.y)];
  }

  private predictSurfPosition(wave: EnemyWave, direction: number) {
    let x = this.getX();
    let y = this.getY();
    let speed = this.getSpeed();
    let heading = this.getDirection();

    for (let tick = 1; tick <= 120; tick += 1) {
      const bearing = directionTo(wave.sourceX, wave.sourceY, x, y);
      const desired = this.wallSmoothedAngleFrom(
        x,
        y,
        bearing + direction * 90,
        direction,
      );
      let turn = normalizeBearing(desired - heading);
      let driveDirection = 1;
      if (Math.abs(turn) > 90) {
        turn = normalizeBearing(turn + 180);
        driveDirection = -1;
      }

      const maxTurn = 10 - 0.75 * Math.abs(speed);
      heading = normalizeBearing(heading + clamp(-maxTurn, turn, maxTurn));
      speed += speed * driveDirection < 0 ? 2 * driveDirection : driveDirection;
      speed = clamp(-8, speed, 8);
      x = clamp(
        WALL_MARGIN,
        x + Math.cos(toRadians(heading)) * speed,
        this.getArenaWidth() - WALL_MARGIN,
      );
      y = clamp(
        WALL_MARGIN,
        y + Math.sin(toRadians(heading)) * speed,
        this.getArenaHeight() - WALL_MARGIN,
      );

      const bulletDistance =
        (this.getTurnNumber() - wave.fireTurn + tick) * wave.bulletSpeed;
      if (
        Math.hypot(x - wave.sourceX, y - wave.sourceY) <
        bulletDistance + wave.bulletSpeed
      ) {
        break;
      }
    }
    return { x, y };
  }

  private surfFactorIndex(wave: EnemyWave, x: number, y: number) {
    const bearing = directionTo(wave.sourceX, wave.sourceY, x, y);
    const offset = normalizeBearing(bearing - wave.directBearing);
    const factor = clamp(
      -1,
      offset / (wave.lateralDirection * wave.maxEscapeAngle),
      1,
    );
    return Math.round(factor * SURF_MIDDLE + SURF_MIDDLE);
  }

  private recordSurfHit(event: HitByBulletEvent) {
    const hitWave = this.enemyWaves.find((wave) => {
      const traveled =
        (event.turnNumber - wave.fireTurn) * wave.bulletSpeed;
      const distance = Math.hypot(
        this.getX() - wave.sourceX,
        this.getY() - wave.sourceY,
      );
      return (
        Math.abs(traveled - distance) < 60 &&
        Math.abs(wave.bulletSpeed - event.bullet.speed) < 0.01
      );
    });
    if (hitWave === undefined) return;

    const index = this.surfFactorIndex(
      hitWave,
      event.bullet.x,
      event.bullet.y,
    );
    for (let i = 0; i < SURF_BINS; i += 1) {
      this.surfStats[i] *= 1 - 1 / SURF_ROLLING_WINDOW;
      this.surfStats[i] += 1 / ((index - i) ** 2 + 1);
    }
    this.enemyWaves = this.enemyWaves.filter((wave) => wave !== hitWave);
  }

  private wallSmoothedAngleFrom(
    x: number,
    y: number,
    angle: number,
    orientation: number,
  ) {
    let candidate = angle;
    for (let i = 0; i < 72; i += 1) {
      const projectedX = x + Math.cos(toRadians(candidate)) * MOVE_PROJECTION;
      const projectedY = y + Math.sin(toRadians(candidate)) * MOVE_PROJECTION;
      if (
        projectedX >= WALL_MARGIN &&
        projectedX <= this.getArenaWidth() - WALL_MARGIN &&
        projectedY >= WALL_MARGIN &&
        projectedY <= this.getArenaHeight() - WALL_MARGIN
      ) {
        return candidate;
      }
      candidate += orientation * 5;
    }
    return directionTo(x, y, this.getArenaWidth() / 2, this.getArenaHeight() / 2);
  }

  private wallSmoothedAngle(angle: number, orientation: number) {
    let candidate = angle;
    for (let i = 0; i < 72; i += 1) {
      const radians = toRadians(candidate);
      const projectedX = this.getX() + Math.cos(radians) * MOVE_PROJECTION;
      const projectedY = this.getY() + Math.sin(radians) * MOVE_PROJECTION;
      if (
        projectedX >= WALL_MARGIN &&
        projectedX <= this.getArenaWidth() - WALL_MARGIN &&
        projectedY >= WALL_MARGIN &&
        projectedY <= this.getArenaHeight() - WALL_MARGIN
      ) {
        return candidate;
      }
      candidate += orientation * 5;
    }
    return candidate;
  }

  private aimAndFire(event: ScannedBotEvent, distance: number) {
    const targetIsStationary = Math.abs(event.speed) < 0.5;
    const power = this.firepowerFor(distance, event.energy, targetIsStationary);
    const directBearing = directionTo(
      this.getX(),
      this.getY(),
      event.x,
      event.y,
    );
    const stopAndGoTarget = this.isStopAndGoTarget();
    const useLearningGun =
      this.observationCount() >= 20 &&
      !stopAndGoTarget &&
      !this.isTargetingStalled();
    let aimDirection = directBearing;
    let gunBuffer: GunBuffer | undefined;

    if (useLearningGun) {
      const lateralSpeed =
        event.speed * Math.sin(toRadians(event.direction - directBearing));
      if (Math.abs(lateralSpeed) > 0.1) {
        this.lateralDirection = lateralSpeed < 0 ? -1 : 1;
      }
      gunBuffer = this.gunBuffer(
        distance,
        lateralSpeed,
        this.lastEnemyLateralSpeed,
      );
      this.lastEnemyLateralSpeed = lateralSpeed;
      const bulletSpeed = 20 - 3 * power;
      const maxEscapeAngle = toDegrees(Math.asin(8 / bulletSpeed));
      aimDirection +=
        this.lateralDirection *
        this.bestGuessFactor(gunBuffer) *
        maxEscapeAngle;
    } else if (!targetIsStationary && !this.isTargetingStalled()) {
      const bulletSpeed = 20 - 3 * power;
      let aimX = event.x;
      let aimY = event.y;
      let predictedDirection = event.direction;
      let flightTime = 0;
      while (
        flightTime < 100 &&
        flightTime * bulletSpeed < this.distanceTo(aimX, aimY)
      ) {
        flightTime += 1;
        predictedDirection += this.enemyTurnRate;
        aimX += Math.cos(toRadians(predictedDirection)) * event.speed;
        aimY += Math.sin(toRadians(predictedDirection)) * event.speed;
        aimX = Math.max(20, Math.min(this.getArenaWidth() - 20, aimX));
        aimY = Math.max(20, Math.min(this.getArenaHeight() - 20, aimY));
      }
      aimDirection = directionTo(this.getX(), this.getY(), aimX, aimY);
    }

    const gunBearing = normalizeBearing(aimDirection - this.getGunDirection());
    this.setTurnGunLeft(gunBearing);
    const shouldFire = stopAndGoTarget
      ? targetIsStationary &&
        (!this.firedDuringStop ||
          event.turnNumber - this.lastStationaryShot >= 30)
      : distance < 700;
    if (
      Math.abs(gunBearing) <= (targetIsStationary ? 4 : 5) &&
      this.getGunHeat() === 0 &&
      shouldFire
    ) {
      const fired = this.setFire(power);
      if (targetIsStationary) {
        this.firedDuringStop = true;
        this.lastStationaryShot = event.turnNumber;
      }
      if (fired && gunBuffer !== undefined) {
        const bulletSpeed = 20 - 3 * power;
        this.gunWaves.push({
          sourceX: this.getX(),
          sourceY: this.getY(),
          fireTurn: event.turnNumber,
          bulletSpeed,
          directBearing,
          lateralDirection: this.lateralDirection,
          maxEscapeAngle: toDegrees(Math.asin(8 / bulletSpeed)),
          buffer: gunBuffer,
        });
      }
    }
  }

  private firepowerFor(
    distance: number,
    enemyEnergy: number,
    targetIsStationary: boolean,
  ) {
    const affordable = Math.max(0.1, Math.min(3, this.getEnergy() / 8));
    const finishingPower =
      enemyEnergy < 12 ? Math.min(3, enemyEnergy / 4 + 0.1) : 3;
    const learningTarget = this.isAdvancedTarget();
    const distancePower = this.isTargetingStalled()
      ? distance < 260
        ? 3
        : LEARNING_FIREPOWER
      : learningTarget
      ? LEARNING_FIREPOWER
      : targetIsStationary
        ? distance < 220
          ? 3
          : 1
        : distance < 170
          ? 3
          : 1.8;
    return Math.max(0.1, Math.min(affordable, finishingPower, distancePower));
  }

  private updateGunWaves(event: ScannedBotEvent) {
    const active: GunWave[] = [];
    for (const wave of this.gunWaves) {
      const traveled = (event.turnNumber - wave.fireTurn) * wave.bulletSpeed;
      const targetDistance = Math.hypot(
        event.x - wave.sourceX,
        event.y - wave.sourceY,
      );
      if (traveled >= targetDistance - 20) {
        const bearing = directionTo(wave.sourceX, wave.sourceY, event.x, event.y);
        const offset = normalizeBearing(bearing - wave.directBearing);
        const factor = Math.max(
          -1,
          Math.min(
            1,
            offset / (wave.lateralDirection * wave.maxEscapeAngle),
          ),
        );
        const index = Math.max(
          0,
          Math.min(GUN_BINS - 1, Math.round(factor * GUN_MIDDLE + GUN_MIDDLE)),
        );
        for (let i = 0; i < GUN_BINS; i += 1) {
          wave.buffer[i] *= 1 - 1 / GUN_ROLLING_WINDOW;
          wave.buffer[i] += 1 / ((index - i) ** 2 + 1);
        }
      } else {
        active.push(wave);
      }
    }
    this.gunWaves = active;
  }

  private gunBuffer(
    distance: number,
    lateralSpeed: number,
    lastLateralSpeed: number,
  ) {
    const distanceIndex = Math.min(
      DISTANCE_SEGMENTS - 1,
      Math.floor(distance / (900 / DISTANCE_SEGMENTS)),
    );
    const lateralIndex =
      Math.abs(lateralSpeed) < 1 ? 0 : Math.abs(lateralSpeed) < 5 ? 1 : 2;
    const lastLateralIndex =
      Math.abs(lastLateralSpeed) < 1
        ? 0
        : Math.abs(lastLateralSpeed) < 5
          ? 1
          : 2;
    return this.gunStats[distanceIndex][lateralIndex][lastLateralIndex];
  }

  private bestGuessFactor(buffer: GunBuffer) {
    let best = GUN_MIDDLE;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] > buffer[best]) best = i;
    }
    return (best - GUN_MIDDLE) / GUN_MIDDLE;
  }

  private isStopAndGoTarget() {
    const observations = this.observationCount();
    return (
      observations >= 20 &&
      this.stationaryScans / observations > 0.2 &&
      this.turningScans / observations < 0.15
    );
  }

  private observationCount() {
    return this.stationaryScans + this.movingScans;
  }

  private isTargetingStalled() {
    const stopAndGoStalled =
      this.isStopAndGoTarget() &&
      this.shots >= 12 &&
      this.hits * 5 < this.shots;
    const circlingStalled =
      this.isCirclingTarget() &&
      this.getTurnNumber() - this.lastShotTurn > 200;
    return stopAndGoStalled || circlingStalled;
  }

  private isCirclingTarget() {
    return this.movingScans >= 20 && Math.abs(this.enemyTurnRate) > 1;
  }

  private isAdvancedTarget() {
    return this.observationCount() >= 20 && !this.isStopAndGoTarget();
  }
}

DangrundBot.main();
