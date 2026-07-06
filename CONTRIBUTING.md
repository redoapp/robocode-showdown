# Submitting your bot

We collect bots via **pull request** so every bot lands in `main` and the
organizer can pull them all at once.

## How to submit

1. **Create your bot** (if you haven't):

   ```bash
   npm run new-bot -- YourBotName
   ```

2. **Branch, commit your folder, push:**

   ```bash
   git checkout -b bot/yourbotname
   git add bots/YourBotName
   git commit -m "Add bot: YourBotName"
   git push -u origin bot/yourbotname
   ```

3. **Open a PR** titled `Add bot: YourBotName`.

## Rules (keep the merge painless)

- ✅ **Only touch your own folder**, `bots/YourBotName/`. Don't edit other bots,
  shared config, `package.json`, or the scripts.
- ✅ **Folder name == file names.** `bots/YourBotName/` must contain
  `YourBotName.ts`, `.json`, `.sh`, `.cmd`. (The `new-bot` script does this for
  you — use it instead of copy-pasting.)
- ✅ **Fill in `authors`** in your `.json` so you get credit on the scoreboard.
- ✅ **Your bot must boot and run a battle** locally before you submit.
- 🚫 **Don't commit `node_modules/`** — it's gitignored; the organizer runs
  `npm run setup` once on the host.
- 🚫 No network calls, no reading/writing files outside your bot, no trying to
  crash the server. Keep it a fair fight. 🙂

## Updating your bot between rounds

You can keep improving your bot during the event. Just push changes to the **same
folder** (open a new PR or update your existing one). The organizer re-pulls
`main` before each round, so as long as your bot keeps the **same folder name**,
your latest code is what battles next round. Changing the name would look like a
brand-new bot and won't join a bracket that's already in progress.

## Naming

Pick something fun and identifiable — it's what shows up in the arena and on the
bracket. Letters, digits, and underscores only; start with a letter
(e.g. `SpinKing`, `Dodge_9000`).
