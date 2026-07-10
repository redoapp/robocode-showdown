import {
  Bot,
  BotDeathEvent,
  HitBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  ScannedBotEvent,
} from "@robocode.dev/tank-royale-bot-api";

type Point = { x: number; y: number };

class MooseBot extends Bot {
  private static readonly MELEE_SPECIALIST = false;
  private static readonly WALL_MARGIN = 72;
  private static readonly BOT_MARGIN = 18;
  private static readonly TARGET_STALE_TURNS: number = 13;
  private static readonly PREFERRED_DISTANCE: number = 298;
  private static readonly MELEE_DISTANCE: number = 430;
  private static readonly CLOSE_RANGE: number = 100;
  private static readonly LONG_RANGE: number = 730;
  private static readonly REVERSAL_MIN: number = 12;
  private static readonly REVERSAL_SPAN: number = 34;
  private static readonly AIM_MODE: number = 3;
  private static readonly AGGRESSION: number = 1.26;
  private static readonly RAM_RANGE: number = 108;

  private targetId = -1;
  private targetX = 0;
  private targetY = 0;
  private targetDirection = 0;
  private targetSpeed = 0;
  private targetEnergy = 100;
  private targetTurnRate = 0;
  private targetAge = 999;
  private targetSeenAt = -1;
  private orbitDirection = 1;
  private reversalClock = 0;
  private nextReversalAt = MooseBot.REVERSAL_MIN + Math.floor(MooseBot.REVERSAL_SPAN / 2);
  private randomState = 2685821657736378312;

  static main() {
    new MooseBot().start();
  }

  override run() {
    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setFireAssist(false);

    while (this.isRunning()) {
      this.targetAge++;
      if (this.targetAge > MooseBot.TARGET_STALE_TURNS) {
        this.targetId = -1;
      }
      const hasTarget = this.targetId >= 0;
      this.drive(hasTarget);
      this.aim(hasTarget);
      this.scan(hasTarget);
      this.go();
    }
  }

  private drive(hasTarget: boolean) {
    if (!hasTarget) {
      this.setTargetSpeed(MooseBot.MELEE_SPECIALIST ? 8 : 7);
      this.setTurnRate((MooseBot.MELEE_SPECIALIST ? 8 : 7) * this.orbitDirection);
      return;
    }

    if (++this.reversalClock > this.nextReversalAt || this.shouldStopGoReverse()) {
      this.reverseOrbit();
    }

    const distance = this.distanceTo(this.targetX, this.targetY);
    const preferred = this.getEnemyCount() <= 1 ? MooseBot.PREFERRED_DISTANCE : MooseBot.MELEE_DISTANCE;
    const enemyDirection = this.directionTo(this.targetX, this.targetY);
    let heading = enemyDirection + 90 * this.orbitDirection;

    if (MooseBot.AIM_MODE === 5 && this.getTurnNumber() % 23 === 0) {
      heading += (this.nextRandom() % 2n === 0n ? 1 : -1) * 22;
    }

    if (distance > preferred + 75) {
      heading -= (MooseBot.MELEE_SPECIALIST ? 18 : 30 + 10 * MooseBot.AGGRESSION) * this.orbitDirection;
    } else if (distance < preferred - 70) {
      heading += (MooseBot.MELEE_SPECIALIST ? 48 : 38 + 12 / Math.max(0.7, MooseBot.AGGRESSION)) * this.orbitDirection;
    }

    if (MooseBot.AIM_MODE === 7 && distance < 220) {
      heading += 26 * this.orbitDirection;
    }

    if (MooseBot.MELEE_SPECIALIST && this.getEnemyCount() > 2) {
      const centerBearing = this.directionTo(this.getArenaWidth() / 2, this.getArenaHeight() / 2);
      heading = this.blendHeading(heading, this.normalizeAbsoluteAngle(centerBearing + 180), 0.24);
    }

    if (!MooseBot.MELEE_SPECIALIST && this.targetEnergy < 6 && distance < MooseBot.RAM_RANGE && this.getEnergy() > this.targetEnergy + 22) {
      this.setTurnRate(this.normalizeRelativeAngle(enemyDirection - this.getDirection()));
      this.setTargetSpeed(8);
      return;
    }

    heading = this.wallSmoothed(heading);
    const turn = this.normalizeRelativeAngle(heading - this.getDirection());
    this.setTurnRate(turn);

    let speed = 8;
    if (MooseBot.AIM_MODE === 3 && Math.floor(this.getTurnNumber() / 9) % 3 === 0) {
      speed = 0.8;
    } else if (MooseBot.AIM_MODE === 5 && Math.floor(this.getTurnNumber() / 11) % 4 === 0) {
      speed = 3.2;
    }
    this.setTargetSpeed(Math.abs(turn) > 76 ? Math.min(speed, 4.8) : speed);
  }

  private shouldStopGoReverse() {
    if (MooseBot.MELEE_SPECIALIST) {
      return this.getTurnNumber() % 33 === 0 && this.nextRandom() % 4n === 0n;
    }
    return MooseBot.AIM_MODE === 3 && this.getTurnNumber() % 37 === 0 && Math.abs(this.getSpeed()) < 1.4;
  }

