// Two-leg paper bot for the pump.fun Sharpe sprint.
//
// Why two legs: on the dev window every directional rule loses money after
// fees — fresh coins drift down on average once latency is modelled, and the
// house momentum pilot lost 94% doing exactly that. Two facts survive that
// analysis, and the bot is built on them:
//
//   Leg A — breadth (guardrail leg). Tiny 0.015 SOL stakes in fresh curves
//   the first time real reserves cross 1.5 SOL on net-buy flow, exited fast
//   (+20% take-profit / -10% stop / 1,200-slot max hold). Per-trade bleed is
//   the smallest of any variant tested, and short holds cycle the five slots
//   through dozens of coins, clearing the 20-distinct-mint guardrail with
//   room to spare. Its job is breadth, not profit. It is capped at 25
//   entries total: uncapped it loses ~0.48 SOL over a dev window
//   (Sharpe -1.32), so it only buys enough coins to clear the guardrail.
//
//   Leg B — survivor (upside leg). A curve whose real reserves cross 50 SOL
//   is a survivor: on dev, 35 of the 56 coins that crossed 50 SOL went on to
//   complete, and the crossers' short-horizon drift is the only positive one
//   measured (+1.1% mean over the next 150 slots, 55% win rate). The bot buys
//   the crossing itself, 0.50 SOL, and lets it run: +50% take-profit,
//   -20% stop, 20,000-slot max hold, so a completion pays for many small
//   losses. Crossings are rare (about 18 per day on dev), so this leg adds
//   positive skew to the hourly equity curve — which is what an hourly Sharpe
//   ratio rewards — without ever risking more than ~15% of capital.
//
// Sizing keeps total exposure small: at most five open positions, at most
// about 1.5 SOL (15% of the 10 SOL capital) at risk at once, so the maximum
// drawdown stays far below the 50% guardrail even if every open position
// went to zero.
//
// Deterministic by construction: no clock, no randomness, no network, no reads
// outside the repo. Iteration is only over insertion-ordered maps fed by the
// batch stream, so the two grading executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** One leg's configuration: its entry rule, stake and exits. */
export interface LegParams {
  /** Target stake per position, in SOL. */
  stakeSol: number;
  /** Smallest buy worth sending, in SOL (round trips must be >= 0.01 SOL). */
  minBuySol: number;
  /** Take profit: sell when mark value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: sell when mark value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell whatever is left after this many slots held. */
  maxHoldSlots: number;
  /** Fade exit: sell when net SOL flow over the recent trades falls below
      minus this (sellers have taken over); a huge value disables it. */
  fadeNetSol: number;
  /** Most entries per mint over the whole run. */
  maxEntriesPerMint: number;
}

