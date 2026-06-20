/**
 * hyperflow.loop
 *
 * Main autonomous agent loop.
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { decide } from "./decision.js";
import { HLExecutor } from "./executor.js";
import { TRACE_TABLE_DDL, persistTrace } from "./reasoning.js";
import { RiskManager } from "./risk.js";
import { alert, AlertLevel, info as tgInfo } from "./telegram-alerts.js";
import { buildApp } from "./dashboard.js";
import { CCTPBridge } from "./cctp.js";
import { CircleBridgeClient } from "./circle-bridge.js";
import { NebiusReasoner, isNebiusEnabled, isNebiusVetoEnabled, type NebiusReview } from "./nebius.js";
import type {
  AgentCounters,
  BridgeResult,
  CircleBridgeTransferResult,
  ExecutionResult,
  MarketState,
  PortfolioState,
  Signal,
} from "./types.js";
import { appConfig, requiredConfigString, secretEnv } from "./config.js";
import { CircleAgentWalletClient, CircleAgentWalletError, type AgentWalletSpend } from "./circle-agent-wallet.js";

const POLL_INTERVAL = appConfig.process.agentPollIntervalSeconds;
const TIME_STOP_SECONDS = appConfig.risk.timeStopSeconds;
const sqlitePath = appConfig.process.sqlitePath;
const statePort = appConfig.process.statePort;

class AgentLoop {
  private walletClient: CircleAgentWalletClient;
  private executor: HLExecutor;
  private db: Database.Database;
  private risk: RiskManager;

  private positionOpenedAt: number | null = null;
  private accountValueAtOpen: number | null = null;
  private lastTradeAt = 0;
  private startedAt = Date.now() / 1000;
  private signalsReceived = 0;
  private tradesOpened = 0;
  private tradesClosed = 0;
  private killSwitchLogged = false;

  private cctp: CCTPBridge | null = null;
  private cctpRecipient = "";
  private cctpLock = new AsyncLock();
  private cctpLastTriggerAt = 0;
  private circleBridge: CircleBridgeClient | null = null;
  private circleBridgeLock = new AsyncLock();
  private circleBridgeLastTriggerAt = 0;
  private nebius: NebiusReasoner | null = null;

  private initialState: any = null;

  private constructor(walletClient: CircleAgentWalletClient, executor: HLExecutor, db: Database.Database, risk: RiskManager) {
    this.walletClient = walletClient;
    this.executor = executor;
    this.db = db;
    this.risk = risk;

    if (isNebiusEnabled()) {
      this.nebius = new NebiusReasoner();
      console.log(`Nebius reasoner enabled: model=${this.nebius.modelName}`);
    }

    try {
      if (appConfig.cctp.enabled) {
        this.cctp = new CCTPBridge(secretEnv("CONSUMER_PK"), this.db);
        this.cctpRecipient = requiredConfigString(appConfig.hyperliquid.masterAddress, "hyperliquid.masterAddress");
        console.log(`CCTP bridge ready: Consumer to HL Master (${this.cctpRecipient}) on Arb Sepolia`);
      } else {
        console.warn("CCTP disabled by config.cctp.enabled=false");
      }
    } catch (e) {
      console.error("CCTP bridge init failed:", e);
      this.cctp = null;
    }

    try {
      if (appConfig.circleBridge.enabled) {
        this.circleBridge = new CircleBridgeClient(this.db);
        const route = this.circleBridge.route();
        console.log(
          `Circle CLI bridge ready: ${route.from_chain} -> ${route.to_chain} recipient=${route.recipient_address}`,
        );
      } else {
        console.warn("Circle CLI bridge disabled by config.circleBridge.enabled=false");
      }
    } catch (e) {
      console.error("Circle CLI bridge init failed:", e);
      this.circleBridge = null;
    }
  }

  static async create(): Promise<AgentLoop> {
    const executor = new HLExecutor();
    const db = initDb();
    const walletClient = new CircleAgentWalletClient(db);
    const initialState = await executor.getState();
    const initialAccountValue = Number(initialState.marginSummary?.accountValue ?? 0);
    const risk = new RiskManager(db, initialAccountValue);
    const agent = new AgentLoop(walletClient, executor, db, risk);
    agent.initialState = initialState;
    return agent;
  }

  async getAccountState(): Promise<any> {
    return this.executor.getState();
  }

  getRiskSnapshot(): Record<string, unknown> {
    return this.risk.snapshot();
  }

  getCounters(): AgentCounters {
    return {
      started_at: this.startedAt,
      signals_received: this.signalsReceived,
      trades_opened: this.tradesOpened,
      trades_closed: this.tradesClosed,
      position_opened_at: this.positionOpenedAt,
    };
  }

  getDb(): Database.Database {
    return this.db;
  }

  getAgentWalletSpend(limit: number = 20): AgentWalletSpend[] {
    return this.walletClient.listSpend(limit);
  }

  async getAgentWalletBalance(): Promise<Record<string, unknown>> {
    return this.walletClient.balance();
  }

  getCctpBridges(limit: number = 10): Record<string, unknown>[] {
    if (!this.cctp) return [];
    try {
      return this.cctp.listBridges(limit);
    } catch (e) {
      console.error("listBridges failed:", e);
      return [];
    }
  }

  getCircleBridgeTransfers(limit: number = 10): Record<string, unknown>[] {
    if (!this.circleBridge) return [];
    try {
      return this.circleBridge.listTransfers(limit) as unknown as Record<string, unknown>[];
    } catch (e) {
      console.error("listCircleBridgeTransfers failed:", e);
      return [];
    }
  }

  getCircleBridgeRoute(): Record<string, unknown> {
    if (!this.circleBridge) return {};
    return this.circleBridge.route();
  }

  async manualTriggerCctp(amountUsdc: number = 1.0): Promise<BridgeResult> {
    if (!this.cctp) {
      throw new Error("CCTP bridge not initialized (check env vars)");
    }

    const now = Date.now() / 1000;
    const cooldownRemaining = 60 - (now - this.cctpLastTriggerAt);
    if (cooldownRemaining > 0) {
      throw new Error(`CCTP bridge cooldown: try again in ${Math.trunc(cooldownRemaining)}s`);
    }

    return this.cctpLock.runExclusive(async () => {
      this.cctpLastTriggerAt = Date.now() / 1000;
      console.log(`Manual CCTP trigger: bridging ${amountUsdc.toFixed(2)} USDC to HL Master on Arb Sepolia`);
      try {
        await alert(
          AlertLevel.INFO,
          `CCTP bridge starting: ${amountUsdc.toFixed(2)} USDC to HL Master (Arb Sepolia)`,
        );
      } catch {
        // Alert failures should not block bridge execution.
      }

      const result = await this.cctp!.bridgeToArbSepolia(amountUsdc, this.cctpRecipient);

      try {
        if (result.success) {
          await alert(
            AlertLevel.INFO,
            `CCTP bridge complete in ${result.total_seconds}s\nburn: ${String(result.burn_tx).slice(0, 10)}\nmint: ${String(result.mint_tx).slice(0, 10)}`,
          );
        } else {
          await alert(AlertLevel.WARN, `CCTP bridge failed: ${result.error}`);
        }
      } catch {
        // Alert failures should not block returning the bridge result.
      }

      return result;
    });
  }

  async manualTriggerCircleBridge(
    amountUsdc: number = appConfig.circleBridge.defaultAmountUsdc,
  ): Promise<CircleBridgeTransferResult> {
    if (!this.circleBridge) {
      throw new Error("Circle CLI bridge not initialized (check config.circleBridge)");
    }
    if (!appConfig.circleBridge.triggerEnabled) {
      throw new Error("Circle CLI bridge trigger is disabled by config.circleBridge.triggerEnabled=false");
    }

    const now = Date.now() / 1000;
    const cooldownRemaining = 60 - (now - this.circleBridgeLastTriggerAt);
    if (cooldownRemaining > 0) {
      throw new Error(`Circle CLI bridge cooldown: try again in ${Math.trunc(cooldownRemaining)}s`);
    }

    return this.circleBridgeLock.runExclusive(async () => {
      this.circleBridgeLastTriggerAt = Date.now() / 1000;
      const route = this.circleBridge!.route();
      console.log(
        `Manual Circle CLI bridge trigger: ${amountUsdc.toFixed(6)} USDC ${route.from_chain} -> ${route.to_chain}`,
      );
      try {
        await alert(
          AlertLevel.INFO,
          `Circle bridge starting: ${amountUsdc.toFixed(2)} USDC ${route.from_chain} -> ${route.to_chain}`,
        );
      } catch {
        // Alert failures should not block bridge execution.
      }

      const result = await this.circleBridge!.transfer(amountUsdc);

      try {
        if (result.success) {
          await alert(
            AlertLevel.INFO,
            `Circle bridge complete: ${result.amount_usdc.toFixed(2)} USDC\nburn: ${String(result.burn_tx ?? "--").slice(0, 10)}\nmint: ${String(result.mint_tx ?? "--").slice(0, 10)}`,
          );
        } else {
          await alert(AlertLevel.WARN, `Circle bridge failed: ${result.error}`);
        }
      } catch {
        // Alert failures should not block returning the bridge result.
      }

      return result;
    });
  }

  async run(): Promise<void> {
    console.log(`Agent loop starting: poll=${POLL_INTERVAL.toFixed(1)}s time_stop=${TIME_STOP_SECONDS}s`);
    await tgInfo(`HyperFlow online. Daily kill threshold: $${Number(this.risk.snapshot().daily_loss_threshold_usd).toFixed(2)}`);

    while (true) {
      try {
        await this.tick();
      } catch (e) {
        console.error("tick raised:", e);
      }
      await sleep(POLL_INTERVAL * 1000);
    }
  }

  private async tick(): Promise<void> {
    if (await this.maybeIntratradeClose()) return;
    if (await this.maybeTimeStop()) return;

    if (!this.risk.killSwitchTripped) {
      this.killSwitchLogged = false;
    }
    if (this.risk.killSwitchTripped) {
      if (!this.killSwitchLogged) {
        console.log("Kill switch tripped; skipping paid signal fetch until day rollover");
        this.killSwitchLogged = true;
      }
      return;
    }

    let signal: Signal | null;
    let spend: AgentWalletSpend | null = null;
    try {
      const paid = await this.walletClient.fetchPaidSignal();
      signal = paid.signal;
      spend = paid.spend;
    } catch (e) {
      if (e instanceof CircleAgentWalletError) {
        console.warn("agent wallet paid signal error:", e.message);
        return;
      }
      throw e;
    }
    if (!signal) return;

    this.signalsReceived += 1;
    console.log(
      `[#${this.signalsReceived}] signal: ${signal.symbol} ${signal.direction} conf=${signal.confidence.toFixed(3)} vol=${signal.vol_ratio.toFixed(2)} tx=${signal.tx_hash ? `${signal.tx_hash.slice(0, 10)}...` : "?"}`,
    );

    const state = await this.executor.getState();
    const midPx = await this.executor.getMidPrice(signal.symbol);
    const portfolio = buildPortfolio(state, midPx, this.risk.dailyPnlUsd, this.lastTradeAt);
    const market = buildMarket(midPx, signal.vol_ratio);

    const trace = decide(signal, portfolio, market, this.risk.killSwitchTripped);
    if (!trace.action) {
      throw new Error("decision returned trace without action");
    }
    console.log(`decision: ${trace.toTelegramSummary()}`);

    const nebiusReview = await this.reviewWithNebius(signal, portfolio, market, trace.action);
    if (nebiusReview && !nebiusReview.approved && isNebiusVetoEnabled()) {
      console.warn(`Nebius VETO: ${nebiusReview.rationale}`);
      await alert(AlertLevel.WARN, `Nebius vetoed trade: ${nebiusReview.rationale}`);
      trace.setExecutionResult({
        success: false,
        error: "nebius_veto",
        action_taken: "vetoed",
        nebius_review: nebiusReview as unknown as Record<string, unknown>,
        agent_wallet_spend: spend as unknown as Record<string, unknown> | null,
      });
      persistTrace(this.db, trace);
      return;
    }

    const verdict = this.risk.checkPretrade(state, trace.action.side);
    if (verdict.veto) {
      console.warn(`pre-trade VETO: ${verdict.reason}`);
      await alert(AlertLevel.WARN, `Trade vetoed: ${verdict.reason}`);
      trace.setExecutionResult({
        success: false,
        error: `vetoed:${verdict.reason}`,
        action_taken: "vetoed",
        nebius_review: nebiusReview as unknown as Record<string, unknown> | null,
        agent_wallet_spend: spend as unknown as Record<string, unknown> | null,
      });
      persistTrace(this.db, trace);
      return;
    }

    const preAccountValue = Number(state.marginSummary?.accountValue ?? 0);
    const result = await this.executor.execute(trace.action);
    trace.setExecutionResult({
      ...(result as unknown as Record<string, unknown>),
      nebius_review: nebiusReview as unknown as Record<string, unknown> | null,
      agent_wallet_spend: spend as unknown as Record<string, unknown> | null,
    });

    await this.applyExecutionResult(result, trace.action.side, preAccountValue);

    try {
      persistTrace(this.db, trace);
    } catch (e) {
      console.error("persistTrace failed:", e);
    }
  }

  private async reviewWithNebius(
    signal: Signal,
    portfolio: PortfolioState,
    market: MarketState,
    action: NonNullable<ReturnType<typeof decide>["action"]>,
  ): Promise<NebiusReview | null> {
    if (!this.nebius) return null;

    const review = await this.nebius.reviewDecision({
      signal,
      portfolio,
      market,
      action,
      riskSnapshot: this.risk.snapshot(),
    });
    console.log(
      `Nebius review: approved=${review.approved} risk=${review.risk_level} latency=${review.latency_ms}ms ${review.rationale}`,
    );
    return review;
  }

  private async applyExecutionResult(result: ExecutionResult, actionSide: string, preAccountValue: number): Promise<void> {
    if (result.success && result.action_taken === "opened") {
      this.positionOpenedAt = Date.now() / 1000;
      this.accountValueAtOpen = preAccountValue;
      this.lastTradeAt = Date.now() / 1000;
      this.tradesOpened += 1;
      console.log(`OPENED ${actionSide} size=${result.fill_size} @ ${result.fill_price} oid=${result.order_id}`);
      return;
    }

    if (result.success && result.action_taken === "closed") {
      await sleep(1000);
      const postState = await this.executor.getState();
      const postAccountValue = Number(postState.marginSummary?.accountValue ?? 0);
      const baseAccountValue = this.accountValueAtOpen ?? preAccountValue;
      await this.risk.recordClose(baseAccountValue, postAccountValue);

      this.positionOpenedAt = null;
      this.accountValueAtOpen = null;
      this.lastTradeAt = Date.now() / 1000;
      this.tradesClosed += 1;

      const pnl = postAccountValue - baseAccountValue;
      const sign = pnl >= 0 ? "+" : "";
      console.log(`CLOSED size=${result.fill_size} @ ${result.fill_price} oid=${result.order_id} PnL=${sign}$${pnl.toFixed(4)}`);
      return;
    }

    if (!result.success) {
      console.error(`execution failed: ${result.error}`);
      await alert(AlertLevel.ERROR, `Execution failed: ${result.error}`);
    }
  }

  private async maybeIntratradeClose(): Promise<boolean> {
    if (this.positionOpenedAt === null) return false;
    const state = await this.executor.getState();
    const verdict = await this.risk.checkIntratrade(state);
    if (!verdict.force_close) return false;
    console.warn(`Intratrade force-close: ${verdict.reason}`);
    await alert(AlertLevel.WARN, `Force-closing position: ${verdict.reason}`);
    return this.forceClose(verdict.reason ?? "intratrade");
  }

  private async maybeTimeStop(): Promise<boolean> {
    if (this.positionOpenedAt === null) return false;
    const elapsed = Date.now() / 1000 - this.positionOpenedAt;
    if (elapsed < TIME_STOP_SECONDS) return false;
    console.log(`Time stop fired: position open ${elapsed.toFixed(1)}s`);
    return this.forceClose("time_stop");
  }

  private async forceClose(reason: string): Promise<boolean> {
    const preState = await this.executor.getState();
    const preAccountValue = Number(preState.marginSummary?.accountValue ?? 0);
    const result = await this.executor.closePosition();
    if (!result.success) {
      console.error(`force-close failed: ${result.error}`);
      return false;
    }

    await sleep(1000);
    const postState = await this.executor.getState();
    const postAccountValue = Number(postState.marginSummary?.accountValue ?? 0);
    const baseAccountValue = this.accountValueAtOpen ?? preAccountValue;
    await this.risk.recordClose(baseAccountValue, postAccountValue);

    const pnl = postAccountValue - baseAccountValue;
    const sign = pnl >= 0 ? "+" : "";
    console.log(`FORCE-CLOSED (${reason}) @ ${result.fill_price} oid=${result.order_id} PnL=${sign}$${pnl.toFixed(4)}`);

    this.positionOpenedAt = null;
    this.accountValueAtOpen = null;
    this.lastTradeAt = Date.now() / 1000;
    this.tradesClosed += 1;
    return true;
  }
}

function initDb(): Database.Database {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.exec(TRACE_TABLE_DDL);
  return db;
}

function buildPortfolio(state: any, _midPx: number, dailyPnlUsd: number, lastTradeAt: number): PortfolioState {
  const ms = state.marginSummary ?? {};
  const accountValue = Number(ms.accountValue ?? 0);
  const totalUsed = Number(ms.totalMarginUsed ?? 0);
  const freeMargin = accountValue - totalUsed;

  let side: "long" | "short" | null = null;
  let sizeBtc = 0;
  let entryPx = 0;
  let unrealized = 0;

  for (const item of state.assetPositions ?? []) {
    const pos = item.position ?? {};
    if (pos.coin !== "BTC") continue;
    const szi = Number(pos.szi ?? 0);
    if (szi === 0) continue;
    side = szi > 0 ? "long" : "short";
    sizeBtc = Math.abs(szi);
    entryPx = Number(pos.entryPx ?? 0);
    unrealized = Number(pos.unrealizedPnl ?? 0);
    break;
  }

  return {
    account_value_usd: accountValue,
    free_margin_usd: freeMargin,
    margin_used_usd: totalUsed,
    open_position_side: side,
    open_position_size_btc: sizeBtc,
    open_position_entry_px: entryPx,
    open_position_unrealized_pnl_usd: unrealized,
    daily_pnl_usd: dailyPnlUsd,
    seconds_since_last_trade: lastTradeAt ? Date.now() / 1000 - lastTradeAt : 9999,
  };
}

function buildMarket(midPx: number, volRatio: number): MarketState {
  return {
    mid_px: midPx,
    bid_px: midPx * (1 - 0.0001),
    ask_px: midPx * (1 + 0.0001),
    spread_bps: 2.0,
    realized_vol_1h_pct: 0.005 * volRatio,
    funding_rate_8h_pct: 0.0001,
  };
}

async function serveDashboard(agent: AgentLoop): Promise<void> {
  const app = buildApp({
    getAccountState: () => agent.getAccountState(),
    getRiskSnapshot: () => agent.getRiskSnapshot(),
    getLoopCounters: () => agent.getCounters(),
    db: agent.getDb(),
    getCctpBridges: (limit) => agent.getCctpBridges(limit),
    triggerCctpBridge: (amount) => agent.manualTriggerCctp(amount),
    getCircleBridgeTransfers: (limit) => agent.getCircleBridgeTransfers(limit),
    getCircleBridgeRoute: () => agent.getCircleBridgeRoute(),
    triggerCircleBridge: (amount) => agent.manualTriggerCircleBridge(amount),
    getAgentWalletSpend: (limit) => agent.getAgentWalletSpend(limit),
    getAgentWalletBalance: () => agent.getAgentWalletBalance(),
  });

  app.listen(statePort, "0.0.0.0", () => {
    console.log(`Dashboard starting on :${statePort}`);
  });
}

async function main(): Promise<void> {
  const agent = await AgentLoop.create();
  await serveDashboard(agent);
  await agent.run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
