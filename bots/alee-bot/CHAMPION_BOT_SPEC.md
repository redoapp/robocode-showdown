# AleeBot Champion Architecture and Training Plan

Status: submission candidate frozen; deterministic default, learned candidates rejected
Repository: `redoapp/robocode-showdown`
Bot: `bots/alee-bot`
Runtime: Robocode Tank Royale 1.0.2, TypeScript/Node

## 1. Objective

Build the strongest empirically validated AleeBot possible: a competitive 1v1
and melee bot whose radar, targeting, movement, learning, evaluation, and model
promotion systems are correct, reproducible, measurable, and fast.

"Best" is an evaluation claim, not a model-size claim. A candidate becomes the
champion only by beating the incumbent across a versioned opponent league with
statistical confidence and without unacceptable regressions on held-out bots.

The target is a hybrid architecture:

- deterministic physics and safety;
- per-opponent state estimation;
- a virtual-gun ensemble containing statistical and learned guns;
- wave-surfing movement with trajectory danger evaluation;
- optional framework-free JSON models where learning adds measured value;
- optional hierarchical self-play RL after the deterministic foundation wins.

## 2. Initial Schema-v1 Verdict

The initial learning signal and combat architecture were not trustworthy; the
tested zgml branch also produced zero gradients despite reporting success:

- waves advance by scan count rather than game turn;
- waves are not associated with `scannedBotId`;
- GuessFactor labels are measured from the chosen aim angle instead of the
  head-on bearing at wave creation;
- 207 examples are spread across 31 classes;
- the reported 34.3% training accuracy exactly equals the 34.3% majority-class
  baseline;
- evaluation uses training data and aggregate battle totals only;
- movement reverses after damage rather than avoiding inferred bullets;
- one learned gun controls every shot without virtual-gun competition;
- the model and feature definition are duplicated between bot and trainer;
- generated data and checkpoints have no schema/version manifest.

The former `training/guess-factor.jsonl` and
`training/guess-factor-model.json` artifacts were schema v1, invalid for future
promotion, and have been removed. The frozen battle scores in
`baselines/schema-v1.json` remain historical evaluation evidence; they are not
training data or a deployable model. Every trainable run now enters through the
schema-v2 manifest validator.

### 2.1 Implementation decision — deterministic default and Bradley gate

The deployed default remains the deterministic/statistical architecture. No
learned checkpoint has been promoted. A genuine PyTorch candidate beat kNN
offline, but regressed in the official Bradley A/B: 64/100 wins and +28.1 mean
margin versus the deterministic default's 72/100 and +49.3. Failed candidate
reports remain in the ignored local training directory as negative evidence.

Bradley's `bcn-bot` is now the primary nemesis and a protected promotion
opponent. Sample bots remain correctness and floor checks; success against them
cannot compensate for a Bradley regression. A learned ensemble member is
activated only after both offline and official-battle gates pass.

## 3. Non-Negotiable Invariants

### 3.1 Time and identity

- All physics use the Robocode `turnNumber`, never event or scan counts.
- Every opponent observation is keyed by `scannedBotId`.
- Every friendly or enemy wave records its intended opponent or shooter ID.
- A wave can only be updated or resolved against the matching bot.
- Out-of-order, missing, and repeated scans must not corrupt history.

### 3.2 GuessFactor reference frame

Every friendly wave stores:

- origin `(x, y)`;
- fire turn;
- head-on absolute bearing at wave creation;
- lateral direction at wave creation;
- bullet power and speed;
- maximum escape angle;
- opponent ID;
- feature snapshot and schema version;
- real or virtual wave kind;
- selected gun and selected aim angle as separate fields.

The training label is:

```text
offset = normalize(bearing(origin, opponent_at_arrival) - head_on_bearing)
guess_factor = clamp(offset / (max_escape_angle * lateral_direction), -1, 1)
```

The selected aim angle must never affect the label.

### 3.3 No privileged inference

- Observer/controller data may generate offline labels and evaluation metrics.
- The deployed policy may consume only information available to the bot through
  its events and state getters.
- Opponent identity may be stored for splits and per-opponent statistics, but a
  general model must not memorize runtime IDs as an input feature.

### 3.4 Hot path

- Models compile and bind once at bot startup.
- Per-turn inference uses preallocated input and output buffers.
- No graph compilation, checkpoint parsing, synchronous filesystem writes, or
  JSON serialization occurs in the normal combat hot path.
- Telemetry is disabled in tournament mode and buffered when collection mode is
  enabled.