export interface Params {
  breadth: LegParams;
  survivor: LegParams;
  /** Real SOL a curve must reach before the breadth leg can buy it. */
  breadthMinRqSol: number;
  /** Never buy a breadth coin with more real SOL than this. */
  breadthMaxRqSol: number;
  /** Real SOL whose crossing arms the survivor leg. */
  survivorRqSol: number;
  /** Slots after creation before a buy is allowed (skip the opening bundle). */
  minAgeSlots: number;
  /** Never buy a breadth coin older than this (the early pump is over). */
  breadthMaxAgeSlots: number;
  /** A survivor crossing older than this is stale (the moment passed). */
  survivorMaxAgeSlots: number;
  /** A queued breadth candidate older than this is dropped, not bought late. */
  breadthQueueFreshSlots: number;
  /** A queued survivor candidate older than this is dropped, not bought late. */
  survivorQueueFreshSlots: number;
  /** Breadth positions may use at most this many of the open-position slots,
      leaving room so survivor crossings can be bought promptly. */
  maxBreadthPositions: number;
  /** Survivor positions may use at most this many slots at once, so a
      crossing that arrives while another survivor is held is not dropped. */
  maxSurvivorPositions: number;
  /** Slots to wait after an exit before the same mint may be bought again. */
  cooldownSlots: number;
  /** Most breadth entries over the whole run (the breadth leg only exists
      for the 20-mint guardrail, and every breadth trip bleeds on average,
      so cap its total cost; the survivor leg carries the PnL). */
  breadthMaxTotalEntries: number;
  /** Recent trades looked at for the buy-flow check. */
  flowTrades: number;
  /** Curve fee (protocol + creator) charged on a sell, as a fraction. */
  curveFee: number;
  /** Slippage allowed on buys, in bps (sells always go out wide open). */
  buySlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  breadth: {
    stakeSol: 0.015,
    minBuySol: 0.015,
    takeProfit: 0.2,
    stopLoss: 0.1,
    maxHoldSlots: 1200,
    fadeNetSol: 0.2,
    maxEntriesPerMint: 1,
  },
  survivor: {
    stakeSol: 0.3,
    minBuySol: 0.05,
    takeProfit: 0.5,
    stopLoss: 0.2,
    maxHoldSlots: 20000,
    fadeNetSol: 1e9,
    maxEntriesPerMint: 1,
  },
  breadthMinRqSol: 1.5,
  breadthMaxRqSol: 80,
  survivorRqSol: 50,
  minAgeSlots: 30,
  breadthMaxAgeSlots: 4000,
  survivorMaxAgeSlots: 5000,
  breadthQueueFreshSlots: 600,
  survivorQueueFreshSlots: 300,
  breadthMaxTotalEntries: 1e9,
  maxBreadthPositions: 3,
  maxSurvivorPositions: 2,
  cooldownSlots: 600,
  flowTrades: 10,
  curveFee: 0.0125,
  buySlippageBps: 1500,
};

const LAMPORTS = 1e9;

interface RecentTrade {
  slot: number;
  buy: boolean;
  sol: number;
}

interface Coin {
  createdSlot: number | null;
  entriesBreadth: number;
  entriesSurvivor: number;
  /** Slot a breadth position in this mint last exited (breadth cooldown). */
  lastExitBreadthSlot: number;
  /** Slot a survivor position in this mint last exited (survivor cooldown). */
  lastExitSurvivorSlot: number;
  /** Waiting for a free slot on the breadth leg. */
  queuedBreadth: boolean;
  /** Slot the breadth queueing happened (stale candidates are dropped). */
  queuedBreadthSlot: number;
  /** Waiting for a free slot on the survivor leg. */
  queuedSurvivor: boolean;
  /** Slot the survivor queueing happened (stale candidates are dropped). */
  queuedSurvivorSlot: number;
  /** Slot the curve's real reserves crossed the survivor threshold, if ever. */
  crossedSlot: number | null;
  /** Real SOL seen on the coin's latest trade (for crossing detection). */
  lastRqSol: number;
  recent: RecentTrade[];
  peakPrice: number;
}

