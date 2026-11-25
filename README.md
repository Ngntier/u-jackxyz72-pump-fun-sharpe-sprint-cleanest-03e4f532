[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Ngntier/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Ngntier/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Cleanest Paper Bot — Pump.fun Sharpe Sprint

A paper-trading bot for the [make.fun](https://make.fun) bounty
`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`. It trades paper SOL on
a 6-hour pump.fun forward replay, ranked by hourly Sharpe ratio — steady,
controlled gains beat one lucky moonshot.

## Strategy

Two-leg paper bot, written from scratch in TypeScript:

- **Leg A — breadth (guardrail leg):** 0.015 SOL scalps in fresh curves the
  first time real SOL reserves cross 1.5 SOL on net-buy flow — real demand,
  still young. Skips the opening bundle (30-slot minimum age) and anything
  that already dumped 15% off its peak. Exits fast (+20% take-profit, −10%
  stop, 1,200-slot max hold, fade exit when sellers take over the tape).
  Short holds cycle the slots through dozens of coins, clearing the
  20-distinct-mint guardrail (round trips of at least 0.01 SOL) with room to
  spare. Its job is breadth, not profit.
- **Leg B — survivor (upside leg):** 0.50 SOL into a curve the moment its real
  reserves cross 50 SOL — on the dev window 35 of the 56 coins that crossed
  50 SOL went on to complete, and crossers are the only positive-drift setup
  measured. Held for the completion run-up (+50% take-profit, −20% stop,
  20,000-slot max hold). Crossings are rare (~18/day on dev), so this leg
  adds positive skew to the hourly equity curve — which is what an hourly
  Sharpe ratio rewards — without ever risking more than ~15% of capital.
  The breadth leg is capped at 25 entries total: on its own it loses ~0.48
  SOL over a dev window (Sharpe −1.32), so it only buys enough coins to
  clear the 20-mint guardrail with margin; the survivor leg carries the PnL.
- **Sizing:** at most 5 open positions (harness cap), at most ~1.5 SOL
  (15% of the 10 SOL capital) at risk at once, so drawdown stays far below
  the 50% guardrail even if every open position went to zero.
  Queued candidates are dropped if they go stale — buying a pump late is
  what bleeds the breadth leg.

Deterministic: no wall-clock time, no unseeded randomness, no network calls,
nothing read outside this repo — the two grading executions agree byte for
byte.

## Run it

Requires Node 22.18+ (the grader runs Node 22.23.4; TypeScript runs as-is).

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout via the
vendored SDK shim in `vendor/makefun-bot.ts`. To grade it locally against the
dev window, run from the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Files

- `main.ts` — entrypoint (wires the strategy into the SDK's `runBot`).
- `strategy.ts` — the strategy: entry filter, exits, sizing, queueing.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `LICENSE` — MIT.