- Target p99: under 0.5 ms for model inference and under 2 ms for the complete
  decision turn on the target Apple Silicon machine.

### 3.5 Champion integrity

- A candidate cannot overwrite the champion artifact directly.
- Promotion is an explicit evaluator operation.
- A champion artifact identifies its model, schema, source revision, trainer,
  dataset, training configuration, and evaluation report.
- A bot must start safely with no model, a corrupt model, or a schema mismatch.

## 4. Target Runtime Architecture

```text
Robocode events
      |
      v
CombatState
  - actual turn timeline
  - per-opponent histories
  - friendly and enemy waves
  - energy/fire inference
  - battlefield geometry
      |
      +--------------------+----------------------+-------------------+
      |                    |                      |                   |
      v                    v                      v                   v
Target/Radar Manager   Gun System          Movement System      Telemetry
                       - virtual guns      - enemy waves        - traces
                       - learned gun       - trajectory sim     - outcomes
                       - shot policy       - wall smoothing     - metrics
      |                    |                      |
      +--------------------+----------------------+
                           |
                           v
                     Intent Actuator
```

The deployed `alee-bot.ts` becomes a thin Robocode adapter. It translates
events into `CombatState`, asks the three deep combat modules for decisions, and
queues intents. Robocode-specific lifecycle and event registration remain in
that adapter; physics, tactics, and learning do not.

## 5. Planned Modules

Prefer a few deep modules over many pass-through files. Internal helpers remain
private unless two real adapters need the same seam.

### 5.1 `src/combat-state.ts`

Responsibilities:

- maintain actual turn and round state;
- maintain a bounded history per opponent;
- derive velocity components, acceleration, turn rate, lateral velocity,
  advancing velocity, distance delta, and time since motion changes;
- infer enemy fire from energy drops while accounting for observable damage and
  collision events;
- create, advance, match, resolve, and expire friendly/enemy waves;
- expose safe battlefield geometry and wall-distance calculations;
- isolate 1v1 and melee opponent state.

This is the sole authority for combat history and wave physics.

Tests must cover delayed scans, missed scans, multiple scans in one turn, melee
identity isolation, angle wrapping, wave arrival, enemy fire inference, round
reset, and stale-wave cleanup.

### 5.2 `src/gun-system.ts`

Responsibilities:

- run all guns as virtual guns on the same fire opportunity;
- maintain per-opponent and global performance with recent-data decay;
- select a gun using calibrated expected damage, not raw training accuracy;
- select bullet power using hit probability, distance, both energy levels,
  kill-shot value, gun heat, and expected energy return;
- create real and virtual friendly waves through `CombatState`;
- provide a deterministic fallback if learning is unavailable.

Initial guns:

1. head-on;
2. exact linear intercept;
3. circular/turn-rate prediction;
4. segmented GuessFactor histogram;
5. dynamic-clustering or k-nearest-neighbor GuessFactor gun;
6. optional MLP GuessFactor-distribution gun.

Each gun returns an aim distribution or angle plus confidence. Virtual-gun
outcomes record whether each candidate angle would have intersected the target.
The selected gun is allowed to differ by opponent and situation.

### 5.3 `src/movement-system.ts`

Responsibilities:

- maintain enemy bullet waves inferred by `CombatState`;
- match `HitByBullet` and `BulletHitBullet` events to enemy waves;
- learn segmented danger distributions over enemy GuessFactors;
- simulate reachable forward/reverse trajectories through the nearest waves;
- account for acceleration, braking, maximum turn rate, battlefield walls, and
  future wave intersections;
- apply wall smoothing and choose the minimum-danger path;
- provide deterministic anti-ram and melee fallback behavior.

Movement is implemented before advanced RL. A learned danger estimator may be
added behind the module only after the deterministic surfer beats the existing
movement baseline.

### 5.4 `src/target-radar-system.ts`

Responsibilities:

- maintain radar lock in 1v1;
- schedule scans across live opponents in melee;
- choose a target using distance, threat, energy, recency, line of fire, and
  score opportunity;
- prevent stale targets from controlling gun or movement decisions;
- expose target changes to virtual-gun and telemetry accounting.

### 5.5 `src/learning-system.ts`

Responsibilities:

- own `FEATURE_SCHEMA_VERSION`, feature count, bin count, normalization,
  topology, checkpoint prefix, and model construction;
- encode a feature vector from `CombatState` without duplicated definitions;
- validate checkpoint and feature compatibility;
- validate and compile the framework-free JSON model;
- perform allocation-controlled inference;
- return calibrated logits/probabilities and confidence;
- fail closed to the statistical gun on any mismatch.

