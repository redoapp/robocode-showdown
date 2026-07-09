#!/usr/bin/env node
/**
 * Scaffold a new bot folder under bots/ from a template.
 *
 *   npm run new-bot -- aburns-bot
 *   npm run new-bot -- aburns-bot --python
 *   node scripts/new-bot.mjs aburns-bot "Your Name"
 *
 * Creates bots/aburns-bot/ with aburns-bot.{ts,json,sh,cmd} (or .py with
 * --python), all named to match the folder (required by the Robocode booter).
 */
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const botsDir = join(__dirname, "..", "bots");

const args = process.argv.slice(2);
const usePython = args.includes("--python");
const positional = args.filter((a) => !a.startsWith("--"));
const name = positional[0];
const author = positional[1] || "Anonymous";

if (!name) {
  console.error("Usage: npm run new-bot -- <BotName> [\"Author Name\"] [--python]");
  process.exit(1);
}
if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
  console.error(`Invalid bot name "${name}". Use letters, digits and hyphens; start with a letter.`);
  console.error("Good: aburns-bot   Bad: 3fast, my bot, -bot");
  process.exit(1);
}

// The folder/files use the name as-is (e.g. aburns-bot), but a JS class name can't
// contain hyphens — derive a valid PascalCase identifier for the class.
const className = name
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
  .join("");

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

class ${className} extends Bot {
  static main() {
    new ${className}().start();
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

${className}.main();
`;

const py = `"""
${name} — good luck!

See docs/API_CHEATSHEET.md for the most useful methods and events.
Boot it locally: start the server in the Robocode GUI, then run this bot
from the GUI's bot list (or ./${name}.sh from a terminal).
"""
from robocode_tank_royale.bot_api.bot import Bot
from robocode_tank_royale.bot_api.events import ScannedBotEvent, HitByBulletEvent, HitWallEvent


class ${className}(Bot):
    # Runs once at the start of each round. Your main loop goes here.
    def run(self) -> None:
        while self.running:
            self.forward(100)
            self.turn_gun_left(360)
            self.back(100)
            self.turn_gun_left(360)

    # Fires when the radar sweeps across an enemy — this is when you shoot.
    def on_scanned_bot(self, e: ScannedBotEvent) -> None:
        self.fire(1)

    # Fires when an enemy bullet hits you — dodge!
    def on_hit_by_bullet(self, e: HitByBulletEvent) -> None:
        bearing = self.calc_bearing(e.bullet.direction)
        self.turn_right(90 - bearing)

    # Fires when you drive into a wall.
    def on_hit_wall(self, e: HitWallEvent) -> None:
        self.back(50)
        self.turn_right(45)


if __name__ == "__main__":
    ${className}().start()
`;

const json = JSON.stringify(
  {
    name,
    version: "1.0",
    authors: [author],
    description: `${name} — a Robocode Tank Royale bot.`,
    platform: usePython ? "Python" : "Node.js",
    programmingLang: usePython ? "Python 3" : "TypeScript",
    gameTypes: ["classic", "1v1", "melee"],
    tournament: true,
  },
  null,
  2
) + "\n";

const sh = usePython
  ? `#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
exec "../.venv/bin/python" -u "${name}.py"
`
  : `#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
exec "../node_modules/.bin/tsx" "${name}.ts"
`;

const cmd = usePython
  ? `@echo off
cd /d "%~dp0"
..\\.venv\\Scripts\\python.exe -u ${name}.py
`
  : `@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
..\\node_modules\\.bin\\tsx ${name}.ts
`;

const srcExt = usePython ? "py" : "ts";
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${name}.${srcExt}`), usePython ? py : ts);
writeFileSync(join(dir, `${name}.json`), json);
writeFileSync(join(dir, `${name}.sh`), sh);
writeFileSync(join(dir, `${name}.cmd`), cmd);
try {
  chmodSync(join(dir, `${name}.sh`), 0o755);
} catch {
  /* chmod may fail on Windows — the .cmd is used there anyway */
}

console.log(`Created bots/${name}/`);
console.log(`  ${name}.${srcExt}    <- write your bot here`);
console.log(`  ${name}.json  <- edit authors / description ("tournament": true enters you in the tournament)`);
console.log(`  ${name}.sh / ${name}.cmd  <- boot scripts (leave these alone)`);
console.log("");
console.log("Next:");
if (usePython) {
  console.log("  1. npm run setup:python   (only needed once — creates bots/.venv)");
} else {
  console.log("  1. cd bots && npm install   (only needed once)");
}
console.log("  2. Start the server in the Robocode GUI");
console.log(`  3. Boot ${name} from the GUI and battle it against SampleBot / Hunter`);