  private aim(hasTarget: boolean) {
    if (!hasTarget) {
      this.setGunTurnRate(0);
      return;
    }
    const firePower = this.chooseFirePower();
    if (firePower <= 0) return;

    const aimPoint = this.predictTarget(firePower);
    const gunTurn = this.gunBearingTo(aimPoint.x, aimPoint.y);
    this.setGunTurnRate(gunTurn);

    const distance = this.distanceTo(this.targetX, this.targetY);
    const tolerance = Math.max(0.8, Math.min(4.5, (MooseBot.MELEE_SPECIALIST ? 78 : 96) / Math.max(1, distance)));
    if (this.getGunHeat() === 0 && Math.abs(gunTurn) <= tolerance) {
      this.setFire(firePower);
    }
  }

  private scan(hasTarget: boolean) {
    if (!hasTarget) {
      this.setRadarTurnRate(MooseBot.MELEE_SPECIALIST ? 60 : 45);
      return;
    }
    const radarTurn = this.radarBearingTo(this.targetX, this.targetY);
    const overshoot = Math.max(22, Math.min(MooseBot.MELEE_SPECIALIST ? 62 : 50, Math.abs(radarTurn) * 2.7));
    this.setRadarTurnRate(radarTurn + Math.sign(radarTurn === 0 ? 1 : radarTurn) * overshoot);
  }

  private predictTarget(firePower: number): Point {
    const bulletSpeed = 20 - 3 * firePower;
    let predictedX = this.targetX;
    let predictedY = this.targetY;
    let predictedDirection = this.targetDirection;
    const turnRate = Math.abs(this.targetTurnRate) > 0.4 ? this.clamp(this.targetTurnRate, -7, 7) : 0;

    if (MooseBot.AIM_MODE === 1 && this.distanceTo(this.targetX, this.targetY) > MooseBot.LONG_RANGE * 0.82) {
      return { x: this.targetX, y: this.targetY };
    }

    for (let time = 1; time < (MooseBot.MELEE_SPECIALIST ? 82 : 100); time++) {
      const distance = Math.hypot(predictedX - this.getX(), predictedY - this.getY());
      if (time * bulletSpeed >= distance) break;

      let direction = predictedDirection;
      if (MooseBot.AIM_MODE === 2) {
        direction += 3.5 * Math.sign(this.targetSpeed === 0 ? this.orbitDirection : this.targetSpeed);
      } else if (MooseBot.AIM_MODE === 3) {
        direction += 2.2 * this.orbitDirection + turnRate * 0.45;
      } else if (MooseBot.AIM_MODE === 4) {
        direction += 1.8 * this.orbitDirection + turnRate * 0.35;
      } else if (MooseBot.AIM_MODE === 5) {
        const lateralSign = Math.sign(this.targetSpeed === 0 ? this.orbitDirection : this.targetSpeed);
        const distanceFactor = Math.min(1, Math.max(0.35, this.distanceTo(this.targetX, this.targetY) / 700));
        direction += lateralSign * (5.5 + 4 * distanceFactor) + turnRate * 0.55;
      } else if (MooseBot.AIM_MODE === 6) {
        direction += turnRate * 0.85 + this.orbitDirection * (MooseBot.MELEE_SPECIALIST ? 1.3 : 2.8);
      } else if (MooseBot.AIM_MODE === 7) {
        const nearWall = !this.inside(predictedX, predictedY, MooseBot.WALL_MARGIN + 28);
        direction += nearWall ? turnRate * 0.15 : 1.2 * this.orbitDirection + turnRate * 0.35;
      }

      predictedX += Math.sin(this.toRadians(direction)) * this.targetSpeed;
      predictedY += Math.cos(this.toRadians(direction)) * this.targetSpeed;
      predictedDirection = this.normalizeAbsoluteAngle(predictedDirection + turnRate);

      if (!this.inside(predictedX, predictedY, MooseBot.BOT_MARGIN)) {
        predictedX = this.clamp(predictedX, MooseBot.BOT_MARGIN, this.getArenaWidth() - MooseBot.BOT_MARGIN);
        predictedY = this.clamp(predictedY, MooseBot.BOT_MARGIN, this.getArenaHeight() - MooseBot.BOT_MARGIN);
        break;
      }
    }
    return { x: predictedX, y: predictedY };
  }

  private chooseFirePower() {
    const distance = this.distanceTo(this.targetX, this.targetY);
    const myEnergy = this.getEnergy();
    if (myEnergy <= 0.3) return 0;

    let power: number;
    if (distance < MooseBot.CLOSE_RANGE) {
      power = MooseBot.MELEE_SPECIALIST ? 2.25 : 3;
    } else if (distance < 300) {
      power = MooseBot.MELEE_SPECIALIST ? 1.85 : 2.35;
    } else if (distance < 540) {
      power = MooseBot.MELEE_SPECIALIST ? 1.35 : 1.75;
    } else if (distance < MooseBot.LONG_RANGE) {
      power = MooseBot.MELEE_SPECIALIST ? 0.95 : 1.12;
    } else {
      power = MooseBot.MELEE_SPECIALIST ? 0.55 : 0.72;
    }

    power *= MooseBot.AGGRESSION;
    if (MooseBot.MELEE_SPECIALIST && this.getEnemyCount() > 3) power = Math.min(power, 1.25);
    if (this.targetEnergy < 4) power = Math.min(power, this.targetEnergy / 4 + 0.12);
    if (myEnergy < 18) power = Math.min(power, MooseBot.MELEE_SPECIALIST ? 0.75 : 1.05);
    if (myEnergy < 7) power = Math.min(power, 0.4);
    return Math.max(0.1, Math.min(power, myEnergy - 0.15));
  }

