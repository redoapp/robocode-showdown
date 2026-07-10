import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertArtifactSnapshotUnchanged,
  atomicReplaceDirectory,
  inspectCandidateArtifacts,
  sha256Bytes,
  sha256File,
  snapshotArtifactFiles,
  verifyHashedArtifacts,
} from "../lib/artifacts.mjs";

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`);

test("candidate artifact inspection verifies integrity and reproducibility provenance", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "alee-artifacts-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const modelText = "{\"weights\":[1,2,3]}\n";
  writeFileSync(join(directory, "model.json"), modelText);
  const candidateId = "candidate-1";
  writeJson(join(directory, "manifest.json"), {
    candidateId,
    modelSha256: sha256Bytes(modelText),
    configSha256: "a".repeat(64),
    datasetSha256: "b".repeat(64),
    repositoryCommit: "c".repeat(40),
    repositoryDirty: false,
    createdAt: "2026-07-09T00:00:00.000Z",
    datasetRuns: ["run-1"],
    eligibleForBattleEvaluation: true,
  });
  writeJson(join(directory, "offline-report.json"), { candidateId, eligibleForBattleEvaluation: true });
  const snapshot = inspectCandidateArtifacts(directory);
  assert.equal(snapshot.provenanceEligible, true);
  assert.equal(snapshot.modelSha256, sha256File(join(directory, "model.json")));
  writeFileSync(join(directory, "model.json"), "changed\n");
  assert.throws(() => inspectCandidateArtifacts(directory), /model hash/);
});

test("artifact snapshots detect mutation", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "alee-snapshot-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "model.json"), "first");
  const before = snapshotArtifactFiles(directory, ["model.json"]);
  writeFileSync(join(directory, "model.json"), "second");
  const after = snapshotArtifactFiles(directory, ["model.json"]);
  assert.throws(() => assertArtifactSnapshotUnchanged(before, after), /changed during evaluation/);
});

test("atomic directory replacement installs a complete tree and verifies hashes", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "alee-promote-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const target = join(parent, "champion");
  mkdirSync(target);
  writeFileSync(join(target, "old.txt"), "old");
  atomicReplaceDirectory(target, (temporary) => {
    writeFileSync(join(temporary, "model.json"), "new model");
  });
  assert.equal(readFileSync(join(target, "model.json"), "utf8"), "new model");
  assert.deepEqual(verifyHashedArtifacts(target, { "model.json": sha256File(join(target, "model.json")) }), {
    "model.json": sha256File(join(target, "model.json")),
  });
});
