/**
 * hyperflow.decision — pure decision engine.
 * Given a signal, portfolio state, and market state,
 * returns a ReasoningTrace with the action baked in.
 * No side effects. Deterministic and replayable.
 */

import { createTrace, holdAction } from "./reasoning.js";
import type { ReasoningTrace, Signal, PortfolioState, MarketState } from "./types.js";
import { appConfig } from "./config.js";

// ---- Config ----

const confidenceThreshold = appConfig.risk.confidenceThreshold;
const takeProfitPct = appConfig.risk.takeProfitPct;
const stopLossPct = appConfig.risk.stopLossPct;
const timeStopSeconds = appConfig.risk.timeStopSeconds;
const maxLeverage = appConfig.risk.maxLeverage;
const kellyFraction = appConfig.risk.kellyFraction;
const maxPositionPct = appConfig.risk.maxPositionPct;

// ---- Public ----

export function decide(
  signal: Signal,
  portfolio: PortfolioState,
  market: MarketState,
  killSwitchTripped: boolean = false,
): ReasoningTrace {
  const trace = createTrace();

  // Capture inputs
  trace.signal = {
    symbol: signal.symbol,
    direction: signal.direction,
    confidence: signal.confidence,
    vol_ratio: signal.vol_ratio,
    timestamp_ms: signal.timestamp_ms,
    payment_tx_hash: signal.tx_hash,
  };
  trace.portfolio = { ...portfolio };
  trace.market = { ...market };

  // Rule 1: kill switch
  trace.step(
    "daily_kill_switch",
    "daily_pnl > -2% NAV",
    !killSwitchTripped,
    portfolio.daily_pnl_usd,
  );
  if (killSwitchTripped) {
    trace.setAction(holdAction("daily_kill_switch"));
    trace.freeze();
    return trace;
  }

  // Rule 2: confidence threshold
  const passesConf = signal.confidence >= confidenceThreshold;
  trace.step(
    "confidence_threshold",
    `signal.confidence >= ${confidenceThreshold}`,
    passesConf,
    signal.confidence,
  );
  if (!passesConf) {
    trace.setAction(holdAction("low_confidence"));
    trace.freeze();
    return trace;
  }

  // Rule 3: existing position handling
  const posSide = portfolio.open_position_side;
  if (posSide !== null) {
    const sameDirection = posSide === signal.direction;
    trace.step(
      "position_direction_match",
      "open_position_side == signal.direction",
      sameDirection,
      `${posSide} vs ${signal.direction}`,
    );
    if (sameDirection) {
      trace.setAction(holdAction("same_direction_open"));
      trace.freeze();
      return trace;
    } else {
      trace.setAction({
        side: "close",
        size_usd: 0,
        size_btc: portfolio.open_position_size_btc,
        leverage: 1,
        tp_px: null,
        sl_px: null,
        time_stop_s: null,
        hold_reason: null,
      });
      trace.freeze();
      return trace;
    }
  }

  // Rule 4: position sizing
  const accountValue = portfolio.account_value_usd;
  const edge = signal.confidence - 0.5;
  const variance = Math.max(0.001, market.realized_vol_1h_pct * signal.vol_ratio);
  const kellyPct = (kellyFraction * edge) / variance;
  const sizedPct = Math.min(kellyPct, maxPositionPct);
  const sizeUsd = Math.max(11.0, accountValue * sizedPct);

  trace.step(
    "position_sizing",
    `size = min(Kelly * NAV, ${maxPositionPct * 100}% NAV)`,
    true,
    Math.round(sizeUsd * 100) / 100,
    `kelly_pct=${kellyPct.toFixed(4)}, sized_pct=${sizedPct.toFixed(4)}`,
  );

  // Rule 5: leverage
  const baseLev = 3.0;
  const volAdj = Math.max(0.5, Math.min(2.0, 1.0 / signal.vol_ratio));
  const leverage = Math.min(maxLeverage, baseLev * volAdj);
  trace.step(
    "leverage_scaling",
    "lev = min(max_lev, base_lev / vol_ratio)",
    true,
    Math.round(leverage * 100) / 100,
    `vol_ratio=${signal.vol_ratio.toFixed(2)}, vol_adj=${volAdj.toFixed(2)}`,
  );

  // Build action
  const midPx = market.mid_px;
  const sizeBtc = Math.round((sizeUsd / midPx) * 100000) / 100000;
  if (sizeBtc < 0.00012) {
    trace.step("min_notional_check", "size_btc >= HL min", false, sizeBtc);
    trace.setAction(holdAction("min_notional"));
    trace.freeze();
    return trace;
  }

  const isLong = signal.direction === "long";
  const tpPx = isLong
    ? Math.round(midPx * (1 + takeProfitPct) * 10) / 10
    : Math.round(midPx * (1 - takeProfitPct) * 10) / 10;
  const slPx = isLong
    ? Math.round(midPx * (1 - stopLossPct) * 10) / 10
    : Math.round(midPx * (1 + stopLossPct) * 10) / 10;

  trace.setAction({
    side: isLong ? "long" : "short",
    size_usd: Math.round(sizeUsd * 100) / 100,
    size_btc: sizeBtc,
    leverage: Math.round(leverage * 100) / 100,
    tp_px: tpPx,
    sl_px: slPx,
    time_stop_s: timeStopSeconds,
    hold_reason: null,
  });

  trace.freeze();
  return trace;
}