  private wallSmoothed(heading: number) {
    let smoothed = this.normalizeAbsoluteAngle(heading);
    for (let i = 0; i < 52; i++) {
      const probe = MooseBot.MELEE_SPECIALIST ? 185 : 155;
      const x = this.getX() + Math.sin(this.toRadians(smoothed)) * probe;
      const y = this.getY() + Math.cos(this.toRadians(smoothed)) * probe;
      if (this.inside(x, y, MooseBot.WALL_MARGIN)) return smoothed;
      smoothed = this.normalizeAbsoluteAngle(smoothed + (MooseBot.MELEE_SPECIALIST ? 6 : 5) * this.orbitDirection);
    }
    return this.directionTo(this.getArenaWidth() / 2, this.getArenaHeight() / 2);
  }

  private blendHeading(a: number, b: number, bWeight: number) {
    return this.normalizeAbsoluteAngle(a + this.normalizeRelativeAngle(b - a) * bWeight);
  }

  private inside(x: number, y: number, margin: number) {
    return x > margin && x < this.getArenaWidth() - margin && y > margin && y < this.getArenaHeight() - margin;
  }

  private reverseOrbit() {
    this.orbitDirection = -this.orbitDirection;
    this.reversalClock = 0;
    this.nextReversalAt = MooseBot.REVERSAL_MIN + Number(this.nextRandom() % BigInt(Math.max(1, MooseBot.REVERSAL_SPAN)));
  }

  private nextRandom() {
    let x = BigInt(this.randomState);
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    x &= 0x7fffffffffffffffn;
    this.randomState = Number(x % BigInt(Number.MAX_SAFE_INTEGER));
    return x;
  }

  private clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
  }

  private toRadians(degrees: number) {
    return degrees * Math.PI / 180;
  }

  override onScannedBot(e: ScannedBotEvent) {
    const scannedId = e.scannedBotId;
    const distance = this.distanceTo(e.x, e.y);
    const currentDistance = this.targetId < 0 ? Number.POSITIVE_INFINITY : this.distanceTo(this.targetX, this.targetY);
    let accept: boolean;
    if (this.targetId < 0 || scannedId === this.targetId) {
      accept = true;
    } else if (this.getEnemyCount() > 1) {
      const score = distance + e.energy * 2.5 + (e.energy < 10 ? -180 : 0) + (distance < 190 ? -60 : 0);
      const currentScore = currentDistance + this.targetEnergy * 2.5 + (this.targetEnergy < 10 ? -180 : 0) + (currentDistance < 190 ? -60 : 0);
      accept = score < currentScore * 0.9 || (e.energy < 7 && distance < 560);
    } else {
      accept = distance < currentDistance * 0.78 || e.energy < this.targetEnergy - 8;
    }
    if (!accept) return;

    if (scannedId === this.targetId) {
      const energyDrop = this.targetEnergy - e.energy;
      if (energyDrop > 0.09 && energyDrop <= 3.01) this.reverseOrbit();
      if (this.targetSeenAt >= 0) {
        const elapsed = Math.max(1, this.getTurnNumber() - this.targetSeenAt);
        const observedTurn = this.normalizeRelativeAngle(e.direction - this.targetDirection) / elapsed;
        this.targetTurnRate = 0.64 * this.targetTurnRate + 0.36 * observedTurn;
      }
    } else {
      this.targetTurnRate = 0;
    }

    this.targetId = scannedId;
    this.targetX = e.x;
    this.targetY = e.y;
    this.targetDirection = e.direction;
    this.targetSpeed = e.speed;
    this.targetEnergy = e.energy;
    this.targetAge = 0;
    this.targetSeenAt = this.getTurnNumber();
  }

  override onBotDeath(e: BotDeathEvent) {
    if (e.victimId === this.targetId) {
      this.targetId = -1;
      this.targetAge = 999;
    }
  }

  override onHitByBullet(_e: HitByBulletEvent) {
    this.reverseOrbit();
  }

  override onHitBot(_e: HitBotEvent) {
    this.reverseOrbit();
    this.setTargetSpeed(MooseBot.MELEE_SPECIALIST ? -8 : -6);
  }

  override onHitWall(_e: HitWallEvent) {
    this.reverseOrbit();
    this.setTurnRate(this.bearingTo(this.getArenaWidth() / 2, this.getArenaHeight() / 2));
    this.setTargetSpeed(7);
  }
}

MooseBot.main();
