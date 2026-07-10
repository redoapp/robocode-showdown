import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function snapshotArtifactFiles(directory, files) {
  const artifacts = {};
  for (const file of files) {
    if (basename(file) !== file) throw new Error(`unsafe artifact path ${file}`);
    const path = join(directory, file);
    if (!existsSync(path)) throw new Error(`artifact is missing ${file}`);
    artifacts[file] = sha256File(path);
  }
  const fingerprint = sha256Bytes(Buffer.from(files.map((file) => `${file}:${artifacts[file]}`).join("\n")));
  return Object.freeze({ artifacts, fingerprint });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function inspectCandidateArtifacts(candidateDirectory) {
  const manifestPath = join(candidateDirectory, "manifest.json");
  const offlinePath = join(candidateDirectory, "offline-report.json");
  const modelPath = join(candidateDirectory, "model.json");
  for (const path of [manifestPath, offlinePath, modelPath]) {
    if (!existsSync(path)) throw new Error(`candidate artifact is missing ${basename(path)}`);
  }
  const manifest = readJson(manifestPath);
  const offlineReport = readJson(offlinePath);
  if (!manifest.candidateId || typeof manifest.candidateId !== "string") throw new Error("candidate manifest has no candidateId");
  if (offlineReport.candidateId !== manifest.candidateId) {
    throw new Error(`offline report candidateId ${offlineReport.candidateId} does not match manifest ${manifest.candidateId}`);
  }
  if (!SHA256_PATTERN.test(manifest.modelSha256 ?? "")) throw new Error("candidate manifest has an invalid modelSha256");
  const modelSha256 = sha256File(modelPath);
  if (modelSha256 !== manifest.modelSha256) throw new Error("candidate model hash does not match manifest");
  for (const field of ["configSha256", "datasetSha256"]) {
    if (manifest[field] !== undefined && !SHA256_PATTERN.test(manifest[field])) {
      throw new Error(`candidate manifest has an invalid ${field}`);
    }
  }

  const provenanceIssues = [];
  if (!COMMIT_PATTERN.test(manifest.repositoryCommit ?? "")) provenanceIssues.push("missing or invalid repositoryCommit");
  if (manifest.repositoryDirty !== false) provenanceIssues.push("repositoryDirty is not false");
  if (!SHA256_PATTERN.test(manifest.configSha256 ?? "")) provenanceIssues.push("missing or invalid configSha256");
  if (!SHA256_PATTERN.test(manifest.datasetSha256 ?? "")) provenanceIssues.push("missing or invalid datasetSha256");
  if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) provenanceIssues.push("missing or invalid createdAt");
  if (!Array.isArray(manifest.datasetRuns) || manifest.datasetRuns.length === 0) provenanceIssues.push("datasetRuns is empty");
  if (manifest.eligibleForBattleEvaluation !== offlineReport.eligibleForBattleEvaluation) {
    provenanceIssues.push("manifest/offline eligibility disagree");
  }

  const files = ["manifest.json", "offline-report.json", "model.json"];
  if (existsSync(join(candidateDirectory, "golden.json"))) files.push("golden.json");
  const { artifacts, fingerprint } = snapshotArtifactFiles(candidateDirectory, files);
  return Object.freeze({
    manifest,
    offlineReport,
    modelSha256,
    artifacts,
    fingerprint,
    provenanceIssues,
    provenanceEligible: provenanceIssues.length === 0,
  });
}

export function assertArtifactSnapshotUnchanged(before, after) {
  if (before.fingerprint !== after.fingerprint) {
    throw new Error(`candidate artifacts changed during evaluation (${before.fingerprint} -> ${after.fingerprint})`);
  }
}

export function verifyHashedArtifacts(directory, artifacts) {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("champion manifest has no artifact hash map");
  }
  const verified = {};
  for (const [file, expected] of Object.entries(artifacts)) {
    if (basename(file) !== file) throw new Error(`unsafe champion artifact path ${file}`);
    if (!SHA256_PATTERN.test(expected)) throw new Error(`invalid hash for champion artifact ${file}`);
    const path = join(directory, file);
    if (!existsSync(path)) throw new Error(`champion artifact is missing ${file}`);
    const actual = sha256File(path);
    if (actual !== expected) throw new Error(`champion artifact hash mismatch for ${file}`);
    verified[file] = actual;
  }
  return verified;
}

export function atomicReplaceDirectory(targetDirectory, populate) {
  const parent = dirname(targetDirectory);
  mkdirSync(parent, { recursive: true });
  const nonce = `${process.pid}-${randomUUID()}`;
  const temporary = join(parent, `.${basename(targetDirectory)}.tmp-${nonce}`);
  const backup = join(parent, `.${basename(targetDirectory)}.backup-${nonce}`);
  mkdirSync(temporary, { recursive: false });
  let movedExisting = false;
  try {
    populate(temporary);
    if (existsSync(targetDirectory)) {
      renameSync(targetDirectory, backup);
      movedExisting = true;
    }
    try {
      renameSync(temporary, targetDirectory);
    } catch (error) {
      if (movedExisting && !existsSync(targetDirectory)) renameSync(backup, targetDirectory);
      throw error;
    }
    if (movedExisting) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function copyArtifact(sourceDirectory, targetDirectory, file) {
  copyFileSync(join(sourceDirectory, file), join(targetDirectory, file));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
