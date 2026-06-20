/**
 * hyperflow.risk — risk manager.
 * Pre-trade gate, intra-trade liquidation watch, post-close accounting.
 * State persists in SQLite across restarts.
 */

import type Database from "better-sqlite3";
import { alert, AlertLevel } from "./telegram-alerts.js";
import type { RiskVerdict } from "./types.js";
import { appConfig } from "./config.js";

// ---- Config ----

const DAILY_LOSS_PCT = appConfig.risk.dailyLossPct;
const LIQ_MARGIN_RATIO = appConfig.risk.liquidationMarginRatio;
const EMERGENCY_HALT_PCT = appConfig.risk.emergencyHaltPct;

// ---- SQL ----

export const RISK_STATE_DDL = `
CREATE TABLE IF NOT EXISTS risk_state (
    day_key TEXT PRIMARY KEY,
    kill_switch_tripped INTEGER NOT NULL DEFAULT 0,
    kill_switch_tripped_at INTEGER,
    kill_switch_reason TEXT,
    daily_pnl_usd REAL NOT NULL DEFAULT 0,
    peak_account_value REAL NOT NULL DEFAULT 0,
    initial_account_value REAL NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);
`;

// ---- Helpers ----

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const OK: RiskVerdict = { ok: true, veto: false, force_close: false, reason: null };

// ---- RiskManager ----

export class RiskManager {
  private db: Database.Database;
  private dayKey: string;

  private _killSwitchTripped = false;
  private _killSwitchTrippedAt: number | null = null;
  private _killSwitchReason: string | null = null;
  private _dailyPnlUsd = 0;
  private _peakAccountValue = 0;
  private _initialAccountValue = 0;

  constructor(db: Database.Database, initialAccountValue: number = 0) {
    this.db = db;
    db.exec(RISK_STATE_DDL);
    this.dayKey = utcDayKey();
    this.loadOrInit(initialAccountValue);
  }

  // ---- Properties ----

  get killSwitchTripped(): boolean {
    this.maybeRolloverDay();
    return this._killSwitchTripped;
  }

  get dailyPnlUsd(): number {
    this.maybeRolloverDay();
    return this._dailyPnlUsd;
  }

  snapshot(): Record<string, unknown> {
    this.maybeRolloverDay();
    return {
      day_key: this.dayKey,
      kill_switch_tripped: this._killSwitchTripped,
      kill_switch_tripped_at: this._killSwitchTrippedAt,
      kill_switch_reason: this._killSwitchReason,
      daily_pnl_usd: Math.round(this._dailyPnlUsd * 10000) / 10000,
      daily_loss_threshold_usd: -(DAILY_LOSS_PCT * this._peakAccountValue),
      peak_account_value: Math.round(this._peakAccountValue * 100) / 100,
      initial_account_value: Math.round(this._initialAccountValue * 100) / 100,
    };
  }

  // ---- Pre-trade gate ----

  checkPretrade(state: any, actionSide: string): RiskVerdict {
    this.maybeRolloverDay();
    this.refreshPeak(state);

    if (actionSide === "hold" || actionSide === "close") return OK;
    if (this._killSwitchTripped) {
      return { ok: false, veto: true, force_close: false, reason: `kill_switch_active (${this._killSwitchReason})` };
    }

    if (this._initialAccountValue > 0) {
      const ratio = parseFloat(state.marginSummary?.accountValue ?? 0) / this._initialAccountValue;
      if (ratio < EMERGENCY_HALT_PCT) {
        this.tripKillSwitch(`emergency_halt account ratio ${(ratio * 100).toFixed(1)}% < ${(EMERGENCY_HALT_PCT * 100).toFixed(0)}%`);
        return { ok: false, veto: true, force_close: false, reason: "emergency_halt" };
      }
    }

    return OK;
  }

  // ---- Intra-trade ----

  async checkIntratrade(state: any): Promise<RiskVerdict> {
    this.maybeRolloverDay();
    const ms = state.marginSummary ?? {};
    const accountValue = parseFloat(ms.accountValue ?? 0);
    const marginUsed = parseFloat(ms.totalMarginUsed ?? 0);
    if (accountValue <= 0) return OK;

    const ratio = marginUsed / accountValue;
    if (ratio > LIQ_MARGIN_RATIO) {
      const msg = `liq_protection: margin_used/account = ${(ratio * 100).toFixed(1)}% > threshold ${(LIQ_MARGIN_RATIO * 100).toFixed(0)}% (NAV=$${accountValue.toFixed(2)})`;
      console.warn(msg);
      await alert(AlertLevel.WARN, msg);
      return { ok: false, veto: false, force_close: true, reason: "liq_protection" };
    }

    return OK;
  }

