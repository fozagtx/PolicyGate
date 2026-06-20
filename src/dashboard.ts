/**
 * hyperflow.dashboard
 *
 * Express dashboard for live agent state.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type { BridgeResult, CircleBridgeTransferResult } from "./types.js";
import { buildRealityReport } from "./reality.js";
import { appConfig } from "./config.js";
import type { AgentWalletSpend } from "./circle-agent-wallet.js";
import { checkNebiusHealth } from "./nebius.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, "../client");
const CLIENT_BUNDLE = path.resolve(process.cwd(), "dist/client/app.js");
const CLIENT_DIST_DIR = path.resolve(process.cwd(), "dist/client");

type MaybePromise<T> = T | Promise<T>;

interface DashboardOptions {
  getAccountState: () => MaybePromise<any>;
  getRiskSnapshot: () => MaybePromise<Record<string, unknown>>;
  getLoopCounters: () => MaybePromise<Record<string, any>>;
  db: Database.Database;
  getCctpBridges?: (limit?: number) => MaybePromise<Record<string, unknown>[]>;
  triggerCctpBridge?: (amountUsdc: number) => Promise<BridgeResult>;
  getCircleBridgeTransfers?: (limit?: number) => MaybePromise<Record<string, unknown>[]>;
  getCircleBridgeRoute?: () => MaybePromise<Record<string, unknown>>;
  triggerCircleBridge?: (amountUsdc: number) => Promise<CircleBridgeTransferResult>;
  getAgentWalletSpend?: (limit?: number) => MaybePromise<AgentWalletSpend[]>;
  getAgentWalletBalance?: () => MaybePromise<Record<string, unknown>>;
  getLoopStatus?: () => MaybePromise<Record<string, unknown>>;
}

export function buildApp(options: DashboardOptions): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/static/app.js", (_req: Request, res: Response) => {
    res.sendFile(CLIENT_BUNDLE, (err) => {
      if (err && !res.headersSent) {
        res.status(503).json({
          error: "dashboard client bundle not found",
          expected: CLIENT_BUNDLE,
          hint: "run npm run build",
        });
      }
    });
  });

  app.use("/static", express.static(CLIENT_DIST_DIR));
  app.use("/static", express.static(STATIC_DIR));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "hyperflow-dashboard" });
  });

  app.get("/reality", (_req: Request, res: Response) => {
    res.json(buildRealityReport());
  });

  app.get("/nebius/health", async (req: Request, res: Response) => {
    const live = req.query.live === "1" || req.query.live === "true";
    try {
      res.json(await checkNebiusHealth(live));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: message.slice(0, 300) });
    }
  });

  app.get("/agent-wallet", async (_req: Request, res: Response) => {
    const spend = options.getAgentWalletSpend ? await options.getAgentWalletSpend(50) : [];
    let balance: Record<string, unknown> | null = null;
    if (options.getAgentWalletBalance) {
      balance = await options.getAgentWalletBalance();
    }
    res.json({
      wallet_address: appConfig.circleAgentWallet.address,
      chain: appConfig.circleAgentWallet.chain,
      max_usdc_per_call: appConfig.circleAgentWallet.maxUsdcPerCall,
      balance,
      spend,
    });
  });

  app.get("/", (_req: Request, res: Response) => {
    const indexPath = path.join(STATIC_DIR, "index.html");
    res.sendFile(indexPath, (err) => {
      if (err && !res.headersSent) {
        res.status(503).json({ error: "client/index.html not found", expected: indexPath });
      }
    });
  });

  app.get("/state", async (_req: Request, res: Response) => {
    let hlState: any;
    try {
      hlState = await options.getAccountState();
    } catch (e) {
      console.error("getAccountState failed:", e);
      hlState = { error: String(e), marginSummary: {}, assetPositions: [] };
    }

    const risk = await options.getRiskSnapshot();
    const counters = await options.getLoopCounters();
    const loopStatus = options.getLoopStatus ? await options.getLoopStatus() : {};
    const ms = hlState.marginSummary ?? {};
    const positions = hlState.assetPositions ?? [];

    let positionPayload: Record<string, unknown> | null = null;
    for (const item of positions) {
      const pos = item.position ?? {};
      const szi = Number(pos.szi ?? 0);
      if (szi === 0) continue;
      positionPayload = {
        coin: pos.coin,
        side: szi > 0 ? "long" : "short",
        size_btc: Math.abs(szi),
        entry_px: Number(pos.entryPx ?? 0),
        unrealized_pnl_usd: Number(pos.unrealizedPnl ?? 0),
        leverage: pos.leverage ?? {},
      };
      break;
    }

    const traces = recentTraces(options.db);
    const sparkline = pnlSparkline(options.db);

    let bridges: Record<string, unknown>[] = [];
    let circleBridgeTransfers: Record<string, unknown>[] = [];
    let circleBridgeRoute: Record<string, unknown> = {
      from_chain: appConfig.circleBridge.fromChain,
      to_chain: appConfig.circleBridge.toChain,
      source_address: appConfig.circleBridge.sourceAddress,
      recipient_address: appConfig.circleBridge.recipientAddress,
      default_amount_usdc: appConfig.circleBridge.defaultAmountUsdc,
    };
    const agentWalletSpend = options.getAgentWalletSpend ? await options.getAgentWalletSpend(20) : [];
    const cctpEnabled = Boolean(options.getCctpBridges);
    const triggerEnabled = Boolean(options.triggerCctpBridge) && appConfig.cctp.triggerEnabled;
    const circleBridgeEnabled = Boolean(options.getCircleBridgeTransfers) && appConfig.circleBridge.enabled;
    const circleBridgeTriggerEnabled = Boolean(options.triggerCircleBridge) && appConfig.circleBridge.triggerEnabled;
    if (options.getCctpBridges) {
      try {
        bridges = await options.getCctpBridges(10);
      } catch (e) {
        console.error("getCctpBridges failed:", e);
      }
    }
    if (options.getCircleBridgeTransfers) {
      try {
        circleBridgeTransfers = await options.getCircleBridgeTransfers(10);
      } catch (e) {
        console.error("getCircleBridgeTransfers failed:", e);
      }
    }
    if (options.getCircleBridgeRoute) {
      try {
        circleBridgeRoute = await options.getCircleBridgeRoute();
      } catch (e) {
        console.error("getCircleBridgeRoute failed:", e);
      }
    }

    res.json({
      now_ms: Date.now(),
      uptime_seconds: Math.trunc(Date.now() / 1000 - Number(counters.started_at ?? Date.now() / 1000)),
      network: appConfig.hyperliquid.network,
      hyperliquid: {
        network: appConfig.hyperliquid.network,
        symbol: appConfig.hyperliquid.symbol,
        master_address: appConfig.hyperliquid.masterAddress,
      },
      loop_status: loopStatus,
      account: {
        value_usd: Number(ms.accountValue ?? 0),
        withdrawable_usd: Number(hlState.withdrawable ?? 0),
        margin_used_usd: Number(ms.totalMarginUsed ?? 0),
        total_notional_usd: Number(ms.totalNtlPos ?? 0),
      },
      position: positionPayload,
      position_opened_at_ms: counters.position_opened_at
        ? Math.trunc(Number(counters.position_opened_at) * 1000)
        : null,
      risk,
      counters: {
        signals_received: counters.signals_received ?? 0,
        trades_opened: counters.trades_opened ?? 0,
        trades_closed: counters.trades_closed ?? 0,
      },
      traces,
      sparkline,
      cctp: {
        enabled: cctpEnabled,
        trigger_enabled: triggerEnabled,
        bridges,
      },
      circle_bridge: {
        enabled: circleBridgeEnabled,
        trigger_enabled: circleBridgeTriggerEnabled,
        route: circleBridgeRoute,
        transfers: circleBridgeTransfers,
      },
      runtime: buildRealityReport(),
      agent_wallet: {
        address: appConfig.circleAgentWallet.address,
        chain: appConfig.circleAgentWallet.chain,
        max_usdc_per_call: appConfig.circleAgentWallet.maxUsdcPerCall,
        spend: agentWalletSpend,
      },
    });
  });

  app.post("/cctp/trigger", async (req: Request, res: Response) => {
    if (!options.triggerCctpBridge) {
      res.status(503).json({
        error: "CCTP trigger not configured",
        hint: "loop.ts must inject triggerCctpBridge into dashboard",
      });
      return;
    }
    if (!appConfig.cctp.triggerEnabled) {
      res.status(403).json({
        error: "CCTP trigger is disabled",
        hint: "set cctp.triggerEnabled=true in config/hyperflow.config.json to enable",
      });
      return;
    }

    const rawAmount = Number(req.query.amount_usdc ?? req.body?.amount_usdc ?? 1.0);
    const amountUsdc = Math.max(0.1, Math.min(Number.isFinite(rawAmount) ? rawAmount : 1.0, 5.0));
    try {
      const result = await options.triggerCctpBridge(amountUsdc);
      res.json({ ok: true, result });
    } catch (e) {
      console.error("CCTP trigger failed:", e);
      const message = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e).slice(0, 200);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/circle-bridge/trigger", async (req: Request, res: Response) => {
    if (!options.triggerCircleBridge) {
      res.status(503).json({
        error: "Circle bridge trigger not configured",
        hint: "loop.ts must inject triggerCircleBridge into dashboard",
      });
      return;
    }
    if (!appConfig.circleBridge.triggerEnabled) {
      res.status(403).json({
        error: "Circle bridge trigger is disabled",
        hint: "set circleBridge.triggerEnabled=true in config/hyperflow.config.json to enable",
      });
      return;
    }

    const defaultAmount = appConfig.circleBridge.defaultAmountUsdc;
    const rawAmount = Number(req.query.amount_usdc ?? req.body?.amount_usdc ?? defaultAmount);
    const amountUsdc = Math.max(0.1, Math.min(Number.isFinite(rawAmount) ? rawAmount : defaultAmount, 5.0));
    try {
      const result = await options.triggerCircleBridge(amountUsdc);
      res.json({ ok: true, result });
    } catch (e) {
      console.error("Circle bridge trigger failed:", e);
      const message = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e).slice(0, 200);
      res.status(500).json({ ok: false, error: message });
    }
  });

  return app;
}

function recentTraces(db: Database.Database): Record<string, unknown>[] {
  try {
    const rows = db.prepare(`
      SELECT trace_id, created_at_ms, side, size_usd, payment_tx_hash, json_blob
      FROM traces
      ORDER BY created_at_ms DESC
      LIMIT 20
    `).all() as any[];

    return rows.map((row) => {
      let full: any = {};
      try {
        full = row.json_blob ? JSON.parse(row.json_blob) : {};
      } catch {
        full = {};
      }
      const action = full.action ?? {};
      const execution = full.execution_result ?? {};
      const signal = full.signal ?? {};
      const nebius = execution.nebius_review ?? null;
      const marketResearch = execution.market_research ?? null;
      const agentWalletSpend = execution.agent_wallet_spend ?? null;
      return {
        trace_id: row.trace_id,
        trace_id_short: String(row.trace_id).slice(0, 8),
        created_at_ms: row.created_at_ms,
        side: row.side,
        hold_reason: action.hold_reason,
        size_usd: row.size_usd,
        leverage: action.leverage,
        tp_px: action.tp_px,
        sl_px: action.sl_px,
        signal_confidence: signal.confidence,
        signal_vol_ratio: signal.vol_ratio,
        payment_tx_hash: row.payment_tx_hash,
        exec_success: execution.success,
        exec_action: execution.action_taken,
        fill_price: execution.fill_price,
        fill_size: execution.fill_size,
        order_id: execution.order_id,
        exec_error: execution.error,
        nebius_review: nebius,
        market_research: marketResearch,
        tavily_source_count: Number(marketResearch?.result_count ?? 0),
        tavily_sources: Array.isArray(marketResearch?.sources) ? marketResearch.sources.slice(0, 5) : [],
        agent_wallet_spend: agentWalletSpend,
      };
    });
  } catch (e) {
    console.error("trace query failed:", e);
    return [];
  }
}

function pnlSparkline(db: Database.Database): Record<string, number>[] {
  try {
    const rows = db.prepare(`
      SELECT created_at_ms, json_blob
      FROM traces
      WHERE created_at_ms >= ?
      ORDER BY created_at_ms ASC
    `).all(Date.now() - 24 * 3600 * 1000) as any[];

    const points: Record<string, number>[] = [];
    for (const row of rows) {
      try {
        const full = JSON.parse(row.json_blob);
        const execution = full.execution_result ?? {};
        if (execution.action_taken === "closed" && execution.success) {
          points.push({ ts: row.created_at_ms, n: points.length + 1 });
        }
      } catch {
        // Ignore malformed historical blobs.
      }
    }
    return points;
  } catch {
    return [];
  }
}