Initial v2 feature candidates:

- normalized distance and bullet flight time;
- lateral and advancing velocity;
- acceleration and turn rate;
- time since direction, velocity, and acceleration changes;
- relative heading represented as sine/cosine;
- forward/reverse wall distance within the escape envelope;
- opponent and own energy;
- distance delta;
- prior observed GuessFactor tendency;
- melee pressure/threat summary where applicable.

Opponent ID, round result, future state, and observer-only information are not
features.

The initial exported topology begins with `N -> 64 -> 31`. Larger or recurrent models
must earn promotion through evaluation and meet the latency budget.

### 5.6 `src/telemetry.ts`

Responsibilities:

- define versioned trace and wave-outcome records;
- buffer collection records and flush outside the decision hot path;
- record battle, round, turn, opponent, wave kind, features, label, selected
  gun, virtual-gun outcomes, actual bullet result, and source metadata;
- separate training, validation, held-out, and evaluation runs;
- reject mixed schemas.

## 6. Data Contract v2

Each collection run writes a run manifest and sharded JSONL or compact binary
records under the ignored local data directory:

```text
bots/alee-bot/training/runs/<run-id>/
  manifest.json
  wave-outcomes-000.jsonl
  round-results.jsonl
```

The manifest includes:

- schema version;
- repository commit and dirty-state flag;
- trainer and runtime model format;
- bot/checkpoint version;
- opponent names and versions;
- arena/game configuration;
- collection mode and wave weighting;
- random seed when the engine exposes one;
- timestamps and record counts.

Wave records include both real and virtual waves. Real waves receive higher
training weight because the opponent can react to actual fire; virtual waves
provide coverage and are evaluated separately.

Splits happen by complete battle/run and opponent, never by randomly mixing
individual waves from the same battle across train and validation.

Required partitions:

- training opponents/runs;
- validation runs from known opponents;
- held-out opponents never used for fitting or tuning;
- final promotion league.

## 7. Training Pipeline

Replace the single-purpose trainer with a versioned experiment runner.

### 7.1 Preflight

- validate every manifest and record;
- report class balance, opponent balance, real/virtual balance, and corrupt data;
- reject schema v1;
- compute majority, uniform, head-on, linear, histogram, and kNN baselines;
- stop if the requested split leaks battles or opponents.

### 7.2 Training

- construct the model only through `learning-system.ts`;
- use deterministic initialization and recorded seeds;
- preserve stable seeded batches for training;
- address class imbalance with balanced sampling or supported loss weighting;
- use early stopping selected on validation log loss or simulated hit value;
- save candidate artifacts separately from champion artifacts;
- record loss curves and native execution evidence.

### 7.3 Offline evaluation

Report at minimum:

- majority baseline accuracy;
- top-1 and top-3 accuracy;
- cross entropy/log loss;
- expected calibration error;
- mean absolute GuessFactor/bin error;
- simulated hit rate at each bullet power and distance band;
- results per opponent and held-out opponent;
- real-wave versus virtual-wave performance;
- inference latency distribution.

Training-set accuracy alone is never a promotion metric.

### 7.4 Artifact layout

Local candidates:

```text
bots/alee-bot/training/candidates/<candidate-id>/
  model.json
  manifest.json
  offline-report.json
```

Tracked champion:

```text
bots/alee-bot/champion/
  model.json
  manifest.json
  evaluation-report.json
```

The champion manifest contains hashes for every artifact and the exact model and
feature schema. Tournament mode reads only `champion/`.

## 8. Battle and Evaluation Harness

Extend the battle runner rather than scraping console output.

Required capabilities:

- structured JSON output;
- per-round results, not only final totals;
- survival, bullet damage, bullet kill bonus, ram damage, total score, placing,
  energy efficiency, shots, hits, and skipped turns where observable;
- explicit collection/training/evaluation mode;
- candidate and champion checkpoint selection through environment/config;
- configurable arena, rounds, game type, and opponent set;
- parallel isolated Tank Royale servers on separate ports;
- process failure, timeout, and invalid-model detection;
- retained raw reports for bootstrap analysis;
- reproducible run manifests.

### 8.1 Opponent league

Maintain a versioned league with:

- Bradley Nelson's `bcn-bot` as the primary nemesis and protected benchmark;
- `SampleBot` and `SamplePyBot` sanity opponents;
- `Hunter`;
- every submitted local bot;
- deterministic adversarial/exploiter bots targeting common weaknesses;
- frozen snapshots of previous AleeBot champions;
- training-only sparring bots;
- held-out promotion opponents.

