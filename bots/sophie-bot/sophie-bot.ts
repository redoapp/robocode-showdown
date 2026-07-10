import {
  Bot,
  BotDeathEvent,
  Color,
  Constants,
  HitBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  ScannedBotEvent,
} from "@robocode.dev/tank-royale-bot-api";

// --- Strategy types & constants --------------------------------------------

const MAX_BOT_SPEED = 8;

const MOVEMENTS = [
  "antiGravity",
  "orbit",
  "stopAndGo",
  "oscillator",
  "minRisk",
  "ram",
  "randomWalk",
] as const;

const TARGETINGS = [
  "headOn",
  "linear",
  "circular",
  "guessAngle",
] as const;

const RADARS = [
  "spin",
  "lock",
  "sweepLock",
] as const;

type Movement = (typeof MOVEMENTS)[number];
type Targeting = (typeof TARGETINGS)[number];
type Radar = (typeof RADARS)[number];

const ROTATION_MOVEMENTS: Movement[] = [
  "antiGravity",
  "orbit",
  "stopAndGo",
  "oscillator",
  "minRisk",
  "randomWalk",
];
const ROTATION_RADARS: Radar[] = ["lock", "sweepLock"];

interface StrategyCombo {
  movement: Movement;
  targeting: Targeting;
  radar: Radar;
}

interface Vec {
  x: number;
  y: number;
}

interface EnemySnapshot {
  x: number;
  y: number;
  direction: number;
  speed: number;
}

interface Arena {
  width: number;
  height: number;
}

interface WindowState {
  elapsedMs: number;
  myEnergyStart: number;
  myEnergyNow: number;
  oppEnergyStart: number;
  oppEnergyNow: number;
  scannedThisWindow: boolean;
}

interface RiskEnemy extends Vec {
  energy: number;
}

// --- Strategy helpers ------------------------------------------------------

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

function pickRandomCombo(): StrategyCombo {
  return {
    movement: pick(ROTATION_MOVEMENTS),
    targeting: pick(TARGETINGS),
    radar: pick(ROTATION_RADARS),
  };
}

function combosEqual(a: StrategyCombo, b: StrategyCombo): boolean {
  return a.movement === b.movement && a.targeting === b.targeting && a.radar === b.radar;
}

function pickDifferentCombo(current: StrategyCombo): StrategyCombo {
  for (let i = 0; i < 10; i++) {
    const next = pickRandomCombo();
    if (!combosEqual(next, current)) return next;
  }
  return { ...current, movement: pick(ROTATION_MOVEMENTS) };
}

// --- Geometry helpers ------------------------------------------------------

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const BOT_RADIUS = 18;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clampToArena(p: Vec, arena: Arena): Vec {
  return {
    x: clamp(p.x, BOT_RADIUS, arena.width - BOT_RADIUS),
    y: clamp(p.y, BOT_RADIUS, arena.height - BOT_RADIUS),
  };
}

function angleTo(from: Vec, to: Vec): number {
  return Math.atan2(to.y - from.y, to.x - from.x) * DEG;
}

