/**
 * hyperflow.types — shared type definitions for the TypeScript port.
 * Equivalent to the dataclasses spread across reasoning.py, executor.py.
 */

// ---- Signal ----

export interface Signal {
  symbol: string;
  direction: "long" | "short";
  confidence: number;
  vol_ratio: number;
  timestamp_ms: number;
  tx_hash: string;
  raw: Record<string, unknown>;
}

// ---- Portfolio / Market inputs ----

export interface PortfolioState {
  account_value_usd: number;
  free_margin_usd: number;
  margin_used_usd: number;
  open_position_side: "long" | "short" | null;
  open_position_size_btc: number;
  open_position_entry_px: number;
  open_position_unrealized_pnl_usd: number;
  daily_pnl_usd: number;
  seconds_since_last_trade: number;
}

export interface MarketState {
  mid_px: number;
  bid_px: number;
  ask_px: number;
  spread_bps: number;
  realized_vol_1h_pct: number;
  funding_rate_8h_pct: number;
}

// ---- Action ----

export type Side = "long" | "short" | "close" | "hold";
export type HoldReason =
  | "low_confidence"
  | "same_direction_open"
  | "opposite_direction_open_waiting"
  | "daily_kill_switch"
  | "liquidation_protection"
  | "min_notional"
  | "leverage_cap"
  | "cooldown"
  | "invalid_market"
  | "insufficient_account_value"
  | "manual_halt";

export interface ActionOutput {
  side: Side;
  size_usd: number;
  size_btc: number;
  leverage: number;
  tp_px: number | null;
  sl_px: number | null;
  time_stop_s: number | null;
  hold_reason: HoldReason | null;
}

// ---- Reasoning trace ----

export interface SignalInput {
  symbol: string;
  direction: string;
  confidence: number;
  vol_ratio: number;
  timestamp_ms: number;
  payment_tx_hash: string;
}

export interface PortfolioInput {
  account_value_usd: number;
  free_margin_usd: number;
  margin_used_usd: number;
  open_position_side: Side | null;
  open_position_size_btc: number;
  open_position_entry_px: number;
  open_position_unrealized_pnl_usd: number;
  daily_pnl_usd: number;
  seconds_since_last_trade: number;
}

export interface MarketInput {
  mid_px: number;
  bid_px: number;
  ask_px: number;
  spread_bps: number;
  realized_vol_1h_pct: number;
  funding_rate_8h_pct: number;
}

export interface ReasoningStep {
  rule: string;
  predicate: string;
  evaluated_to: boolean;
  value_observed: number | string | boolean;
  notes: string;
}

export interface ReasoningTrace {
  trace_id: string;
  schema_version: number;
  created_at_ms: number;
  signal: SignalInput | null;
  portfolio: PortfolioInput | null;
  market: MarketInput | null;
  steps: ReasoningStep[];
  action: ActionOutput | null;
  execution_result: Record<string, unknown> | null;
  parent_trace_hash: string | null;
  trace_hash: string | null;
  freeze(): string;
  step(rule: string, predicate: string, evaluated_to: boolean, value_observed: number | string | boolean, notes?: string): ReasoningTrace;
  setAction(action: ActionOutput): ReasoningTrace;
  setExecutionResult(result: Record<string, unknown>): ReasoningTrace;
  toJSON(): string;
  toTelegramSummary(): string;
}

// ---- Execution result ----

export interface ExecutionResult {
  success: boolean;
  action_taken: "opened" | "closed" | "skipped" | "vetoed";
  order_id: number | null;
  fill_size: number | null;
  fill_price: number | null;
  raw: Record<string, unknown> | null;
  error: string | null;
}

// ---- CCTP bridge ----

export interface BridgeConfig {
  privateKey: string;
  db: import("better-sqlite3").Database;
}

export interface BridgeResult {
  success: boolean;
  amount_usdc: number;
  sender: string;
  recipient: string;
  approve_tx: string | null;
  burn_tx: string | null;
  mint_tx: string | null;
  attestation_seconds: number | null;
  total_seconds: number;
  error: string | null;
}

export interface CircleBridgeTransferResult {
  success: boolean;
  amount_usdc: number;
  from_chain: string;
  to_chain: string;
  source: string;
  recipient: string;
  burn_tx: string | null;
  mint_tx: string | null;
  idempotency_key: string;
  status: string;
  total_seconds: number;
  raw: Record<string, unknown> | null;
  error: string | null;
}

// ---- Risk verdict ----

export interface RiskVerdict {
  ok: boolean;
  veto: boolean;
  force_close: boolean;
  reason: string | null;
}

// ---- Loop counters ----

export interface AgentCounters {
  started_at: number;
  signals_received: number;
  trades_opened: number;
  trades_closed: number;
  position_opened_at: number | null;
}
