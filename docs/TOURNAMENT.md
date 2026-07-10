# Tournament runbook (organizer)

This is the guide for whoever runs the competition. Format: groups of ~4, **one
melee battle per group** (all group-mates in a single free-for-all), top 2
finishers advance, single-elimination 1v1 knockout.

Why melee groups? With ~16 bots a round-robin group stage is 24 matches; melee
groups cut that to 4 battles, everyone still sees their bot fight on the big
screen at least once, and a 4-tank brawl is a great spectacle.

The `scripts/tournament.mjs` manager handles the draw, placements, and bracket.
You run the actual battles in the Robocode GUI (best for the projector) and
record the results back in. State is saved to `scripts/tournament-state.json`, so
you can stop and resume any time.

There are two interchangeable ways to drive it — mix and match, they share the
same state file:

- **Browser (recommended live):** `npm run bracket` serves a live page that both
  visualizes and controls the whole tournament — draw, enter results, seed the
  knockout, click winners, reset. See
  [Live bracket on the big screen](#live-bracket-on-the-big-screen).
- **CLI:** `npm run tournament -- <command>`, documented step by step below.

## Before the event

- One machine is the **tournament host**. It needs Node + Java + the GUI, and a
  clone of this repo.
- Make sure `npm run setup` has been run so all bots can boot.
- Add the repo's `bots/` folder as a **Bot Root Directory** in the GUI (see
  QUICKSTART step 4).

## The flow at a glance

```
collect PRs  ──►  git pull  ──►  draw  ──►  play each group's melee  ──►  report order
   ──►  knockout (seed bracket)  ──►  play + report each round  ──►  🏆
        ▲                                   │
        └────────  git pull between rounds ─┘   (people keep improving bots)
```

## 1. Collect everyone's bots

Merge the submission PRs into `main` (see [../CONTRIBUTING.md](../CONTRIBUTING.md)),
then on the host:

```bash
git pull
npm run setup     # picks up any new dependencies (usually none)
```

Sanity-check that every bot boots in the GUI before you draw.

## 2. Draw the groups

```bash
npm run tournament -- draw
```

- Only bots that **opted in** join the draw: `"tournament": true` in their
  `bots/<name>/<name>.json`. `new-bot` sets it automatically, so submitted bots
  are in by default; the reference bots (`SampleBot`, `SamplePyBot`, `Hunter`)
  aren't flagged and stay out. The draw prints who was skipped.
- Bots are auto-split into balanced groups of ~4. Each group fights **one melee
  battle** (its id is just the group letter: `A`, `B`, …). The number of groups
  is always a **power of two** (2, 4, 8, …) so the knockout bracket comes out
  perfectly balanced with no byes — with more bots the draw grows the groups
  (up to ~6) rather than adding a fifth group.
- Need a fill-in to even out a group? `npm run tournament -- draw --include Hunter`
  pulls in a bot that hasn't opted in. `--all` takes every bot regardless of the
  flag, and `--exclude A,B` drops bots even if they opted in.
- Drew it wrong? `npm run tournament -- reset` and draw again.

Show the draw on the big screen:

```bash
npm run tournament -- status
```

## 3. Play the group stage

One battle per group: boot **all of the group's bots into a single melee** in
the GUI (a decent default: **10–20 rounds** — melee rounds are chaotic, so more
rounds gives a steadier signal). When it ends, the GUI's results screen ranks
the bots by total score — that ranking is the group's finishing order. Record
it top-down, comma-separated (at least the top 2; the rest is optional but nice
for the big screen):

```bash
npm run tournament -- report A NightHawk,TankGod,SlowBot,WallHugger
npm run tournament -- report B NightOwl,Crusher            # top 2 is enough
```

`npm run tournament -- next` lists what's left to play. The top 2 of each group
are marked `→`. There are no draws — if two bots tie on total score for a
qualifying spot, go by 1st-place counts, or just re-run the melee.