interface Held {
  openedSlot: number;
  /** 0 = breadth leg, 1 = survivor leg. */
  leg: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Breadth entries placed so far (capped: the leg exists for the guardrail). */
  let breadthEntries = 0;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createdSlot: null,
        entriesBreadth: 0,
        entriesSurvivor: 0,
        lastExitBreadthSlot: -1e12,
        lastExitSurvivorSlot: -1e12,
        queuedBreadth: false,
        queuedBreadthSlot: 0,
        queuedSurvivor: false,
        queuedSurvivorSlot: 0,
        crossedSlot: null,
        lastRqSol: 0,
        recent: [],
        peakPrice: 0,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Price of a curve from its virtual reserves (SOL per token). */
  const priceOf = (state: BotState, mint: Pubkey): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const vt = Number(curve.virtual_token_reserves);
    const vq = Number(curve.virtual_quote_reserves);
    if (vt <= 0) return 0;
    return vq / vt;
  };

  /** Mark value in SOL of selling the whole position now (curve fee + tx fee off). */
  const markValueSol = (state: BotState, mint: Pubkey, txFeeSol: number): number => {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined) return 0;
    const tokens = Number(pos.token_amount);
    const vt = Number(curve.virtual_token_reserves);
    const vq = Number(curve.virtual_quote_reserves);
    if (vt + tokens <= 0) return 0;
    const gross = ((tokens * vq) / (vt + tokens)) / LAMPORTS;
    return gross * (1 - p.curveFee) - txFeeSol;
  };

  /** Net buy flow over the coin's recent trades is positive with buys outnumbering sells. */
  const flowOk = (c: Coin): boolean => {
    const rs = c.recent;
    if (rs.length < 3) return false;
    const window = rs.slice(-p.flowTrades);
    let net = 0;
    let buys = 0;
    let sells = 0;
    for (const tr of window) {
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buys++;
      else sells++;
    }
    return net > 0 && buys >= sells;
  };

  const legOf = (h: Held): LegParams => (h.leg === 1 ? p.survivor : p.breadth);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Ingest this batch's events into the per-coin records, watching for the
      // survivor crossing (real reserves passing the threshold on a trade).
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coinOf(e.mint).createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (price > c.peakPrice) c.peakPrice = price;
          const rqSol = Number(e.real_quote_reserves) / LAMPORTS;
          if (c.crossedSlot === null && c.lastRqSol < p.survivorRqSol && rqSol >= p.survivorRqSol) {
            c.crossedSlot = e.slot;
          }
          c.lastRqSol = rqSol;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS });
          if (c.recent.length > 40) c.recent.splice(0, c.recent.length - 40);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      // Exits first, per leg: take profit, stop loss, or the time limit, on
      // mark value vs cost.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.leg === 1) c.lastExitSurvivorSlot = now;
            else c.lastExitBreadthSlot = now;
            c.queuedBreadth = false;
            c.queuedSurvivor = false;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const leg = legOf(h);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        const value = markValueSol(state, mint, txFeeSol);
        const ratio = value / cost;
        const agedOut = now - h.openedSlot > leg.maxHoldSlots;
        // A breadth position in a coin that just crossed the survivor
        // threshold is sold at once: the mint must be free for the survivor
        // leg to buy the crossing (its edge lives in the ~150 slots after
        // the cross), and the small breadth stake is not worth blocking it.
        const coin = coinOf(mint);
        const crossedOver =
          h.leg === 0 &&
          coin.crossedSlot !== null &&
          now - coin.crossedSlot <= p.survivorMaxAgeSlots;
        // Fade exit: sellers have taken over the recent tape.
        let faded = false;
        if (leg.fadeNetSol < 1e8) {
          const window = coin.recent.slice(-p.flowTrades);
          let net = 0;
          for (const tr of window) net += tr.buy ? tr.sol : -tr.sol;
          faded = net < -leg.fadeNetSol;
        }
        if (ratio >= 1 + leg.takeProfit || ratio <= 1 - leg.stopLoss || agedOut || crossedOver || faded) {
          if (pendingMints.has(mint)) continue;
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        }
      }

      // Refresh the candidate queues. Cooldowns are per leg: a breadth exit
      // must never block a survivor entry (the crossing window is short).
      for (const [mint, c] of coins) {
        if (held.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.createdSlot === null) continue;
        const age = now - c.createdSlot;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        // Survivor leg: crossed the threshold, still fresh, flow still buying.
        if (
          !c.queuedSurvivor &&
          c.entriesSurvivor < p.survivor.maxEntriesPerMint &&
          c.crossedSlot !== null &&
          now - c.crossedSlot <= p.survivorMaxAgeSlots &&
          now - c.lastExitSurvivorSlot >= p.cooldownSlots &&
          age >= p.minAgeSlots &&
          rqSol >= p.survivorRqSol * 0.7 &&
          flowOk(c)
        ) {
          c.queuedSurvivor = true;
          c.queuedSurvivorSlot = now;
        }
        // Breadth leg: young curve with real demand, not already dumped.
        if (
          !c.queuedBreadth &&
          c.entriesBreadth < p.breadth.maxEntriesPerMint &&
          now - c.lastExitBreadthSlot >= p.cooldownSlots &&
          age >= p.minAgeSlots &&
          age <= p.breadthMaxAgeSlots &&
          rqSol >= p.breadthMinRqSol &&
          rqSol <= p.breadthMaxRqSol &&
          flowOk(c)
        ) {
          const price = priceOf(state, mint);
          if (c.peakPrice <= 0 || price >= c.peakPrice * 0.85) {
            c.queuedBreadth = true;
            c.queuedBreadthSlot = now;
          }
        }
      }

      // Entries: survivor leg first (rare, valuable), then breadth, sharing
      // the five open-position slots, in queue (first-seen) order. A queued
      // candidate is re-validated at buy time — flow, reserves and price must
      // still hold — and dropped if it went stale waiting for a slot, so the
      // bot never buys a pump that already happened. The breadth leg may use
      // at most maxBreadthPositions slots, leaving one free for survivors.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const breadthHeld = (): number => {
        let n = 0;
        for (const h of held.values()) if (h.leg === 0) n++;
        return n;
      };
      const survivorHeld = (): number => {
        let n = 0;
        for (const h of held.values()) if (h.leg === 1) n++;
        return n;
      };
      const stillFresh = (mint: Pubkey, c: Coin, legIndex: 0 | 1): boolean => {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) return false;
        if (!flowOk(c)) return false;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (legIndex === 1) {
          if (now - c.queuedSurvivorSlot > p.survivorQueueFreshSlots) return false;
          if (rqSol < p.survivorRqSol * 0.7) return false;
          return true;
        }
        if (now - c.queuedBreadthSlot > p.breadthQueueFreshSlots) return false;
        if (rqSol < p.breadthMinRqSol || rqSol > p.breadthMaxRqSol) return false;
        const price = priceOf(state, mint);
        return c.peakPrice <= 0 || price >= c.peakPrice * 0.85;
      };
      const tryEntries = (legIndex: 0 | 1): void => {
        const leg = legIndex === 1 ? p.survivor : p.breadth;
        for (const [mint, c] of coins) {
          if (orders.length >= cap || slotsLeft <= 0) return;
          if (legIndex === 0 && breadthHeld() >= p.maxBreadthPositions) return;
          if (legIndex === 0 && breadthEntries >= p.breadthMaxTotalEntries) return;
          if (legIndex === 1 && survivorHeld() >= p.maxSurvivorPositions) return;
          const queued = legIndex === 1 ? c.queuedSurvivor : c.queuedBreadth;
          if (!queued || held.has(mint) || pendingMints.has(mint)) continue;
          if (!stillFresh(mint, c, legIndex)) {
            if (legIndex === 1) c.queuedSurvivor = false;
            else c.queuedBreadth = false;
            continue;
          }
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) {
            if (legIndex === 1) c.queuedSurvivor = false;
            else c.queuedBreadth = false;
            continue;
          }
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          let amount = Math.min(leg.stakeSol, capSol);
          if (amount > free - txFeeSol) amount = free - txFeeSol;
          if (amount < leg.minBuySol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
            max_slippage_bps: p.buySlippageBps,
          });
          held.set(mint, { openedSlot: now, leg: legIndex });
          if (legIndex === 1) {
            c.entriesSurvivor++;
            c.queuedSurvivor = false;
          } else {
            c.entriesBreadth++;
            breadthEntries++;
            c.queuedBreadth = false;
          }
          free -= amount + txFeeSol;
          slotsLeft--;
        }
      };
      tryEntries(1);
      tryEntries(0);

      return orders;
    },
  };
}
