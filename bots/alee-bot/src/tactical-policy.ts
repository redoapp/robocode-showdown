import { readFileSync } from "node:fs";
import { clamp } from "./combat-state.ts";
import type { OpponentState, SelfState } from "./combat-state.ts";

export type TacticalPolicyConfig = Readonly<{
  schemaVersion: 1;
  policyId: string;
  decisionInterval: number;
  preferredRange: number;
  dangerAversion: number;
  antiRamDistance: number;
  powerBias: number;
}>;

export type TacticalAction = Readonly<{
  preferredRange: number;
  dangerAversion: number;
  antiRamDistance: number;
  powerBias: number;
}>;

export const DEFAULT_TACTICAL_POLICY = validateTacticalPolicy(
  JSON.parse(readFileSync(new URL("../config/tactical-default.json", import.meta.url), "utf8")),
);

export function validateTacticalPolicy(input: unknown): TacticalPolicyConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tactical policy must be an object");
  }
  const config = input as Partial<TacticalPolicyConfig>;
  if (config.schemaVersion !== 1 || typeof config.policyId !== "string" || config.policyId.trim().length === 0) {
    throw new Error("invalid tactical policy identity");
  }
  const decisionInterval = config.decisionInterval;
  const preferredRange = config.preferredRange;
  const dangerAversion = config.dangerAversion;
  const antiRamDistance = config.antiRamDistance;
  const powerBias = config.powerBias;
  if (typeof decisionInterval !== "number" || !Number.isSafeInteger(decisionInterval) || decisionInterval < 8 || decisionInterval > 20) {
    throw new Error("tactical decision interval must be 8..20 turns");
  }
  if (typeof preferredRange !== "number" || !(preferredRange >= 180 && preferredRange <= 500)) throw new Error("invalid preferred range");
  if (typeof dangerAversion !== "number" || !(dangerAversion >= 0.5 && dangerAversion <= 2)) throw new Error("invalid danger aversion");
  if (typeof antiRamDistance !== "number" || !(antiRamDistance >= 80 && antiRamDistance <= 180)) throw new Error("invalid anti-ram distance");
  if (typeof powerBias !== "number" || !(powerBias >= 0.7 && powerBias <= 1.3)) throw new Error("invalid power bias");
  return Object.freeze({
    schemaVersion: 1,
    policyId: config.policyId,
    decisionInterval,
    preferredRange,
    dangerAversion,
    antiRamDistance,
    powerBias,
  });
}

export class TacticalPolicy {
  private config = DEFAULT_TACTICAL_POLICY;
  private cachedAction: TacticalAction | undefined;
  private nextDecisionTurn = Number.NEGATIVE_INFINITY;

  load(path = process.env.ALEE_TACTICAL_POLICY_PATH) {
    if (!path) return false;
    this.config = validateTacticalPolicy(JSON.parse(readFileSync(path, "utf8")));
    return true;
  }

  resetRound() {
    this.cachedAction = undefined;
    this.nextDecisionTurn = Number.NEGATIVE_INFINITY;
  }

  decide(self: SelfState, opponent: OpponentState) {
    if (this.cachedAction && self.turnNumber < this.nextDecisionTurn) return this.cachedAction;
    const energyLead = clamp((self.energy - opponent.energy) / 100, -1, 1);
    const rangeScale = 1 - 0.12 * energyLead;
    this.cachedAction = Object.freeze({
      preferredRange: clamp(this.config.preferredRange * rangeScale, 180, 500),
      dangerAversion: this.config.dangerAversion * (self.energy < 25 ? 1.15 : 1),
      antiRamDistance: this.config.antiRamDistance,
      powerBias: this.config.powerBias * (energyLead < -0.35 ? 0.9 : 1),
    });
    this.nextDecisionTurn = self.turnNumber + this.config.decisionInterval;
    return this.cachedAction;
  }

  getConfig() {
    return this.config;
  }
}
