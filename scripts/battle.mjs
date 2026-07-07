import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

const PORT = await freePort();
const SERVER_URL = `ws://localhost:${PORT}`;

const parseArgs = (argv) => {
  const rounds = (() => {
    const i = argv.indexOf("--rounds");
    return i >= 0 ? Number(argv[i + 1]) : 10;
  })();
  const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--rounds");
  return { names, rounds };
};

const { names, rounds } = parseArgs(process.argv.slice(2));

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
  arenaWidth: 800,
  isArenaWidthLocked: false,
  arenaHeight: 600,
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

console.error(`Booting ${bots.length} bots: ${bots.map((b) => b.name).join(", ")} — ${rounds} rounds`);

await waitForServer();

const controller = new WebSocket(SERVER_URL);
const bootedNames = new Set(bots.map((b) => b.config.name));

controller.onmessage = (event) => {
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
        botProcs.push(spawn("sh", [bot.script], { env: botEnv(bot), stdio: ["ignore", "ignore", "inherit"] }));
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
    case "GameEndedEventForObserver": {
      const results = [...msg.results].sort((a, b) => a.rank - b.rank);
      const width = Math.max(...results.map((r) => r.name.length));
      console.log(`\nResults after ${msg.numberOfRounds} rounds:\n`);
      for (const r of results) {
        const marker = r.rank === 1 ? "🏆" : "  ";
        console.log(`${marker} #${r.rank}  ${r.name.padEnd(width)}  ${String(r.totalScore).padStart(6)} pts  (1st×${r.firstPlaces})`);
      }
      console.log("");
      cleanup();
      process.exit(0);
    }
  }
};

controller.onerror = (err) => {
  console.error(`Controller connection error: ${err.message ?? err}`);
  cleanup();
  process.exit(1);
};
