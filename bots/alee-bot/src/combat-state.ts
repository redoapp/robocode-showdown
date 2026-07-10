export const BOT_RADIUS = 18;
export const MAX_BOT_SPEED = 8;

export type Point = Readonly<{ x: number; y: number }>;

export type SelfState = Readonly<{
  roundNumber: number;
  turnNumber: number;
  botId: number;
  x: number;
  y: number;
  direction: number;
  gunDirection: number;
  radarDirection: number;
  speed: number;
  energy: number;
  arenaWidth: number;
  arenaHeight: number;
  enemyCount: number;
}>;

export type ScanObservation = Readonly<{
  turnNumber: number;
  scannedBotId: number;
  energy: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
}>;

export type OpponentState = Readonly<{
  id: number;
  turnNumber: number;
  energy: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
  acceleration: number;
  turnRate: number;
  timeSinceDirectionChange: number;
  timeSinceVelocityChange: number;
}>;

export type FriendlyWaveKind = "real" | "virtual";

export type FriendlyWave = Readonly<{
  id: number;
  schemaVersion: 2;
  kind: FriendlyWaveKind;
  opponentId: number;
  fireTurn: number;
  origin: Point;
  headOnBearing: number;
  selectedAimAngle: number;
  selectedGun: string;
  collectForTraining: boolean;
  lateralDirection: -1 | 1;
  bulletPower: number;
  bulletSpeed: number;
  maxEscapeAngle: number;
  features: readonly number[];
}>;

export type CreateFriendlyWave = Omit<FriendlyWave, "id" | "schemaVersion" | "bulletSpeed" | "maxEscapeAngle">;

export type ResolvedFriendlyWave = Readonly<{
  wave: FriendlyWave;
  resolvedTurn: number;
  target: Point;
  guessFactor: number;
  label: number;
}>;

export type ScanUpdate = Readonly<{
  opponent: OpponentState;
  resolvedWaves: readonly ResolvedFriendlyWave[];
  inferredEnemyWaves: readonly EnemyWave[];
}>;

export type EnemyWave = Readonly<{
  id: number;
  shooterId: number;
  fireTurn: number;
  origin: Point;
  directAngle: number;
  lateralDirection: -1 | 1;
  bulletPower: number;
  bulletSpeed: number;
  maxEscapeAngle: number;
}>;

export type ResolvedEnemyWave = Readonly<{
  wave: EnemyWave;
  turnNumber: number;
  position: Point;
  guessFactor: number;
}>;

type OpponentTrack = {
  history: OpponentState[];
  lastDirectionChangeTurn: number;
  lastVelocityChangeTurn: number;
};

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function normalizeRelativeAngle(angle: number) {
  let normalized = angle;
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return normalized;
}

export function absoluteBearing(from: Point, to: Point) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

export function distance(from: Point, to: Point) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function bulletSpeed(power: number) {
  return 20 - 3 * power;
}

export function maximumEscapeAngle(speed: number) {
  return (Math.asin(MAX_BOT_SPEED / speed) * 180) / Math.PI;
}

export function guessFactorToBin(guessFactor: number, bins: number) {
  return Math.round(((clamp(guessFactor, -1, 1) + 1) / 2) * (bins - 1));
}

export function binToGuessFactor(bin: number, bins: number) {
  if (!Number.isInteger(bin) || bin < 0 || bin >= bins) throw new RangeError(`bin ${bin} outside 0..${bins - 1}`);
  return (bin / (bins - 1)) * 2 - 1;
}

export function lateralDirection(opponent: Pick<OpponentState, "direction" | "speed">, bearing: number): -1 | 1 {
  const lateral = Math.sin(((opponent.direction - bearing) * Math.PI) / 180) * opponent.speed;
  return lateral < 0 ? -1 : 1;
}

