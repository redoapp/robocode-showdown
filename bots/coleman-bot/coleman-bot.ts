import {
  Bot,
  BotDeathEvent,
  BulletFiredEvent,
  BulletHitBotEvent,
  BulletHitBulletEvent,
  BulletHitWallEvent,
  BulletState,
  HitByBulletEvent,
  HitWallEvent,
  RoundEndedEvent,
  RoundStartedEvent,
  ScannedBotEvent,
  TickEvent,
} from "@robocode.dev/tank-royale-bot-api";

type Point = { x: number; y: number };
type ModelName = "linear" | "rollingVelocity" | "angleStat";
type CombatRegime = "duel" | "melee";
type PowerBandName = "micro" | "light" | "standard" | "heavy" | "assault" | "maximum";
type GunPolicy = "panel" | "direct";
type BehaviorClass = "low-lateral" | "steady-lateral" | "reversing-lateral";

type PowerBandDefinition = {
  name: PowerBandName;
  power: number;
  priorHitRate: number;
  duelPriorHitRate: number;
  meleePriorHitRate: number;
};

type PowerBandStats = {
  duelHits: number;
  duelMisses: number;
  duelDamage: number;
  meleeHits: number;
  meleeMisses: number;
  meleeDamage: number;
};

type BehaviorAssessment = {
  class: BehaviorClass;
  confidence: number;
  reversalRate: number;
};

type Scan = {
  turn: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
  energy: number;
  lateralVelocity: number;
  lateralDirection: number;
  contextKey: string;
  parentContextKey: string;
};

type TargetTrack = {
  id: number;
  samples: Scan[];
  lastSeenTurn: number;
  lastVirtualShotTurn: number;
  totalScans: number;
};

type ModelStats = {
  prior: number;
  rating: number;
  virtualHits: number;
  virtualMisses: number;
  realHits: number;
  realMisses: number;
};

type GunPolicyStats = {
  prior: number;
  virtualHits: number;
  virtualMisses: number;
  realHits: number;
  realMisses: number;
};

type ContextStats = {
  models: Map<ModelName, ModelStats>;
};

type RoundOutcome = {
  hits: number;
  samples: number;
};

type ContextStability = {
  leader: ModelName | undefined;
  consecutiveRounds: number;
  lastRound: number;
};

type VirtualShot = {
  targetId: number;
  model: ModelName;
  policy: GunPolicy;
  origin: Point;
  direction: number;
  directAngle: number;
  bulletSpeed: number;
  maxEscapeAngle: number;
  directionSign: number;
  contextKey: string;
  parentContextKey: string;
  firedTurn: number;
};

type LiveShot = {
  model: ModelName;
  policy: GunPolicy;
  targetId: number;
  contextKey: string;
  parentContextKey: string;
  firedTurn: number;
  power: number;
  powerBand: PowerBandName;
  regime: CombatRegime;
};

type ShotPlan = {
  model: ModelName;
  policy: GunPolicy;
  power: number;
  powerBand: PowerBandName;
  expectedValue: number;
  regime: CombatRegime;
};

type ContextKeys = {
  contextKey: string;
  parentContextKey: string;
};

type BulletThreat = {
  bullet: BulletState;
  timeToImpact: number;
  missDistance: number;
  side: number;
};

type Candidate = {
  point: Point;
  heading: number;
  score: number;
};

const MODELS: readonly ModelName[] = ["linear", "rollingVelocity", "angleStat"];
const GUN_POLICIES: readonly GunPolicy[] = ["panel", "direct"];
const ANGLE_BIN_COUNT = 25;
const WALL_MARGIN = 52;
const AIM_MARGIN = 25;
const MAX_TRACK_AGE = 16;
const MAX_WAVE_AGE = 105;
const MIN_PARENT_SAMPLES = 20;
const MIN_FINE_SAMPLES = 30;
const PARENT_MAX_WEIGHT = 0.32;
const FINE_MAX_WEIGHT = 0.2;
const PRIOR_STRENGTH = 18;
const CONTEXT_SWITCH_MARGIN = 0.015;
const COLD_START_TURNS = 150;
const COLD_TARGET_LOCK_TURNS = 24;
const WARM_TARGET_LOCK_TURNS = 8;
const MELEE_RADAR_REFRESH_INTERVAL = 48;
const MELEE_RADAR_REFRESH_TURNS = 8;
const MIN_ROUND_MODEL_SAMPLES = 5;
const MIN_STABLE_ROUNDS = 3;
const STABILITY_MARGIN = 0.035;
const DANGER_ENTER_THRESHOLD = 0.66;
const DANGER_EXIT_THRESHOLD = 0.28;
const DANGER_MIN_SHOTS = 6;
const DANGER_ENTER_STREAK = 12;
const DANGER_EXIT_STREAK = 80;
const DANGER_POLICY_HOLD_TURNS = 60;
const DANGER_MAX_BULLET_IDS = 512;
const POWER_BANDS: readonly PowerBandDefinition[] = [
  { name: "micro", power: 0.45, priorHitRate: 0.25, duelPriorHitRate: 0.30, meleePriorHitRate: 0.25 },
  { name: "light", power: 0.75, priorHitRate: 0.27, duelPriorHitRate: 0.33, meleePriorHitRate: 0.27 },
  { name: "standard", power: 1.05, priorHitRate: 0.29, duelPriorHitRate: 0.35, meleePriorHitRate: 0.29 },
  { name: "heavy", power: 1.5, priorHitRate: 0.31, duelPriorHitRate: 0.34, meleePriorHitRate: 0.31 },
  { name: "assault", power: 2.25, priorHitRate: 0.29, duelPriorHitRate: 0.29, meleePriorHitRate: 0.29 },
  { name: "maximum", power: 3, priorHitRate: 0.26, duelPriorHitRate: 0.22, meleePriorHitRate: 0.26 },
];

const modelPrior = (model: ModelName) => {
  if (model === "linear") return 0.58;
  if (model === "rollingVelocity") return 0.53;
  return 0.48;
};

const directModelPrior = (model: ModelName) => {
  if (model === "linear") return 0.59;
  if (model === "rollingVelocity") return 0.53;
  return 0.46;
};

const gunPolicyPrior = (_policy: GunPolicy) => 0.3;

const makeModelStats = (model: ModelName): ModelStats => ({
  prior: modelPrior(model),
  rating: modelPrior(model),
  virtualHits: 0,
  virtualMisses: 0,
  realHits: 0,
  realMisses: 0,
});

const makeGunPolicyStats = (policy: GunPolicy): GunPolicyStats => ({
  prior: gunPolicyPrior(policy),
  virtualHits: 0,
  virtualMisses: 0,
  realHits: 0,
  realMisses: 0,
});

const makePowerBandStats = (): PowerBandStats => ({
  duelHits: 0,
  duelMisses: 0,
  duelDamage: 0,
  meleeHits: 0,
  meleeMisses: 0,
  meleeDamage: 0,
});

class ColemanBot extends Bot {
  private arenaWidth = 800;
  private arenaHeight = 600;
  private activeTargetId: number | undefined;
  private moveSide = 1;
  private nextMoveChangeTurn = 30;
  private movementPolicy: "g06" | "dangerOrbit" = "g06";
  private movementPolicyStartedTurn = 0;
  private dangerStreak = 0;
  private safeStreak = 0;
  private dangerScore = 0;
  private dangerAssessment = 0;
  private incomingShotsObserved = 0;
  private incomingHits = 0;
  private incomingDamage = 0;
  private readonly incomingBulletIds = new Set<number>();
  private targetLockUntilTurn = -1;
  private meleeRadarRefreshUntilTurn = -1;
  private nextMeleeRadarRefreshTurn = 18;
  private roundStartTurn = 0;
  private currentRoundNumber = 0;
  private brakingUntilTurn = -1;
  private lastFireTurn = -1;
  private pressureTargetId: number | undefined;
  private pressureUntilTurn = -1;
  private pressureLevel = 0;
  private pendingShot: LiveShot | undefined;
  private readonly tracks = new Map<number, TargetTrack>();
  private readonly virtualShots: VirtualShot[] = [];
  private readonly liveShots = new Map<number, LiveShot>();
  private readonly modelStats = new Map<ModelName, ModelStats>(
    MODELS.map((model) => [model, makeModelStats(model)]),
  );
  private readonly gunPolicyStats = new Map<GunPolicy, GunPolicyStats>(
    GUN_POLICIES.map((policy) => [policy, makeGunPolicyStats(policy)]),
  );
  private readonly parentStats = new Map<string, ContextStats>();
  private readonly contextStats = new Map<string, ContextStats>();
  private readonly parentRoundOutcomes = new Map<string, Map<ModelName, RoundOutcome>>();
  private readonly contextRoundOutcomes = new Map<string, Map<ModelName, RoundOutcome>>();
  private readonly parentStability = new Map<string, ContextStability>();
  private readonly contextStability = new Map<string, ContextStability>();
  private readonly powerBandStats = new Map<PowerBandName, PowerBandStats>(
    POWER_BANDS.map((band) => [band.name, makePowerBandStats()]),
  );
  private readonly angleHistograms = new Map<string, number[]>();
  private readonly parentAngleHistograms = new Map<string, number[]>();
  private readonly globalAngleHistogram = this.newHistogram();
  private readonly recentHeadings: number[] = [];
  private virtualEvaluations = 0;
  private virtualHits = 0;
  private shots = 0;
  private hits = 0;
  private wallHits = 0;

