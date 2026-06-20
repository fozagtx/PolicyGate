import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { Signal } from "./types.js";
import { appConfig, requiredConfigString } from "./config.js";

const execFileAsync = promisify(execFile);

export const AGENT_WALLET_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS agent_wallet_spend_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms INTEGER NOT NULL,
    workflow TEXT NOT NULL,
    service_url TEXT NOT NULL,
    method TEXT NOT NULL,
    chain TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    max_amount_usdc REAL NOT NULL,
    amount_usdc REAL,
    seller TEXT,
    scheme TEXT,
    receipt TEXT,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    response_json TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_wallet_spend_created
ON agent_wallet_spend_ledger (created_at_ms DESC);
`;

export interface AgentWalletSpend {
  id: number;
  created_at_ms: number;
  workflow: string;
  service_url: string;
  method: string;
  chain: string;
  wallet_address: string;
  max_amount_usdc: number;
  amount_usdc: number | null;
  seller: string | null;
  scheme: string | null;
  receipt: string | null;
  status: string;
  reason: string;
  response_json: string | null;
  error: string | null;
}

export interface PaidSignal {
  signal: Signal;
  spend: AgentWalletSpend;
}

export class CircleAgentWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircleAgentWalletError";
  }
}

export class CircleAgentWalletClient {
  private db: Database.Database;
  private cliBin: string;
  private chain: string;
  private address: string;
  private maxAmountUsdc: number;
  private timeoutSeconds: number;
  private commandTimeoutMs: number;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(AGENT_WALLET_LEDGER_DDL);

    this.cliBin = requiredConfigString(appConfig.circleAgentWallet.cliBin, "circleAgentWallet.cliBin");
    this.chain = requiredConfigString(appConfig.circleAgentWallet.chain, "circleAgentWallet.chain");
    this.address = requiredConfigString(appConfig.circleAgentWallet.address, "circleAgentWallet.address");
    this.maxAmountUsdc = appConfig.circleAgentWallet.maxUsdcPerCall;
    this.timeoutSeconds = appConfig.circleAgentWallet.serviceTimeoutSeconds;
    this.commandTimeoutMs = appConfig.circleAgentWallet.commandTimeoutMs;
  }

  get walletAddress(): string {
    return this.address;
  }

  get walletChain(): string {
    return this.chain;
  }

  async status(): Promise<Record<string, unknown>> {
    return this.circleJson(["wallet", "status", "--type", "agent", "--output", "json"]);
  }

  async listWallets(): Promise<Record<string, unknown>> {
    return this.circleJson(["wallet", "list", "--chain", this.chain, "--type", "agent", "--output", "json"]);
  }

  async balance(): Promise<Record<string, unknown>> {
    return this.circleJson([
      "wallet",
      "balance",
      "--address",
      this.address,
      "--chain",
      this.chain,
      "--output",
      "json",
    ]);
  }

  async searchServices(query: string, limit: number): Promise<Record<string, unknown>> {
    return this.circleJson(["services", "search", query, "--limit", String(limit), "--output", "json"]);
  }

  async inspectService(url: string): Promise<Record<string, unknown>> {
    return this.circleJson(["services", "inspect", url, "--output", "json"]);
  }

  async fetchPaidSignal(): Promise<PaidSignal> {
    const serviceUrl = `${requiredConfigString(appConfig.services.paidSignalService, "services.paidSignalService").replace(/\/$/, "")}/signals/latest`;
    const reason = "buy paid BTC cascade signal for autonomous Hyperliquid decision";

    const startedAt = Date.now();
    try {
      const rawPaid = await this.circleJson([
        "services",
        "pay",
        serviceUrl,
        "--address",
        this.address,
        "--chain",
        this.chain,
        "--max-amount",
        String(this.maxAmountUsdc),
        "--timeout",
        String(this.timeoutSeconds),
        "--output",
        "json",
      ]);

      const paid = unwrapCirclePayload(rawPaid);
      const payment = requireRecord(paid.payment, "payment");
      const response = requireRecord(paid.response, "response");
      const signal = parseSignalResponse(response, paid);
      const amountUsdc = parseUsdc(payment.amount, "payment.amount");
      const receipt = readReceipt(response, payment);

      const spend = this.insertSpend({
        createdAtMs: startedAt,
        workflow: "paid_signal_purchase",
        serviceUrl,
        method: "GET",
        chain: requireString(payment.chain, "payment.chain"),
        walletAddress: this.address,
        maxAmountUsdc: this.maxAmountUsdc,
        amountUsdc,
        seller: requireString(payment.seller, "payment.seller"),
        scheme: requireString(payment.scheme, "payment.scheme"),
        receipt,
        status: "paid",
        reason,
        responseJson: JSON.stringify(paid),
        error: null,
      });

      return { signal, spend };
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.insertSpend({
        createdAtMs: startedAt,
        workflow: "paid_signal_purchase",
        serviceUrl,
        method: "GET",
        chain: this.chain,
        walletAddress: this.address,
        maxAmountUsdc: this.maxAmountUsdc,
        amountUsdc: null,
        seller: null,
        scheme: null,
        receipt: null,
        status: "failed",
        reason,
        responseJson: null,
        error,
      });
      throw e;
    }
  }

  listSpend(limit: number): AgentWalletSpend[] {
    return this.db.prepare(`
      SELECT id, created_at_ms, workflow, service_url, method, chain, wallet_address,
             max_amount_usdc, amount_usdc, seller, scheme, receipt, status, reason,
             response_json, error
      FROM agent_wallet_spend_ledger
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(limit) as AgentWalletSpend[];
  }

  private async circleJson(args: string[]): Promise<Record<string, unknown>> {
    const { stdout, stderr } = await execFileAsync(this.cliBin, args, {
      timeout: this.commandTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (e) {
      throw new CircleAgentWalletError(
        `Circle CLI returned non-JSON output for "${args.join(" ")}": ${String(e)}: ${stdout.slice(0, 500)}`,
      );
    }
  }

  private insertSpend(input: {
    createdAtMs: number;
    workflow: string;
    serviceUrl: string;
    method: string;
    chain: string;
    walletAddress: string;
    maxAmountUsdc: number;
    amountUsdc: number | null;
    seller: string | null;
    scheme: string | null;
    receipt: string | null;
    status: "paid" | "failed";
    reason: string;
    responseJson: string | null;
    error: string | null;
  }): AgentWalletSpend {
    const result = this.db.prepare(`
      INSERT INTO agent_wallet_spend_ledger (
        created_at_ms, workflow, service_url, method, chain, wallet_address,
        max_amount_usdc, amount_usdc, seller, scheme, receipt, status, reason,
        response_json, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.createdAtMs,
      input.workflow,
      input.serviceUrl,
      input.method,
      input.chain,
      input.walletAddress,
      input.maxAmountUsdc,
      input.amountUsdc,
      input.seller,
      input.scheme,
      input.receipt,
      input.status,
      input.reason,
      input.responseJson,
      input.error,
    );

    return this.db.prepare(`
      SELECT id, created_at_ms, workflow, service_url, method, chain, wallet_address,
             max_amount_usdc, amount_usdc, seller, scheme, receipt, status, reason,
             response_json, error
      FROM agent_wallet_spend_ledger
      WHERE id = ?
    `).get(result.lastInsertRowid) as AgentWalletSpend;
  }
}

function parseSignalResponse(response: Record<string, unknown>, raw: Record<string, unknown>): Signal {
  const sigPayload = requireRecord(response.signal, "response.signal");
  const direction = parseSignalDirection(sigPayload);
  if (direction !== "long" && direction !== "short") {
    throw new CircleAgentWalletError(`signal.direction must be long or short, got ${direction}`);
  }

  return {
    symbol: requireString(sigPayload.symbol, "signal.symbol"),
    direction,
    confidence: parseFirstNumber(sigPayload, ["confidence", "conviction", "directional_bias"], "signal.confidence"),
    vol_ratio: parseFirstNumber(sigPayload, ["vol_ratio", "volume_ratio"], "signal.vol_ratio"),
    timestamp_ms: parseFirstInteger(sigPayload, ["timestamp_ms", "timestamp"], "signal.timestamp_ms"),
    tx_hash: readReceipt(response, requireRecord(raw.payment, "payment")),
    raw,
  };
}

function readReceipt(response: Record<string, unknown>, payment: Record<string, unknown>): string {
  if (typeof response.tx_hash === "string" && response.tx_hash.trim()) return response.tx_hash;
  if (typeof response.txHash === "string" && response.txHash.trim()) return response.txHash;
  const settlement = response.settlement;
  if (settlement && typeof settlement === "object" && !Array.isArray(settlement)) {
    const txHash = (settlement as Record<string, unknown>).tx_hash ?? (settlement as Record<string, unknown>).txHash;
    if (typeof txHash === "string" && txHash.trim()) return txHash;
  }
  if (typeof payment.receipt === "string" && payment.receipt.trim()) return payment.receipt;
  throw new CircleAgentWalletError("paid response missing transaction receipt");
}

function unwrapCirclePayload(value: Record<string, unknown>): Record<string, unknown> {
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return value;
}

function parseSignalDirection(sigPayload: Record<string, unknown>): "long" | "short" {
  if (typeof sigPayload.direction === "string") {
    const direct = sigPayload.direction.toLowerCase();
    if (direct === "long" || direct === "short") return direct;
  }

  const side = typeof sigPayload.side === "string" ? sigPayload.side.toUpperCase() : "";
  if (side.includes("LONG_LIQ")) return "short";
  if (side.includes("SHORT_LIQ")) return "long";
  if (side.includes("LONG")) return "long";
  if (side.includes("SHORT")) return "short";

  const bias = Number(sigPayload.directional_bias);
  if (Number.isFinite(bias)) return bias >= 0 ? "long" : "short";

  throw new CircleAgentWalletError("signal missing trade direction");
}

function requireRecord(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CircleAgentWalletError(`${name} must be an object`);
  }
  return value as Record<string, any>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CircleAgentWalletError(`${name} must be a non-empty string`);
  }
  return value;
}

function parseNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CircleAgentWalletError(`${name} must be numeric`);
  }
  return parsed;
}

function parseInteger(value: unknown, name: string): number {
  const parsed = parseNumber(value, name);
  if (!Number.isInteger(parsed)) {
    throw new CircleAgentWalletError(`${name} must be an integer`);
  }
  return parsed;
}

function parseUsdc(value: unknown, name: string): number {
  const raw = requireString(value, name).replace(/\s*USDC$/i, "").replace(/^\$/, "");
  return parseNumber(raw, name);
}

function parseFirstNumber(payload: Record<string, unknown>, keys: string[], name: string): number {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) return parseNumber(payload[key], name);
  }
  throw new CircleAgentWalletError(`${name} missing`);
}

function parseFirstInteger(payload: Record<string, unknown>, keys: string[], name: string): number {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) return parseInteger(payload[key], name);
  }
  throw new CircleAgentWalletError(`${name} missing`);
}
