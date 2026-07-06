#!/usr/bin/env node
/**
 * Scaffold a new bot folder under bots/ from a template.
 *
 *   npm run new-bot -- MyCoolBot
 *   node scripts/new-bot.mjs MyCoolBot "Your Name"
 *
 * Creates bots/MyCoolBot/ with MyCoolBot.{ts,json,sh,cmd}, all named to match
 * the folder (required by the Robocode booter).
 */
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const botsDir = join(__dirname, "..", "bots");

const name = process.argv[2];
const author = process.argv[3] || "Anonymous";

if (!name) {
  console.error("Usage: npm run new-bot -- <BotName> [\"Author Name\"]");
  process.exit(1);
}
if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
  console.error(`Invalid bot name "${name}". Use letters, digits and underscores; start with a letter.`);
  console.error("Good: SpinKing   Bad: spin-king, 3fast, my bot");
  process.exit(1);
}

const dir = join(botsDir, name);
if (existsSync(dir)) {
  console.error(`bots/${name}/ already exists — pick another name or delete it first.`);
  process.exit(1);
}

const ts = `/**
 * ${name} — good luck!
 *
 * See docs/API_CHEATSHEET.md for the most useful methods and events.
 * Boot it locally: start the server in the Robocode GUI, then run this bot
 * from the GUI's bot list (or ./${name}.sh from a terminal).
 */
import { Bot, ScannedBotEvent, HitByBulletEvent, HitWallEvent } from "@robocode.dev/tank-royale-bot-api";

class ${name} extends Bot {
  static main() {
    new ${name}().start();
  }

  // Runs once at the start of each round. Your main loop goes here.
  override run() {
    while (this.isRunning()) {
      this.forward(100);
      this.turnGunLeft(360);
      this.back(100);
      this.turnGunLeft(360);
    }
  }

  // Fires when the radar sweeps across an enemy — this is when you shoot.
  override onScannedBot(e: ScannedBotEvent) {
    this.fire(1);
  }

  // Fires when an enemy bullet hits you — dodge!
  override onHitByBullet(e: HitByBulletEvent) {
    const bearing = this.calcBearing(e.bullet.direction);
    this.turnRight(90 - bearing);
  }

  // Fires when you drive into a wall.
  override onHitWall(e: HitWallEvent) {
    this.back(50);
    this.turnRight(45);
  }
}

${name}.main();
`;

const json = JSON.stringify(
  {
    name,
    version: "1.0",
    authors: [author],
    description: `${name} — a Robocode Tank Royale bot.`,
    platform: "Node.js",
    programmingLang: "TypeScript",
    gameTypes: ["classic", "1v1", "melee"],
  },
  null,
  2
) + "\n";

const sh = `#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
exec "../node_modules/.bin/tsx" "${name}.ts"
`;

const cmd = `@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
..\\node_modules\\.bin\\tsx ${name}.ts
`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${name}.ts`), ts);
writeFileSync(join(dir, `${name}.json`), json);
writeFileSync(join(dir, `${name}.sh`), sh);
writeFileSync(join(dir, `${name}.cmd`), cmd);
try {
  chmodSync(join(dir, `${name}.sh`), 0o755);
} catch {
  /* chmod may fail on Windows — the .cmd is used there anyway */
}

console.log(`Created bots/${name}/`);
console.log(`  ${name}.ts    <- write your bot here`);
console.log(`  ${name}.json  <- edit authors / description`);
console.log(`  ${name}.sh / ${name}.cmd  <- boot scripts (leave these alone)`);
console.log("");
console.log("Next:");
console.log("  1. cd bots && npm install   (only needed once)");
console.log("  2. Start the server in the Robocode GUI");
console.log(`  3. Boot ${name} from the GUI and battle it against SampleBot / Hunter`);
