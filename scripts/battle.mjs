import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { ensureJar } from "./robocode-jars.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const botsDir = join(repoRoot, "bots");

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const configuredPort = process.env.ROBOCODE_PORT ? Number(process.env.ROBOCODE_PORT) : undefined;
if (configuredPort !== undefined && (!Number.isSafeInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535)) {
  throw new Error("ROBOCODE_PORT must be an integer between 1024 and 65535");
}
const PORT = configuredPort ?? await freePort();
const SERVER_URL = `ws://localhost:${PORT}`;

export const parseArgs = (argv) => {
  const options = {
    rounds: 10,
    jsonPath: null,
    mode: "battle",
    candidateDirectory: null,
    tacticalPolicyPath: null,
    runId: null,
    arenaWidth: 800,
    arenaHeight: 600,
    names: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case "--rounds": options.rounds = Number(value()); break;
      case "--json": options.jsonPath = resolve(value()); break;
      case "--mode": options.mode = value(); break;
      case "--candidate-dir": options.candidateDirectory = resolve(value()); break;
      case "--tactical-policy": options.tacticalPolicyPath = resolve(value()); break;
      case "--run-id": options.runId = value(); break;
      case "--arena-width": options.arenaWidth = Number(value()); break;
      case "--arena-height": options.arenaHeight = Number(value()); break;
      default:
        if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}`);
        options.names.push(argument);
    }
  }
  for (const [name, number] of [["rounds", options.rounds], ["arena width", options.arenaWidth], ["arena height", options.arenaHeight]]) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (!new Set(["battle", "collection", "evaluation"]).has(options.mode)) throw new Error(`Unsupported mode ${options.mode}`);
  return options;
};

const {
  names,
  rounds,
  jsonPath,
  mode,
  candidateDirectory,
  tacticalPolicyPath,
  runId,
  arenaWidth,
  arenaHeight,
} = parseArgs(process.argv.slice(2));

if (names.length < 2) {
  console.error("Usage: npm run battle -- <botA> <botB> [<botC> ...] [--rounds N]");
  console.error("Example: npm run battle -- joshmoody-bot Hunter --rounds 20");
  process.exit(1);
}

const loadBot = async (name) => {
  const dir = join(botsDir, name);
  const config = JSON.parse(await readFile(join(dir, `${name}.json`), "utf8"));
  return { name, dir, config, script: join(dir, `${name}.sh`) };
};

const bots = await Promise.all(names.map(loadBot));

// Classic game-type defaults (see game-setup.schema.yaml).
const gameSetup = {
  gameType: "classic",
  arenaWidth,
  isArenaWidthLocked: false,
  arenaHeight,
  isArenaHeightLocked: false,
  minNumberOfParticipants: 2,
  isMinNumberOfParticipantsLocked: false,
  maxNumberOfParticipants: bots.length,
  isMaxNumberOfParticipantsLocked: false,
  numberOfRounds: rounds,
  isNumberOfRoundsLocked: false,
  gunCoolingRate: 0.1,
  isGunCoolingRateLocked: false,
  maxInactivityTurns: 450,
  isMaxInactivityTurnsLocked: false,
  turnTimeout: 30000,
  isTurnTimeoutLocked: false,
  readyTimeout: 1000000,
  isReadyTimeoutLocked: false,
  defaultTurnsPerSecond: 30,
};

const botEnv = (bot) => ({
  ...process.env,
  SERVER_URL,
  BOT_BOOTED: "true",
  BOT_NAME: bot.config.name,
  BOT_VERSION: String(bot.config.version ?? "1.0"),
  BOT_AUTHORS: (bot.config.authors ?? ["Anonymous"]).join(", "),
  BOT_DESCRIPTION: bot.config.description ?? "",
  BOT_HOMEPAGE: bot.config.homepage ?? "",
  BOT_COUNTRY_CODES: (bot.config.countryCodes ?? []).join(", "),
  BOT_GAME_TYPES: (bot.config.gameTypes ?? ["classic"]).join(", "),
  BOT_PLATFORM: bot.config.platform ?? "Node.js",
  BOT_PROG_LANG: bot.config.programmingLang ?? "TypeScript",
  ALEE_OPPONENTS: bots.filter((candidate) => candidate.name !== bot.name).map((candidate) => candidate.config.name).join(","),
  ALEE_CHAMPION_DIR: bot.name === "alee-bot" && candidateDirectory ? candidateDirectory : process.env.ALEE_CHAMPION_DIR,
  ALEE_TACTICAL_POLICY_PATH: bot.name === "alee-bot" && tacticalPolicyPath
    ? tacticalPolicyPath
    : process.env.ALEE_TACTICAL_POLICY_PATH,
  ALEE_RUN_ID: bot.name === "alee-bot" && runId ? runId : process.env.ALEE_RUN_ID,
  GUESS_FACTOR_COLLECT: mode === "collection" && bot.name === "alee-bot" ? "1" : process.env.GUESS_FACTOR_COLLECT,
});

const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(SERVER_URL);
      probe.onopen = () => { probe.close(); resolve(true); };
      probe.onerror = () => resolve(false);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Robocode server did not come up on time");
};

const serverJar = await ensureJar("server");

const server = spawn("java", ["-jar", serverJar, `--port=${PORT}`, "--tps=-1"], {
  stdio: ["ignore", "ignore", "inherit"],
});

const botProcs = [];
const processFailures = [];
const roundResults = [];
const startedAt = new Date().toISOString();
let gameEnded = false;
const cleanup = (() => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const p of botProcs) p.kill();
    server.kill();
  };
})();

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}

server.on("exit", (code, signal) => {
  if (!signal && code) {
    console.error(`Robocode server exited unexpectedly (code ${code}).`);
    cleanup();
    process.exit(1);
  }
});

console.error(`Booting ${bots.length} bots on port ${PORT}: ${bots.map((b) => b.name).join(", ")} — ${rounds} rounds`);

await waitForServer();

const controller = new WebSocket(SERVER_URL);
const bootedNames = new Set(bots.map((b) => b.config.name));

controller.onmessage = async (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "ServerHandshake": {
      controller.send(JSON.stringify({
        type: "ControllerHandshake",
        sessionId: msg.sessionId,
        name: "robocode-showdown battle runner",
        version: "1.0",
      }));
      for (const bot of bots) {
        const child = spawn("sh", [bot.script], { env: botEnv(bot), stdio: ["ignore", "ignore", "inherit"] });
        child.on("exit", (code, signal) => {
          if (!gameEnded && !signal && code) processFailures.push({ bot: bot.name, code, signal: null });
        });
        botProcs.push(child);
      }
      break;
    }
    case "BotListUpdate": {
      const ready = msg.bots.filter((b) => bootedNames.has(b.name));
      if (ready.length === bots.length) {
        controller.send(JSON.stringify({
          type: "StartGame",
          gameSetup,
          botAddresses: ready.map((b) => ({ host: b.host, port: b.port })),
        }));
      }
      break;
    }
    case "RoundEndedEventForObserver": {
      roundResults.push({
        roundNumber: msg.roundNumber,
        turnNumber: msg.turnNumber,
        results: [...msg.results].sort((left, right) => left.rank - right.rank),
      });
      break;
    }
    case "GameEndedEventForObserver": {
      gameEnded = true;
      const results = [...msg.results].sort((a, b) => a.rank - b.rank);
      const width = Math.max(...results.map((r) => r.name.length));
      console.log(`\nResults after ${msg.numberOfRounds} rounds:\n`);
      for (const r of results) {
        const marker = r.rank === 1 ? "🏆" : "  ";
        console.log(`${marker} #${r.rank}  ${r.name.padEnd(width)}  ${String(r.totalScore).padStart(6)} pts  (1st×${r.firstPlaces})`);
      }
      console.log("");
      const report = {
        reportVersion: 1,
        mode,
        startedAt,
        endedAt: new Date().toISOString(),
        serverVersion: "1.0.2",
        gameSetup,
        participants: bots.map((bot) => ({
          folder: bot.name,
          name: bot.config.name,
          version: String(bot.config.version ?? "1.0"),
        })),
        candidateDirectory,
        tacticalPolicyPath,
        runId,
        roundResults,
        results,
        processFailures,
      };
      if (jsonPath) {
        await mkdir(dirname(jsonPath), { recursive: true });
        await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`Structured report: ${jsonPath}`);
      }
      cleanup();
      process.exit(processFailures.length === 0 ? 0 : 1);
    }
  }
};

controller.onerror = (err) => {
  console.error(`Controller connection error: ${err.message ?? err}`);
  cleanup();
  process.exit(1);
};
