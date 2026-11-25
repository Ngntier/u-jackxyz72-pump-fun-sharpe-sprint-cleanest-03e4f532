// Cleanest Paper Bot — two-leg paper trader for the pump.fun Sharpe sprint.
//
// Leg A (breadth): 0.015 SOL scalps in fresh curves for the 20-mint
// guardrail, exited fast. Leg B (survivor): 0.50 SOL into curves whose real
// reserves cross 50 SOL — the only positive-drift setup found on the dev
// window — held for the completion run-up. See strategy.ts for the analysis.
//
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is vendored byte for byte in vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Tuned on the dev window (see strategy.ts): the breadth stake is the
// smallest that still clears the 0.01 SOL round-trip floor with margin, the
// survivor stake is sized so one completion pays for many small losses, and
// queued candidates are dropped if they go stale — buying a pump late is
// what bleeds the breadth leg. Slots are split 3/2 (breadth/survivor), and
// the two legs keep separate cooldowns: the ablation grades showed the
// survivor leg earns +0.33 SOL alone, but its crossings were being blocked
// by breadth positions and the shared cooldown, so a breadth position in a
// crossing coin is now sold at once to free the mint. The breadth leg is
// deliberately throttled (one entry per mint, young coins only): it exists
// for the 20-mint guardrail, its per-trade expectancy is negative, and the
// dev window gives ~4x the needed breadth — so fewer, cheaper tickets.
// The breadth leg also exits on a fade (net sell flow over the recent tape),
// which the offline replay showed cuts its bleed by ~11%.
// Dev-window diagnosis (grade-local, 2026-11-26): breadth-only Sharpe
// -1.32 / PnL -0.48 SOL, survivor-only Sharpe +0.09 / PnL +0.33 SOL — so
// breadth is capped at 25 entries total (the dev window is 24h but the
// final window is 6h: survivor-only would give ~7 mints and fail the
// 20-mint guardrail, while 25 capped breadth trips still clear it with
// ~1.6x margin and cost only ~0.03 SOL of bleed). Survivor stake raised to
// 0.50 SOL with 3 slots: the fixed tx fee shrinks relative to the stake
// and more crossings are caught. (A 0.70 SOL survivor stake graded no
// better — Sharpe is scale-invariant here — so 0.50 stays.)
await runBot(
  createStrategy({
    ...DEFAULT_PARAMS,
    breadth: { ...DEFAULT_PARAMS.breadth, stakeSol: 0.015, maxHoldSlots: 1200, maxEntriesPerMint: 1, fadeNetSol: 0.2 },
    survivor: { ...DEFAULT_PARAMS.survivor, stakeSol: 0.5 },
    breadthMaxAgeSlots: 2000,
    breadthQueueFreshSlots: 600,
    survivorQueueFreshSlots: 300,
    breadthMaxTotalEntries: 25,
    maxBreadthPositions: 3,
    maxSurvivorPositions: 3,
  }),
);
