import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  services: {
    paidSignalService: string;
  };
  arc: {
    chainId: number;
    rpcUrl: string;
    usdc: string;
  };
  facilitator: {
    port: number;
  };
  circleAgentWallet: {
    cliBin: string;
    commandTimeoutMs: number;
    address: string;
    chain: string;
    maxUsdcPerCall: number;
    serviceTimeoutSeconds: number;
  };
  circleBridge: {
    enabled: boolean;
    triggerEnabled: boolean;
    fromChain: string;
    toChain: string;
    sourceAddress: string;
    recipientAddress: string;
    defaultAmountUsdc: number;
    commandTimeoutMs: number;
  };
  hyperliquid: {
    network: "testnet" | "mainnet";
    symbol: string;
    masterAddress: string;
  };
  risk: {
    confidenceThreshold: number;
    takeProfitPct: number;
    stopLossPct: number;
    timeStopSeconds: number;
    maxLeverage: number;
    dailyLossPct: number;
    liquidationMarginRatio: number;
    kellyFraction: number;
    maxPositionPct: number;
    emergencyHaltPct: number;
  };
  cctp: {
    enabled: boolean;
    triggerEnabled: boolean;
    arbitrumSepoliaRpcUrl: string;
    irisApiBase: string;
    attestationMaxWaitSeconds: number;
    attestationPollIntervalSeconds: number;
    recipientAddress: string;
  };
  telegram: {
    alertPrefix: string;
  };
  reasoning: {
    traceSchemaVersion: number;
    traceHashAlgorithm: string;
  };
  nebius: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    vetoEnabled: boolean;
    timeoutMs: number;
    maxTokens: number;
    temperature: number;
  };
  process: {
    agentPollIntervalSeconds: number;
    logLevel: string;
    sqlitePath: string;
    statePort: number;
  };
}

const CONFIG_PATH = path.resolve(process.cwd(), "config/hyperflow.config.json");

export const appConfig = loadConfig();

function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as AppConfig;
  const port = Number(process.env.PORT);
  if (Number.isInteger(port) && port > 0) {
    raw.process.statePort = port;
  }
  return raw;
}

export function secretEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required secret in .env: ${name}`);
  }
  return value;
}

export function optionalSecretEnv(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return null;
  return value;
}

export function requiredConfigString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required config value: ${pathLabel}`);
  }
  return value;
}

export function requiredConfigNumber(value: unknown, pathLabel: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Config value ${pathLabel} must be a finite number`);
  }
  return value;
}

export function requiredConfigInt(value: unknown, pathLabel: string): number {
  const valueNumber = requiredConfigNumber(value, pathLabel);
  if (!Number.isInteger(valueNumber)) {
    throw new Error(`Config value ${pathLabel} must be an integer`);
  }
  return valueNumber;
}
