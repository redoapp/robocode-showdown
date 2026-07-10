#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, verifyHashedArtifacts } from "./lib/artifacts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const championDirectory = resolve(value("--champion", join(ROOT, "bots", "alee-bot", "champion")));
const outputPath = value("--output");
const allowDirty = args.includes("--allow-dirty");
const runTests = args.includes("--test");

const readJson = (file) => JSON.parse(readFileSync(join(championDirectory, file), "utf8"));
for (const file of ["manifest.json", "candidate-manifest.json", "model.json", "offline-report.json", "evaluation-report.json"]) {
  if (!existsSync(join(championDirectory, file))) throw new Error(`champion is missing ${file}`);
}
const manifest = readJson("manifest.json");
const candidateManifest = readJson("candidate-manifest.json");
const offline = readJson("offline-report.json");
const evaluation = readJson("evaluation-report.json");
if (manifest.championFormatVersion !== 1) throw new Error("unsupported or missing championFormatVersion");
if (manifest.candidateId !== candidateManifest.candidateId) throw new Error("champion/candidate manifest candidateId mismatch");
if (offline.candidateId !== manifest.candidateId || evaluation.candidateId !== manifest.candidateId) {
  throw new Error("champion evidence candidateId mismatch");
}
if (!offline.eligibleForBattleEvaluation || !evaluation.eligibleForPromotion) {
  throw new Error("champion evidence does not contain passing offline and battle gates");
}
if (!evaluation.promotionGates || !Object.values(evaluation.promotionGates).every(Boolean)) {
  throw new Error("champion evaluation promotion gates are incomplete or failing");
}
if (evaluation.evaluationId !== manifest.promotionEvaluationId) throw new Error("promotion evaluationId mismatch");
if (evaluation.candidateArtifact?.fingerprint !== manifest.promotedFromCandidateFingerprint) {
  throw new Error("promoted candidate fingerprint mismatch");
}
if (sha256File(join(championDirectory, "model.json")) !== manifest.modelSha256) {
  throw new Error("runtime model hash does not match champion manifest");
}
const verifiedArtifacts = verifyHashedArtifacts(championDirectory, manifest.artifacts);
const sourceHashMapping = {
  "candidate-manifest.json": "manifest.json",
  "offline-report.json": "offline-report.json",
  "model.json": "model.json",
  "golden.json": "golden.json",
};
for (const [championFile, candidateFile] of Object.entries(sourceHashMapping)) {
  if (verifiedArtifacts[championFile] && evaluation.candidateArtifact?.hashes?.[candidateFile] !== verifiedArtifacts[championFile]) {
    throw new Error(`evaluation candidate hash does not match promoted ${championFile}`);
  }
}

const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();
git("cat-file", "-e", `${manifest.repositoryCommit}^{commit}`);
const repositoryHead = git("rev-parse", "HEAD");
const trackedChanges = git("status", "--porcelain", "--untracked-files=no");
if (trackedChanges && !allowDirty) throw new Error("tracked repository changes prevent clean-checkout reproduction; use --allow-dirty only for diagnosis");

const configPath = join(ROOT, "bots", "alee-bot", "config", "train.json");
if (sha256File(configPath) !== manifest.configSha256) throw new Error("training config hash does not match champion manifest");

if (runTests) execFileSync("npm", ["run", "bot:test"], { cwd: ROOT, stdio: "inherit" });
const reproductionReport = {
  reportVersion: 1,
  reproducedAt: new Date().toISOString(),
  candidateId: manifest.candidateId,
  promotionEvaluationId: manifest.promotionEvaluationId,
  repositoryHead,
  sourceRepositoryCommit: manifest.repositoryCommit,
  repositoryClean: trackedChanges.length === 0,
  configSha256: manifest.configSha256,
  datasetSha256: manifest.datasetSha256,
  artifactHashes: verifiedArtifacts,
  testsRun: runTests,
  reproducible: true,
};
if (outputPath) {
  const resolvedOutput = resolve(outputPath);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(reproductionReport, null, 2)}\n`);
}
console.log(JSON.stringify(reproductionReport, null, 2));
