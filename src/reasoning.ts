/**
 * hyperflow.reasoning — structured reasoning trace.
 *
 * Hashable, replayable, composable. Every decision leaves a SHA-256
 * trace that can be committed on-chain. Deterministic — given the same
 * inputs, re-running the engine reproduces the same action.
 */

import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { appConfig } from "./config.js";
import type {
  ActionOutput,
  HoldReason,
  ReasoningStep,
  ReasoningTrace,
  SignalInput,
  PortfolioInput,
  MarketInput,
} from "./types.js";

// ---- Config ----

const SCHEMA_VERSION = appConfig.reasoning.traceSchemaVersion;
const HASH_ALGO = appConfig.reasoning.traceHashAlgorithm;

// ---- SQL DDL ----

export const TRACE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS traces (
    trace_id TEXT PRIMARY KEY,
    parent_trace_hash TEXT,
    trace_hash TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    side TEXT,
    size_usd REAL,
    payment_tx_hash TEXT,
    json_blob TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces (created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_parent ON traces (parent_trace_hash);
`;

// ---- Trace builder ----

export function createTrace(): ReasoningTrace {
  const trace_id = randomBytes(16).toString("hex");
  const created_at_ms = Date.now();

  const steps: ReasoningStep[] = [];
  let signal: SignalInput | null = null;
  let portfolio: PortfolioInput | null = null;
  let market: MarketInput | null = null;
  let action: ActionOutput | null = null;
  let execution_result: Record<string, unknown> | null = null;
  let parent_trace_hash: string | null = null;
  let trace_hash: string | null = null;

  function canonicalDict(): Record<string, unknown> {
    return {
      trace_id,
      schema_version: SCHEMA_VERSION,
      created_at_ms,
      signal,
      portfolio,
      market,
      steps,
      action,
      execution_result,
      parent_trace_hash,
      trace_hash,
    };
  }

  const self: ReasoningTrace = {
    get trace_id() { return trace_id; },
    get schema_version() { return SCHEMA_VERSION; },
    get created_at_ms() { return created_at_ms; },
    get signal() { return signal; },
    set signal(s: SignalInput | null) { signal = s; },
    get portfolio() { return portfolio; },
    set portfolio(p: PortfolioInput | null) { portfolio = p; },
    get market() { return market; },
    set market(m: MarketInput | null) { market = m; },
    get steps() { return steps; },
    get action() { return action; },
    get execution_result() { return execution_result; },
    get parent_trace_hash() { return parent_trace_hash; },
    set parent_trace_hash(h: string | null) { parent_trace_hash = h; },
    get trace_hash() { return trace_hash; },

    step(rule, predicate, evaluated_to, value_observed, notes = "") {
      steps.push({ rule, predicate, evaluated_to, value_observed, notes });
      return self;
    },

    setAction(a) {
      action = a;
      return self;
    },

    setExecutionResult(result) {
      execution_result = result;
      return self;
    },

    freeze() {
      if (trace_hash) return trace_hash;
      const payload = { ...canonicalDict() };
      delete payload.trace_hash;
      const canonical = stableStringify(payload);
      const h = createHash(HASH_ALGO).update(canonical).digest("hex");
      trace_hash = h;
      return h;
    },

    toJSON() {
      return JSON.stringify(canonicalDict());
    },

    toTelegramSummary() {
      if (!action) return `[trace ${trace_id.slice(0, 8)}] incomplete`;
      const a = action;
      if (a.side === "hold") {
        return `[${trace_id.slice(0, 8)}] HOLD reason=${a.hold_reason} steps=${steps.length}`;
      }
      return `[${trace_id.slice(0, 8)}] ${a.side.toUpperCase()} $${a.size_usd.toFixed(2)} @ ${a.leverage.toFixed(1)}x TP=${a.tp_px} SL=${a.sl_px} steps=${steps.length}`;
    },
  };

  return self;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

// ---- Helpers ----

export function holdAction(reason: HoldReason): ActionOutput {
  return {
    side: "hold",
    size_usd: 0,
    size_btc: 0,
    leverage: 0,
    tp_px: null,
    sl_px: null,
    time_stop_s: null,
    hold_reason: reason,
  };
}

// ---- Persistence ----

export function persistTrace(db: Database.Database, trace: ReasoningTrace): void {
  trace.freeze();
  const a = trace.action;
  const s = trace.signal;
  db.prepare(`
    INSERT INTO traces (
      trace_id, parent_trace_hash, trace_hash, schema_version,
      created_at_ms, side, size_usd, payment_tx_hash, json_blob
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trace.trace_id,
    trace.parent_trace_hash,
    trace.trace_hash,
    trace.schema_version,
    trace.created_at_ms,
    a?.side ?? null,
    a?.size_usd ?? null,
    s?.payment_tx_hash ?? null,
    trace.toJSON(),
  );
}
