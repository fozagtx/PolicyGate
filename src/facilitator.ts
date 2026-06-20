/**
 * hyperflow.facilitator
 *
 * Self-hosted x402 facilitator for Arc Testnet.
 */

import express, { type Request, type Response } from "express";
import { ethers } from "ethers";
import { appConfig, secretEnv } from "./config.js";

const arcRpc = appConfig.arc.rpcUrl;
const arcUsdc = appConfig.arc.usdc;
const arcChainId = appConfig.arc.chainId;
const facilitatorPk = secretEnv("X402_FACILITATOR_PK");

const USDC_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function balanceOf(address a) view returns (uint256)",
];

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

interface VerifyRequestBody {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: Record<string, string>;
  };
}

interface ValidationResult {
  auth: Record<string, string>;
  error: string | null;
}

const provider = new ethers.JsonRpcProvider(arcRpc);
const wallet = new ethers.Wallet(facilitatorPk, provider);
const usdc = new ethers.Contract(ethers.getAddress(arcUsdc), USDC_ABI, wallet);
const nonceLock = new AsyncLock();

export function buildFacilitatorRouter(): express.Router {
  const router = express.Router();

  router.get("/health", async (_req: Request, res: Response) => {
    try {
      const balance = await usdc.balanceOf(wallet.address) as bigint;
      const network = await provider.getNetwork();
      res.json({
        ok: true,
        facilitator: wallet.address,
        chain_id: Number(network.chainId),
        usdc_balance: Number(balance) / 1e6,
      });
    } catch (e) {
      res.json({ ok: false, error: String(e) });
    }
  });

  router.post("/verify", async (req: Request, res: Response) => {
    const body = req.body as VerifyRequestBody;
    const { auth, error } = validateBasic(body);
    if (error) {
      res.json({ isValid: false, invalidReason: error, payer: auth.from ?? "" });
      return;
    }

    try {
      const recovered = recoverSigner(body, auth);
      if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
        res.json({
          isValid: false,
          invalidReason: `signature mismatch: recovered ${recovered}, expected ${auth.from}`,
          payer: auth.from,
        });
        return;
      }
      res.json({ isValid: true, payer: auth.from });
    } catch (e) {
      res.json({
        isValid: false,
        invalidReason: `signature decode error: ${String(e)}`,
        payer: auth.from,
      });
    }
  });

  router.post("/settle", async (req: Request, res: Response) => {
    const body = req.body as VerifyRequestBody;
    const { auth, error } = validateBasic(body);
    if (error) {
      res.json({
        success: false,
        network: body.network,
        errorReason: error,
        payer: auth.from ?? "",
      });
      return;
    }

    try {
      const recovered = recoverSigner(body, auth);
      if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
        res.json({
          success: false,
          network: body.network,
          errorReason: `signature mismatch: recovered ${recovered}, expected ${auth.from}`,
          payer: auth.from,
        });
        return;
      }
    } catch (e) {
      res.json({
        success: false,
        network: body.network,
        errorReason: `signature decode error: ${String(e)}`,
        payer: auth.from,
      });
      return;
    }

    const result = await nonceLock.runExclusive(async () => submitTransfer(body, auth));
    res.json(result);
  });

  return router;
}

function validateBasic(req: VerifyRequestBody | undefined): ValidationResult {
  const empty = {};
  if (!req) return { auth: empty, error: "missing request body" };
  if (req.x402Version !== 2) return { auth: empty, error: `unsupported x402 version: ${req.x402Version}` };
  if (req.scheme !== "exact") return { auth: empty, error: `unsupported scheme: ${req.scheme}` };
  if (req.network !== `eip155:${arcChainId}`) return { auth: empty, error: `unsupported network: ${req.network}` };

  const auth = req.payload?.authorization ?? {};
  const required = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
  const missing = required.filter((field) => !(field in auth));
  if (missing.length > 0) {
    return { auth, error: `authorization missing fields: ${missing.join(", ")}` };
  }

  const now = Math.trunc(Date.now() / 1000);
  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (now < validAfter) return { auth, error: "authorization not yet valid" };
  if (now >= validBefore) return { auth, error: "authorization expired" };

  return { auth, error: null };
}

function recoverSigner(req: VerifyRequestBody, auth: Record<string, string>): string {
  const domain = {
    name: "USDC",
    version: "2",
    chainId: arcChainId,
    verifyingContract: arcUsdc,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
  return ethers.verifyTypedData(domain, types, message, req.payload.signature);
}

async function submitTransfer(req: VerifyRequestBody, auth: Record<string, string>): Promise<Record<string, unknown>> {
  try {
    const sig = ethers.Signature.from(req.payload.signature);
    const nonce = auth.nonce.startsWith("0x") ? auth.nonce : `0x${auth.nonce}`;
    const fee = await provider.getFeeData();
    const txOptions = {
      gasLimit: 200_000,
      gasPrice: fee.gasPrice ?? undefined,
      chainId: arcChainId,
    };

    let tx: ethers.ContractTransactionResponse;
    try {
      tx = await usdc[
        "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
      ](
        ethers.getAddress(auth.from),
        ethers.getAddress(auth.to),
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        nonce,
        sig.v,
        sig.r,
        sig.s,
        txOptions,
      );
    } catch {
      tx = await usdc[
        "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"
      ](
        ethers.getAddress(auth.from),
        ethers.getAddress(auth.to),
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        nonce,
        req.payload.signature,
        txOptions,
      );
    }

    const receipt = await tx.wait(1, 30_000);
    if (!receipt || receipt.status !== 1) {
      return {
        success: false,
        transaction: tx.hash,
        network: req.network,
        errorReason: `tx reverted: ${tx.hash}`,
        payer: auth.from,
      };
    }

    return {
      success: true,
      transaction: tx.hash,
      network: req.network,
      payer: auth.from,
    };
  } catch (e) {
    console.error("settle failed:", e);
    return {
      success: false,
      network: req.network,
      errorReason: `on-chain submission failed: ${String(e)}`,
      payer: auth.from,
    };
  }
}
