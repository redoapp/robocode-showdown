# Quickstart — from zero to your first battle

Target time: **~10 minutes**. If you get stuck, grab an organizer.

## 1. Install the two prerequisites

**Java 11+** (runs the Robocode app itself):

```bash
java -version   # if this errors, install from https://adoptium.net/
```

**Node.js 22 or newer** (runs your TypeScript bot — `.nvmrc` pins 22.17.1):

```bash
node -v         # want v22+; if you use nvm, run `nvm use` to match .nvmrc
                # no Node yet? install from https://nodejs.org/
```

**Python 3.10+** — *only* if you plan to write your bot in Python (Node.js is
still required either way; it runs the repo's battle/GUI scripts):

```bash
python3 --version   # want 3.10+; install from https://www.python.org/ or `brew install python@3.12`
```

## 2. Clone the repo and install the bot API

```bash
git clone https://github.com/alex-burnzie/robocode-showdown robocode-showdown
cd robocode-showdown
npm run setup     # == cd bots && npm install  (installs the TS bot API once)
```

Writing your bot in Python? Also run:

```bash
npm run setup:python   # creates bots/.venv with the Python bot API (once)
```

## 3. Make your own bot

From the repo root — **name your bot `<yourname>-bot`** so it's easy to spot in
the arena and on the bracket:

```bash
npm run new-bot -- aburns-bot            # TypeScript (default)
npm run new-bot -- aburns-bot --python   # …or Python
```

This creates `bots/aburns-bot/` with everything named correctly. Open
`bots/aburns-bot/aburns-bot.ts` (or `.py`) in your editor and start hacking.
Also edit the `authors` field in `aburns-bot.json` so your name shows up.

## 4. Battle!

Two commands, both run from the repo root. Each downloads the Robocode jar it
needs on first use (cached in `.robocode/`) — no manual install or config.

**Fast tuning loop — headless, prints the winner:**

```bash
npm run battle -- aburns-bot Hunter            # 10 rounds vs Hunter
npm run battle -- aburns-bot SampleBot Hunter --rounds 50   # melee, 50 rounds
```

Edit `aburns-bot.ts`, re-run, read the score, repeat. No GUI, no clicking.

**Watch it visually — the GUI:**

```bash
npm run gui
```

This opens the Robocode GUI with the `bots/` folder already registered. Then:
**Battle → Start Battle → Boot** your bot + opponents ▶ → **Start Battle**.
Edit your `.ts` and **re-Boot** to pick up changes — no relaunch needed.

## Common gotchas

- **Bot doesn't appear / doesn't connect** → the folder name and file names must
  match exactly (`aburns-bot/aburns-bot.ts`). Re-run `npm run new-bot` rather than
  copying by hand.
- **"Cannot find module @robocode.dev/..."** → you skipped `npm run setup`, or
  ran it somewhere other than the repo. Run it from the repo root.
- **Nothing happens when you fire** → the gun has *heat*; it can't fire again
  until it cools. And you only get enemy positions inside `onScannedBot`, so make
  sure your radar keeps sweeping.

Next: skim **[API_CHEATSHEET.md](API_CHEATSHEET.md)** and read `bots/Hunter/Hunter.ts`
for ideas.
