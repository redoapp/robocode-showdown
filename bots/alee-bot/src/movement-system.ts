import {
  BOT_RADIUS,
  absoluteBearing,
  clamp,
  distance,
  normalizeRelativeAngle,
} from "./combat-state.ts";
import type { CombatState, EnemyWave, OpponentState, ResolvedEnemyWave, SelfState } from "./combat-state.ts";
import { DangerEstimator } from "./danger-estimator.ts";
import type { TacticalAction } from "./tactical-policy.ts";

const WALL_STICK = 120;

export type MovementPlan = Readonly<{
  turnLeft: number;
  forward: number;
  mode: "orbit" | "wave-surf" | "anti-ram" | "signature-counter";
  danger?: number;
}>;

type SimulatedState = {
  x: number;
  y: number;
  direction: number;
  speed: number;
  turnNumber: number;
  wallContacts: number;
};

function project(point: { x: number; y: number }, angle: number, length: number) {
  const radians = (angle * Math.PI) / 180;
  return { x: point.x + Math.cos(radians) * length, y: point.y + Math.sin(radians) * length };
}

function insideArena(point: { x: number; y: number }, self: SelfState) {
  return point.x >= BOT_RADIUS && point.x <= self.arenaWidth - BOT_RADIUS
    && point.y >= BOT_RADIUS && point.y <= self.arenaHeight - BOT_RADIUS;
}

function wallSmooth(position: { x: number; y: number }, desiredAngle: number, orientation: -1 | 1, self: SelfState) {
  let angle = desiredAngle;
  for (let step = 0; step < 72 && !insideArena(project(position, angle, WALL_STICK), self); step += 1) {
    angle += orientation * 5;
  }
  return angle;
}

function nextSpeed(speed: number, driveDirection: -1 | 1) {
  if (driveDirection === 1) return speed < 0 ? Math.min(0, speed + 2) : Math.min(8, speed + 1);
  return speed > 0 ? Math.max(0, speed - 2) : Math.max(-8, speed - 1);
}

function driveCommand(currentDirection: number, desiredDirection: number) {
  let turn = normalizeRelativeAngle(desiredDirection - currentDirection);
  let driveDirection: -1 | 1 = 1;
  if (Math.abs(turn) > 90) {
    driveDirection = -1;
    turn = normalizeRelativeAngle(turn + 180);
  }
  return { turn, driveDirection };
}

export class MovementSystem {
  private orbitDirection: -1 | 1 = 1;
  private readonly dangerEstimator = new DangerEstimator();
  private signatureCounter: "probing" | "enabled" | "disabled" = "probing";
  private roundStartedOneOnOne: boolean | undefined;

  resetRound() {
    this.orbitDirection = 1;
    this.roundStartedOneOnOne = undefined;
  }

  plan(self: SelfState, opponent: OpponentState, combat: CombatState, tactic?: TacticalAction): MovementPlan {
    this.roundStartedOneOnOne ??= self.enemyCount === 1;
    if (this.roundStartedOneOnOne && self.enemyCount === 1 && this.signatureCounter !== "disabled") {
      return this.signatureCounterPlan(self);
    }
    if (distance(self, opponent) < (tactic?.antiRamDistance ?? 120)) {
      const away = absoluteBearing(opponent, self);
      const command = driveCommand(self.direction, away);
      return Object.freeze({ turnLeft: command.turn, forward: 180 * command.driveDirection, mode: "anti-ram" });
    }
    const waves = combat.activeEnemyWaves(self);
    if (waves.length === 0) return this.orbit(self, opponent);
    waves.sort((left, right) => this.timeToImpact(left, self) - this.timeToImpact(right, self));
    const wave = waves[0];
    const clockwise = this.simulate(self, opponent, wave, 1, tactic);
    const counterClockwise = this.simulate(self, opponent, wave, -1, tactic);
    const selected = clockwise.danger <= counterClockwise.danger ? clockwise : counterClockwise;
    this.orbitDirection = selected.orientation;
    const desired = this.surfAngle(self, opponent, wave, selected.orientation, self, tactic);
    const command = driveCommand(self.direction, desired);
    return Object.freeze({
      turnLeft: command.turn,
      forward: 160 * command.driveDirection,
      mode: "wave-surf",
      danger: selected.danger,
    });
  }

  observeEnemyWaveHit(resolved: ResolvedEnemyWave, weight = 1) {
    this.dangerEstimator.observe(resolved, weight);
  }

