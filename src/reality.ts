/**
 * Runtime reality report: flags what is live, testnet, disabled, or blocked.
 */

import { isNebiusEnabled } from "./nebius.js";
import { appConfig } from "./config.js";

export interface RealityReport {
  mode: "real" | "mixed" | "blocked";
  components: Record<string, {
    status: "real" | "testnet-real" | "disabled" | "blocked";
    detail: string;
  }>;
}

export function buildRealityReport(): RealityReport {
  const paidSignalService = appConfig.services.paidSignalService;
  const hlNetwork = appConfig.hyperliquid.network;
  const cctpEnabled = appConfig.cctp.enabled;
  const circleBridgeEnabled = appConfig.circleBridge.enabled;
  const nebiusEnabled = isNebiusEnabled();

  const components: RealityReport["components"] = {
    signals: {
      status: "real",
      detail: `paid x402 endpoint ${paidSignalService}`,
    },
    hyperliquid: {
      status: hlNetwork === "mainnet" ? "real" : "testnet-real",
      detail: `network=${hlNetwork}`,
    },
    agentWallet: {
      status: "real",
      detail: `Circle Agent Wallet ${appConfig.circleAgentWallet.address} on ${appConfig.circleAgentWallet.chain}`,
    },
    agentWalletBudget: {
      status: "real",
      detail: `per-call cap ${appConfig.circleAgentWallet.maxUsdcPerCall} USDC enforced by circle services pay --max-amount`,
    },
    cctp: {
      status: cctpEnabled ? "testnet-real" : "disabled",
      detail: cctpEnabled
        ? "Arc Testnet to Arbitrum Sepolia CCTP V2"
        : "config.cctp.enabled=false",
    },
    circleBridge: {
      status: circleBridgeEnabled ? "testnet-real" : "disabled",
      detail: circleBridgeEnabled
        ? `${appConfig.circleBridge.fromChain} to ${appConfig.circleBridge.toChain} via Circle CLI bridge transfer`
        : "config.circleBridge.enabled=false",
    },
    facilitator: {
      status: "testnet-real",
      detail: "optional seller-side x402 verify/settle service; not the Agent Wallet buyer identity",
    },
    nebius: {
      status: nebiusEnabled ? "real" : "disabled",
      detail: nebiusEnabled
        ? `model=${appConfig.nebius.model}`
        : "config.nebius.enabled=false",
    },
  };

  const statuses = Object.values(components).map((component) => component.status);
  const mode = statuses.includes("blocked")
    ? "blocked"
    : statuses.includes("disabled")
      ? "mixed"
      : "real";

  return { mode, components };
}
