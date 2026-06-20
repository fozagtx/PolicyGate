import "dotenv/config";

/**
 * hyperflow.cctp
 *
 * Circle CCTP V2 bridge: Arc Testnet to Arbitrum Sepolia.
 */

import { ethers } from "ethers";
import type Database from "better-sqlite3";
import type { BridgeResult } from "./types.js";
import { appConfig, requiredConfigString, secretEnv } from "./config.js";

const TOKEN_MESSENGER_V2 = ethers.getAddress("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
const MESSAGE_TRANSMITTER = ethers.getAddress("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");

const DOMAIN_ARC_TESTNET = 26;
const DOMAIN_ARBITRUM = 3;

const USDC_ARC = ethers.getAddress(appConfig.arc.usdc);

const ERC20_ABI = [
  "function balanceOf(address a) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
];

const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
];

export const CCTP_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS cctp_bridges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    sender_address TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    src_domain INTEGER NOT NULL,
    dst_domain INTEGER NOT NULL,
    approve_tx TEXT,
    burn_tx TEXT,
    attestation_received_ms INTEGER,
    mint_tx TEXT,
    status TEXT NOT NULL,
    error TEXT
);
`;

export class CCTPBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CCTPBridgeError";
  }
}

export class CCTPBridge {
  private wallet: ethers.Wallet;
  private db: Database.Database;
  private srcProvider: ethers.JsonRpcProvider;
  private dstProvider: ethers.JsonRpcProvider;
  private usdcSrc: ethers.Contract;
  private tokenMessenger: ethers.Contract;
  private messageTransmitter: ethers.Contract;

  constructor(privateKey: string, db: Database.Database) {
    this.db = db;
    this.db.exec(CCTP_TABLE_DDL);

    this.srcProvider = new ethers.JsonRpcProvider(appConfig.arc.rpcUrl);
    this.dstProvider = new ethers.JsonRpcProvider(appConfig.cctp.arbitrumSepoliaRpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.srcProvider);

    this.usdcSrc = new ethers.Contract(USDC_ARC, ERC20_ABI, this.wallet);
    this.tokenMessenger = new ethers.Contract(TOKEN_MESSENGER_V2, TOKEN_MESSENGER_ABI, this.wallet);
    this.messageTransmitter = new ethers.Contract(
      MESSAGE_TRANSMITTER,
      MESSAGE_TRANSMITTER_ABI,
      this.wallet.connect(this.dstProvider),
    );

    console.log(`CCTPBridge initialized for ${this.wallet.address}`);
  }

  async bridgeToArbSepolia(amountUsdc: number, recipient: string): Promise<BridgeResult> {
    const amountMicros = BigInt(Math.trunc(amountUsdc * 1_000_000));
    const recipientAddress = ethers.getAddress(recipient);
    const start = Date.now();
    const bridgeId = this.insertStarted(this.wallet.address, recipientAddress, amountUsdc);

    try {
      const balance = await this.usdcSrc.balanceOf(this.wallet.address) as bigint;
      if (balance < amountMicros) {
        throw new CCTPBridgeError(
          `insufficient Arc USDC: have ${Number(balance) / 1e6}, need ${amountUsdc.toFixed(6)}`,
        );
      }

      const approveTx = await this.stepApprove(amountMicros);
      this.dbUpdate(bridgeId, { approve_tx: approveTx });

      const burnTx = await this.stepBurn(amountMicros, recipientAddress);
      this.dbUpdate(bridgeId, { burn_tx: burnTx });

      const attestStart = Date.now();
      const { message, attestation } = await this.stepPollAttestation(burnTx);
      const attestationSeconds = Math.trunc((Date.now() - attestStart) / 1000);
      this.dbUpdate(bridgeId, { attestation_received_ms: Date.now() });

      const mintTx = await this.stepMint(message, attestation);
      this.dbUpdate(bridgeId, { mint_tx: mintTx });

      const totalSeconds = Math.trunc((Date.now() - start) / 1000);
      this.dbFinalize(bridgeId, "success", null);

      return {
        success: true,
        amount_usdc: amountUsdc,
        sender: this.wallet.address,
        recipient: recipientAddress,
        approve_tx: approveTx,
        burn_tx: burnTx,
        mint_tx: mintTx,
        attestation_seconds: attestationSeconds,
        total_seconds: totalSeconds,
        error: null,
      };
    } catch (e) {
      const err = `${e instanceof Error ? e.name : "Error"}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`;
      this.dbFinalize(bridgeId, "failed", err);
      console.error("CCTP bridge failed:", err);
      return {
        success: false,
        amount_usdc: amountUsdc,
        sender: this.wallet.address,
        recipient: recipientAddress,
        approve_tx: null,
        burn_tx: null,
        mint_tx: null,
        attestation_seconds: null,
        total_seconds: Math.trunc((Date.now() - start) / 1000),
        error: err,
      };
    }
  }

  listBridges(limit: number = 10): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT id, started_at_ms, finished_at_ms, sender_address, recipient_address,
             amount_usdc, src_domain, dst_domain, approve_tx, burn_tx,
             attestation_received_ms, mint_tx, status, error
      FROM cctp_bridges
      ORDER BY started_at_ms DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
  }

  private async stepApprove(amountMicros: bigint): Promise<string> {
    const current = await this.usdcSrc.allowance(this.wallet.address, TOKEN_MESSENGER_V2) as bigint;
    if (current >= amountMicros) {
      return `0x${"0".repeat(64)} (skipped, allowance sufficient)`;
    }

    const approveAmount = amountMicros > 1_000_000_000n ? amountMicros : 1_000_000_000n;
    const gasPrice = await this.srcProvider.getFeeData().then((f) => f.gasPrice ?? undefined);
    const tx = await this.usdcSrc.approve(TOKEN_MESSENGER_V2, approveAmount, {
      gasLimit: 200_000,
      gasPrice,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new CCTPBridgeError(`approve failed: tx ${tx.hash}`);
    }
    return tx.hash;
  }

  private async stepBurn(amountMicros: bigint, recipient: string): Promise<string> {
    const mintRecipient = ethers.zeroPadValue(recipient, 32);
    const destinationCaller = ethers.ZeroHash;
    const maxFee = 0n;
    const minFinalityThreshold = 2000;
    const gasPrice = await this.srcProvider.getFeeData().then((f) => f.gasPrice ?? undefined);

    const tx = await this.tokenMessenger.depositForBurn(
      amountMicros,
      DOMAIN_ARBITRUM,
      mintRecipient,
      USDC_ARC,
      destinationCaller,
      maxFee,
      minFinalityThreshold,
      {
        gasLimit: 500_000,
        gasPrice,
      },
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new CCTPBridgeError(`burn failed: tx ${tx.hash}`);
    }
    return tx.hash;
  }

  private async stepPollAttestation(burnTxHash: string): Promise<{ message: string; attestation: string }> {
    const txHex = burnTxHash.startsWith("0x") ? burnTxHash : `0x${burnTxHash}`;
    const url = `${appConfig.cctp.irisApiBase}/messages/${DOMAIN_ARC_TESTNET}?transactionHash=${txHex}`;
    const maxWaitSeconds = appConfig.cctp.attestationMaxWaitSeconds;
    const pollIntervalSeconds = appConfig.cctp.attestationPollIntervalSeconds;

    for (let elapsed = 0; elapsed < maxWaitSeconds; elapsed += pollIntervalSeconds) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (response.status === 200) {
          const body = await response.json() as any;
          const message = body.messages?.[0];
          if (message?.status === "complete") {
            return { message: message.message, attestation: message.attestation };
          }
          console.log(`attestation pending status=${message?.status ?? "unknown"} elapsed=${elapsed}s`);
        } else if (response.status !== 404) {
          console.warn(`IRIS unexpected status ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }
      } catch (e) {
        console.warn("IRIS poll error:", e);
      }

      await sleep(pollIntervalSeconds * 1000);
    }

    throw new CCTPBridgeError(`attestation not received after ${maxWaitSeconds}s for tx ${burnTxHash}`);
  }

  private async stepMint(message: string, attestation: string): Promise<string> {
    const fee = await this.dstProvider.getFeeData();
    const gasPrice = fee.gasPrice ?? 0n;
    const tx = await this.messageTransmitter.receiveMessage(message, attestation, {
      gasLimit: 300_000,
      maxFeePerGas: fee.maxFeePerGas ?? gasPrice * 2n,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? gasPrice / 2n,
      type: 2,
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new CCTPBridgeError(`mint failed: tx ${tx.hash}`);
    }
    return tx.hash;
  }

  private insertStarted(sender: string, recipient: string, amount: number): number {
    const result = this.db.prepare(`
      INSERT INTO cctp_bridges
        (started_at_ms, sender_address, recipient_address, amount_usdc, src_domain, dst_domain, status)
      VALUES (?, ?, ?, ?, ?, ?, 'in_progress')
    `).run(Date.now(), sender, recipient, amount, DOMAIN_ARC_TESTNET, DOMAIN_ARBITRUM);
    return Number(result.lastInsertRowid);
  }

  private dbUpdate(bridgeId: number, fields: Record<string, string | number | null>): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const allowed = new Set(["approve_tx", "burn_tx", "attestation_received_ms", "mint_tx"]);
    for (const [key] of entries) {
      if (!allowed.has(key)) throw new Error(`invalid cctp update field: ${key}`);
    }
    const sets = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE cctp_bridges SET ${sets} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      bridgeId,
    );
  }

  private dbFinalize(bridgeId: number, status: "success" | "failed", error: string | null): void {
    this.db.prepare(`
      UPDATE cctp_bridges
      SET finished_at_ms = ?, status = ?, error = ?
      WHERE id = ?
    `).run(Date.now(), status, error, bridgeId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: Database } = await import("better-sqlite3");
  const { config } = await import("dotenv");
  config();

  const amountArg = process.argv[2];
  if (!amountArg) throw new Error("Usage: tsx src/cctp.ts <amount_usdc>");
  const amount = Number(amountArg);
  const dbPath = appConfig.process.sqlitePath;
  const privateKey = secretEnv("CCTP_WALLET_PK");

  const bridge = new CCTPBridge(privateKey, new Database(dbPath));
  const result = await bridge.bridgeToArbSepolia(
    amount,
    requiredConfigString(appConfig.cctp.recipientAddress, "cctp.recipientAddress"),
  );
  console.log(JSON.stringify(result, null, 2));
}
