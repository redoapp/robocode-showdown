# 🤖 Robocode Showdown

Build a tank bot, battle-test it, and fight for the trophy. This repo is
everything you need for our Robocode [Tank Royale](https://robocode.dev/) event:
a one-command setup, a starter bot, a stronger sparring bot, and a World Cup–style
tournament runner.

**You write TypeScript. The tank does the rest.**

---

## ⏱️ Get battling in 5 minutes

You need two things installed: **[Node.js](https://nodejs.org/) 22 or newer** (repo pins 22.17.1 in `.nvmrc`) and
**[Java](https://adoptium.net/) 11+** (Java runs the Robocode app itself).

```bash
# 1. Clone and install
git clone <REPO_URL> robocode-showdown
cd robocode-showdown
npm run setup            # installs the bot API (once)

# 2. Download & launch the Robocode GUI  (the .jar — see docs/QUICKSTART.md)
java -jar robocode-tankroyale-gui-x.y.z.jar

# 3. Make your own bot
npm run new-bot -- MyCoolBot
```

Then in the GUI: **Start a server → add the `bots/` folder as a bot directory →
Boot your bot → start a battle against `SampleBot` or `Hunter`.**

Full step-by-step (with screenshots of where to click): **[docs/QUICKSTART.md](docs/QUICKSTART.md)**

---

## 🧠 Writing your bot

Your bot is one TypeScript class. The interesting parts:

```ts
override run() {
  // Called once per round. Your main movement loop.
  while (this.isRunning()) { this.forward(100); this.turnGunLeft(360); }
}

override onScannedBot(e: ScannedBotEvent) {
  this.fire(1);          // you only "see" enemies here — so aim & fire here
}

override onHitByBullet(e: HitByBulletEvent) {
  this.turnRight(90);    // got hit — dodge
}
```

- **`bots/SampleBot/`** — the simplest bot, heavily commented. Read this first.
- **`bots/Hunter/`** — radar lock + predictive aim. Your real sparring partner and
  a source of ideas.
- **[docs/API_CHEATSHEET.md](docs/API_CHEATSHEET.md)** — the methods and events you'll
  actually use, on one page.

Everything on the physics (bullet damage, energy, gun heat, turn rates) is in the
official docs: <https://robocode.dev/articles/intro.html>.

---

## 📥 Submitting your bot

We collect bots through **pull requests** so everything lands in one repo.

1. Create your bot: `npm run new-bot -- YourBotName`
2. Commit **only your bot's folder** under `bots/YourBotName/`.
3. Open a PR titled `Add bot: YourBotName`.

Details and rules: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

> 🔁 **You can keep improving your bot between rounds.** We re-pull `main` before
> every tournament round, so merge your changes (same folder name) and they'll be
> live for the next round. See the tournament guide below.

---

## 🏆 The tournament — World Cup format

At the end we run a World Cup:

1. **Groups of ~4**, drawn at random.
2. **Round-robin** inside each group (everyone plays everyone).
3. **Top 2 of each group advance** to a single-elimination **knockout** bracket.
4. Knockout until one bot lifts the trophy. 🥇

The organizer runs battles live in the GUI (great on the big screen) and records
results with the built-in manager:

```bash
npm run tournament -- draw        # draw the groups
npm run tournament -- status      # standings + bracket + what's left to play
npm run tournament -- report A1 MyCoolBot   # record a result
npm run tournament -- knockout    # seed the bracket once groups finish
```

Organizer runbook (including the **re-pull-between-rounds** flow):
**[docs/TOURNAMENT.md](docs/TOURNAMENT.md)**

---

## 🗂️ What's in here

```
robocode-showdown/
├── bots/                  # every bot lives here; also the npm project
│   ├── SampleBot/         # simple starter (leave in place)
│   ├── Hunter/            # stronger sparring bot (leave in place)
│   └── <YourBot>/         # you add this via `npm run new-bot`
├── scripts/
│   ├── new-bot.mjs        # scaffolds a new bot folder
│   └── tournament.mjs     # the World Cup manager
├── docs/
│   ├── QUICKSTART.md      # install + first battle, click by click
│   ├── API_CHEATSHEET.md  # the API on one page
│   └── TOURNAMENT.md      # organizer runbook
├── CONTRIBUTING.md        # how to submit via PR
└── README.md
```

Have fun, and *build the best — destroy the rest.*
