import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResolvedFriendlyWave } from "./combat-state.js";
import { FEATURE_COUNT, FEATURE_SCHEMA_VERSION, GUESS_FACTOR_BINS } from "./learning-system.js";

export type WaveOutcomeRecord = Readonly<{
  recordType: "wave-outcome";
  schemaVersion: 2;
  runId: string;
  roundNumber: number;
  opponentId: number;
  waveId: number;
  waveKind: "real" | "virtual";
  fireTurn: number;
  resolvedTurn: number;
  headOnBearing: number;
  selectedAimAngle: number;
  selectedGun: string;
  bulletPower: number;
  bulletSpeed: number;
  lateralDirection: -1 | 1;
  guessFactor: number;
  label: number;
  features: readonly number[];
}>;

export type RunManifest = Readonly<{
  schemaVersion: 2;
  runId: string;
  createdAt: string;
  featureSchemaVersion: 2;
  featureCount: number;
  guessFactorBins: number;
  repositoryCommit: string;
  repositoryDirty: boolean | "unknown";
  trainer: string;
  botVersion: string;
  opponents: readonly string[];
  collectionMode: "real-and-virtual";
}>;

export type RoundDiagnostics = Readonly<{
  recordType: "round-diagnostics";
  schemaVersion: 1;
  runId?: string;
  roundNumber: number;
  endTurn: number;
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
  movementModes: Readonly<Record<string, number>>;
  selectedGuns: Readonly<Record<string, number>>;
}>;

function safeRunId(value: string) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!sanitized) throw new Error("telemetry run id cannot be empty");
  return sanitized;
}

export class TelemetryCollector {
  private readonly enabled: boolean;
  private readonly runId: string;
  private readonly outcomePath: string | undefined;
  private readonly diagnosticsPath: string | undefined;
  private records: WaveOutcomeRecord[] = [];
  private diagnostics: RoundDiagnostics[] = [];

  constructor(trainingDirectory: string, enabled: boolean) {
    this.enabled = enabled;
    this.runId = safeRunId(process.env.ALEE_RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
    if (!enabled) return;

    const runDirectory = join(trainingDirectory, "runs", this.runId);
    mkdirSync(runDirectory, { recursive: true });
    this.outcomePath = join(runDirectory, "wave-outcomes-000.jsonl");
    this.diagnosticsPath = join(runDirectory, "round-diagnostics.jsonl");
    const manifest: RunManifest = Object.freeze({
      schemaVersion: 2,
      runId: this.runId,
      createdAt: new Date().toISOString(),
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureCount: FEATURE_COUNT,
      guessFactorBins: GUESS_FACTOR_BINS,
      repositoryCommit: process.env.ALEE_REPOSITORY_COMMIT ?? "unknown",
      repositoryDirty: process.env.ALEE_REPOSITORY_DIRTY === "true"
        ? true
        : process.env.ALEE_REPOSITORY_DIRTY === "false" ? false : "unknown",
      trainer: process.env.ALEE_TRAINER ?? "pytorch-or-none",
      botVersion: process.env.BOT_VERSION ?? "unknown",
      opponents: Object.freeze((process.env.ALEE_OPPONENTS ?? "").split(",").map((name) => name.trim()).filter(Boolean)),
      collectionMode: "real-and-virtual",
    });
    writeFileSync(join(runDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  record(roundNumber: number, resolved: ResolvedFriendlyWave) {
    if (!this.enabled) return;
    if (resolved.wave.schemaVersion !== 2 || resolved.wave.features.length !== FEATURE_COUNT) {
      throw new Error("refusing to record an incompatible wave outcome");
    }
    this.records.push(Object.freeze({
      recordType: "wave-outcome",
      schemaVersion: 2,
      runId: this.runId,
      roundNumber,
      opponentId: resolved.wave.opponentId,
      waveId: resolved.wave.id,
      waveKind: resolved.wave.kind,
      fireTurn: resolved.wave.fireTurn,
      resolvedTurn: resolved.resolvedTurn,
      headOnBearing: resolved.wave.headOnBearing,
      selectedAimAngle: resolved.wave.selectedAimAngle,
      selectedGun: resolved.wave.selectedGun,
      bulletPower: resolved.wave.bulletPower,
      bulletSpeed: resolved.wave.bulletSpeed,
      lateralDirection: resolved.wave.lateralDirection,
      guessFactor: resolved.guessFactor,
      label: resolved.label,
      features: resolved.wave.features,
    }));
  }

  recordRound(diagnostics: Omit<RoundDiagnostics, "recordType" | "schemaVersion" | "runId">) {
    if (!this.enabled) return;
    this.diagnostics.push(Object.freeze({
      ...diagnostics,
      recordType: "round-diagnostics",
      schemaVersion: 1,
      runId: this.runId,
      movementModes: Object.freeze({ ...diagnostics.movementModes }),
      selectedGuns: Object.freeze({ ...diagnostics.selectedGuns }),
    }));
  }

  flush() {
    if (!this.enabled) return;
    if (this.outcomePath && this.records.length > 0) {
      appendFileSync(this.outcomePath, `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      this.records = [];
    }
    if (this.diagnosticsPath && this.diagnostics.length > 0) {
      appendFileSync(this.diagnosticsPath, `${this.diagnostics.map((record) => JSON.stringify(record)).join("\n")}\n`);
      this.diagnostics = [];
    }
  }
}
