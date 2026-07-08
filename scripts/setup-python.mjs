#!/usr/bin/env node
/**
 * Set up the shared Python environment for Python bots.
 *
 *   npm run setup:python
 *
 * Creates bots/.venv (git-ignored) with the Tank Royale Bot API installed.
 * Python bots' boot scripts run ../.venv/bin/python, mirroring how the
 * TypeScript bots share ../node_modules.
 *
 * Requires Python 3.10+. Only needed if you want to write (or battle) a
 * Python bot — TypeScript-only users can skip this.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const botsDir = join(__dirname, "..", "bots");
const venvDir = join(botsDir, ".venv");

const MIN_MINOR = 10; // Python 3.10+

const findPython = () => {
  const candidates = ["python3", "python3.13", "python3.12", "python3.11", "python3.10", "python"];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], {
      encoding: "utf8",
    });
    if (res.status !== 0) continue;
    const [major, minor] = res.stdout.trim().split(" ").map(Number);
    if (major === 3 && minor >= MIN_MINOR) return { cmd, version: `3.${minor}` };
  }
  return null;
};

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\nCommand failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
};

const venvPython = join(venvDir, process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

if (existsSync(venvDir)) {
  console.log(`bots/.venv already exists — updating dependencies.`);
} else if (hasUv) {
  // uv manages its own Pythons, so it works even without a system Python 3.10+.
  console.log("Creating bots/.venv with uv...");
  run("uv", ["venv", "--python", `>=3.${MIN_MINOR}`, "--allow-existing", venvDir]);
} else {
  const python = findPython();
  if (!python) {
    console.error(`No Python 3.${MIN_MINOR}+ found on your PATH.`);
    console.error("Install one first, e.g.:");
    console.error("  brew install python@3.12          (macOS)");
    console.error("  uv python install 3.12            (https://docs.astral.sh/uv/)");
    process.exit(1);
  }
  console.log(`Creating bots/.venv with ${python.cmd} (Python ${python.version})...`);
  run(python.cmd, ["-m", "venv", venvDir]);
}

if (hasUv) {
  // uv venvs ship without pip — install straight through uv instead.
  run("uv", ["pip", "install", "--quiet", "--python", venvPython, "-r", join(botsDir, "requirements.txt")]);
} else {
  run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  run(venvPython, ["-m", "pip", "install", "--quiet", "-r", join(botsDir, "requirements.txt")]);
}

console.log("");
console.log("Python Bot API installed. You can now boot Python bots from the");
console.log("Robocode GUI or battle them: npm run battle -- SamplePyBot Hunter");