function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeRelative(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

// --- Targeting -------------------------------------------------------------

function selectFirepower(distanceToEnemy: number, energy: number): number {
  let power =
    distanceToEnemy < 120
      ? 3
      : distanceToEnemy < 300
        ? 2.4
        : distanceToEnemy < 500
          ? 1.6
          : distanceToEnemy < 750
            ? 1.1
            : 0.7;
  if (energy < 20) power = Math.min(power, 1.2);
  if (energy < 10) power = Math.min(power, 0.6);
  if (energy < 4) power = Math.min(power, 0.2);
  return clamp(power, 0.1, 3);
}

function bulletSpeed(firepower: number): number {
  return 20 - 3 * firepower;
}

function maxEscapeAngleDeg(speedOfBullet: number): number {
  return Math.asin(clamp(MAX_BOT_SPEED / speedOfBullet, -1, 1)) * DEG;
}

function predictLinear(shooter: Vec, enemy: EnemySnapshot, speedOfBullet: number, arena: Arena): Vec {
  const vx = enemy.speed * Math.cos(enemy.direction * RAD);
  const vy = enemy.speed * Math.sin(enemy.direction * RAD);
  let aim: Vec = { x: enemy.x, y: enemy.y };
  for (let i = 0; i < 12; i++) {
    const t = distance(shooter, aim) / speedOfBullet;
    aim = clampToArena({ x: enemy.x + vx * t, y: enemy.y + vy * t }, arena);
  }
  return aim;
}

function predictCircular(
  shooter: Vec,
  enemy: EnemySnapshot,
  angularVelocity: number,
  speedOfBullet: number,
  arena: Arena,
): Vec {
  let heading = enemy.direction;
  let p: Vec = { x: enemy.x, y: enemy.y };
  for (let step = 1; step <= 80; step++) {
    heading += angularVelocity;
    p = clampToArena(
      { x: p.x + enemy.speed * Math.cos(heading * RAD), y: p.y + enemy.speed * Math.sin(heading * RAD) },
      arena,
    );
    if (step * speedOfBullet >= distance(shooter, p)) break;
  }
  return p;
}

function guessAngle(shooter: Vec, enemy: EnemySnapshot, speedOfBullet: number): number {
  const direct = angleTo(shooter, enemy);
  const vx = enemy.speed * Math.cos(enemy.direction * RAD);
  const vy = enemy.speed * Math.sin(enemy.direction * RAD);
  const toEnemyX = enemy.x - shooter.x;
  const toEnemyY = enemy.y - shooter.y;
  const lateral = Math.sign(toEnemyX * vy - toEnemyY * vx) || 1;
  const fraction = 0.35 + Math.random() * 0.65;
  return direct + lateral * fraction * maxEscapeAngleDeg(speedOfBullet);
}

// --- Strategy-switching ----------------------------------------------------

function windowComplete(
  state: Pick<WindowState, "elapsedMs" | "myEnergyStart" | "myEnergyNow">,
  minMs: number,
  lossFraction: number,
): boolean {
  const lost = state.myEnergyStart - state.myEnergyNow;
  const lostFraction = state.myEnergyStart > 0 ? lost / state.myEnergyStart : 0;
  return state.elapsedMs >= minMs || lostFraction >= lossFraction;
}

function losingTheTrade(state: WindowState): boolean {
  const myLoss = state.myEnergyStart - state.myEnergyNow;
  if (!state.scannedThisWindow) return myLoss > 0;
  const elapsedSec = Math.max(state.elapsedMs / 1000, 1e-3);
  const myRate = myLoss / elapsedSec;
  const oppRate = (state.oppEnergyStart - state.oppEnergyNow) / elapsedSec;
  return myRate > oppRate;
}

function lowestRiskPoint(me: Vec, enemies: RiskEnemy[], arena: Arena): Vec {
  const margin = 60;
  let best: Vec = me;
  let bestRisk = Infinity;
  for (let i = 0; i < 16; i++) {
    const angle = ((i + Math.random()) / 16) * 2 * Math.PI;
    const reach = 90 + Math.random() * 110;
    const p: Vec = {
      x: clamp(me.x + Math.cos(angle) * reach, margin, arena.width - margin),
      y: clamp(me.y + Math.sin(angle) * reach, margin, arena.height - margin),
    };
    let risk = 0;
    for (const e of enemies) {
      const d = Math.max(distance(p, e), 30);
      risk += Math.max(e.energy, 5) / (d * d);
    }
    const wallDist = Math.min(p.x, p.y, arena.width - p.x, arena.height - p.y);
    risk += 0.4 / Math.max(wallDist, 20) + Math.random() * 1e-6;
    if (risk < bestRisk) {
      bestRisk = risk;
      best = p;
    }
  }
  return best;
}

function worstLossInField(myLossRate: number, enemyLossRates: number[]): boolean {
  return enemyLossRates.length > 0 && enemyLossRates.every((r) => myLossRate > r);
}

// --- Bot constants ---------------------------------------------------------

const TURNS_PER_SECOND = 30;
const MIN_STRATEGY_MS = 5000;
const HEALTH_LOSS_FRACTION = 0.2;
const STALE_SCAN_TURNS = 8;
const ENEMY_TTL = 20;
const STOP_GO_PERIOD = 22;
const WANDER_PERIOD = 24;
const FINISH_ENERGY = 15;
const START_ENERGY = 100;

type Posture = "engage" | "skirmish" | "retreat";

interface Scan extends EnemySnapshot {
  id: number;
  turn: number;
  energy: number;
  prevDirection: number | null;
  prevTurn: number | null;
}

class SophieBot extends Bot {
  private combo: StrategyCombo = pickRandomCombo();
  private posture: Posture = "skirmish";

  private windowStartTurn = 0;
  private myEnergyStart = START_ENERGY;
  private oppEnergyStart = START_ENERGY;
  private scannedThisWindow = false;
  private focusFired = false;

  private enemies = new Map<number, Scan>();
  private fieldEnergyStart = new Map<number, number>();
  private oppEnergy = START_ENERGY;

  private orbitDir: 1 | -1 = 1;
  private wanderHeading = 0;
  private dodgeCooldownUntil = 0;

  static main() {
    new SophieBot().start();
  }

  override run() {
    this.setBodyColor(Color.fromRgb(20, 20, 24));
    this.setTurretColor(Color.fromRgb(220, 40, 40));
    this.setRadarColor(Color.fromRgb(255, 120, 40));
    this.setBulletColor(Color.fromRgb(255, 200, 40));
    this.setScanColor(Color.fromRgb(255, 60, 60));

    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustRadarForBodyTurn(true);

    this.resetForRound();

    while (this.isRunning()) {
      this.maybeSwitchStrategy();
      this.posture = this.isMelee() ? this.computePosture() : "skirmish";
      this.driveRadar();
      this.driveGun();
      this.driveBody();
      this.go();
    }
  }

  private resetForRound() {
    this.combo = pickRandomCombo();
    this.enemies.clear();
    this.fieldEnergyStart.clear();
    this.oppEnergy = START_ENERGY;
    this.focusFired = false;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.wanderHeading = Math.random() * 360;
    this.dodgeCooldownUntil = 0;
    this.openWindow();
  }

  private openWindow() {
    this.windowStartTurn = this.getTurnNumber();
    this.myEnergyStart = this.getEnergy();
    this.oppEnergyStart = this.oppEnergy;
    this.scannedThisWindow = false;
    this.fieldEnergyStart.clear();
    for (const e of this.livingEnemies()) this.fieldEnergyStart.set(e.id, e.energy);
  }

  private isMelee(): boolean {
    return this.getEnemyCount() > 1;
  }

  private effectiveRadar(): Radar {
    return this.isMelee() ? "spin" : this.combo.radar;
  }

  private effectiveMovement(): Movement {
    if (this.isMelee() && this.combo.movement === "ram") return "antiGravity";
    return this.combo.movement;
  }

  private maybeSwitchStrategy() {
    const elapsedMs = ((this.getTurnNumber() - this.windowStartTurn) / TURNS_PER_SECOND) * 1000;
    const myEnergyNow = this.getEnergy();
    if (!windowComplete({ elapsedMs, myEnergyStart: this.myEnergyStart, myEnergyNow }, MIN_STRATEGY_MS, HEALTH_LOSS_FRACTION)) {
      return;
    }
    const losing = this.isMelee() ? this.losingToField(elapsedMs, myEnergyNow) : this.losingDuel(elapsedMs, myEnergyNow);
    if (losing) this.combo = pickDifferentCombo(this.combo);
    this.openWindow();
  }

  private losingDuel(elapsedMs: number, myEnergyNow: number): boolean {
    return losingTheTrade({
      elapsedMs,
      myEnergyStart: this.myEnergyStart,
      myEnergyNow,
      oppEnergyStart: this.oppEnergyStart,
      oppEnergyNow: this.oppEnergy,
      scannedThisWindow: this.scannedThisWindow,
    });
  }

  private losingToField(elapsedMs: number, myEnergyNow: number): boolean {
    const elapsedSec = Math.max(elapsedMs / 1000, 1e-3);
    const myRate = (this.myEnergyStart - myEnergyNow) / elapsedSec;
    const rates: number[] = [];
    for (const e of this.livingEnemies()) {
      const start = this.fieldEnergyStart.get(e.id);
      if (start !== undefined) rates.push(Math.max(0, start - e.energy) / elapsedSec);
    }
    this.focusFired = worstLossInField(myRate, rates);
    return this.focusFired;
  }

  private computePosture(): Posture {
    const enemies = this.livingEnemies();
    if (enemies.length === 0) return "skirmish";
    const myEnergy = this.getEnergy();
    const energies = enemies.map((e) => e.energy);
    const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
    const primary = this.primaryTarget();

    if (primary !== null && primary.energy < FINISH_ENERGY && !this.focusFired && myEnergy > primary.energy) {
      return "engage";
    }
    if (this.focusFired || myEnergy < 0.6 * avg) return "retreat";
    return "skirmish";
  }

  private livingEnemies(): Scan[] {
    const cutoff = this.getTurnNumber() - ENEMY_TTL;
    const alive: Scan[] = [];
    for (const [id, scan] of this.enemies) {
      if (scan.turn < cutoff) this.enemies.delete(id);
      else alive.push(scan);
    }
    return alive;
  }

  private primaryTarget(): Scan | null {
    const me = { x: this.getX(), y: this.getY() };
    const enemies = this.livingEnemies();
    if (enemies.length === 0) return null;

    if (this.isMelee()) {
      const finishable = enemies.filter((e) => e.energy < FINISH_ENERGY && distance(me, e) < 450);
      if (finishable.length > 0) {
        return finishable.reduce((a, b) => (b.energy < a.energy ? b : a));
      }
    }
    return enemies.reduce((a, b) => (distance(me, b) < distance(me, a) ? b : a));
  }

  private driveRadar() {
    const primary = this.primaryTarget();
    const stale = primary === null || this.getTurnNumber() - primary.turn > STALE_SCAN_TURNS;
    if (this.effectiveRadar() === "spin" || stale) {
      this.setRadarTurnRate(Constants.MAX_RADAR_TURN_RATE);
      return;
    }
    const bearing = normalizeRelative(this.radarBearingTo(primary.x, primary.y));
    if (this.effectiveRadar() === "lock") {
      this.setRadarTurnRate(this.clampRadar(bearing * 2));
    } else {
      const sweepSign = bearing >= 0 ? 1 : -1;
      this.setRadarTurnRate(this.clampRadar(bearing + sweepSign * 30));
    }
  }

  private driveGun() {
    const primary = this.primaryTarget();
    if (primary === null) {
      this.setGunTurnRate(0);
      return;
    }
    this.oppEnergy = primary.energy;
    const me = { x: this.getX(), y: this.getY() };
    const dist = distance(me, primary);
    let power = selectFirepower(dist, this.getEnergy());
    let mayFire = true;
    if (this.isMelee()) {
      const cap = this.posture === "engage" ? 3 : this.posture === "retreat" ? 1.5 : 2.4;
      power = Math.min(power, cap);
      if (dist > 600 && this.posture !== "engage") mayFire = false;
    }
    const aim = this.computeAimAngle(primary, power, me);

    const gunTurn = normalizeRelative(aim - this.getGunDirection());
    this.setGunTurnRate(Math.max(-Constants.MAX_GUN_TURN_RATE, Math.min(Constants.MAX_GUN_TURN_RATE, gunTurn)));

    const tolerance = dist < 150 ? 14 : dist < 400 ? 8 : 4;
    if (mayFire && this.getGunHeat() === 0 && Math.abs(gunTurn) <= tolerance && this.getEnergy() > power + 0.3) {
      this.setFire(power);
    }
  }

  private computeAimAngle(target: Scan, power: number, me: { x: number; y: number }): number {
    const enemy: EnemySnapshot = { x: target.x, y: target.y, direction: target.direction, speed: target.speed };
    const arena = { width: this.getArenaWidth(), height: this.getArenaHeight() };
    const bs = bulletSpeed(power);
    switch (this.combo.targeting) {
      case "headOn":
        return angleTo(me, enemy);
      case "linear": {
        const p = predictLinear(me, enemy, bs, arena);
        return angleTo(me, p);
      }
      case "circular": {
        const p = predictCircular(me, enemy, this.angularVelocity(target), bs, arena);
        return angleTo(me, p);
      }
      case "guessAngle":
        return guessAngle(me, enemy, bs);
    }
  }

  private angularVelocity(target: Scan): number {
    if (target.prevTurn === null || target.prevDirection === null) return 0;
    const dt = target.turn - target.prevTurn;
    if (dt <= 0 || dt > 5) return 0;
    return normalizeRelative(target.direction - target.prevDirection) / dt;
  }

  private driveBody() {
    const intent = this.isMelee() ? this.meleeMoveIntent() : this.duelMoveIntent();
    this.steer(intent.heading, intent.speed);
  }

  private duelMoveIntent(): { heading: number; speed: number } {
    const me = { x: this.getX(), y: this.getY() };
    let [fx, fy] = this.wallForce();
    let speed: number = Constants.MAX_SPEED;

    const primary = this.primaryTarget();
    if (primary === null) {
      fx += (this.getArenaWidth() / 2 - me.x) * 0.01;
      fy += (this.getArenaHeight() / 2 - me.y) * 0.01;
      return { heading: this.deg(Math.atan2(fy, fx)), speed: Constants.MAX_SPEED * 0.6 };
    }

    const dx = primary.x - me.x;
    const dy = primary.y - me.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;

    if (primary.energy < 12 && this.getEnergy() > 20) {
      return { heading: this.deg(Math.atan2(fy + uy * 1.6, fx + ux * 1.6)), speed };
    }

    switch (this.effectiveMovement()) {
      case "antiGravity": {
        const w = 1.2 * Math.max(0.5, Math.min(2.5, 250 / dist));
        fx -= ux * w;
        fy -= uy * w;
        break;
      }
      case "orbit":
      case "stopAndGo":
      case "oscillator": {
        const perpX = -uy * this.orbitDir;
        const perpY = ux * this.orbitDir;
        const radial = Math.max(-1, Math.min(1, (dist - 200) / 200)) * 0.7;
        fx += perpX + ux * radial;
        fy += perpY + uy * radial;
        if (this.effectiveMovement() === "stopAndGo") {
          const moving = Math.floor(this.getTurnNumber() / STOP_GO_PERIOD) % 2 === 0;
          speed = moving ? Constants.MAX_SPEED : 0;
        } else if (this.effectiveMovement() === "oscillator") {
          if (Math.random() < 0.07) this.orbitDir = (this.orbitDir * -1) as 1 | -1;
          speed = 3 + Math.random() * (Constants.MAX_SPEED - 3);
        }
        break;
      }
      case "minRisk": {
        const target = lowestRiskPoint(me, this.riskEnemies(), this.arena());
        return { heading: this.deg(Math.atan2(target.y - me.y, target.x - me.x)), speed };
      }
      case "ram": {
        fx += ux * 1.5;
        fy += uy * 1.5;
        break;
      }
      case "randomWalk": {
        if (this.getTurnNumber() % WANDER_PERIOD === 0) this.wanderHeading = Math.random() * 360;
        fx += Math.cos(this.rad(this.wanderHeading));
        fy += Math.sin(this.rad(this.wanderHeading));
        break;
      }
    }
    return { heading: this.deg(Math.atan2(fy, fx)), speed };
  }

  private meleeMoveIntent(): { heading: number; speed: number } {
    const me = { x: this.getX(), y: this.getY() };
    let [fx, fy] = this.wallForce();
    let speed: number = Constants.MAX_SPEED;

    const enemies = this.livingEnemies();
    if (enemies.length === 0) {
      fx += (this.getArenaWidth() / 2 - me.x) * 0.01;
      fy += (this.getArenaHeight() / 2 - me.y) * 0.01;
      return { heading: this.deg(Math.atan2(fy, fx)), speed: Constants.MAX_SPEED * 0.6 };
    }

    if (this.effectiveMovement() === "minRisk" && this.posture !== "engage") {
      const target = lowestRiskPoint(me, this.riskEnemies(), this.arena());
      return { heading: this.deg(Math.atan2(target.y - me.y, target.x - me.x)), speed };
    }

    const packBase = this.posture === "retreat" ? 2.4 : this.posture === "engage" ? 0.6 : 1.1;
    for (const en of enemies) {
      const dx = en.x - me.x;
      const dy = en.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      const proximity = Math.max(0.5, Math.min(2.5, 250 / d));
      const threat = Math.max(0.3, Math.min(2.0, en.energy / 50));
      const w = packBase * proximity * threat;
      fx -= (dx / d) * w;
      fy -= (dy / d) * w;
    }

    const primary = this.primaryTarget()!;
    const pdx = primary.x - me.x;
    const pdy = primary.y - me.y;
    const pd = Math.hypot(pdx, pdy) || 1;
    const tang = this.posture === "retreat" ? 0.4 : 1.2;
    fx += (-pdy / pd) * this.orbitDir * tang;
    fy += (pdx / pd) * this.orbitDir * tang;
    if (this.posture === "engage") {
      fx += (pdx / pd) * 0.9;
      fy += (pdy / pd) * 0.9;
    }

    const move = this.effectiveMovement();
    if (move === "stopAndGo") {
      const moving = Math.floor(this.getTurnNumber() / STOP_GO_PERIOD) % 2 === 0;
      speed = moving ? Constants.MAX_SPEED : 0;
    } else if (move === "randomWalk") {
      if (this.getTurnNumber() % WANDER_PERIOD === 0) this.wanderHeading = Math.random() * 360;
      fx += Math.cos(this.rad(this.wanderHeading)) * 0.6;
      fy += Math.sin(this.rad(this.wanderHeading)) * 0.6;
    }
    return { heading: this.deg(Math.atan2(fy, fx)), speed };
  }

  private riskEnemies(): { x: number; y: number; energy: number }[] {
    return this.livingEnemies().map((e) => ({ x: e.x, y: e.y, energy: e.energy }));
  }

  private arena(): { width: number; height: number } {
    return { width: this.getArenaWidth(), height: this.getArenaHeight() };
  }

  private wallForce(): [number, number] {
    const margin = 150;
    const strength = 2.0;
    const x = this.getX();
    const y = this.getY();
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    let fx = 0;
    let fy = 0;
    if (x < margin) fx += strength * ((margin - x) / margin) ** 2;
    if (w - x < margin) fx -= strength * ((margin - (w - x)) / margin) ** 2;
    if (y < margin) fy += strength * ((margin - y) / margin) ** 2;
    if (h - y < margin) fy -= strength * ((margin - (h - y)) / margin) ** 2;
    return [fx, fy];
  }

  private steer(headingDeg: number, speed: number) {
    let turn = normalizeRelative(headingDeg - this.getDirection());
    let sp = speed;
    if (Math.abs(turn) > 90) {
      turn = normalizeRelative(turn - 180);
      sp = -speed;
    }
    const max = Constants.MAX_TURN_RATE;
    this.setTurnRate(Math.max(-max, Math.min(max, turn)));
    this.setTargetSpeed(sp);
  }

  override onScannedBot(e: ScannedBotEvent) {
    const old = this.enemies.get(e.scannedBotId);
    this.enemies.set(e.scannedBotId, {
      id: e.scannedBotId,
      x: e.x,
      y: e.y,
      direction: e.direction,
      speed: e.speed,
      energy: e.energy,
      turn: this.getTurnNumber(),
      prevDirection: old ? old.direction : null,
      prevTurn: old ? old.turn : null,
    });
    this.scannedThisWindow = true;
    this.maybeDodge(old, e);
  }

  private maybeDodge(old: Scan | undefined, e: ScannedBotEvent) {
    if (old === undefined || this.getTurnNumber() < this.dodgeCooldownUntil) return;
    const drop = old.energy - e.energy;
    if (drop < 0.1 || drop > 3.0) return;
    if (distance({ x: this.getX(), y: this.getY() }, { x: e.x, y: e.y }) > 500) return;
    this.orbitDir = (this.orbitDir * -1) as 1 | -1;
    this.dodgeCooldownUntil = this.getTurnNumber() + 8;
  }

  override onBotDeath(e: BotDeathEvent) {
    this.enemies.delete(e.victimId);
  }

  override onHitByBullet(_e: HitByBulletEvent) {
    this.orbitDir = (this.orbitDir * -1) as 1 | -1;
  }

  override onHitWall(_e: HitWallEvent) {
    this.orbitDir = (this.orbitDir * -1) as 1 | -1;
    this.wanderHeading = Math.random() * 360;
  }

  override onHitBot(e: HitBotEvent) {
    if (!e.isRammed && this.getGunHeat() === 0 && (this.combo.movement === "ram" || e.energy < FINISH_ENERGY)) {
      this.setFire(3);
    } else {
      this.orbitDir = (this.orbitDir * -1) as 1 | -1;
    }
  }

  private clampRadar(rate: number): number {
    const max = Constants.MAX_RADAR_TURN_RATE;
    return Math.max(-max, Math.min(max, rate));
  }

  private rad(deg: number): number {
    return (deg * Math.PI) / 180;
  }

  private deg(rad: number): number {
    return (rad * 180) / Math.PI;
  }
}

SophieBot.main();