  // ---- Post-close ----

  async recordClose(accountValuePre: number, accountValuePost: number): Promise<void> {
    this.maybeRolloverDay();
    const pnlDelta = accountValuePost - accountValuePre;
    this._dailyPnlUsd += pnlDelta;

    if (accountValuePost > this._peakAccountValue) {
      this._peakAccountValue = accountValuePost;
    }

    const lossLimit = DAILY_LOSS_PCT * this._peakAccountValue;
    if (this._dailyPnlUsd <= -lossLimit && !this._killSwitchTripped) {
      this.tripKillSwitch(
        `daily_loss: pnl=$${this._dailyPnlUsd.toFixed(2)} <= -$${lossLimit.toFixed(2)} (${(DAILY_LOSS_PCT * 100).toFixed(0)}% of peak $${this._peakAccountValue.toFixed(2)})`
      );
      await alert(AlertLevel.KILL, this._killSwitchReason!);
    }

    this.persist();
  }

  // ---- Kill switch ----

  private tripKillSwitch(reason: string): void {
    this._killSwitchTripped = true;
    this._killSwitchTrippedAt = Date.now();
    this._killSwitchReason = reason;
    this.persist();
    console.error("KILL SWITCH TRIPPED:", reason);
  }

  // ---- Persistence ----

  private loadOrInit(initialAccountValue: number): void {
    const row = this.db.prepare(
      `SELECT kill_switch_tripped, kill_switch_tripped_at, kill_switch_reason,
              daily_pnl_usd, peak_account_value, initial_account_value
       FROM risk_state WHERE day_key = ?`
    ).get(this.dayKey) as any;

    if (!row) {
      this._killSwitchTripped = false;
      this._killSwitchTrippedAt = null;
      this._killSwitchReason = null;
      this._dailyPnlUsd = 0;
      this._peakAccountValue = initialAccountValue;
      this._initialAccountValue = initialAccountValue;
      this.persist();
      console.log(`RiskManager initialized fresh for ${this.dayKey} (initial=$${initialAccountValue.toFixed(2)})`);
    } else {
      this._killSwitchTripped = !!row.kill_switch_tripped;
      this._killSwitchTrippedAt = row.kill_switch_tripped_at;
      this._killSwitchReason = row.kill_switch_reason;
      this._dailyPnlUsd = Number(row.daily_pnl_usd);
      this._peakAccountValue = Number(row.peak_account_value);
      this._initialAccountValue = Number(row.initial_account_value);
      if (this._initialAccountValue === 0 && initialAccountValue > 0) {
        this._initialAccountValue = initialAccountValue;
        this.persist();
      }
      console.log(`RiskManager loaded for ${this.dayKey}: kill=${this._killSwitchTripped} pnl=$${this._dailyPnlUsd.toFixed(2)} peak=$${this._peakAccountValue.toFixed(2)}`);
    }
  }

  private persist(): void {
    const nowMs = Date.now();
    this.db.prepare(`
      INSERT INTO risk_state (
        day_key, kill_switch_tripped, kill_switch_tripped_at,
        kill_switch_reason, daily_pnl_usd, peak_account_value,
        initial_account_value, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day_key) DO UPDATE SET
        kill_switch_tripped = excluded.kill_switch_tripped,
        kill_switch_tripped_at = excluded.kill_switch_tripped_at,
        kill_switch_reason = excluded.kill_switch_reason,
        daily_pnl_usd = excluded.daily_pnl_usd,
        peak_account_value = excluded.peak_account_value,
        initial_account_value = excluded.initial_account_value,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      this.dayKey,
      this._killSwitchTripped ? 1 : 0,
      this._killSwitchTrippedAt,
      this._killSwitchReason,
      this._dailyPnlUsd,
      this._peakAccountValue,
      this._initialAccountValue,
      nowMs,
    );
  }

  private maybeRolloverDay(): void {
    const current = utcDayKey();
    if (current === this.dayKey) return;
    console.log(`Day rollover: ${this.dayKey} -> ${current}, resetting kill switch`);
    this.dayKey = current;
    this._killSwitchTripped = false;
    this._killSwitchTrippedAt = null;
    this._killSwitchReason = null;
    this._dailyPnlUsd = 0;
    this.persist();
  }

  private refreshPeak(state: any): void {
    const av = parseFloat(state.marginSummary?.accountValue ?? 0);
    if (av > this._peakAccountValue) {
      this._peakAccountValue = av;
      this.persist();
    }
  }
}