  static main() {
    new ColemanBot().start();
  }

  override run() {
    this.arenaWidth = this.getArenaWidth();
    this.arenaHeight = this.getArenaHeight();

    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);
    this.setMaxSpeed(8);

    while (this.isRunning()) {
      const target = this.activeTrack();
      const threat = this.mostDangerousBullet();

      if (threat) {
        this.dodge(threat);
      } else if (this.isMelee()) {
        this.moveToMinimumRisk(target);
      } else if (this.movementPolicy === "dangerOrbit") {
        this.moveWithDuelOrbit(target);
      } else {
        this.moveWithAccelerationOrbit(target);
      }

      this.aimAndFire(target);
      if (this.meleeRadarRefreshActive(this.getTurnNumber())) this.setTurnRadarRight(360);
      else this.lockRadar(target);
      this.go();
    }
  }

  override onRoundStarted(event: RoundStartedEvent) {
    this.currentRoundNumber = event.roundNumber;
    this.roundStartTurn = this.getTurnNumber();
    this.tracks.clear();
    this.virtualShots.length = 0;
    this.liveShots.clear();
    this.activeTargetId = undefined;
    this.targetLockUntilTurn = -1;
    this.meleeRadarRefreshUntilTurn = -1;
    this.nextMeleeRadarRefreshTurn = this.getTurnNumber() + 18;
    this.pendingShot = undefined;
    this.lastFireTurn = -1;
    this.moveSide = 1;
    this.nextMoveChangeTurn = 30;
    this.movementPolicy = "g06";
    this.movementPolicyStartedTurn = this.getTurnNumber();
    this.dangerStreak = 0;
    this.safeStreak = 0;
    this.dangerScore = 0;
    this.dangerAssessment = 0;
    this.incomingShotsObserved = 0;
    this.incomingHits = 0;
    this.incomingDamage = 0;
    this.incomingBulletIds.clear();
    this.brakingUntilTurn = -1;
    this.recentHeadings.length = 0;
    this.pressureTargetId = undefined;
    this.pressureUntilTurn = -1;
    this.pressureLevel = 0;
    this.virtualEvaluations = 0;
    this.virtualHits = 0;
    this.shots = 0;
    this.hits = 0;
    this.wallHits = 0;
    this.parentRoundOutcomes.clear();
    this.contextRoundOutcomes.clear();

    this.decayModelRatings(this.modelStats);
    for (const context of this.parentStats.values()) this.decayModelRatings(context.models);
    for (const context of this.contextStats.values()) this.decayModelRatings(context.models);
  }

  override onTick(event: TickEvent) {
    if (event.turnNumber < this.roundStartTurn) this.roundStartTurn = event.turnNumber;
    this.resolveVirtualShots(event.turnNumber);
    this.updateMovementPolicy(event.turnNumber);
  }

  override onScannedBot(event: ScannedBotEvent) {
    if (event.scannedBotId === this.getMyId() || this.isTeammate(event.scannedBotId)) return;

    const radarRefreshActive = this.meleeRadarRefreshActive(event.turnNumber);
    const track = this.tracks.get(event.scannedBotId) ?? {
      id: event.scannedBotId,
      samples: [],
      lastSeenTurn: event.turnNumber,
      lastVirtualShotTurn: -1,
      totalScans: 0,
    };
    track.totalScans++;
    const previous = track.samples[track.samples.length - 1];
    track.samples.push(this.makeScan(event, previous));
    track.samples.splice(0, Math.max(0, track.samples.length - 14));
    track.lastSeenTurn = event.turnNumber;
    this.tracks.set(event.scannedBotId, track);

    this.activeTargetId = this.chooseTargetId();
    const energyDrop = previous && previous.energy - event.energy >= 0.1 && previous.energy - event.energy <= 3.1;
    if (event.scannedBotId === this.activeTargetId) {
      if (energyDrop) this.raisePressure(event.scannedBotId, event.turnNumber + 8, 0.28);
      const energyLead = event.energy - this.getEnergy();
      if (energyLead > 8) this.raisePressure(event.scannedBotId, event.turnNumber + 4, this.clamp((energyLead - 8) / 40, 0, 0.28));
    }
    this.queueVirtualShots(track);

    const target = this.activeTrack();
    if (!target) return;

    if (radarRefreshActive) this.setTurnRadarRight(360);
    else this.setTurnRadarLeft(this.radarBearingTo(target.samples[target.samples.length - 1].x, target.samples[target.samples.length - 1].y) * 2.2);
    this.aimAndFire(target);

    if (energyDrop) {
      this.brakingUntilTurn = Math.max(this.brakingUntilTurn, event.turnNumber + 2);
      this.reverseMovement(7);
    }
  }

  override onBulletFired(event: BulletFiredEvent) {
    if (event.bullet.ownerId !== this.getMyId()) {
      this.observeIncomingBullet(event.bullet);
      if (event.bullet.ownerId === this.activeTargetId) {
        this.raisePressure(event.bullet.ownerId, event.turnNumber + 8, 0.3);
        this.brakingUntilTurn = Math.max(this.brakingUntilTurn, event.turnNumber + 2);
        this.reverseMovement(5);
      }
      return;
    }

    this.shots++;
    const shot = this.pendingShot;
    this.pendingShot = undefined;
    if (!shot || event.turnNumber - shot.firedTurn > 2) return;
    this.liveShots.set(event.bullet.bulletId, shot);
  }

  override onBulletHitBot(event: BulletHitBotEvent) {
    if (event.bullet.ownerId !== this.getMyId()) return;
    const shot = this.liveShots.get(event.bullet.bulletId);
    if (shot) {
      this.recordGunPolicyOutcome(shot.policy, true, true);
      this.recordModelOutcome(shot.model, true, true, shot.contextKey, shot.parentContextKey);
      this.recordPowerOutcome(shot.powerBand, true, event.damage, shot.regime);
      this.raisePressure(event.victimId, event.turnNumber + 10, 0.2);
      this.liveShots.delete(event.bullet.bulletId);
    }
    this.hits++;
  }

  override onBulletHitWall(event: BulletHitWallEvent) {
    if (event.bullet.ownerId !== this.getMyId()) return;
    this.wallHits++;
    this.resolveLiveShot(event.bullet, false);
  }

  override onBulletHitBullet(event: BulletHitBulletEvent) {
    this.resolveLiveShot(event.bullet, false);
    this.resolveLiveShot(event.hitBullet, false);
  }

  override onHitByBullet(event: HitByBulletEvent) {
    this.incomingHits++;
    this.incomingDamage += Math.max(0, this.bulletDamage(event.bullet.power));
    this.dangerScore = this.clamp(this.dangerScore + 0.16 + Math.min(0.22, this.bulletDamage(event.bullet.power) / 32), 0, 1);
    if (this.tracks.has(event.bullet.ownerId)) this.raisePressure(event.bullet.ownerId, event.turnNumber + 10, 0.25);
    this.reverseMovement(6);
    const preferred = this.normalizeAbsoluteAngle(event.bullet.direction + this.moveSide * 90);
    this.setTurnLeft(this.normalizeRelativeAngle(preferred - this.getDirection()));
    this.setForward(155);
  }

  override onHitWall(_event: HitWallEvent) {
    this.reverseMovement(4);
    this.setBack(95);
    this.setTurnLeft(this.moveSide * 70);
  }

  override onBotDeath(event: BotDeathEvent) {
    this.tracks.delete(event.victimId);
    if (this.pressureTargetId === event.victimId) {
      this.pressureTargetId = undefined;
      this.pressureUntilTurn = -1;
      this.pressureLevel = 0;
    }
    if (this.activeTargetId === event.victimId) {
      this.activeTargetId = undefined;
      this.targetLockUntilTurn = -1;
      this.activeTargetId = this.chooseTargetId();
    }
  }

  override onRoundEnded(event: RoundEndedEvent) {
    for (const shot of this.liveShots.values()) {
      this.recordGunPolicyOutcome(shot.policy, false, true);
      this.recordModelOutcome(shot.model, false, true, shot.contextKey, shot.parentContextKey);
      this.recordPowerOutcome(shot.powerBand, false, 0, shot.regime);
    }
    this.liveShots.clear();
    this.updateContextStability(event.roundNumber);

    if (process.env.RESEARCH_G23_ENSEMBLE_DIAGNOSTICS !== "true") return;
    const modelSummary = MODELS.map((model) => {
      const stats = this.modelStats.get(model);
      return `${model}=${stats?.rating.toFixed(3) ?? "n/a"}`;
    }).join(" ");
    const accuracy = this.shots === 0 ? 0 : (100 * this.hits) / this.shots;
    console.error(
      `[coleman-bot] round=${event.roundNumber} shots=${this.shots} hits=${this.hits} ` +
      `accuracy=${accuracy.toFixed(1)}% walls=${this.wallHits} ` +
      `virtual=${this.virtualHits}/${this.virtualEvaluations} movement=${this.movementPolicy} ` +
      `danger=${this.dangerAssessment.toFixed(2)} incoming=${this.incomingHits}/${this.incomingShotsObserved} ` +
      `${modelSummary}`,
    );
  }

  private observeIncomingBullet(bullet: BulletState) {
    if (this.incomingBulletIds.has(bullet.bulletId)) return;
    this.incomingBulletIds.add(bullet.bulletId);
    this.incomingShotsObserved++;
    this.dangerScore = this.clamp(this.dangerScore + 0.025, 0, 1);
    if (this.incomingBulletIds.size > DANGER_MAX_BULLET_IDS) {
      const oldest = this.incomingBulletIds.values().next().value as number | undefined;
      if (oldest !== undefined) this.incomingBulletIds.delete(oldest);
    }
  }

  private updateMovementPolicy(turn: number) {
    const liveThreats = [...this.getBulletStates()]
      .filter((bullet) => bullet.ownerId !== this.getMyId())
      .map((bullet) => this.threatFromBullet(bullet))
      .filter((threat): threat is BulletThreat => threat !== undefined);
    const urgentThreat = liveThreats.some((threat) => threat.timeToImpact <= 8);
    const liveSignal = this.clamp(liveThreats.length / 2, 0, 1) * 0.7 + (urgentThreat ? 0.3 : 0);
    this.dangerScore = this.clamp(this.dangerScore * 0.985 + liveSignal * 0.025, 0, 1);

    const observedHitRate = this.incomingHits / Math.max(1, this.incomingShotsObserved);
    const evasionRate = this.clamp(1 - observedHitRate, 0, 1);
    const damagePerShot = this.incomingDamage / Math.max(1, this.incomingShotsObserved);
    const hitSignal = this.clamp((0.76 - evasionRate) / 0.18, 0, 1);
    const damageSignal = this.clamp((damagePerShot - 0.8) / 1.5, 0, 1);
    const collapseBonus = observedHitRate >= 0.3 && damagePerShot >= 1.3 ? 0.1 : 0;
    this.dangerAssessment = this.clamp(
      hitSignal * 0.42 + damageSignal * 0.32 + liveSignal * 0.12 + this.dangerScore * 0.14 + collapseBonus,
      0,
      1,
    );

    if (this.combatRegime() !== "duel" || this.incomingShotsObserved < DANGER_MIN_SHOTS) {
      this.dangerStreak = 0;
      this.safeStreak = 0;
      return;
    }

    if (this.dangerAssessment >= DANGER_ENTER_THRESHOLD) {
      this.dangerStreak++;
      this.safeStreak = 0;
    } else if (this.dangerAssessment <= DANGER_EXIT_THRESHOLD) {
      this.safeStreak++;
      this.dangerStreak = 0;
    } else {
      this.dangerStreak = Math.max(0, this.dangerStreak - 1);
      this.safeStreak = Math.max(0, this.safeStreak - 2);
    }

    if (this.movementPolicy === "g06" && this.dangerStreak >= DANGER_ENTER_STREAK) {
      this.movementPolicy = "dangerOrbit";
      this.movementPolicyStartedTurn = turn;
      this.safeStreak = 0;
      return;
    }
    if (this.movementPolicy === "dangerOrbit" && this.safeStreak >= DANGER_EXIT_STREAK &&
      turn - this.movementPolicyStartedTurn >= DANGER_POLICY_HOLD_TURNS) {
      this.movementPolicy = "g06";
      this.movementPolicyStartedTurn = turn;
      this.dangerStreak = 0;
    }
  }

  private makeScan(event: ScannedBotEvent, previous?: Scan): Scan {
    const directAngle = this.directionTo(event.x, event.y);
    const lateralVelocity = event.speed * Math.sin(this.degreesToRadians(event.direction - directAngle));
    const lateralDirection = Math.abs(lateralVelocity) < 0.05
      ? previous?.lateralDirection ?? this.moveSide
      : lateralVelocity >= 0 ? 1 : -1;

    const contexts = this.contextKeys(event.x, event.y, lateralVelocity, lateralDirection);
    return {
      turn: event.turnNumber,
      x: event.x,
      y: event.y,
      direction: event.direction,
      speed: event.speed,
      energy: event.energy,
      lateralVelocity,
      lateralDirection,
      contextKey: contexts.contextKey,
      parentContextKey: contexts.parentContextKey,
    };
  }

  private contextKeys(x: number, y: number, lateralVelocity: number, lateralDirection: number): ContextKeys {
    const distance = this.distanceTo(x, y);
    const distanceBand = distance < 170 ? 0 : distance < 300 ? 1 : distance < 460 ? 2 : distance < 620 ? 3 : 4;
    const lateralBand = Math.abs(lateralVelocity) < 1.25 ? 0 : Math.abs(lateralVelocity) < 4.75 ? 1 : 2;
    const lateralSign = lateralBand === 0 ? 0 : lateralDirection > 0 ? 1 : 0;
    const parentContextKey = `${distanceBand}:${lateralBand}`;
    return {
      parentContextKey,
      contextKey: `${parentContextKey}:${lateralSign}`,
    };
  }

  private chooseTargetId() {
    const melee = this.isMelee();
    let bestId: number | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    const now = this.getTurnNumber();
    const coldStart = this.isColdStart();
    const current = this.activeTargetId === undefined ? undefined : this.tracks.get(this.activeTargetId);
    if (current && now - current.lastSeenTurn <= MAX_TRACK_AGE && now < this.targetLockUntilTurn) {
      return current.id;
    }

    for (const [id, track] of this.tracks) {
      if (now - track.lastSeenTurn > MAX_TRACK_AGE) continue;
      const scan = this.latestScan(track);
      const distance = this.distanceTo(scan.x, scan.y);
      const freshnessCost = (now - scan.turn) * 13;
      const weaknessBonus = Math.max(0, 35 - scan.energy) * (melee ? 0.7 : 0.35);
      const baseScore = melee
        ? distance * 0.03 + scan.energy + freshnessCost - weaknessBonus
        : distance - weaknessBonus + freshnessCost;
      const scanConfidencePenalty = coldStart ? Math.max(0, 8 - track.totalScans) * 5 : 0;
      const score = baseScore + scanConfidencePenalty;
      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    if (bestId !== undefined) {
      if (current && now - current.lastSeenTurn <= MAX_TRACK_AGE && bestId !== current.id) {
        const currentScan = this.latestScan(current);
        const candidate = this.tracks.get(bestId);
        const candidateScan = candidate ? this.latestScan(candidate) : undefined;
        if (!candidateScan || !this.isClearlyWeakCloseSwitch(currentScan, candidateScan)) {
          this.targetLockUntilTurn = now + WARM_TARGET_LOCK_TURNS;
          return current.id;
        }
      }
      this.targetLockUntilTurn = now + (coldStart ? COLD_TARGET_LOCK_TURNS : WARM_TARGET_LOCK_TURNS);
    }
    return bestId;
  }

  private isClearlyWeakCloseSwitch(current: Scan, candidate: Scan) {
    if (!this.isMelee()) return false;
    const candidateDistance = this.distanceTo(candidate.x, candidate.y);
    const currentDistance = this.distanceTo(current.x, current.y);
    if (candidate.energy > 12 || candidateDistance > 260) return false;
    return candidate.energy <= current.energy - 4 || candidateDistance <= currentDistance - 80;
  }

  private activeTrack() {
    if (this.activeTargetId === undefined) return undefined;
    const track = this.tracks.get(this.activeTargetId);
    if (!track || this.getTurnNumber() - track.lastSeenTurn > MAX_TRACK_AGE) return undefined;
    return track;
  }

  private aimAndFire(target: TargetTrack | undefined) {
    if (!target) return;
    const sample = this.latestScan(target);
    const distance = this.distanceTo(sample.x, sample.y);
    const plan = this.selectShot(target, sample, distance);
    if (!plan) return;

    const predicted = this.predict(plan.model, target, plan.power, plan.policy);
    const gunBearing = this.gunBearingTo(predicted.x, predicted.y);
    this.setTurnGunLeft(gunBearing);

    const tolerance = this.aimTolerance(plan.power);
    const isFresh = this.getTurnNumber() - sample.turn <= 2;
    if (!isFresh || Math.abs(gunBearing) > tolerance || this.getGunHeat() > 0.001) return;
    if (this.lastFireTurn === this.getTurnNumber()) return;

    const intent: LiveShot = {
      model: plan.model,
      policy: plan.policy,
      targetId: target.id,
      contextKey: sample.contextKey,
      parentContextKey: sample.parentContextKey,
      firedTurn: this.getTurnNumber(),
      power: plan.power,
      powerBand: plan.powerBand,
      regime: plan.regime,
    };
    this.pendingShot = intent;
    if (this.setFire(plan.power)) this.lastFireTurn = this.getTurnNumber();
    else this.pendingShot = undefined;
  }

  private selectShot(target: TargetTrack, sample: Scan, distance: number): ShotPlan | undefined {
    const policy = this.selectGunPolicy();
    return this.selectShotForPolicy(policy, target, sample, distance);
  }

  private selectShotForPolicy(policy: GunPolicy, target: TargetTrack, sample: Scan, distance: number): ShotPlan | undefined {
    const regime = this.combatRegime();
    const fallbackPower = this.firepowerFor(distance, sample.energy);
    if (fallbackPower <= 0) return undefined;

    const fallback: ShotPlan = {
      model: this.modelForPolicy(policy, sample.contextKey, sample.parentContextKey),
      policy,
      power: fallbackPower,
      powerBand: this.powerBandFor(fallbackPower).name,
      expectedValue: 0,
      regime,
    };
    if (!this.powerSelectionConfidence(target, sample, regime)) return fallback;

    const reserve = this.energyReserve();
    const available = this.getEnergy() - reserve;
    if (available < 0.1) return fallback;

    const pressure = this.pressureFor(target.id, sample.energy, distance, regime);
    const powerLimit = this.duelPowerLimit(distance, regime);
    const model = this.modelForPolicy(policy, sample.contextKey, sample.parentContextKey);
    let selected: ShotPlan | undefined;
    for (const band of POWER_BANDS) {
      if (band.power > powerLimit) continue;
      let power = band.power;
      if (sample.energy < band.power || available < band.power) {
        if (band.name !== "micro") continue;
        power = Math.min(sample.energy, available);
      }
      if (power < 0.1) continue;

      const hitRate = this.powerBandHitRate(band.name, regime);
      const damage = this.expectedDamageFor(band.name, power, regime);
      const targetDamage = Math.min(damage, sample.energy);
      const killBonus = damage >= sample.energy ? Math.min(3, sample.energy * 0.12) : 0;
      const cooldown = this.shotCooldownTurns(power);
      const reserveSlack = this.getEnergy() - power - reserve;
      const reservePenalty = Math.max(0, 2 - reserveSlack) * 0.04;
      const energyCost = power * (0.02 + (sample.energy > damage ? 0.012 : 0));
      const baseValue = (hitRate * (targetDamage + killBonus) - energyCost) / cooldown - reservePenalty;
      const pressureBonus = pressure * Math.min(0.035, (targetDamage / cooldown) * 0.35);
      const expectedValue = baseValue + pressureBonus;

      if (!selected || expectedValue > selected.expectedValue) {
        selected = {
          model,
          policy,
          power: Number(power.toFixed(2)),
          powerBand: band.name,
          expectedValue,
          regime,
        };
      }
    }

    const minimumValue = pressure >= 0.5 && regime === "duel" ? 0.012 : 0.018;
    return selected && selected.expectedValue >= minimumValue ? selected : fallback;
  }

  private selectGunPolicy() {
    let selected: GunPolicy = "direct";
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const policy of GUN_POLICIES) {
      const stats = this.gunPolicyStats.get(policy);
      if (!stats) continue;
      const samples = stats.virtualHits + stats.virtualMisses + stats.realHits + stats.realMisses;
      const observedHits = stats.virtualHits * 0.65 + stats.realHits * 1.25;
      const observedSamples = (stats.virtualHits + stats.virtualMisses) * 0.65 +
        (stats.realHits + stats.realMisses) * 1.25;
      const posterior = (stats.prior * 18 + observedHits) / (18 + observedSamples);
      const exploration = 0.012 / Math.sqrt(samples + 1);
      const score = posterior + exploration;
      if (score > bestScore) {
        bestScore = score;
        selected = policy;
      }
    }
    return selected;
  }

  private powerSelectionConfidence(target: TargetTrack, sample: Scan, regime: CombatRegime) {
    if (this.isColdStart() || regime === "melee") return false;
    if (target.totalScans < 12 || target.samples.length < 8) return false;
    const freshness = this.clamp(1 - (this.getTurnNumber() - sample.turn) / 3, 0, 1);
    if (freshness < 0.66) return false;

    const assessment = this.assessBehavior(target);
    if (assessment.class === "reversing-lateral") return false;
    const recentSamples = target.samples.slice(-8);
    const latestLateralBand = this.lateralBand(sample.lateralVelocity);
    const sameBandCount = recentSamples.filter((scan) => this.lateralBand(scan.lateralVelocity) === latestLateralBand).length;
    const behaviorAgreement = sameBandCount / recentSamples.length;
    const confidence = assessment.confidence * freshness * (0.55 + behaviorAgreement * 0.45);
    return confidence >= 0.58 && this.getEnergy() > 18;
  }

  private assessBehavior(target: TargetTrack): BehaviorAssessment {
    const samples = target.samples.slice(-8);
    const active = samples.filter((sample) => Math.abs(sample.lateralVelocity) >= 1.25);
    const meanLateral = active.length === 0
      ? 0
      : active.reduce((sum, sample) => sum + Math.abs(sample.lateralVelocity), 0) / active.length;
    let signChanges = 0;
    for (let index = 1; index < active.length; index++) {
      if (active[index].lateralDirection !== active[index - 1].lateralDirection) signChanges++;
    }
    const reversalRate = signChanges / Math.max(1, active.length - 1);
    const behaviorClass: BehaviorClass = active.length < 3 || meanLateral < 1.5
      ? "low-lateral"
      : reversalRate >= 0.3
        ? "reversing-lateral"
        : "steady-lateral";
    const historyConfidence = Math.min(1, target.totalScans / 14);
    const predictability = 1 - Math.min(1, reversalRate * 1.5);
    return {
      class: behaviorClass,
      confidence: historyConfidence * predictability,
      reversalRate,
    };
  }

  private lateralBand(lateralVelocity: number) {
    const speed = Math.abs(lateralVelocity);
    return speed < 1.25 ? 0 : speed < 4.75 ? 1 : 2;
  }

  private duelPowerLimit(distance: number, regime: CombatRegime) {
    if (regime !== "duel") return 3;
    if (distance > 390) return 1.05;
    if (distance > 320) return 1.5;
    if (distance > 245) return 2.25;
    return 3;
  }

  private energyReserve() {
    const energy = this.getEnergy();
    if (energy > 45) return 14;
    if (energy > 28) return 10;
    if (energy > 14) return 7;
    return 3.5;
  }

  private powerBandHitRate(powerBand: PowerBandName, regime: CombatRegime) {
    const stats = this.powerBandStats.get(powerBand);
    const definition = POWER_BANDS.find((band) => band.name === powerBand);
    if (!stats || !definition) return 0;
    const hits = regime === "duel" ? stats.duelHits : stats.meleeHits;
    const misses = regime === "duel" ? stats.duelMisses : stats.meleeMisses;
    const samples = hits + misses;
    const prior = regime === "duel" ? definition.duelPriorHitRate : definition.meleePriorHitRate;
    if (samples === 0) return prior;
    const learnedWeight = Math.min(0.78, samples / (samples + 8));
    return prior * (1 - learnedWeight) + (hits / samples) * learnedWeight;
  }

  private expectedDamageFor(powerBand: PowerBandName, power: number, regime: CombatRegime) {
    const baseDamage = this.bulletDamage(power);
    const stats = this.powerBandStats.get(powerBand);
    if (!stats) return baseDamage;
    const hits = regime === "duel" ? stats.duelHits : stats.meleeHits;
    const damage = regime === "duel" ? stats.duelDamage : stats.meleeDamage;
    if (hits === 0) return baseDamage;
    const learnedWeight = Math.min(0.65, hits / (hits + 8));
    return baseDamage * (1 - learnedWeight) + (damage / hits) * learnedWeight;
  }

  private recordPowerOutcome(powerBand: PowerBandName, hit: boolean, damage: number, regime: CombatRegime) {
    const stats = this.powerBandStats.get(powerBand);
    if (!stats) return;
    if (regime === "duel") {
      if (hit) {
        stats.duelHits++;
        stats.duelDamage += Math.max(0, damage);
      } else {
        stats.duelMisses++;
      }
      return;
    }
    if (hit) {
      stats.meleeHits++;
      stats.meleeDamage += Math.max(0, damage);
    } else {
      stats.meleeMisses++;
    }
  }

  private powerBandFor(power: number) {
    let selected = POWER_BANDS[0];
    for (const band of POWER_BANDS) {
      if (Math.abs(band.power - power) < Math.abs(selected.power - power)) selected = band;
    }
    return selected;
  }

  private bulletDamage(power: number) {
    return power <= 1 ? power * 4 : power * 2 + 2;
  }

  private shotCooldownTurns(power: number) {
    const coolingTurns = Math.max(0, this.getGunHeat() / 0.1);
    const firedHeatTurns = (1 + power / 5) / 0.1;
    return Math.max(1, coolingTurns + firedHeatTurns);
  }

  private aimTolerance(power: number) {
    if (power >= 2.5) return 3.2;
    if (power >= 1.25) return 4.5;
    return 6.5;
  }

  private firepowerFor(distance: number, targetEnergy: number) {
    let power = distance < 125 ? 3 : distance < 210 ? 2.35 : distance < 330 ? 1.65 : distance < 480 ? 1.05 : 0.65;
    if (targetEnergy < 10) power = Math.min(power, Math.max(0.35, targetEnergy / 4));

    const reserve = this.getEnergy() > 36 ? 10 : this.getEnergy() > 18 ? 7 : 4;
    const available = this.getEnergy() - reserve;
    if (available < 0.1) return 0;
    if (this.getEnergy() < 9) power = Math.min(power, 0.55);
    return Math.max(0.1, Math.min(3, available, Number(power.toFixed(2))));
  }

  private bestModel(contextKey: string, parentContextKey: string) {
    // Pool broad behavior evidence first; only well-sampled directional buckets can refine it.
    if (this.isColdStart()) return "linear";
    let globalSelected: ModelName = "linear";
    let globalBestScore = Number.NEGATIVE_INFINITY;
    let selected: ModelName = "linear";
    let bestScore = Number.NEGATIVE_INFINITY;
    const parent = this.contextStatsFor(this.parentStats, parentContextKey);
    const fine = this.contextStatsFor(this.contextStats, contextKey);

    for (const model of MODELS) {
      const globalStats = this.modelStats.get(model);
      const parentStats = parent.models.get(model);
      const fineStats = fine.models.get(model);
      if (!globalStats || !parentStats || !fineStats) continue;

      const globalScore = this.posteriorEstimate(globalStats);
      if (globalScore > globalBestScore) {
        globalBestScore = globalScore;
        globalSelected = model;
      }

      const parentSamples = this.sampleCount(parentStats);
      const parentWeight = !this.isStable(this.parentStability, parentContextKey, model) || parentSamples < MIN_PARENT_SAMPLES
        ? 0
        : Math.min(PARENT_MAX_WEIGHT, (parentSamples - MIN_PARENT_SAMPLES + 1) / (parentSamples + 38));
      const fineSamples = this.sampleCount(fineStats);
      const fineWeight = !this.isStable(this.contextStability, contextKey, model) || fineSamples < MIN_FINE_SAMPLES
        ? 0
        : Math.min(FINE_MAX_WEIGHT, (fineSamples - MIN_FINE_SAMPLES + 1) / (fineSamples + 52));
      const parentScore = this.posteriorEstimate(parentStats);
      const fineScore = this.posteriorEstimate(fineStats);
      const pooledScore = globalScore * (1 - parentWeight) + parentScore * parentWeight;
      const score = pooledScore * (1 - fineWeight) + fineScore * fineWeight;
      if (score > bestScore) {
        bestScore = score;
        selected = model;
      }
    }
    if (selected !== globalSelected && bestScore < globalBestScore + CONTEXT_SWITCH_MARGIN) return globalSelected;
    return selected;
  }

  private modelForPolicy(policy: GunPolicy, contextKey: string, parentContextKey: string) {
    if (policy === "panel") return this.bestModel(contextKey, parentContextKey);
    return this.bestDirectModel();
  }

  private bestDirectModel() {
    let selected: ModelName = "linear";
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const model of MODELS) {
      const stats = this.modelStats.get(model);
      if (!stats) continue;
      const virtualSamples = stats.virtualHits + stats.virtualMisses;
      const realSamples = stats.realHits + stats.realMisses;
      const virtualWeight = Math.min(0.78, virtualSamples / (virtualSamples + 28));
      const realWeight = Math.min(0.92, realSamples / (realSamples + 5));
      const learnedWeight = Math.max(virtualWeight, realWeight);
      const exploration = 0.018 / Math.sqrt(virtualSamples + realSamples + 1);
      const score = directModelPrior(model) * (1 - learnedWeight) + stats.rating * learnedWeight + exploration;
      if (score > bestScore) {
        bestScore = score;
        selected = model;
      }
    }
    return selected;
  }

  private posteriorEstimate(stats: ModelStats) {
    const weightedHits = stats.virtualHits * 0.65 + stats.realHits * 1.25;
    const weightedSamples = (stats.virtualHits + stats.virtualMisses) * 0.65 +
      (stats.realHits + stats.realMisses) * 1.25;
    const countEstimate = (stats.prior * PRIOR_STRENGTH + weightedHits) / (PRIOR_STRENGTH + weightedSamples);
    const learnedWeight = Math.min(0.64, weightedSamples / (weightedSamples + 36));
    const recentEstimate = countEstimate * 0.35 + stats.rating * 0.65;
    return stats.prior * (1 - learnedWeight) + recentEstimate * learnedWeight;
  }

  private predict(model: ModelName, track: TargetTrack, firepower: number, policy: GunPolicy) {
    const sample = this.latestScan(track);
    const bulletSpeed = this.calcBulletSpeed(firepower);
    let time = Math.max(1, this.distanceTo(sample.x, sample.y) / bulletSpeed);

    for (let iteration = 0; iteration < 4; iteration++) {
      const candidate = this.predictAtTime(model, track, time, firepower, policy);
      time = Math.max(1, this.distanceBetween({ x: this.getX(), y: this.getY() }, candidate) / bulletSpeed);
    }
    return this.predictAtTime(model, track, time, firepower, policy);
  }

  private predictAtTime(model: ModelName, track: TargetTrack, time: number, firepower: number, policy: GunPolicy): Point {
    const sample = this.latestScan(track);
    if (model === "linear") {
      return this.clampedPoint(
        sample.x + Math.cos(this.degreesToRadians(sample.direction)) * sample.speed * time,
        sample.y + Math.sin(this.degreesToRadians(sample.direction)) * sample.speed * time,
      );
    }

    if (model === "rollingVelocity") {
      const velocity = this.rollingVelocity(track);
      return this.clampedPoint(sample.x + velocity.x * time, sample.y + velocity.y * time);
    }

    const directAngle = this.directionTo(sample.x, sample.y);
    const escapeAngle = this.radiansToDegrees(Math.asin(Math.min(1, 8 / this.calcBulletSpeed(firepower))));
    const guessFactor = policy === "panel"
      ? this.bestStatisticalGuess(sample.contextKey, sample.parentContextKey)
      : this.bestDirectStatisticalGuess(sample.contextKey);
    const aimAngle = directAngle + guessFactor * sample.lateralDirection * escapeAngle;
    return this.clampedPoint(
      this.getX() + Math.cos(this.degreesToRadians(aimAngle)) * this.distanceTo(sample.x, sample.y),
      this.getY() + Math.sin(this.degreesToRadians(aimAngle)) * this.distanceTo(sample.x, sample.y),
    );
  }

  private rollingVelocity(track: TargetTrack) {
    const samples = track.samples;
    if (samples.length < 2) {
      const sample = this.latestScan(track);
      const radians = this.degreesToRadians(sample.direction);
      return { x: Math.cos(radians) * sample.speed, y: Math.sin(radians) * sample.speed };
    }

    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    const start = Math.max(1, samples.length - 7);
    for (let index = start; index < samples.length; index++) {
      const previous = samples[index - 1];
      const current = samples[index];
      const elapsed = Math.max(1, current.turn - previous.turn);
      const weight = index - start + 1;
      weightedX += ((current.x - previous.x) / elapsed) * weight;
      weightedY += ((current.y - previous.y) / elapsed) * weight;
      totalWeight += weight;
    }

    const x = totalWeight === 0 ? 0 : weightedX / totalWeight;
    const y = totalWeight === 0 ? 0 : weightedY / totalWeight;
    const speed = Math.hypot(x, y);
    if (speed <= 8) return { x, y };
    return { x: (x / speed) * 8, y: (y / speed) * 8 };
  }

  private queueVirtualShots(track: TargetTrack) {
    const sample = this.latestScan(track);
    if (track.lastVirtualShotTurn === sample.turn) return;
    track.lastVirtualShotTurn = sample.turn;

    const distance = this.distanceTo(sample.x, sample.y);
    for (const policy of GUN_POLICIES) {
      const plan = this.selectShotForPolicy(policy, track, sample, distance);
      if (!plan) continue;
      const firepower = plan.power;
      const bulletSpeed = this.calcBulletSpeed(firepower);
      const directAngle = this.directionTo(sample.x, sample.y);
      const maxEscapeAngle = Math.asin(Math.min(1, 8 / bulletSpeed));
      const predicted = this.predict(plan.model, track, firepower, plan.policy);
      this.virtualShots.push({
        targetId: track.id,
        model: plan.model,
        policy,
        origin: { x: this.getX(), y: this.getY() },
        direction: this.directionTo(predicted.x, predicted.y),
        directAngle,
        bulletSpeed,
        maxEscapeAngle,
        directionSign: sample.lateralDirection,
        contextKey: sample.contextKey,
        parentContextKey: sample.parentContextKey,
        firedTurn: sample.turn,
      });
    }
    if (this.virtualShots.length > 360) this.virtualShots.splice(0, 60);
  }

  private resolveVirtualShots(turn: number) {
    for (let index = this.virtualShots.length - 1; index >= 0; index--) {
      const shot = this.virtualShots[index];
      const age = turn - shot.firedTurn;
      if (age < 2) continue;

      const track = this.tracks.get(shot.targetId);
      if (!track) {
        this.virtualShots.splice(index, 1);
        continue;
      }
      const sample = this.latestScan(track);
      const ageSinceScan = turn - sample.turn;
      if (ageSinceScan > 3 && age <= MAX_WAVE_AGE) continue;

      const targetVector = { x: sample.x - shot.origin.x, y: sample.y - shot.origin.y };
      const radians = this.degreesToRadians(shot.direction);
      const along = targetVector.x * Math.cos(radians) + targetVector.y * Math.sin(radians);
      const lateral = Math.abs(targetVector.x * Math.sin(radians) - targetVector.y * Math.cos(radians));
      const waveFront = shot.bulletSpeed * age;
      const hit = along >= 0 && Math.abs(along - waveFront) <= shot.bulletSpeed * 1.35 && lateral <= 31;
      const passed = along < 0 || waveFront > along + shot.bulletSpeed * 1.6;
      if (!hit && !passed && age <= MAX_WAVE_AGE) continue;

      this.virtualEvaluations++;
      if (hit) this.virtualHits++;
      this.recordGunPolicyOutcome(shot.policy, hit, false);
      this.recordModelOutcome(shot.model, hit, false, shot.contextKey, shot.parentContextKey);
      if (shot.model === "angleStat") this.learnStatisticalAngle(shot, sample);
      this.virtualShots.splice(index, 1);
    }
  }

  private learnStatisticalAngle(shot: VirtualShot, sample: Scan) {
    const actualAngle = this.directionBetween(shot.origin.x, shot.origin.y, sample.x, sample.y);
    const relative = this.normalizeRelativeAngle(actualAngle - shot.directAngle);
    const guessFactor = this.clamp(
      this.degreesToRadians(relative) / shot.maxEscapeAngle / shot.directionSign,
      -1,
      1,
    );
    const histogram = this.angleHistogramFor(shot.contextKey);
    const parentHistogram = this.parentAngleHistogramFor(shot.parentContextKey);
    this.decayHistogram(histogram, 0.985);
    this.decayHistogram(parentHistogram, 0.99);
    this.decayHistogram(this.globalAngleHistogram, 0.992);
    this.increment(histogram, this.binFor(guessFactor), 1);
    this.increment(parentHistogram, this.binFor(guessFactor), 0.7);
    this.increment(this.globalAngleHistogram, this.binFor(guessFactor), 0.4);
  }

  private bestStatisticalGuess(contextKey: string, parentContextKey: string) {
    const local = this.angleHistogramFor(contextKey);
    const parent = this.parentAngleHistogramFor(parentContextKey);
    const localSamples = this.samplesIn(local);
    const parentSamples = this.samplesIn(parent);
    const localWeight = !this.isStable(this.contextStability, contextKey, "angleStat") || localSamples < MIN_FINE_SAMPLES
      ? 0
      : Math.min(FINE_MAX_WEIGHT, (localSamples - MIN_FINE_SAMPLES + 1) / (localSamples + 52));
    const parentWeight = !this.isStable(this.parentStability, parentContextKey, "angleStat") || parentSamples < MIN_PARENT_SAMPLES
      ? 0
      : Math.min(PARENT_MAX_WEIGHT, (parentSamples - MIN_PARENT_SAMPLES + 1) / (parentSamples + 38));
    const globalWeight = Math.max(0, 1 - localWeight - parentWeight);
    let bestBin = Math.floor(ANGLE_BIN_COUNT / 2);
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let bin = 0; bin < ANGLE_BIN_COUNT; bin++) {
      const localScore = this.smoothedBinScore(local, bin);
      const parentScore = this.smoothedBinScore(parent, bin);
      const globalScore = this.smoothedBinScore(this.globalAngleHistogram, bin);
      const score = localScore * localWeight + parentScore * parentWeight + globalScore * globalWeight;
      if (score > bestScore) {
        bestScore = score;
        bestBin = bin;
      }
    }
    return (bestBin / (ANGLE_BIN_COUNT - 1)) * 2 - 1;
  }

  private bestDirectStatisticalGuess(contextKey: string) {
    const local = this.angleHistogramFor(contextKey);
    const localSamples = this.samplesIn(local);
    const localWeight = Math.min(0.82, localSamples / (localSamples + 12));
    let bestBin = Math.floor(ANGLE_BIN_COUNT / 2);
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let bin = 0; bin < ANGLE_BIN_COUNT; bin++) {
      const localScore = this.smoothedBinScore(local, bin);
      const globalScore = this.smoothedBinScore(this.globalAngleHistogram, bin);
      const score = localScore * localWeight + globalScore * (1 - localWeight);
      if (score > bestScore) {
        bestScore = score;
        bestBin = bin;
      }
    }
    return (bestBin / (ANGLE_BIN_COUNT - 1)) * 2 - 1;
  }

  private recordModelOutcome(
    model: ModelName,
    hit: boolean,
    real: boolean,
    contextKey: string,
    parentContextKey: string,
  ) {
    const stats = this.modelStats.get(model);
    const parentStats = this.contextStatsFor(this.parentStats, parentContextKey).models.get(model);
    const fineStats = this.contextStatsFor(this.contextStats, contextKey).models.get(model);
    if (!stats || !parentStats || !fineStats) return;
    this.recordRoundOutcome(this.parentRoundOutcomes, parentContextKey, model, hit);
    this.recordRoundOutcome(this.contextRoundOutcomes, contextKey, model, hit);
    this.updateStats(stats, hit, real);
    this.updateStats(parentStats, hit, real);
    this.updateStats(fineStats, hit, real);
  }

  private updateStats(stats: ModelStats, hit: boolean, real: boolean) {
    if (real) {
      if (hit) stats.realHits++;
      else stats.realMisses++;
      this.updateRating(stats, hit ? 1 : 0, 0.28);
      return;
    }
    if (hit) stats.virtualHits++;
    else stats.virtualMisses++;
    this.updateRating(stats, hit ? 1 : 0, 0.13);
  }

  private updateRating(stats: ModelStats, outcome: number, weight: number) {
    stats.rating = stats.rating * (1 - weight) + outcome * weight;
  }

  private recordGunPolicyOutcome(policy: GunPolicy, hit: boolean, real: boolean) {
    const stats = this.gunPolicyStats.get(policy);
    if (!stats) return;
    if (real) {
      if (hit) stats.realHits++;
      else stats.realMisses++;
      return;
    }
    if (hit) stats.virtualHits++;
    else stats.virtualMisses++;
  }

  private resolveLiveShot(bullet: BulletState, hit: boolean) {
    if (bullet.ownerId !== this.getMyId()) return;
    const shot = this.liveShots.get(bullet.bulletId);
    if (!shot) return;
    this.recordGunPolicyOutcome(shot.policy, hit, true);
    this.recordModelOutcome(shot.model, hit, true, shot.contextKey, shot.parentContextKey);
    this.liveShots.delete(bullet.bulletId);
  }

  private moveWithDuelOrbit(target: TargetTrack | undefined) {
    const turn = this.getTurnNumber();
    if (turn >= this.nextMoveChangeTurn) this.reverseMovement(0);
    if (!target) {
      this.setMaxSpeed(8);
      this.driveTo(this.wallSafeHeading(this.getDirection() + this.moveSide * 38), 145);
      return;
    }

    const sample = this.latestScan(target);
    const bearing = this.directionTo(sample.x, sample.y);
    const phase = Math.floor(turn / 17);
    const braking = turn <= this.brakingUntilTurn;
    const distance = this.distanceTo(sample.x, sample.y);
    const pressure = this.pressureFor(target.id, sample.energy, distance, "duel");
    const jitter = (((phase * 29 + target.id * 17) % 9) - 4) * 2;
    let offset = 104 * this.moveSide + jitter;
    let stride = 190;
    if (distance > 390) {
      offset = 42 * this.moveSide + jitter;
      stride = 180;
    } else if (distance > 320) {
      offset = 62 * this.moveSide + jitter;
      stride = 190;
    } else if (distance < 240) {
      offset = 148 * this.moveSide + jitter;
      stride = 175;
    }
    if (pressure >= 0.5 && distance > 280) {
      offset = 38 * this.moveSide + jitter;
      stride = 215;
    }

    this.setMaxSpeed(braking ? 3.5 : 8);
    const desired = this.wallSafeHeading(bearing + offset, braking ? 125 : 170);
    this.driveTo(desired, braking ? 105 : stride);
  }

  private moveWithAccelerationOrbit(target: TargetTrack | undefined) {
    const turn = this.getTurnNumber();
    if (turn >= this.nextMoveChangeTurn) this.reverseMovement(0);
    if (!target) {
      this.setMaxSpeed(8);
      this.driveTo(this.wallSafeHeading(this.getDirection() + this.moveSide * 38), 145);
      return;
    }

    const sample = this.latestScan(target);
    const bearing = this.directionTo(sample.x, sample.y);
    const phase = Math.floor(turn / 17);
    const braking = turn <= this.brakingUntilTurn;
    this.setMaxSpeed(braking ? 3.5 : 8);
    const jitter = (((phase * 29 + target.id * 17) % 13) - 6) * 4;
    let offset = 90 * this.moveSide + jitter;
    const distance = this.distanceTo(sample.x, sample.y);
    if (distance < 300) offset = 155 * this.moveSide + jitter;
    if (distance > 410) offset = 42 * this.moveSide + jitter;

    const desired = this.wallSafeHeading(bearing + offset, braking ? 125 : 180);
    const stride = braking ? 115 : this.wallDistance() < 135 ? 235 : distance < 300 ? 225 : distance > 410 ? 215 : 230;
    this.driveTo(desired, stride);
  }

  private moveToMinimumRisk(target: TargetTrack | undefined) {
    this.setMaxSpeed(8);
    const candidates: Candidate[] = [];
    for (let heading = 0; heading < 360; heading += 24) {
      candidates.push(this.scoreDestination(this.destinationForHeading(heading, 155), heading, target));
    }
    if (target) {
      const bearing = this.directionTo(this.latestScan(target).x, this.latestScan(target).y);
      for (const offset of [-165, -135, -105, 105, 135, 165, 180]) {
        const heading = this.normalizeAbsoluteAngle(bearing + offset);
        candidates.push(this.scoreDestination(this.destinationForHeading(heading, 175), heading, target));
      }
    }

    const best = candidates.reduce((current, candidate) => candidate.score > current.score ? candidate : current);
    this.recentHeadings.unshift(best.heading);
    this.recentHeadings.splice(8);
    this.driveTo(best.heading, Math.max(60, this.distanceBetween({ x: this.getX(), y: this.getY() }, best.point)));
  }

  private scoreDestination(point: Point, heading: number, target: TargetTrack | undefined): Candidate {
    let score = this.wallSafetyScore(point) * 1.8;
    score -= this.bulletPathRisk(point) * 16;
    score -= this.crowdRisk(point) * 0.45;
    score += this.headingNovelty(heading) * 1.8;

    if (target) {
      const targetPoint = this.predictTargetPoint(target, 8);
      const distance = this.distanceBetween(point, targetPoint);
      score += 190 - Math.abs(distance - 300) * 0.6;
      if (distance < 145) score -= (145 - distance) * 4;
      if (distance > 560) score -= (distance - 560) * 0.4;
    }
    return { point, heading, score };
  }

  private destinationForHeading(heading: number, distance: number) {
    const radians = this.degreesToRadians(heading);
    return this.clampedPoint(this.getX() + Math.cos(radians) * distance, this.getY() + Math.sin(radians) * distance);
  }

  private wallSafetyScore(point: Point) {
    const wallDistance = Math.min(point.x, this.arenaWidth - point.x, point.y, this.arenaHeight - point.y);
    if (wallDistance < 35) return -900 - (35 - wallDistance) * 18;
    if (wallDistance < WALL_MARGIN) return -250 - (WALL_MARGIN - wallDistance) * 5;
    return Math.min(190, wallDistance) * 1.1;
  }

  private bulletPathRisk(point: Point) {
    let risk = 0;
    for (const bullet of this.getBulletStates()) {
      if (bullet.ownerId === this.getMyId()) continue;
      const radians = this.degreesToRadians(bullet.direction);
      const directionX = Math.cos(radians);
      const directionY = Math.sin(radians);
      const along = (point.x - bullet.x) * directionX + (point.y - bullet.y) * directionY;
      const lateral = Math.abs((point.x - bullet.x) * directionY - (point.y - bullet.y) * directionX);
      if (along < -25 || along / bullet.speed > 28) continue;
      if (lateral < 42) risk += (42 - lateral) * (1 + Math.max(0, 18 - along / bullet.speed) / 18);
    }
    return risk;
  }

  private crowdRisk(point: Point) {
    let risk = 0;
    for (const track of this.tracks.values()) {
      if (this.getTurnNumber() - track.lastSeenTurn > MAX_TRACK_AGE) continue;
      const distance = this.distanceBetween(point, this.predictTargetPoint(track, 7));
      if (distance < 120) risk += 180 - distance;
      else if (distance < 210) risk += 55;
    }
    return risk;
  }

  private headingNovelty(heading: number) {
    const distance = this.recentHeadings.reduce((minimum, previous) => Math.min(minimum, Math.abs(this.normalizeRelativeAngle(heading - previous))), 180);
    return distance / 180;
  }

  private predictTargetPoint(track: TargetTrack, time: number) {
    const sample = this.latestScan(track);
    const velocity = this.rollingVelocity(track);
    return this.clampedPoint(sample.x + velocity.x * time, sample.y + velocity.y * time);
  }

  private dodge(threat: BulletThreat) {
    this.setMaxSpeed(8);
    const preferred = this.normalizeAbsoluteAngle(threat.bullet.direction + (threat.side < 0 ? 90 : -90));
    const alternate = this.normalizeAbsoluteAngle(threat.bullet.direction - (threat.side < 0 ? 90 : -90));
    const distance = threat.timeToImpact < 6 ? 210 : threat.timeToImpact < 12 ? 165 : 125;
    const heading = this.isSafeFuture(preferred, distance) ? preferred : alternate;
    this.driveTo(heading, distance);
    if (this.getTurnNumber() - this.nextMoveChangeTurn > -12) this.reverseMovement(0);
  }

  private mostDangerousBullet() {
    return [...this.getBulletStates()]
      .filter((bullet) => bullet.ownerId !== this.getMyId())
      .map((bullet) => this.threatFromBullet(bullet))
      .filter((threat): threat is BulletThreat => threat !== undefined)
      .sort((first, second) => first.timeToImpact - second.timeToImpact || first.missDistance - second.missDistance)[0];
  }

  private threatFromBullet(bullet: BulletState) {
    const radians = this.degreesToRadians(bullet.direction);
    const directionX = Math.cos(radians);
    const directionY = Math.sin(radians);
    const relativeX = this.getX() - bullet.x;
    const relativeY = this.getY() - bullet.y;
    const along = relativeX * directionX + relativeY * directionY;
    if (along < 0) return undefined;
    const timeToImpact = along / bullet.speed;
    if (timeToImpact > 22) return undefined;
    const side = relativeX * directionY - relativeY * directionX;
    const missDistance = Math.abs(side);
    if (missDistance > 48) return undefined;
    return { bullet, timeToImpact, missDistance, side };
  }

  private lockRadar(target: TargetTrack | undefined) {
    if (!target) {
      this.setTurnRadarRight(360);
      return;
    }
    const sample = this.latestScan(target);
    const radarBearing = this.radarBearingTo(sample.x, sample.y);
    const overshoot = Math.abs(radarBearing) < 0.5 ? 1 : 2.25;
    this.setTurnRadarLeft(radarBearing * overshoot);
  }

  private meleeRadarRefreshActive(turn: number) {
    if (this.combatRegime() !== "melee") {
      this.meleeRadarRefreshUntilTurn = -1;
      return false;
    }
    if (turn >= this.nextMeleeRadarRefreshTurn && turn > this.meleeRadarRefreshUntilTurn) {
      this.meleeRadarRefreshUntilTurn = turn + MELEE_RADAR_REFRESH_TURNS - 1;
      this.nextMeleeRadarRefreshTurn = turn + MELEE_RADAR_REFRESH_INTERVAL;
    }
    return turn <= this.meleeRadarRefreshUntilTurn;
  }

  private driveTo(heading: number, distance: number) {
    this.setTurnLeft(this.normalizeRelativeAngle(heading - this.getDirection()));
    this.setForward(Math.max(45, Math.min(220, distance)));
  }

  private wallSafeHeading(heading: number, distance = 120) {
    const normalized = this.normalizeAbsoluteAngle(heading);
    if (this.isSafeFuture(normalized, distance)) return normalized;
    for (let step = 1; step <= 36; step++) {
      for (const candidate of [normalized + this.moveSide * step * 5, normalized - this.moveSide * step * 5]) {
        if (this.isSafeFuture(candidate, distance)) return this.normalizeAbsoluteAngle(candidate);
      }
    }
    return normalized;
  }

  private isSafeFuture(heading: number, distance: number) {
    const radians = this.degreesToRadians(heading);
    const x = this.getX() + Math.cos(radians) * distance;
    const y = this.getY() + Math.sin(radians) * distance;
    return x >= WALL_MARGIN && x <= this.arenaWidth - WALL_MARGIN && y >= WALL_MARGIN && y <= this.arenaHeight - WALL_MARGIN;
  }

  private reverseMovement(delay: number) {
    this.moveSide = -this.moveSide;
    const turn = this.getTurnNumber();
    this.nextMoveChangeTurn = turn + delay + 21 + ((turn * 17) % 31);
  }

  private isMelee() {
    let liveTargets = 0;
    const now = this.getTurnNumber();
    for (const track of this.tracks.values()) if (now - track.lastSeenTurn <= MAX_TRACK_AGE) liveTargets++;
    return liveTargets >= 2;
  }

  private combatRegime(): CombatRegime {
    if (this.getEnemyCount() > 1 || this.isMelee()) return "melee";
    return "duel";
  }

  private pressureFor(targetId: number, targetEnergy: number, _distance: number, regime: CombatRegime) {
    const now = this.getTurnNumber();
    let pressure = 0;
    if (this.pressureTargetId === targetId && now <= this.pressureUntilTurn) {
      const remaining = this.clamp((this.pressureUntilTurn - now) / 10, 0.25, 1);
      pressure += this.pressureLevel * remaining;
    }
    if (regime === "duel") {
      const energyLead = targetEnergy - this.getEnergy();
      if (energyLead > 8) pressure += this.clamp((energyLead - 8) / 40, 0, 0.35);
    }
    return this.clamp(pressure, 0, 1);
  }

  private raisePressure(targetId: number, untilTurn: number, amount: number) {
    const now = this.getTurnNumber();
    if (this.pressureTargetId !== targetId || now > this.pressureUntilTurn) this.pressureLevel = 0;
    this.pressureTargetId = targetId;
    this.pressureUntilTurn = Math.max(this.pressureUntilTurn, untilTurn);
    this.pressureLevel = this.clamp(this.pressureLevel + amount, 0, 1);
  }

  private wallDistance() {
    return Math.min(this.getX(), this.arenaWidth - this.getX(), this.getY(), this.arenaHeight - this.getY());
  }

  private latestScan(track: TargetTrack) {
    return track.samples[track.samples.length - 1];
  }

  private recordRoundOutcome(
    outcomesByContext: Map<string, Map<ModelName, RoundOutcome>>,
    contextKey: string,
    model: ModelName,
    hit: boolean,
  ) {
    let outcomes = outcomesByContext.get(contextKey);
    if (!outcomes) {
      outcomes = new Map<ModelName, RoundOutcome>();
      outcomesByContext.set(contextKey, outcomes);
    }
    const outcome = outcomes.get(model) ?? { hits: 0, samples: 0 };
    outcome.samples++;
    if (hit) outcome.hits++;
    outcomes.set(model, outcome);
  }

  private updateContextStability(roundNumber: number) {
    // A bucket must pick the same model with margin in consecutive rounds before it can specialize.
    this.updateStabilityFor(this.parentRoundOutcomes, this.parentStability, roundNumber);
    this.updateStabilityFor(this.contextRoundOutcomes, this.contextStability, roundNumber);
    this.parentRoundOutcomes.clear();
    this.contextRoundOutcomes.clear();
  }

  private updateStabilityFor(
    outcomesByContext: Map<string, Map<ModelName, RoundOutcome>>,
    stabilityByContext: Map<string, ContextStability>,
    roundNumber: number,
  ) {
    for (const [contextKey, outcomes] of outcomesByContext) {
      const rates = MODELS.map((model) => {
        const outcome = outcomes.get(model) ?? { hits: 0, samples: 0 };
        return {
          model,
          rate: this.roundRate(model, outcome),
          samples: outcome.samples,
        };
      }).sort((first, second) => second.rate - first.rate);
      const leader = rates[0];
      const runnerUp = rates[1];
      if (!leader || !runnerUp) continue;
      const qualified = rates.every((rate) => rate.samples >= MIN_ROUND_MODEL_SAMPLES) &&
        leader.rate - runnerUp.rate >= STABILITY_MARGIN;
      const previous = stabilityByContext.get(contextKey);
      if (!qualified) {
        stabilityByContext.set(contextKey, {
          leader: undefined,
          consecutiveRounds: 0,
          lastRound: roundNumber,
        });
        continue;
      }

      const consecutiveRounds = previous?.leader === leader.model && previous.lastRound === roundNumber - 1
        ? previous.consecutiveRounds + 1
        : 1;
      stabilityByContext.set(contextKey, {
        leader: leader.model,
        consecutiveRounds,
        lastRound: roundNumber,
      });
    }
  }

  private roundRate(model: ModelName, outcome: RoundOutcome) {
    const priorSamples = 8;
    return (modelPrior(model) * priorSamples + outcome.hits) / (priorSamples + outcome.samples);
  }

  private isStable(stabilityByContext: Map<string, ContextStability>, contextKey: string, model: ModelName) {
    const stability = stabilityByContext.get(contextKey);
    return stability?.leader === model &&
      stability.lastRound === this.currentRoundNumber - 1 &&
      stability.consecutiveRounds >= MIN_STABLE_ROUNDS;
  }

  private isColdStart() {
    return Math.max(0, this.getTurnNumber() - this.roundStartTurn) < COLD_START_TURNS;
  }

  private contextStatsFor(statsByContext: Map<string, ContextStats>, contextKey: string) {
    let context = statsByContext.get(contextKey);
    if (!context) {
      context = {
        models: new Map<ModelName, ModelStats>(
          MODELS.map((model) => [model, makeModelStats(model)]),
        ),
      };
      statsByContext.set(contextKey, context);
    }
    return context;
  }

  private sampleCount(stats: ModelStats) {
    return stats.virtualHits + stats.virtualMisses + stats.realHits + stats.realMisses;
  }

  private decayModelRatings(stats: Map<ModelName, ModelStats>) {
    for (const modelStats of stats.values()) modelStats.rating = modelStats.rating * 0.8 + modelStats.prior * 0.2;
  }

  private angleHistogramFor(contextKey: string) {
    let histogram = this.angleHistograms.get(contextKey);
    if (!histogram) {
      histogram = this.newHistogram();
      this.angleHistograms.set(contextKey, histogram);
    }
    return histogram;
  }

  private parentAngleHistogramFor(contextKey: string) {
    let histogram = this.parentAngleHistograms.get(contextKey);
    if (!histogram) {
      histogram = this.newHistogram();
      this.parentAngleHistograms.set(contextKey, histogram);
    }
    return histogram;
  }

  private newHistogram() {
    return Array<number>(ANGLE_BIN_COUNT).fill(0);
  }

  private decayHistogram(histogram: number[], factor: number) {
    for (let index = 0; index < histogram.length; index++) histogram[index] *= factor;
  }

  private binFor(guessFactor: number) {
    return Math.round(((guessFactor + 1) / 2) * (ANGLE_BIN_COUNT - 1));
  }

  private increment(histogram: number[], bin: number, amount: number) {
    const safeBin = this.clamp(Math.round(bin), 0, histogram.length - 1);
    histogram[safeBin] += amount;
  }

  private samplesIn(histogram: number[]) {
    return histogram.reduce((sum, value) => sum + value, 0);
  }

  private smoothedBinScore(histogram: number[], bin: number) {
    let score = 0;
    for (let offset = -2; offset <= 2; offset++) {
      const neighbor = bin + offset;
      if (neighbor >= 0 && neighbor < histogram.length) score += histogram[neighbor] / (1 + Math.abs(offset));
    }
    return score;
  }

  private pointIsSafe(point: Point) {
    return point.x >= AIM_MARGIN && point.x <= this.arenaWidth - AIM_MARGIN && point.y >= AIM_MARGIN && point.y <= this.arenaHeight - AIM_MARGIN;
  }

  private clampedPoint(x: number, y: number) {
    return {
      x: this.clamp(x, AIM_MARGIN, this.arenaWidth - AIM_MARGIN),
      y: this.clamp(y, AIM_MARGIN, this.arenaHeight - AIM_MARGIN),
    };
  }

  private distanceBetween(first: Point, second: Point) {
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  private directionTo(x: number, y: number) {
    return this.normalizeAbsoluteAngle((Math.atan2(y - this.getY(), x - this.getX()) * 180) / Math.PI);
  }

  private directionBetween(fromX: number, fromY: number, toX: number, toY: number) {
    return this.normalizeAbsoluteAngle((Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI);
  }

  private degreesToRadians(degrees: number) {
    return (degrees * Math.PI) / 180;
  }

  private radiansToDegrees(radians: number) {
    return (radians * 180) / Math.PI;
  }

  private normalizeAbsoluteAngle(angle: number) {
    return ((angle % 360) + 360) % 360;
  }

  private normalizeRelativeAngle(angle: number) {
    const normalized = angle % 360;
    return normalized >= 180 ? normalized - 360 : normalized < -180 ? normalized + 360 : normalized;
  }

  private clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
  }
}

ColemanBot.main();