export function distanceToWallAlongHeading(
  point: Point,
  headingDegrees: number,
  arenaWidth: number,
  arenaHeight: number,
  margin = BOT_RADIUS,
) {
  const radians = (headingDegrees * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const minX = margin;
  const maxX = arenaWidth - margin;
  const minY = margin;
  const maxY = arenaHeight - margin;
  const candidates: number[] = [];
  if (dx > 1e-9) candidates.push((maxX - point.x) / dx);
  else if (dx < -1e-9) candidates.push((minX - point.x) / dx);
  if (dy > 1e-9) candidates.push((maxY - point.y) / dy);
  else if (dy < -1e-9) candidates.push((minY - point.y) / dy);
  return Math.max(0, Math.min(...candidates.filter((value) => value >= 0)));
}

function interpolate(from: OpponentState, to: OpponentState, turn: number): Point {
  if (to.turnNumber === from.turnNumber) return { x: to.x, y: to.y };
  const ratio = clamp((turn - from.turnNumber) / (to.turnNumber - from.turnNumber), 0, 1);
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
}

function waveHasReached(wave: FriendlyWave, target: Point, turn: number) {
  return (turn - wave.fireTurn) * wave.bulletSpeed >= distance(wave.origin, target);
}

function resolveIntersection(wave: FriendlyWave, previous: OpponentState | undefined, current: OpponentState) {
  if (!previous || previous.turnNumber >= current.turnNumber || previous.turnNumber < wave.fireTurn) {
    return { turn: current.turnNumber, target: { x: current.x, y: current.y } };
  }

  let low = previous.turnNumber;
  let high = current.turnNumber;
  if (waveHasReached(wave, interpolate(previous, current, low), low)) {
    return { turn: low, target: interpolate(previous, current, low) };
  }
  for (let index = 0; index < 24; index += 1) {
    const middle = (low + high) / 2;
    if (waveHasReached(wave, interpolate(previous, current, middle), middle)) high = middle;
    else low = middle;
  }
  return { turn: high, target: interpolate(previous, current, high) };
}

export class CombatState {
  private readonly opponents = new Map<number, OpponentTrack>();
  private friendlyWaves: FriendlyWave[] = [];
  private enemyWaves: EnemyWave[] = [];
  private readonly knownEnergyLosses = new Map<number, Array<{ turnNumber: number; amount: number }>>();
  private nextWaveId = 1;
  private nextEnemyWaveId = 1;
  private roundNumber = 0;

  resetRound(roundNumber: number) {
    this.roundNumber = roundNumber;
    this.opponents.clear();
    this.friendlyWaves = [];
    this.enemyWaves = [];
    this.knownEnergyLosses.clear();
    this.nextWaveId = 1;
    this.nextEnemyWaveId = 1;
  }

  getRoundNumber() {
    return this.roundNumber;
  }

  observeScan(scan: ScanObservation, bins: number, self?: SelfState): ScanUpdate {
    const track = this.opponents.get(scan.scannedBotId);
    const previous = track?.history.at(-1);
    const elapsed = previous ? Math.max(1, scan.turnNumber - previous.turnNumber) : 1;
    const directionDelta = previous ? normalizeRelativeAngle(scan.direction - previous.direction) : 0;
    const speedDelta = previous ? scan.speed - previous.speed : 0;
    const lastDirectionChangeTurn = !track || Math.abs(directionDelta) > 0.01
      ? scan.turnNumber
      : track.lastDirectionChangeTurn;
    const lastVelocityChangeTurn = !track || Math.abs(speedDelta) > 0.01
      ? scan.turnNumber
      : track.lastVelocityChangeTurn;
    const opponent: OpponentState = Object.freeze({
      id: scan.scannedBotId,
      turnNumber: scan.turnNumber,
      energy: scan.energy,
      x: scan.x,
      y: scan.y,
      direction: scan.direction,
      speed: scan.speed,
      acceleration: clamp(speedDelta / elapsed, -2, 1),
      turnRate: directionDelta / elapsed,
      timeSinceDirectionChange: scan.turnNumber - lastDirectionChangeTurn,
      timeSinceVelocityChange: scan.turnNumber - lastVelocityChangeTurn,
    });

    const inferredEnemyWaves: EnemyWave[] = [];
    if (previous && self) {
      const knownLosses = this.knownEnergyLosses.get(opponent.id) ?? [];
      const knownDamage = knownLosses
        .filter((loss) => loss.turnNumber > previous.turnNumber && loss.turnNumber <= scan.turnNumber)
        .reduce((sum, loss) => sum + loss.amount, 0);
      this.knownEnergyLosses.set(opponent.id, knownLosses.filter((loss) => loss.turnNumber > scan.turnNumber));
      const inferredPower = previous.energy - opponent.energy - knownDamage;
      if (inferredPower >= 0.099 && inferredPower <= 3.001) {
        const power = clamp(inferredPower, 0.1, 3);
        const origin = { x: previous.x, y: previous.y };
        const directAngle = absoluteBearing(origin, self);
        const ourLateralVelocity = Math.sin(((self.direction - directAngle) * Math.PI) / 180) * self.speed;
        const speed = bulletSpeed(power);
        const wave: EnemyWave = Object.freeze({
          id: this.nextEnemyWaveId++,
          shooterId: opponent.id,
          fireTurn: Math.max(previous.turnNumber, scan.turnNumber - 1),
          origin: Object.freeze(origin),
          directAngle,
          lateralDirection: ourLateralVelocity < 0 ? -1 : 1,
          bulletPower: power,
          bulletSpeed: speed,
          maxEscapeAngle: maximumEscapeAngle(speed),
        });
        this.enemyWaves.push(wave);
        inferredEnemyWaves.push(wave);
      }
    }

    const resolvedWaves: ResolvedFriendlyWave[] = [];
    const pending: FriendlyWave[] = [];
    for (const wave of this.friendlyWaves) {
      if (wave.opponentId !== opponent.id || !waveHasReached(wave, opponent, scan.turnNumber)) {
        pending.push(wave);
        continue;
      }
      const intersection = resolveIntersection(wave, previous, opponent);
      const arrivalBearing = absoluteBearing(wave.origin, intersection.target);
      const offset = normalizeRelativeAngle(arrivalBearing - wave.headOnBearing);
      const guessFactor = clamp(offset / (wave.maxEscapeAngle * wave.lateralDirection), -1, 1);
      resolvedWaves.push(Object.freeze({
        wave,
        resolvedTurn: intersection.turn,
        target: Object.freeze(intersection.target),
        guessFactor,
        label: guessFactorToBin(guessFactor, bins),
      }));
    }
    this.friendlyWaves = pending;

    const nextTrack: OpponentTrack = track ?? {
      history: [],
      lastDirectionChangeTurn,
      lastVelocityChangeTurn,
    };
    nextTrack.lastDirectionChangeTurn = lastDirectionChangeTurn;
    nextTrack.lastVelocityChangeTurn = lastVelocityChangeTurn;
    nextTrack.history.push(opponent);
    if (nextTrack.history.length > 64) nextTrack.history.shift();
    this.opponents.set(opponent.id, nextTrack);
    return Object.freeze({
      opponent,
      resolvedWaves: Object.freeze(resolvedWaves),
      inferredEnemyWaves: Object.freeze(inferredEnemyWaves),
    });
  }

  createFriendlyWave(input: CreateFriendlyWave) {
    const speed = bulletSpeed(input.bulletPower);
    const wave: FriendlyWave = Object.freeze({
      ...input,
      id: this.nextWaveId++,
      schemaVersion: 2,
      bulletSpeed: speed,
      maxEscapeAngle: maximumEscapeAngle(speed),
      features: Object.freeze([...input.features]),
      origin: Object.freeze({ ...input.origin }),
    });
    this.friendlyWaves.push(wave);
    return wave;
  }

  removeOpponent(opponentId: number) {
    this.opponents.delete(opponentId);
    this.friendlyWaves = this.friendlyWaves.filter((wave) => wave.opponentId !== opponentId);
    this.enemyWaves = this.enemyWaves.filter((wave) => wave.shooterId !== opponentId);
    this.knownEnergyLosses.delete(opponentId);
  }

  recordKnownEnergyLoss(opponentId: number, turnNumber: number, amount: number) {
    if (!(amount > 0)) return;
    const losses = this.knownEnergyLosses.get(opponentId) ?? [];
    losses.push({ turnNumber, amount });
    this.knownEnergyLosses.set(opponentId, losses);
  }

  activeEnemyWaves(self: SelfState) {
    this.enemyWaves = this.enemyWaves.filter((wave) => {
      const radius = (self.turnNumber - wave.fireTurn) * wave.bulletSpeed;
      return radius <= distance(wave.origin, self) + 80;
    });
    return [...this.enemyWaves];
  }

  resolveEnemyBullet(
    turnNumber: number,
    ownerId: number,
    power: number,
    position: Point,
  ): ResolvedEnemyWave | undefined {
    let bestIndex = -1;
    let bestError = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.enemyWaves.length; index += 1) {
      const wave = this.enemyWaves[index];
      if (wave.shooterId !== ownerId || Math.abs(wave.bulletPower - power) > 0.15) continue;
      const radius = (turnNumber - wave.fireTurn) * wave.bulletSpeed;
      const error = Math.abs(radius - distance(wave.origin, position));
      if (error < bestError) {
        bestError = error;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestError > 80) return undefined;
    const [wave] = this.enemyWaves.splice(bestIndex, 1);
    const offset = normalizeRelativeAngle(absoluteBearing(wave.origin, position) - wave.directAngle);
    const guessFactor = clamp(offset / (wave.maxEscapeAngle * wave.lateralDirection), -1, 1);
    return Object.freeze({ wave, turnNumber, position: Object.freeze({ ...position }), guessFactor });
  }

  getOpponent(opponentId: number) {
    return this.opponents.get(opponentId)?.history.at(-1);
  }

  getPreviousOpponent(opponentId: number) {
    return this.opponents.get(opponentId)?.history.at(-2);
  }

  getOpponents() {
    return [...this.opponents.values()].map((track) => track.history.at(-1)!).filter(Boolean);
  }

  getPendingFriendlyWaves() {
    return [...this.friendlyWaves];
  }
}
