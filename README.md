# 🤖 Robocode Showdown

Write a tank bot in TypeScript, battle it, win the trophy. Everything for our
Robocode [Tank Royale](https://robocode.dev/) event lives here.

## Requirements

| Need | Version | For |
| ---- | ------- | --- |
| [Node.js](https://nodejs.org/) | 22+ | authoring/running bots |
| [Java](https://adoptium.net/) | 11+ | running the Robocode app |

## Setup

```bash
git clone https://github.com/alex-burnzie/robocode-showdown robocode-showdown
cd robocode-showdown
npm run setup                 # installs the bot API (run once)
npm run new-bot -- aburns-bot   # scaffolds bots/aburns-bot/ — name it <yourname>-bot
```

Then download and launch the GUI:

```bash
java -jar robocode-tankroyale-gui-1.0.2.jar
```

In the GUI: **Start a server → add the `bots/` folder as a bot directory → Boot
your bot → start a battle against `SampleBot` or `Hunter`.**

Download link and click-by-click walkthrough: **[docs/QUICKSTART.md](docs/QUICKSTART.md)**

## Writing your bot

Your bot is one TypeScript class:

```ts
override run() {
  while (this.isRunning()) { this.forward(100); this.turnGunLeft(360); }
}
override onScannedBot(e: ScannedBotEvent) { this.fire(1); }   // aim & fire here
override onHitByBullet(e: HitByBulletEvent) { this.turnRight(90); }  // dodge
```

- Reference bots: [`bots/SampleBot/`](bots/SampleBot) (simple, start here) and [`bots/Hunter/`](bots/Hunter) (radar lock + predictive aim).
- API on one page: **[docs/API_CHEATSHEET.md](docs/API_CHEATSHEET.md)**
- Game physics: <https://robocode.dev/articles/intro.html>

## Submitting your bot

Submit via **pull request**. Name your bot `<yourname>-bot`.

```bash
npm run new-bot -- aburns-bot    # creates bots/aburns-bot/
git add bots/aburns-bot          # commit ONLY your folder
git commit -m "Add bot: aburns-bot"
```

Open a PR titled `Add bot: aburns-bot`. Full rules: **[CONTRIBUTING.md](CONTRIBUTING.md)**

> 🔁 Keep improving between rounds — push to the **same folder name** and it's
> live next round (we re-pull `main` each round).

## Tournament — World Cup format

Groups of ~4 → round-robin → top 2 advance → single-elimination knockout.
The organizer runs battles in the GUI and records results:

```bash
npm run tournament -- draw               # draw the groups
npm run tournament -- status             # standings, bracket, remaining games
npm run tournament -- report A1 aburns-bot # record a result
npm run tournament -- knockout           # seed the bracket after groups finish
```

Organizer runbook: **[docs/TOURNAMENT.md](docs/TOURNAMENT.md)**

## Layout

```
bots/          every bot + the shared npm project (SampleBot, Hunter, <yourname>-bot)
scripts/       new-bot.mjs (scaffold), tournament.mjs (World Cup manager)
docs/          QUICKSTART.md, API_CHEATSHEET.md, TOURNAMENT.md
CONTRIBUTING.md
```
