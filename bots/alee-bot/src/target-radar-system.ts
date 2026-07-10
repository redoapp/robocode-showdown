import { CombatState, OpponentState, SelfState, distance, normalizeRelativeAngle } from "./combat-state.js";

export class TargetRadarSystem {
  private targetId: number | undefined;

  resetRound() {
    this.targetId = undefined;
  }

  selectTarget(combat: CombatState, self: SelfState) {
    const candidates = combat.getOpponents().filter((opponent) => self.turnNumber - opponent.turnNumber <= 12);
    candidates.sort((left, right) => this.threatScore(self, right) - this.threatScore(self, left));
    this.targetId = candidates[0]?.id;
    return this.targetId;
  }

  getTargetId() {
    return this.targetId;
  }

  radarTurn(self: SelfState, scanned: OpponentState) {
    const bearing = (Math.atan2(scanned.y - self.y, scanned.x - self.x) * 180) / Math.PI;
    const radarBearing = normalizeRelativeAngle(bearing - self.radarDirection);
    return scanned.id === this.targetId ? radarBearing * 2 : radarBearing;
  }

  removeOpponent(opponentId: number) {
    if (this.targetId === opponentId) this.targetId = undefined;
  }

  private threatScore(self: SelfState, opponent: OpponentState) {
    const recency = Math.max(0, 12 - (self.turnNumber - opponent.turnNumber)) * 25;
    const proximity = Math.max(0, 1200 - distance(self, opponent));
    const weakness = Math.max(0, 100 - opponent.energy) * 2;
    return recency + proximity + weakness;
  }
}
