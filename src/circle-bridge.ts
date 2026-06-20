/**
 * Circle CLI-backed USDC bridge route.
 *
 * Uses Circle's CCTP Forwarding Service through `circle bridge transfer`.
 * This is separate from src/cctp.ts because the CLI forwards the destination
 * mint, which is the practical path for topping up a Base Sepolia Agent Wallet
 * from Arc Testnet without destination gas.
 */

import "dotenv/config";

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { CircleBridgeTransferResult } from "./types.js";
import { appConfig, requiredConfigString } from "./config.js";

const execFileAsync = promisify(execFile);
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export const CIRCLE_BRIDGE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS circle_bridge_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    from_chain TEXT NOT NULL,
    to_chain TEXT NOT NULL,
    source_address TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    idempotency_key TEXT NOT NULL,
    burn_tx TEXT,
    mint_tx TEXT,
    status TEXT NOT NULL,
    response_json TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_circle_bridge_created
ON circle_bridge_transfers (created_at_ms DESC);
`;

export interface CircleBridgeTransferRow {
  id: number;
  created_at_ms: number;
  finished_at_ms: number | null;
  from_chain: string;
  to_chain: string;
  source_address: string;
  recipient_address: string;
  amount_usdc: number;
  idempotency_key: string;
  burn_tx: string | null;
  mint_tx: string | null;
  status: string;
  response_json: string | null;
  error: string | null;
}

export class CircleBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircleBridgeError";
  }
}

export class CircleBridgeClient {
  private db: Database.Database;
  private cliBin: string;
  private fromChain: string;
  private toChain: string;
  private sourceAddress: string;
  private recipientAddress: string;
  private commandTimeoutMs: number;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(CIRCLE_BRIDGE_TABLE_DDL);

    this.cliBin = requiredConfigString(appConfig.circleAgentWallet.cliBin, "circleAgentWallet.cliBin");
    this.fromChain = requiredConfigString(appConfig.circleBridge.fromChain, "circleBridge.fromChain");
    this.toChain = requiredConfigString(appConfig.circleBridge.toChain, "circleBridge.toChain");
    this.sourceAddress = requiredConfigString(appConfig.circleBridge.sourceAddress, "circleBridge.sourceAddress");
    this.recipientAddress = requiredConfigString(appConfig.circleBridge.recipientAddress, "circleBridge.recipientAddress");
    this.commandTimeoutMs = appConfig.circleBridge.commandTimeoutMs;
  }

  route(): Record<string, unknown> {
    return {
      from_chain: this.fromChain,
      to_chain: this.toChain,
      source_address: this.sourceAddress,
      recipient_address: this.recipientAddress,
      default_amount_usdc: appConfig.circleBridge.defaultAmountUsdc,
    };
  }

  listTransfers(limit: number = 10): CircleBridgeTransferRow[] {
    return this.db.prepare(`
      SELECT id, created_at_ms, finished_at_ms, from_chain, to_chain,
             source_address, recipient_address, amount_usdc, idempotency_key,
             burn_tx, mint_tx, status, response_json, error
      FROM circle_bridge_transfers
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(limit) as CircleBridgeTransferRow[];
  }

  async transfer(amountUsdc: number = appConfig.circleBridge.defaultAmountUsdc): Promise<CircleBridgeTransferResult> {
    const amount = normalizeAmount(amountUsdc);
    const startedAt = Date.now();
    const idempotencyKey = `hyperflow-${startedAt}-${crypto.randomUUID()}`;
    const transferId = this.insertStarted(amount, idempotencyKey);

    const args = [
      "bridge",
      "transfer",
      this.toChain,
      this.recipientAddress,
      "--amount",
      amount.toFixed(6),
      "--address",
      this.sourceAddress,
      "--chain",
      this.fromChain,
      "--idempotency-key",
      idempotencyKey,
      "--output",
      "json",
    ];

    if (this.fromChain === "ARC-TESTNET") {
      args.push("--rpc-url", requiredConfigString(appConfig.arc.rpcUrl, "arc.rpcUrl"));
    }

    try {
      await this.ensureSourceWalletAvailable();
      const { stdout, stderr } = await execFileAsync(this.cliBin, args, {
        timeout: this.commandTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr.trim()) process.stderr.write(stderr);

      const raw = parseCliOutput(stdout);
      const burnTx = findHashByKey(raw, ["burn", "source"]) ?? findFirstHash(raw);
      const mintTx = findHashByKey(raw, ["mint", "destination", "receive"]);
      const status = normalizeStatus(readStatus(raw));
      const responseJson = JSON.stringify(raw);

      this.finalize(transferId, {
        status,
        burnTx,
        mintTx,
        responseJson,
        error: null,
      });

      return {
        success: true,
        amount_usdc: amount,
        from_chain: this.fromChain,
        to_chain: this.toChain,
        source: this.sourceAddress,
        recipient: this.recipientAddress,
        burn_tx: burnTx,
        mint_tx: mintTx,
        idempotency_key: idempotencyKey,
        status,
        total_seconds: Math.trunc((Date.now() - startedAt) / 1000),
        raw,
        error: null,
      };
    } catch (e) {
      const raw = rawFromError(e);
      const error = commandErrorMessage(e);
      this.finalize(transferId, {
        status: "failed",
        burnTx: raw ? findHashByKey(raw, ["burn", "source"]) ?? findFirstHash(raw) : null,
        mintTx: raw ? findHashByKey(raw, ["mint", "destination", "receive"]) : null,
        responseJson: raw ? JSON.stringify(raw) : null,
        error,
      });

      return {
        success: false,
        amount_usdc: amount,
        from_chain: this.fromChain,
        to_chain: this.toChain,
        source: this.sourceAddress,
        recipient: this.recipientAddress,
        burn_tx: raw ? findHashByKey(raw, ["burn", "source"]) ?? findFirstHash(raw) : null,
        mint_tx: raw ? findHashByKey(raw, ["mint", "destination", "receive"]) : null,
        idempotency_key: idempotencyKey,
        status: "failed",
        total_seconds: Math.trunc((Date.now() - startedAt) / 1000),
        raw,
        error,
      };
    }
  }

  private insertStarted(amount: number, idempotencyKey: string): number {
    const result = this.db.prepare(`
      INSERT INTO circle_bridge_transfers (
        created_at_ms, from_chain, to_chain, source_address, recipient_address,
        amount_usdc, idempotency_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress')
    `).run(
      Date.now(),
      this.fromChain,
      this.toChain,
      this.sourceAddress,
      this.recipientAddress,
      amount,
      idempotencyKey,
    );
    return Number(result.lastInsertRowid);
  }

  private finalize(transferId: number, input: {
    status: string;
    burnTx: string | null;
    mintTx: string | null;
    responseJson: string | null;
    error: string | null;
  }): void {
    this.db.prepare(`
      UPDATE circle_bridge_transfers
      SET finished_at_ms = ?, status = ?, burn_tx = ?, mint_tx = ?,
          response_json = ?, error = ?
      WHERE id = ?
    `).run(
      Date.now(),
      input.status,
      input.burnTx,
      input.mintTx,
      input.responseJson,
      input.error,
      transferId,
    );
  }

  private async ensureSourceWalletAvailable(): Promise<void> {
    const [localAddresses, agentAddresses] = await Promise.all([
      this.listWalletAddresses("local"),
      this.listWalletAddresses("agent"),
    ]);
    const all = new Set([...localAddresses, ...agentAddresses].map((address) => address.toLowerCase()));
    if (all.has(this.sourceAddress.toLowerCase())) return;

    throw new CircleBridgeError(
      `source address ${this.sourceAddress} is not in Circle CLI wallet storage for ${this.fromChain}. ` +
        "Import the Arc-funded source wallet with `circle wallet import <name> --private-key`, " +
        "or set config.circleBridge.sourceAddress to an existing Circle CLI wallet on that chain.",
    );
  }

  private async listWalletAddresses(type: "local" | "agent"): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(this.cliBin, [
        "wallet",
        "list",
        "--chain",
        this.fromChain,
        "--type",
        type,
        "--output",
        "json",
      ], {
        timeout: this.commandTimeoutMs,
        maxBuffer: 5 * 1024 * 1024,
      });
      return extractWalletAddresses(parseCliOutput(stdout));
    } catch {
      return [];
    }
  }
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CircleBridgeError("bridge amount must be a positive USDC number");
  }
  return Math.trunc(value * 1_000_000) / 1_000_000;
}

function parseCliOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>;
      } catch {
        return { stdout: trimmed };
      }
    }
    return { stdout: trimmed };
  }
}

function normalizeStatus(status: string | null): string {
  if (!status) return "success";
  const lower = status.toLowerCase();
  if (["complete", "completed", "success", "succeeded", "settled"].includes(lower)) return "success";
  if (["failed", "failure", "error", "reverted"].includes(lower)) return "failed";
  return lower;
}

function readStatus(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === "status" && typeof child === "string" && child.trim()) {
      return child;
    }
    const nested = readStatus(child);
    if (nested) return nested;
  }
  return null;
}

function findHashByKey(value: unknown, keyNeedles: string[]): string | null {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHashByKey(item, keyNeedles);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      typeof child === "string" &&
      TX_HASH_RE.test(child) &&
      keyNeedles.some((needle) => lowerKey.includes(needle)) &&
      (lowerKey.includes("tx") || lowerKey.includes("transaction") || lowerKey.includes("hash"))
    ) {
      return child;
    }
    const nested = findHashByKey(child, keyNeedles);
    if (nested) return nested;
  }

  return null;
}

function findFirstHash(value: unknown): string | null {
  if (typeof value === "string") {
    const match = value.match(/0x[a-fA-F0-9]{64}/);
    return match ? match[0] : null;
  }

  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstHash(item);
      if (found) return found;
    }
    return null;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findFirstHash(child);
    if (found) return found;
  }
  return null;
}