1v1 and melee leagues are reported separately. No single opponent is allowed to
dominate the training distribution.

### 8.2 Promotion gate

A candidate is promoted only when all conditions hold:

- no correctness, schema, startup, skipped-turn, or timeout failure;
- beats deterministic fallback baselines;
- exceeds the incumbent's aggregate score ratio with a positive bootstrapped
  95% confidence lower bound across promotion rounds;
- does not regress more than the configured tolerance on any protected opponent
  cohort;
- improves or preserves survival, damage efficiency, and melee placement;
- satisfies inference latency and memory budgets;
- reproduces from its manifest in a clean checkout.

Initial milestone gates before claiming championship quality:

- positive protected-opponent confidence interval against Bradley Nelson's
  `bcn-bot` in its 1v1 nemesis matchup;
- at least 95% round wins against `SampleBot` over 500+ evaluation rounds;
- at least 70% round wins against `Hunter` over 500+ evaluation rounds;
- positive score ratio against every current repository bot in 1v1;
- positive aggregate score ratio in the repository melee league;
- learned gun beats majority, head-on, and linear baselines on held-out data;
- candidate beats the prior champion under the formal promotion gate.

These are floor milestones, not proof of "best ever."

## 9. Hierarchical Self-Play RL

RL begins only after the deterministic champion passes the movement, gun, and
evaluation gates.

### 9.1 Scope

The RL policy does not directly rediscover per-turn physics. Every 8-20 turns it
chooses high-level tactics such as:

- target selection preference;
- clockwise/counter-clockwise orbit;
- desired distance band;
- aggression and bullet-power bias;
- movement mode or danger-aversion coefficient;
- virtual-gun exploration/exploitation weight.

The deterministic combat modules execute those choices safely.

### 9.2 Observation and recurrence

The observation is derived exclusively from `CombatState`. Partial observability
is handled with a bounded history or small recurrent state only after a
feed-forward baseline. Hidden state resets every round and is versioned in the
artifact schema.

### 9.3 Reward

Training reward may include:

- official score delta;
- damage dealt minus damage taken;
- bullet energy efficiency;
- survival and placement;
- wall/ram penalties;
- terminal win/score bonus.

Promotion always uses official battle outcomes, never shaped reward.

### 9.4 League self-play

Training samples opponents from:

- current policy;
- frozen historical champions;
- recent exploiters/best responses;
- scripted league bots;
- style-diverse population members.

Opponent sampling prevents catastrophic forgetting and cycles. A candidate that
only beats itself is rejected.

### 9.5 Search policy

Do not implement AlphaGo-style MCTS in the first RL release. Tank Royale is
partially observed with concurrent continuous controls, and the current engine
is not a cheap cloneable simulator. Reconsider search only if a fast,
deterministic, state-clonable simulator exists and beats the non-search policy
within the latency budget.

## 10. Test Strategy

### 10.1 Unit and property tests

- angle normalization and coordinate conventions;
- exact linear intercept and bullet travel;
- GuessFactor round trips and bin edges;
- wave resolution using actual turns;
- delayed/missing scan behavior;
- melee opponent isolation;
- feature normalization and finite-value guarantees;
- model/artifact schema mismatch rejection;
- deterministic fallback selection;
- trajectory simulation acceleration, braking, turning, and wall constraints;
- enemy-wave matching after hits and bullet collisions.

### 10.2 Golden trace tests

Record small event sequences and verify the complete `CombatState` transition,
wave outcomes, gun choice, and movement choice. Golden traces must contain a
1v1 round, missed scans, direction changes, wall pressure, and a melee round.

### 10.3 Integration tests

- boot without a checkpoint;
- boot with a valid champion;
- reject corrupt and incompatible checkpoints;
- collect a small v2 dataset;
- train a small candidate and verify exported-logit parity;
- execute compiled inference in the Robocode worker thread;
- run deterministic smoke battles and emit structured results;
- run parallel battle workers without port or artifact collisions.

### 10.4 Regression tests

Every candidate records comparison against the incumbent and protected
baselines. Performance regressions fail CI or promotion even when unit tests
pass.

## 11. Implementation Phases

### Phase 0 — Freeze and measure the current baseline

- preserve current source and battle reports as baseline evidence;
- mark schema v1 data/model invalid;
- add structured benchmark configuration and raw result retention;
- establish `SampleBot`, `Hunter`, and melee baseline scores.

