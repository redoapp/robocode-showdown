#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertArtifactSnapshotUnchanged,
  atomicReplaceDirectory,
  copyArtifact,
  inspectCandidateArtifacts,
  sha256File,
  snapshotArtifactFiles,
  verifyHashedArtifacts,
  writeJson,
} from "./lib/artifacts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOT_DIR = join(ROOT, "bots", "alee-bot");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const candidateId = option("--candidate") ?? args.find((argument) => !argument.startsWith("--"));
if (!candidateId) throw new Error("Usage: node scripts/promote-bot.mjs --candidate <candidate-id-or-directory>");
const candidateDirectory = candidateId.includes("/") ? resolve(candidateId) : join(BOT_DIR, "training", "candidates", candidateId);
const candidate = inspectCandidateArtifacts(candidateDirectory);
const { manifest, offlineReport: offline } = candidate;
if (!candidate.provenanceEligible) {
  throw new Error(`candidate provenance is incomplete: ${candidate.provenanceIssues.join("; ")}`);
}
if (!offline.eligibleForBattleEvaluation) throw new Error("candidate failed offline eligibility");

const evaluationPath = option("--evaluation")
  ? resolve(option("--evaluation"))
  : join(candidateDirectory, "evaluation-report.json");
if (!existsSync(evaluationPath)) throw new Error("candidate has no evaluation report");
const evaluation = JSON.parse(readFileSync(evaluationPath, "utf8"));
if (evaluation.reportVersion !== 2) throw new Error("evaluation report predates incumbent/provenance promotion gates");
if (evaluation.candidateId !== manifest.candidateId) throw new Error("evaluation candidateId does not match candidate manifest");
if (evaluation.league !== "promotion") throw new Error("only the promotion league can promote a champion");
if (evaluation.gun !== "ensemble") throw new Error("only the ensemble tournament configuration can promote a champion");
if (evaluation.forcedDiagnostic) throw new Error("a forced diagnostic evaluation cannot promote a champion");
if (!evaluation.eligibleForPromotion) throw new Error("candidate failed battle promotion gate");
if (!evaluation.promotionGates || !Object.values(evaluation.promotionGates).every(Boolean)) {
  throw new Error("evaluation does not contain a complete passing promotion gate set");
}
if (evaluation.candidateArtifact?.fingerprint !== candidate.fingerprint) {
  throw new Error("evaluated candidate fingerprint does not match current candidate artifacts");
}
const evaluatedHashes = evaluation.candidateArtifact?.hashes;
for (const [file, hash] of Object.entries(candidate.artifacts)) {
  if (evaluatedHashes?.[file] !== hash) throw new Error(`evaluated candidate hash does not match ${file}`);
}

const championDirectory = join(BOT_DIR, "champion");
const incumbent = evaluation.incumbent;
if (!incumbent || !new Set(["fallback", "champion"]).has(incumbent.source)) {
  throw new Error("evaluation did not compare against the installed champion or explicit fallback");
}
if (incumbent.source === "fallback" && existsSync(championDirectory)) {
  throw new Error("a champion was installed after fallback evaluation; re-evaluate against it before promotion");
}
if (incumbent.source === "champion") {
  if (!incumbent.artifact?.fingerprint) throw new Error("evaluation has no incumbent artifact fingerprint");
  if (!existsSync(join(championDirectory, "manifest.json")) || !existsSync(join(championDirectory, "model.json"))) {
    throw new Error("the evaluated incumbent champion is no longer installed");
  }
  const currentIncumbent = snapshotArtifactFiles(championDirectory, ["manifest.json", "model.json"]);
  assertArtifactSnapshotUnchanged(incumbent.artifact, currentIncumbent);
}

const promotedAt = new Date().toISOString();
atomicReplaceDirectory(championDirectory, (temporaryDirectory) => {
  copyArtifact(candidateDirectory, temporaryDirectory, "model.json");
  copyArtifact(candidateDirectory, temporaryDirectory, "offline-report.json");
  copyArtifact(candidateDirectory, temporaryDirectory, "manifest.json");
  // Keep the candidate manifest as immutable evidence while manifest.json below
  // becomes the runtime/promotion manifest.
  const sourceManifestPath = join(temporaryDirectory, "manifest.json");
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  const candidateManifestPath = join(temporaryDirectory, "candidate-manifest.json");
  writeJson(candidateManifestPath, sourceManifest);
  copyFileSync(evaluationPath, join(temporaryDirectory, "evaluation-report.json"));
  if (existsSync(join(candidateDirectory, "golden.json"))) copyArtifact(candidateDirectory, temporaryDirectory, "golden.json");

  const artifactFiles = ["model.json", "offline-report.json", "candidate-manifest.json", "evaluation-report.json"];
  if (existsSync(join(temporaryDirectory, "golden.json"))) artifactFiles.push("golden.json");
  const artifacts = Object.fromEntries(artifactFiles.map((file) => [file, sha256File(join(temporaryDirectory, file))]));
  const runtimeManifest = {
    ...sourceManifest,
    championFormatVersion: 1,
    promotedAt,
    promotionEvaluationId: evaluation.evaluationId,
    promotedFromCandidateFingerprint: candidate.fingerprint,
    incumbentCandidateId: incumbent.candidateId,
    artifacts,
  };
  writeFileSync(sourceManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
});

const installedManifest = JSON.parse(readFileSync(join(championDirectory, "manifest.json"), "utf8"));
verifyHashedArtifacts(championDirectory, installedManifest.artifacts);
console.log(`Promoted ${manifest.candidateId} atomically to ${championDirectory}`);
