# bots/

Every bot lives in its own folder inside `bots/`. This folder is also the shared
dependency home for every bot:

- **TypeScript bots** share the one `node_modules/` here (boot scripts run
  `../node_modules/.bin/tsx`) — installed once with `npm run setup`.
- **Python bots** share the one `.venv/` here (boot scripts run
  `../.venv/bin/python`) — created once with `npm run setup:python`.

## Add your bot

The easy way, from the repo root (**name it `<yourname>-bot`** so it's easy to
identify in the arena and on the bracket):

```bash
npm run new-bot -- aburns-bot            # TypeScript
npm run new-bot -- aburns-bot --python   # Python
```

That scaffolds `bots/aburns-bot/` with a ready-to-run `.ts` (or `.py`), `.json`,
`.sh`, and `.cmd`, all named correctly.

The important rule: **every file in a bot folder must share the folder's exact
name.** `bots/aburns-bot/` must contain `aburns-bot.ts` (or `aburns-bot.py`),
`aburns-bot.json`, `aburns-bot.sh`, `aburns-bot.cmd`. The booter finds your bot
by that name — a mismatch means it won't load.

## What each file does

| File             | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `aburns-bot.ts` / `.py` | Your bot's brain.                                                     |
| `aburns-bot.json`  | Metadata: `name`, `version`, `authors` (required). Displayed in the GUI. `"tournament": true` opts your bot in to the tournament draw. |
| `aburns-bot.sh`    | Boot script for macOS/Linux. Don't edit beyond the filename.               |
| `aburns-bot.cmd`   | Boot script for Windows. Don't edit beyond the filename.                   |

## Reference bots

- **`SampleBot/`** — the simplest possible bot, heavily commented. Start here.
- **`SamplePyBot/`** — the same bot in Python, for Python authors.
- **`Hunter/`** — radar lock + predictive aim + adaptive fire power. A tougher
  sparring partner and a good source of ideas. Test your bot against it.

Please leave `SampleBot`, `SamplePyBot`, and `Hunter` in place — they're used as
fill-ins if a group needs an even number of bots. They don't opt in to the
tournament (`"tournament"` isn't set in their `.json`), so they only join a draw
when the organizer pulls them in with `--include` or `--all`.
