# AleeBot submission

Status: deterministic submission candidate frozen on 2026-07-09.

## What ships

- TypeScript/Node bot with no model, Python, Zig, or native runtime dependency.
- Per-opponent combat state and correct turn-based friendly/enemy waves.
- Segmented wave surfing with online learned danger and deterministic safety.
- A one-on-one opening probe that recognizes an exact learned-gun firepower
  signature and switches to a bounded straight stop/go counter; melee never
  activates the probe.
- Contextual full-information virtual-gun ensemble: head-on, linear, circular,
  segmented GuessFactor, and kNN.
- Bradley Nelson's `bcn-bot` as the primary protected opponent.

ML and high-level tactical candidates are deliberately not shipped. The real
MLP candidate passed offline baselines but regressed against Bradley; bounded
tactical population search failed its confirmation confidence gate.

## Frozen evidence

- Bradley 1v1, 100 rounds: AleeBot 72 wins, `bcn-bot` 28; score 11,097–6,164;
  mean per-round margin +49.33, bootstrap 95% CI `[+32.62, +66.48]`.
- ML candidate vs Bradley, 100 rounds: 64 wins; mean margin +28.10. Rejected.
- Sanity league, 50 rounds per matchup: 50/50 wins vs SampleBot, 50/50 vs
  Hunter, and 50/50 first places in the three-bot melee.
- Gun ablation, 100 rounds per sanity matchup: contextual ensemble score
  64,604 vs linear 63,731. Ensemble retained.
- Tactical search: no candidate passed fresh Bradley confirmation. Rejected.

Raw reports and collected telemetry are intentionally ignored under
`bots/alee-bot/training/`; this file records the submission decision.

## Current-repository regression check

The repository field changed after the original freeze. Against the current
`main` bots, the new one-on-one counter changed the reproducible
`dangrund-bot` baseline from 8–52 to 54–6 across three fresh 20-round battles
(aggregate score 9,670–2,545). The counter is selected from observed behavior,
not an opponent name, and its exact-power tolerances reject the nearby opening
powers used by other current bots.

Post-counter checks include 66–34 over 100 accumulated rounds against
`bcn-bot`; fresh 20-round results of 19–1 against `coleman-bot`, 14–6 against
`jbosley-bot`, and 13–7 against `joshmoody-bot`; and known losing matchups of
9–11 against `brett-bot`, 3–17 against `tj-bot`, and 4–16 against
`unbeaten-kimchi`. In the current nine-bot opted-in melee, AleeBot placed fifth
over 25 rounds (9,380 points, two first places). These losing matchups remain
future work rather than being hidden by the submission freeze.

## Submission checks

```bash
npm run setup
npm run bot:test
npm run test:evaluation
mise exec -- npm run battle -- alee-bot bcn-bot --rounds 10
npm run tournament -- draw --include alee-bot
```

The submission directory is `bots/alee-bot/`. Its metadata includes
`"tournament": true` so the current tournament tooling includes it in draws.