Mistyped an order? Report it again — the latest report wins (as long as the
knockout isn't seeded yet).

## 4. 🔁 Re-pull between rounds (let people iterate)

We re-pull `main` before each round so people can keep improving their bots.
Because the tournament tracks bots by **folder name**, changing a bot's *code*
never breaks the bracket.

Between rounds:

```bash
# merge any new PRs that update existing bots, then on the host:
git pull
npm run setup        # only if someone added a dependency
```

Then keep going — `status`, `report`, etc. all still work against the same
bracket. (New *folders* added after the draw won't join a bracket already in
progress; only code changes to already-drawn bots take effect.)

> Heads-up for competitors: melee rewards different tactics than 1v1
> (crossfire-dodging, not being the biggest threat). Since the group stage is
> melee and the knockout is 1v1, iterating between rounds matters!

> If a `git pull` ever removes a bot folder that's in the bracket, `status` warns
> you. That bot still needs its folder present to boot — restore it before its
> next match.

## 5. Seed the knockout bracket

Once every group melee is reported:

```bash
npm run tournament -- knockout
```

This takes the **top 2 of each group** and seeds a single-elimination bracket,
crossing groups so no two group-mates meet in the first knockout round. Because
the draw always makes a power-of-two number of groups, the bracket is full — no
byes. (Byes only appear if you hand-edit the state into an odd shape; the
manager then gives them to the highest seeds automatically.)

## 6. Play the knockout

Same loop — run each match in the GUI, then report the winner (no draws in
knockout; if the GUI shows a score tie, go by 1st-place count or replay):

```bash
npm run tournament -- report K1-2 NightHawk
npm run tournament -- bracket        # show the current bracket
```

The manager generates each next round automatically as the current one fills in,
all the way to the **Final**. When you report the final, it prints the champion. 🏆

## Command reference

```
npm run tournament -- draw [--all] [--include A,B] [--exclude A,B]
                                             Draw group melees (opted-in bots)
npm run tournament -- status                 Placements + bracket + pending (default)
npm run tournament -- next                   Just the battles left to play
npm run tournament -- report <group> first,second[,third,...]
                                             Record a group melee's finishing order
npm run tournament -- report <id> <winner>   Record a knockout result
npm run tournament -- knockout               Seed the bracket after the group stage
npm run tournament -- bracket                Show the knockout bracket
npm run tournament -- reset                  Wipe all state and start over
npm run bracket                              Live bracket viewer + control panel
```

## Live bracket on the big screen

```bash
npm run bracket
```

Opens a browser page (default `http://localhost:4600`) that visualizes
`tournament-state.json` and refreshes itself every couple of seconds — leave it
on the projector and it updates on its own as results come in:

- **Group stage**: each group's melee placements; the top 2 get marked as
  qualifiers once the melee is reported.
- **Knockout**: the bracket with the full path to the Final — future rounds are
  drawn as dashed TBD cards, and bots whose next opponent isn't decided yet are
  seeded forward as soon as their match is reported.
- **Champion**: the winning path is highlighted all the way to the trophy. 🏆

The page is also a full **control panel** — every CLI command has a clickable
equivalent, so you can run the entire event from the browser:

- **Draw**: with no tournament yet, the page lists every bot in `bots/`
  (opted-in bots pre-checked — tick a reference bot like `Hunter` to even out a
  group) and a **Draw groups** button.
- **Group results**: **Enter result** on a group card, then click the bots in
  finishing order (winner first, top 2 is enough) and save. **Edit result**
  re-reports it, latest report wins.
- **Seed knockout**: once every melee is in, a **Seed knockout bracket** button
  appears in the header.
- **Knockout results**: click the winning bot in its match card, then confirm.
  Only the latest round can be corrected — once a winner has been fed into the
  next round, its match is locked.
- **Reset**: header button, with an are-you-sure step.

Changes made in the browser and via the CLI land in the same state file, so mix
freely — the page picks up CLI reports within a couple of seconds and vice versa.

Flags: `--port 4600`, `--no-open` (don't auto-open a browser), `--state <path>`
(view a different state file).

## Tips for running it live

- Put the GUI on the projector and narrate the battles — it's the fun part.
- The format scales to however many bots show up: anywhere from 12 to 23 bots
  is 4 group melees (groups of 3–6) + 7 knockout matches — ~11 battles total,
  and always a full quarter-final bracket with no byes. 10–20 rounds per melee
  and ~10 per knockout match keeps it moving.
- Consider the **[Tank Royale Viewer](https://github.com/jandurovec/tank-royale-viewer)**
  for a slicker big-screen display.
- `tournament-state.json` is your source of truth — back it up if you're paranoid.
  It's gitignored so it won't clash with anyone's PR.

## Optional: fully automated battles

Prefer to auto-run matches instead of clicking through the GUI? Tank Royale ships
a JVM **[Battle Runner](https://robocode.dev/api/battle-runner.html)** (Java/Kotlin)
that can boot these TypeScript bots headlessly and return scores. You'd write a
small Kotlin harness that feeds it each fixture from `tournament-state.json`. It's
more setup than it's worth for a 2-hour event, but it's there if you want a
hands-off bracket.