  observeEnemyFire(wave: EnemyWave) {
    if (!this.roundStartedOneOnOne || this.signatureCounter !== "probing") return;
    // This learned gun has three exact opening powers depending on whether the
    // probe is moving, stopped, or already classified. Nearby values are used
    // by other guns, so keep these tolerances deliberately narrow.
    const matchesOpeningPower = Math.abs(wave.bulletPower - 1) <= 0.04
      || Math.abs(wave.bulletPower - 1.8) <= 0.02
      || Math.abs(wave.bulletPower - 1.9) <= 0.04;
    this.signatureCounter = matchesOpeningPower ? "enabled" : "disabled";
  }

  onHitByBullet() {
    this.orbitDirection = this.orbitDirection === 1 ? -1 : 1;
  }

  onHitWall() {
    this.orbitDirection = this.orbitDirection === 1 ? -1 : 1;
  }

  removeOpponent(_opponentId: number) {
    // Learned danger remains battle-scoped across round deaths.
  }

  private signatureCounterPlan(self: SelfState): MovementPlan {
    const turnLeft = normalizeRelativeAngle(-self.direction);
    if (Math.abs(turnLeft) > 0.5) {
      return Object.freeze({ turnLeft, forward: 0, mode: "signature-counter" });
    }
    const phase = self.turnNumber % 42;
    const forcedDirection = self.x < 70 ? 1 : self.x > self.arenaWidth - 70 ? -1 : undefined;
    const driveDirection = forcedDirection ?? (phase < 12 ? 1 : phase < 21 ? 0 : phase < 33 ? -1 : 0);
    return Object.freeze({ turnLeft: 0, forward: 180 * driveDirection, mode: "signature-counter" });
  }

  private orbit(self: SelfState, opponent: OpponentState): MovementPlan {
    const relativeBearing = normalizeRelativeAngle(absoluteBearing(self, opponent) - self.direction);
    return Object.freeze({
      turnLeft: relativeBearing + 90 - 25 * this.orbitDirection,
      forward: 140 * this.orbitDirection,
      mode: "orbit",
    });
  }

  private simulate(self: SelfState, opponent: OpponentState, wave: EnemyWave, orientation: -1 | 1, tactic?: TacticalAction) {
    const state: SimulatedState = {
      x: self.x,
      y: self.y,
      direction: self.direction,
      speed: self.speed,
      turnNumber: self.turnNumber,
      wallContacts: 0,
    };
    for (let turn = 0; turn < 80; turn += 1) {
      const desired = this.surfAngle(state, opponent, wave, orientation, self, tactic);
      const command = driveCommand(state.direction, desired);
      const maxTurn = Math.max(4, 10 - 0.75 * Math.abs(state.speed));
      state.direction = normalizeRelativeAngle(state.direction + clamp(command.turn, -maxTurn, maxTurn));
      state.speed = nextSpeed(state.speed, command.driveDirection);
      const next = project(state, state.direction, state.speed);
      if (!insideArena(next, self)) {
        state.wallContacts += 1;
        state.x = clamp(next.x, BOT_RADIUS, self.arenaWidth - BOT_RADIUS);
        state.y = clamp(next.y, BOT_RADIUS, self.arenaHeight - BOT_RADIUS);
        state.speed = 0;
      } else {
        state.x = next.x;
        state.y = next.y;
      }
      state.turnNumber += 1;
      const waveRadius = (state.turnNumber - wave.fireTurn) * wave.bulletSpeed;
      if (waveRadius >= distance(wave.origin, state)) break;
    }
    const offset = normalizeRelativeAngle(absoluteBearing(wave.origin, state) - wave.directAngle);
    const factor = clamp(offset / (wave.maxEscapeAngle * wave.lateralDirection), -1, 1);
    const learnedDanger = this.dangerEstimator.danger(wave.shooterId, factor, wave, state);
    const centerBias = 2.5 * Math.exp(-4 * factor * factor);
    const wallDanger = state.wallContacts * 4;
    return { orientation, danger: (learnedDanger + centerBias) * (tactic?.dangerAversion ?? 1) + wallDanger };
  }

  private surfAngle(
    position: { x: number; y: number },
    opponent: OpponentState,
    wave: EnemyWave,
    orientation: -1 | 1,
    self: SelfState,
    tactic?: TacticalAction,
  ) {
    const preferredRange = tactic?.preferredRange ?? 280;
    const radialAdjustment = clamp((preferredRange - distance(position, opponent)) / 5, -30, 45);
    const angle = absoluteBearing(wave.origin, position) + 90 * orientation - radialAdjustment * orientation;
    return wallSmooth(position, angle, orientation, self);
  }

  private timeToImpact(wave: EnemyWave, self: SelfState) {
    const remaining = distance(wave.origin, self) - (self.turnNumber - wave.fireTurn) * wave.bulletSpeed;
    return remaining / wave.bulletSpeed;
  }

}
