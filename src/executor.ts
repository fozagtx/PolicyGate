/**
 * hyperflow.executor — wraps the Hyperliquid TypeScript SDK.
 * Single entry point: execute(action).
 */

import { Hyperliquid } from "hyperliquid";
import type { ActionOutput, ExecutionResult } from "./types.js";
import { appConfig, requiredConfigString, secretEnv } from "./config.js";

// ---- Config ----

const hlNetwork = appConfig.hyperliquid.network;
const hlSymbol = requiredConfigString(appConfig.hyperliquid.symbol, "hyperliquid.symbol");
const hlMasterAddress = requiredConfigString(appConfig.hyperliquid.masterAddress, "hyperliquid.masterAddress");
const hlApiWalletPk = secretEnv("HL_API_WALLET_PK");
const SLIPPAGE = 0.01;

// ---- Executor ----

export class HLExecutor {
  private sdk: Hyperliquid;

  constructor() {
    const isTestnet = hlNetwork === "testnet";
    this.sdk = new Hyperliquid({
      privateKey: hlApiWalletPk,
      testnet: isTestnet,
      walletAddress: hlMasterAddress,
      enableWs: false,
    });
    console.log(
      `HLExecutor initialized: network=${hlNetwork} symbol=${hlSymbol} master=${hlMasterAddress}`
    );
  }

  // ---- Public ----

  async execute(action: ActionOutput): Promise<ExecutionResult> {
    if (action.side === "hold") {
      return {
        success: true,
        action_taken: "skipped",
        order_id: null,
        fill_size: null,
        fill_price: null,
        raw: { reason: action.hold_reason },
        error: null,
      };
    }

    if (action.side === "close") {
      return this.close();
    }

    const isBuy = action.side === "long";
    return this.open(isBuy, action.size_btc);
  }

  // ---- Internals ----

  private async open(isBuy: boolean, sizeBtc: number): Promise<ExecutionResult> {
    try {
      const result = await this.sdk.custom.marketOpen(hlSymbol, isBuy, sizeBtc, undefined, SLIPPAGE);
      return this.parseResult(result, "opened");
    } catch (e: any) {
      console.error("market_open failed:", e);
      return { success: false, action_taken: "opened", order_id: null, fill_size: null, fill_price: null, raw: null, error: String(e) };
    }
  }

  private async close(): Promise<ExecutionResult> {
    try {
      await this.sdk.custom.cancelAllOrders(hlSymbol);
      const closeResult = await this.sdk.custom.marketClose(hlSymbol, undefined, undefined, SLIPPAGE);
      return this.parseResult(closeResult, "closed");
    } catch (e: any) {
      console.error("market_close failed:", e);
      return { success: false, action_taken: "closed", order_id: null, fill_size: null, fill_price: null, raw: null, error: String(e) };
    }
  }

  async closePosition(): Promise<ExecutionResult> {
    return this.close();
  }

  private parseResult(result: any, actionTaken: "opened" | "closed"): ExecutionResult {
    if (!result || typeof result !== "object") {
      return { success: false, action_taken: actionTaken, order_id: null, fill_size: null, fill_price: null, raw: { raw: result }, error: `unexpected result type: ${typeof result}` };
    }

    const status = result.status;
    if (status !== "ok") {
      return { success: false, action_taken: actionTaken, order_id: null, fill_size: null, fill_price: null, raw: result, error: `status=${status}` };
    }

    try {
      const statuses = result.response?.data?.statuses ?? [];
      const first = statuses[0];
      const filled = first?.filled;
      if (!filled) {
        const resting = first?.resting;
        return { success: true, action_taken: actionTaken, order_id: null, fill_size: null, fill_price: null, raw: result, error: resting ? `order resting: ${JSON.stringify(resting)}` : null };
      }
      return {
        success: true,
        action_taken: actionTaken,
        order_id: Number(filled.oid),
        fill_size: Number(filled.totalSz),
        fill_price: Number(filled.avgPx),
        raw: result,
        error: null,
      };
    } catch (e) {
      return { success: false, action_taken: actionTaken, order_id: null, fill_size: null, fill_price: null, raw: result, error: `parse error: ${e}` };
    }
  }

  // ---- State queries ----

  async getState(): Promise<any> {
    await this.sdk.connect();
    return this.sdk.info.perpetuals.getClearinghouseState(hlMasterAddress);
  }

  async getMidPrice(symbol?: string): Promise<number> {
    const sym = symbol ?? hlSymbol;
    const allMids = await this.sdk.info.getAllMids();
    return parseFloat(allMids[sym] ?? "0");
  }
}
