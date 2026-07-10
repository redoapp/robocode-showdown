# AleeBot

AleeBot is a deterministic-first Robocode Tank Royale bot with optional,
strictly gated machine learning. The tournament-safe default does not require a
checkpoint: it uses per-opponent combat state, enemy-wave tracking, wave-surfing
movement, radar lock, and a virtual-gun ensemble. The ensemble compares
head-on, linear, circular, segmented GuessFactor, and k-nearest-neighbor aim on
the same opportunities and keeps the learned gun disabled unless it proves that
it improves battle results.

The immediate benchmark is Bradley Nelson's `bcn-bot`. The `nemesis` league in
[`config/leagues.json`](config/leagues.json) makes it a protected opponent in
1v1 and melee matchups. AleeBot is not considered champion-quality until it can
beat Bradley's bot under the statistical promotion gate; easy sample-bot wins
are only sanity checks.

## Where machine learning fits

Training uses PyTorch, but deployment does not: an eligible model is exported
as framework-free JSON and executed by the bot's small, hash-verified
TypeScript forward pass. It is an optional gun inside the ensemble, not the
bot's control architecture and not an automatic promotion path.

The trainer accepts only schema-v2 wave outcomes from
`training/runs/<run-id>/`, splits whole battles (or a requested opponent) into a
holdout set, benchmarks the model against head-on, majority, segmented
histogram, and kNN predictors, and writes an isolated candidate under
`training/candidates/<candidate-id>/`. A candidate may enter battle evaluation
only after it beats the strongest offline baseline, passes log-loss and
inference checks, and meets the latency budget. Promotion then requires a
positive battle confidence interval and no protected-opponent regression.

No learned checkpoint is currently promoted. A real PyTorch candidate beat kNN
offline, but regressed against Bradley in the official 100-round A/B (64 wins
and +28.1 mean margin versus the default's 72 wins and +49.3). The
deterministic/statistical ensemble therefore remains the submission default.

## Build and verify

Run commands from the repository root:

```bash
npm run setup
npm run bot:test
npm run test:evaluation
```

`npm run setup` installs only the tournament runtime dependencies. PyTorch is
resolved on demand by `uv` when training is explicitly requested.

Evaluate the checkpoint-free bot against the sanity league and Bradley's
nemesis league:

```bash
npm run bot:evaluate -- --candidate fallback --league sanity
npm run bot:evaluate -- --candidate fallback --league nemesis
mise exec -- npm run battle -- alee-bot bcn-bot --rounds 500
```

## Collect, train, and promote an optional learned gun

Collection output and candidates are deliberately local and ignored by Git:

```bash
npm run bot:collect -- --league training --rounds 1000 --run-prefix experiment-01
npm run bot:train -- --runs-dir bots/alee-bot/training/runs
npm run bot:report-model -- --candidate <candidate-id>
```

The training command prints the new candidate directory and eligibility report.
An ineligible model stops there. `--force` is available only for diagnostic
battle evaluation; it does not bypass promotion:

```bash
npm run bot:evaluate -- --candidate <candidate-id> --league promotion
npm run bot:evaluate -- --candidate <candidate-id> --league nemesis
npm run bot:promote -- <candidate-id>
```

Promotion copies a hash-verified model, manifest, and evaluation report into
`bots/alee-bot/champion/`. Until such an artifact exists, startup safely falls
back to the deterministic/statistical ensemble.

The complete architecture, invariants, gates, and phase exits are in
[`CHAMPION_BOT_SPEC.md`](CHAMPION_BOT_SPEC.md).
