# Tournament runbook (organizer)

This is the guide for whoever runs the competition. Format: **World Cup** —
groups of ~4, round-robin, top 2 advance, single-elimination knockout.

The `scripts/tournament.mjs` manager handles the draw, standings, and bracket.
You run the actual battles in the Robocode GUI (best for the projector) and type
the winners back in. State is saved to `scripts/tournament-state.json`, so you can
stop and resume any time.

## Before the event

- One machine is the **tournament host**. It needs Node + Java + the GUI, and a
  clone of this repo.
- Make sure `npm run setup` has been run so all bots can boot.
- Add the repo's `bots/` folder as a **Bot Root Directory** in the GUI (see
  QUICKSTART step 4).

## The flow at a glance

```
collect PRs  ──►  git pull  ──►  draw  ──►  play group matches  ──►  report each
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
- Bots are auto-split into balanced groups of ~4 and round-robin fixtures are
  generated (`A1`, `A2`, … per group).
- Need a fill-in to even out a group? `npm run tournament -- draw --include Hunter`
  pulls in a bot that hasn't opted in. `--all` takes every bot regardless of the
  flag, and `--exclude A,B` drops bots even if they opted in.
- Drew it wrong? `npm run tournament -- reset` and draw again.

Show the draw on the big screen:

```bash
npm run tournament -- status
```

## 3. Play the group stage

For each fixture, run that 1v1 battle in the GUI (a decent default: **best of
odd number of rounds**, e.g. 10 rounds — the bot with the higher total score /
last standing wins the tie). Then record it:

```bash
npm run tournament -- report A1 NightHawk     # NightHawk beat its A1 opponent
npm run tournament -- report A2 draw           # rare, but supported in groups
```

`npm run tournament -- next` lists what's left to play. Standings update live
(**Pts**: win = 3, draw = 1). The top 2 of each group are marked `→`.

Tie-breaks are handled automatically: points, then wins, then head-to-head, then
fewer losses. If two bots are still dead level for a qualifying spot, just replay
that pairing and report the winner.

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

> If a `git pull` ever removes a bot folder that's in the bracket, `status` warns
> you. That bot still needs its folder present to boot — restore it before its
> next match.

## 5. Seed the knockout bracket

Once every group match is reported:

```bash
npm run tournament -- knockout
```

This takes the **top 2 of each group** and seeds a single-elimination bracket,
crossing groups so no two group-mates meet in the first knockout round. If the
number of qualifiers isn't a power of two, the manager gives byes to the highest
seeds automatically.

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
                                             Draw groups & fixtures (opted-in bots)
npm run tournament -- status                 Standings + bracket + pending (default)
npm run tournament -- next                   Just the matches left to play
npm run tournament -- report <id> <winner>   Record a result (winner name, or "draw")
npm run tournament -- knockout               Seed the bracket after the group stage
npm run tournament -- bracket                Show the knockout bracket
npm run tournament -- reset                  Wipe all state and start over
npm run bracket                              Live HTML bracket viewer (for the projector)
```

## Live bracket on the big screen

```bash
npm run bracket
```

Opens a browser page (default `http://localhost:4600`) that visualizes
`tournament-state.json` and refreshes itself every couple of seconds — leave it
on the projector and it updates on its own as you `report` results:

- **Group stage**: live standings per group; qualifiers get marked once a group
  is complete.
- **Knockout**: the bracket with the full path to the Final — future rounds are
  drawn as dashed TBD cards, and bots whose next opponent isn't decided yet are
  seeded forward as soon as their match is reported.
- **Champion**: the winning path is highlighted all the way to the trophy. 🏆

Flags: `--port 4600`, `--no-open` (don't auto-open a browser), `--state <path>`
(view a different state file).

## Tips for running it live

- Put the GUI on the projector and narrate the battles — it's the fun part.
- Keep rounds short (10 rounds each) so you can get through a lot of matches.
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