function extractWalletAddresses(value: Record<string, unknown>): string[] {
  const wallets = readWalletArray(value);
  return wallets
    .map((wallet) => wallet.address)
    .filter((address): address is string => typeof address === "string" && address.trim() !== "");
}

function readWalletArray(value: Record<string, unknown>): AnyWallet[] {
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const wallets = (data as Record<string, unknown>).wallets;
    if (Array.isArray(wallets)) return wallets as AnyWallet[];
  }
  const wallets = value.wallets;
  if (Array.isArray(wallets)) return wallets as AnyWallet[];
  if (Array.isArray(value)) return value as AnyWallet[];
  return [];
}

type AnyWallet = Record<string, any>;

function rawFromError(error: unknown): Record<string, unknown> | null {
  const record = errorRecord(error);
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return combined ? parseCliOutput(combined) : null;
}

function commandErrorMessage(error: unknown): string {
  const record = errorRecord(error);
  const message = typeof record.message === "string" ? record.message : String(error);
  const stderr = typeof record.stderr === "string" && record.stderr.trim() ? ` stderr=${record.stderr.trim()}` : "";
  return `${message}${stderr}`.slice(0, 500);
}

function errorRecord(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") return error as Record<string, unknown>;
  return {};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: Database } = await import("better-sqlite3");
  const amount = process.argv[2] ? Number(process.argv[2]) : appConfig.circleBridge.defaultAmountUsdc;
  fs.mkdirSync(path.dirname(appConfig.process.sqlitePath), { recursive: true });
  const client = new CircleBridgeClient(new Database(appConfig.process.sqlitePath));
  const result = await client.transfer(amount);
  console.log(JSON.stringify(result, null, 2));
}
