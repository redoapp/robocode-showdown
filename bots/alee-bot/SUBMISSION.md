# AleeBot submission

Status: deterministic submission candidate frozen on 2026-07-09.

## What ships

- TypeScript/Node bot with no model, Python, Zig, or native runtime dependency.
- Per-opponent combat state and correct turn-based friendly/enemy waves.
- Segmented wave surfing with online learned danger and deterministic safety.
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
