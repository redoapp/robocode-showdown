# Quickstart — from zero to your first battle

Target time: **~10 minutes**. If you get stuck, grab an organizer.

## 1. Install the two prerequisites

**Java 11+** (runs the Robocode app itself):

```bash
java -version   # if this errors, install from https://adoptium.net/
```

**Node.js 18+** (runs your TypeScript bot):

```bash
node -v         # if this errors, install from https://nodejs.org/
```

## 2. Clone the repo and install the bot API

```bash
git clone <REPO_URL> robocode-showdown
cd robocode-showdown
npm run setup     # == cd bots && npm install  (installs the TS bot API once)
```

## 3. Install & launch the Robocode GUI

Download the installer for your OS from the Tank Royale **[GitHub Releases](https://github.com/robocode-dev/tank-royale/releases)** page:

| OS      | File                                     |
| ------- | ---------------------------------------- |
| Windows | `robocode-tank-royale-gui-<ver>.msi`     |
| macOS   | `robocode-tank-royale-gui-<ver>.pkg`     |
| Linux   | `...-gui-<ver>.deb` or `...-gui-<ver>.rpm` |

Install and launch it. (The installers aren't code-signed, so you may need to
click through an "unidentified developer" warning — see the release page notes.)

Prefer no install? Download the portable `robocode-tankroyale-gui-<ver>.jar` and run:

```bash
java -jar robocode-tankroyale-gui-<ver>.jar
```

## 4. Point Robocode at this repo's bots

In the GUI:

1. **Config → Bot Root Directories**
2. Add the **`bots/`** folder inside this repo (the folder that contains
   `SampleBot/`, `Hunter/`, etc.).
3. Save.

Robocode boots bots by folder name, and each of our bots has a matching
`.sh`/`.cmd` script, so it will find them automatically.

## 5. Make your own bot

From the repo root:

```bash
npm run new-bot -- MyCoolBot
```

This creates `bots/MyCoolBot/` with everything named correctly. Open
`bots/MyCoolBot/MyCoolBot.ts` in your editor and start hacking. Also edit the
`authors` field in `MyCoolBot.json` so your name shows up.

## 6. Battle!

In the GUI:

1. **Battle → Start Battle** (or the "New Battle" button).
2. In the **Boot** column on the left, select `MyCoolBot`, `SampleBot`, and
   `Hunter`, and click **Boot** ▶ — this starts each bot's process.
3. Move the booted bots into the battle, set the number of rounds, and click
   **Start Battle**.
4. Watch. Iterate. Repeat.

> The GUI starts a local server for you automatically. If your bot fails to
> connect, make sure the server is running (**green** status) and that you ran
> `npm run setup`.

## Common gotchas

- **Bot doesn't appear in the list** → the folder name and the file names must
  match exactly (`MyCoolBot/MyCoolBot.ts`). Re-run `npm run new-bot` rather than
  copying by hand.
- **"Cannot find module @robocode.dev/..."** → you skipped `npm run setup`, or
  ran it somewhere other than the repo. Run it from the repo root.
- **Nothing happens when you fire** → the gun has *heat*; it can't fire again
  until it cools. And you only get enemy positions inside `onScannedBot`, so make
  sure your radar keeps sweeping.

Next: skim **[API_CHEATSHEET.md](API_CHEATSHEET.md)** and read `bots/Hunter/Hunter.ts`
for ideas.
