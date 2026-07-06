# bots/

Every bot lives in its own folder inside `bots/`. This folder is also the npm
project — all bots share the one `node_modules/` here (the boot scripts look for
`../node_modules/.bin/tsx`), so you only run `npm install` once.

## Add your bot

The easy way, from the repo root:

```bash
npm run new-bot -- MyCoolBot
```

That scaffolds `bots/MyCoolBot/` with a ready-to-run `.ts`, `.json`, `.sh`, and
`.cmd`, all named correctly.

The important rule: **every file in a bot folder must share the folder's exact
name.** `bots/MyCoolBot/` must contain `MyCoolBot.ts`, `MyCoolBot.json`,
`MyCoolBot.sh`, `MyCoolBot.cmd`. The booter finds your bot by that name — a
mismatch means it won't load.

## What each file does

| File            | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `MyBot.ts`      | Your bot's brain.                                                          |
| `MyBot.json`    | Metadata: `name`, `version`, `authors` (required). Displayed in the GUI.   |
| `MyBot.sh`      | Boot script for macOS/Linux. Don't edit beyond the filename.               |
| `MyBot.cmd`     | Boot script for Windows. Don't edit beyond the filename.                   |

## Reference bots

- **`SampleBot/`** — the simplest possible bot, heavily commented. Start here.
- **`Hunter/`** — radar lock + predictive aim + adaptive fire power. A tougher
  sparring partner and a good source of ideas. Test your bot against it.

Please leave `SampleBot` and `Hunter` in place — they're used as fill-ins if a
group needs an even number of bots.