Exit: repeatable baseline report exists and a clean checkout can reproduce it.

### Phase 1 — Correct Combat State and wave labels

- implement per-opponent histories keyed by ID;
- use actual event turns;
- correct head-on GuessFactor labels;
- separate selected aim from label reference;
- add real/virtual wave kinds and buffered v2 telemetry;
- make `alee-bot.ts` a thin adapter;
- add unit and golden-trace tests.

Exit: physics and label tests pass; a collected v2 dataset passes validation.

### Phase 2 — Evaluation league and champion artifacts

- add structured per-round battle output;
- implement parallel evaluator and league config;
- add statistical comparison and promotion command;
- implement candidate/champion manifests and clean-checkout reproduction.

Exit: a deterministic fallback candidate can be evaluated and promoted/rejected
without manual score reading.

### Phase 3 — Competitive deterministic movement

- infer and track enemy waves;
- implement trajectory simulation, danger bins, and wall smoothing;
- match hits to waves and update danger;
- add melee/ram behavior;
- tune only through the evaluation league.

Exit: movement milestones against `SampleBot` and `Hunter` pass without a
learned gun.

### Phase 4 — Virtual-gun ensemble

- implement head-on, linear, circular, segmented GF, and kNN guns;
- score virtual guns per opponent with decay;
- implement expected-value firepower;
- verify learned-gun fallback behavior.

Exit: ensemble beats every constituent gun across the validation league.

### Phase 5 — Correct supervised learned gun

- centralize schema/model construction;
- collect a large balanced v2 corpus across the league;
- train with battle/opponent-held-out splits;
- report calibration and simulated/real hit value;
- compile and benchmark native inference;
- promote only if it adds league score beyond the ensemble.

Exit: learned gun beats statistical baselines on held-out opponents and improves
the champion under the promotion gate.

### Phase 6 — Learned movement danger and hierarchical RL

- train a learned danger estimator behind `MovementSystem`;
- add a high-level tactical policy with league self-play;
- retain deterministic safety and fallbacks;
- train exploiters and population snapshots;
- promote only by official league score.

Exit: RL candidate beats the non-RL champion with confidence and without
protected-cohort regressions.

### Phase 7 — Champion hardening

- long-run 1v1 and melee evaluation;
- fuzz event sequences and artifact loading;
- verify latency, memory, skipped turns, and clean setup;
- document reproduction and tournament submission;
- publish final champion artifact and evaluation report.

Exit: all completion criteria below hold.

## 12. Completion Criteria

The implementation goal is complete only when:

- all seven phases have met their exits;
- all correctness, unit, golden, integration, and regression tests pass;
- schema v2 data and champion artifacts are reproducible;
- the bot uses actual turns and per-opponent identity everywhere;
- movement wave surfing and the virtual-gun ensemble are active;
- the learned gun is retained only if it beats its baselines and incumbent;
- hierarchical RL is retained only if it beats the non-RL champion;
- a clean checkout can reproduce the champion and run evaluation;
- the final champion evaluation report includes confidence intervals and
  per-opponent results for 1v1 and melee;
- no safer in-scope improvement remains unverified or undocumented.

## 13. Required Commands

The final command names may evolve, but equivalent workflows must exist:

```bash
npm run setup
npm run bot:test
npm run bot:collect -- --league training --rounds 1000
npm run bot:train -- --runs-dir bots/alee-bot/training/runs
npm run bot:report-model -- --candidate <id>
npm run bot:evaluate -- --candidate <id> --league promotion
npm run bot:promote -- --candidate <id>
npm run bot:reproduce-champion
mise exec -- npm run battle -- alee-bot Hunter --rounds 100
```

## 14. Decision Log

- TypeScript remains the product language.
- The deterministic/statistical ensemble remains the deployed default until a
  learned candidate clears every gate.
- learned models deploy only as framework-free, hash-verified JSON; rejected
  candidates do not ship.
- Bradley Nelson's `bcn-bot` is the primary protected nemesis benchmark.
- Model inference remains bounded and in-process with the bot.
- Physics and safety remain deterministic.
- Matchup adaptation is observation-based: the shipped one-on-one stop/go
  counter keys off a narrowly tested opening-fire signature, never a bot name,
  and is disabled for rounds that begin as melee.
- Supervised targeting precedes RL.
- RL is hierarchical and league-trained.
- AlphaGo-style MCTS is deferred pending a cloneable fast simulator.
- Official battle outcomes and formal promotion gates define progress.
