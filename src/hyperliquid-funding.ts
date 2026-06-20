import "dotenv/config";

import { ethers } from "ethers";
import { appConfig, optionalSecretEnv, requiredConfigString } from "./config.js";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function dripAmount() view returns (uint256)",
  "function dripClaimed(uint256 round,address account) view returns (bool)",
  "function claimDrip()",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const ARBITRUM_SEPOLIA_EXPLORER = "https://sepolia.arbiscan.io/tx/";
const HYPERLIQUID_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
const HYPERLIQUID_MAINNET_INFO = "https://api.hyperliquid.xyz/info";
const CCTP_EXTENSION_ABI = [
  "function batchDepositForBurnWithAuth((uint256 amount,uint256 authValidAfter,uint256 authValidBefore,bytes32 authNonce,uint8 v,bytes32 r,bytes32 s) receiveWithAuthorizationData,(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData) depositForBurnData) external",
];

interface TokenSnapshot {
  label: string;
  token: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

class HyperliquidFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidFundingError";
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "balances";
  if (command === "balances" || command === "doctor") {
    await printFundingDoctor();
    return;
  }

  if (command === "claim") {
    await claimLegacyDrip();
    return;
  }

  if (command === "deposit") {
    const amount = Number(process.argv[3]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HyperliquidFundingError("Usage: npm run hl:fund -- deposit <amount_usdc>");
    }
    await depositCircleUsdcViaCctp(amount);
    return;
  }

  if (command === "deposit-bridge2") {
    const amount = Number(process.argv[3]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HyperliquidFundingError("Usage: npm run hl:fund -- deposit-bridge2 <amount_usdc>");
    }
    await depositUsdc2ToHyperliquid(amount);
    return;
  }

  if (command === "poll") {
    await pollHyperliquidAccount();
    return;
  }

  throw new HyperliquidFundingError("Usage: npm run hl:fund -- balances | claim | deposit <amount_usdc> | deposit-bridge2 <amount_usdc> | poll");
}

async function printFundingDoctor(): Promise<void> {
  const masterAddress = getMasterAddress();
  const arbProvider = getArbitrumSepoliaProvider();
  const arcProvider = new ethers.JsonRpcProvider(appConfig.arc.rpcUrl);

  const [arbNative, arcNative, circleArb, usdc2, legacyUsdc, arcUsdc, hlState, mainnetRole] = await Promise.all([
    arbProvider.getBalance(masterAddress),
    arcProvider.getBalance(masterAddress),
    readTokenBalance("Arbitrum Sepolia Circle USDC", arbProvider, appConfig.hyperliquidBridge.circleUsdcArbitrumSepoliaAddress, masterAddress),
    readTokenBalance("Arbitrum Sepolia Hyperliquid USDC2", arbProvider, appConfig.hyperliquidBridge.usdc2Address, masterAddress),
    readTokenBalance("Arbitrum Sepolia Hyperliquid legacy USDC", arbProvider, appConfig.hyperliquidBridge.legacyUsdcAddress, masterAddress),
    readTokenBalance("Arc Testnet Circle USDC", arcProvider, appConfig.arc.usdc, masterAddress),
    getHyperliquidState(masterAddress),
    getHyperliquidUserRole(HYPERLIQUID_MAINNET_INFO, masterAddress),
  ]);

  console.log(`master_address=${masterAddress}`);
  console.log(`hyperliquid_mainnet_role=${mainnetRole}`);
  console.log(`hyperliquid_account_value_usd=${hlState.accountValue}`);
  console.log(`hyperliquid_withdrawable_usd=${hlState.withdrawable}`);
  console.log(`arbitrum_sepolia_native_eth=${ethers.formatEther(arbNative)}`);
  console.log(`arc_testnet_native_eth=${ethers.formatEther(arcNative)}`);
  printToken(arcUsdc);
  printToken(circleArb);
  printToken(usdc2);
  printToken(legacyUsdc);

  if (Number(hlState.accountValue) > 0) {
    console.log("next=Hyperliquid account is funded; run npm run start");
    return;
  }

  if (mainnetRole === "missing") {
    console.log("blocker=HL_MAINNET_STATE_MISSING");
    console.log("detail=HyperCore testnet CCTP recipients must already exist on HyperCore mainnet; this master address is missing there.");
    console.log("next=use a master wallet with mainnet Hyperliquid state, or make a small mainnet Hyperliquid deposit from this same address, then retry testnet funding");
    return;
  }

  const cctpMinimum = amountToMicros(appConfig.hyperliquidBridge.minDepositUsdc);
  if (circleArb.balance >= cctpMinimum) {
    console.log(`next=npm run hl:fund -- deposit ${appConfig.hyperliquidBridge.minDepositUsdc}`);
    return;
  }

  const minDeposit = amountToMicros(appConfig.hyperliquidBridge.minDepositUsdc);
  if (usdc2.balance >= minDeposit) {
    console.log(`next=npm run hl:fund -- deposit-bridge2 ${appConfig.hyperliquidBridge.minDepositUsdc}`);
    return;
  }

  console.log("blocker=HYPERLIQUID_COLLATERAL_EMPTY");
  console.log(
    `detail=Hyperliquid testnet reports account_value_usd=0. The preferred route is CCTP with ${circleArb.symbol} at ${circleArb.token}. ` +
      `The guarded Bridge2 fallback uses ${usdc2.symbol} at ${usdc2.token}.`,
  );
  console.log("next=fund Arbitrum Sepolia Circle USDC or acquire Arbitrum Sepolia USDC2, then rerun this command");
}

async function claimLegacyDrip(): Promise<void> {
  const wallet = getMasterWallet();
  const provider = getArbitrumSepoliaProvider();
  const token = new ethers.Contract(ethers.getAddress(appConfig.hyperliquidBridge.legacyUsdcAddress), ERC20_ABI, wallet.connect(provider));
  const decimals = Number(await token.decimals() as bigint);
  const before = await token.balanceOf(wallet.address) as bigint;
  const claimed = await token.dripClaimed(0, wallet.address) as boolean;
  console.log(`legacy_usdc_before=${ethers.formatUnits(before, decimals)}`);
  console.log(`legacy_drip_claimed=${claimed}`);
  if (claimed) return;

  const tx = await token.claimDrip({ gasLimit: 140_000 });
  console.log(`claim_tx=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new HyperliquidFundingError(`legacy drip claim failed: ${tx.hash}`);
  }
  const after = await token.balanceOf(wallet.address) as bigint;
  console.log(`legacy_usdc_after=${ethers.formatUnits(after, decimals)}`);
  console.log(`explorer=${ARBITRUM_SEPOLIA_EXPLORER}${tx.hash}`);
}

async function depositCircleUsdcViaCctp(amountUsdc: number): Promise<void> {
  const minDeposit = appConfig.hyperliquidBridge.minDepositUsdc;
  if (amountUsdc < minDeposit) {
    throw new HyperliquidFundingError(`Hyperliquid CCTP deposit amount must be at least ${minDeposit} USDC`);
  }

  const wallet = getMasterWallet();
  const provider = getArbitrumSepoliaProvider();
  const signer = wallet.connect(provider);
  const masterAddress = getMasterAddress();
  if (wallet.address.toLowerCase() !== masterAddress.toLowerCase()) {
    throw new HyperliquidFundingError(
      `Signer ${wallet.address} does not match hyperliquid.masterAddress ${masterAddress}.`,
    );
  }

  const usdcAddress = ethers.getAddress(appConfig.hyperliquidBridge.circleUsdcArbitrumSepoliaAddress);
  const extensionAddress = ethers.getAddress(appConfig.hyperliquidBridge.cctpExtensionAddress);
  const destinationCaller = ethers.getAddress(appConfig.hyperliquidBridge.cctpDestinationCaller);
  const amount = ethers.parseUnits(amountUsdc.toFixed(6), 6);
  const maxFee = ethers.parseUnits(appConfig.hyperliquidBridge.cctpMaxFeeUsdc.toFixed(6), 6);
  if (amount <= maxFee) {
    throw new HyperliquidFundingError(`deposit amount ${amountUsdc} must exceed CCTP max fee ${appConfig.hyperliquidBridge.cctpMaxFeeUsdc}`);
  }

  const token = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
  const balance = await token.balanceOf(wallet.address) as bigint;
  if (balance < amount) {
    throw new HyperliquidFundingError(`insufficient Arbitrum Sepolia Circle USDC: have ${ethers.formatUnits(balance, 6)}, need ${amountUsdc.toFixed(6)}`);
  }

  const nativeBalance = await provider.getBalance(wallet.address);
  if (nativeBalance === 0n) {
    throw new HyperliquidFundingError("Arbitrum Sepolia ETH balance is zero; CCTP deposit needs ETH for gas");
  }

  const now = Math.floor(Date.now() / 1000);
  const authValidAfter = now - 60;
  const authValidBefore = now + 3600;
  const authNonce = ethers.hexlify(ethers.randomBytes(32));
  const signature = await wallet.signTypedData(
    { name: "USD Coin", version: "2", chainId: 421614, verifyingContract: usdcAddress },
    {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    {
      from: wallet.address,
      to: extensionAddress,
      value: amount,
      validAfter: authValidAfter,
      validBefore: authValidBefore,
      nonce: authNonce,
    },
  );
  const sig = ethers.Signature.from(signature);

  const extension = new ethers.Contract(extensionAddress, CCTP_EXTENSION_ABI, signer);
  const receiveWithAuthorizationData = {
    amount,
    authValidAfter: BigInt(authValidAfter),
    authValidBefore: BigInt(authValidBefore),
    authNonce,
    v: sig.v,
    r: sig.r,
    s: sig.s,
  };
  const depositForBurnData = {
    amount,
    destinationDomain: appConfig.hyperliquidBridge.cctpDestinationDomain,
    mintRecipient: ethers.zeroPadValue(destinationCaller, 32),
    destinationCaller: ethers.zeroPadValue(destinationCaller, 32),
    maxFee,
    minFinalityThreshold: appConfig.hyperliquidBridge.cctpMinFinalityThreshold,
    hookData: hyperliquidCctpHookData(wallet.address, 0),
  };

  const gas = await extension.batchDepositForBurnWithAuth.estimateGas(
    receiveWithAuthorizationData,
    depositForBurnData,
  );
  const tx = await extension.batchDepositForBurnWithAuth(
    receiveWithAuthorizationData,
    depositForBurnData,
    { gasLimit: gas + 80_000n },
  );
  console.log(`deposit_tx=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new HyperliquidFundingError(`CCTP deposit failed: ${tx.hash}`);
  }

  console.log(`status=sent`);
  console.log(`explorer=${ARBITRUM_SEPOLIA_EXPLORER}${tx.hash}`);
  console.log("next=npm run hl:fund -- poll");
}

async function depositUsdc2ToHyperliquid(amountUsdc: number): Promise<void> {
  const minDeposit = appConfig.hyperliquidBridge.minDepositUsdc;
  if (amountUsdc < minDeposit) {
    throw new HyperliquidFundingError(`Hyperliquid Bridge2 minimum deposit is ${minDeposit} USDC`);
  }

  const masterAddress = getMasterAddress();
  const privateKey = optionalSecretEnv("CONSUMER_PK") ?? optionalSecretEnv("CCTP_WALLET_PK");
  if (!privateKey) {
    throw new HyperliquidFundingError(
      "Deposit requires CONSUMER_PK or CCTP_WALLET_PK for the wallet that owns Arbitrum Sepolia USDC2. Do not use HL_API_WALLET_PK.",
    );
  }

  const provider = getArbitrumSepoliaProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  if (wallet.address.toLowerCase() !== masterAddress.toLowerCase()) {
    throw new HyperliquidFundingError(
      `Signer ${wallet.address} does not match hyperliquid.masterAddress ${masterAddress}. ` +
        "Hyperliquid credits the sender, so this deposit would not fund the app account.",
    );
  }

  const usdc2Address = ethers.getAddress(appConfig.hyperliquidBridge.usdc2Address);
  const bridgeAddress = ethers.getAddress(appConfig.hyperliquidBridge.bridge2Address);
  const token = new ethers.Contract(usdc2Address, ERC20_ABI, wallet);
  const decimals = Number(await token.decimals() as bigint);
  const symbol = String(await token.symbol());
  const amount = ethers.parseUnits(amountUsdc.toFixed(decimals), decimals);
  const balance = await token.balanceOf(wallet.address) as bigint;

  if (balance < amount) {
    throw new HyperliquidFundingError(
      `insufficient ${symbol}: have ${ethers.formatUnits(balance, decimals)}, need ${ethers.formatUnits(amount, decimals)}. ` +
        "Your Circle testnet USDC balance is a different Arbitrum token and must not be sent to Bridge2.",
    );
  }

  const nativeBalance = await provider.getBalance(wallet.address);
  if (nativeBalance === 0n) {
    throw new HyperliquidFundingError("Arbitrum Sepolia ETH balance is zero; deposit needs ETH only for gas");
  }

  console.log(`depositing=${ethers.formatUnits(amount, decimals)} ${symbol}`);
  console.log(`from=${wallet.address}`);
  console.log(`to_hyperliquid_bridge2=${bridgeAddress}`);

  const tx = await token.transfer(bridgeAddress, amount, { gasLimit: 120_000 });
  console.log(`tx=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new HyperliquidFundingError(`Bridge2 transfer failed: ${tx.hash}`);
  }

  console.log(`status=sent`);
  console.log(`explorer=${ARBITRUM_SEPOLIA_EXPLORER}${tx.hash}`);
  console.log("next=wait for Hyperliquid testnet credit, then refresh the dashboard or restart npm run start");
}

async function pollHyperliquidAccount(): Promise<void> {
  const masterAddress = getMasterAddress();
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const state = await getHyperliquidState(masterAddress);
    console.log(`attempt=${attempt} account_value_usd=${state.accountValue} withdrawable_usd=${state.withdrawable}`);
    if (Number(state.accountValue) > 0) return;
    await sleep(15_000);
  }
  throw new HyperliquidFundingError("Hyperliquid still reports account_value_usd=0 after polling");
}

async function readTokenBalance(
  label: string,
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  owner: string,
): Promise<TokenSnapshot> {
  const token = new ethers.Contract(ethers.getAddress(tokenAddress), ERC20_ABI, provider);
  const [symbolRaw, decimalsRaw, balanceRaw] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.balanceOf(owner),
  ]);

  return {
    label,
    token: ethers.getAddress(tokenAddress),
    symbol: String(symbolRaw),
    decimals: Number(decimalsRaw),
    balance: balanceRaw as bigint,
  };
}

function printToken(snapshot: TokenSnapshot): void {
  console.log(`${keyLabel(snapshot.label)}=${ethers.formatUnits(snapshot.balance, snapshot.decimals)} ${snapshot.symbol}`);
}

function amountToMicros(amount: number): bigint {
  return BigInt(Math.trunc(amount * 1_000_000));
}

function hyperliquidCctpHookData(user: string, destinationDex: number): string {
  const prefix = new Uint8Array(24);
  new TextEncoder().encodeInto("cctp-forward", prefix);
  return ethers.hexlify(ethers.concat([
    prefix,
    ethers.toBeArray(ethers.toBeHex(0, 4)),
    ethers.toBeArray(ethers.toBeHex(24, 4)),
    ethers.getBytes(ethers.getAddress(user)),
    ethers.toBeArray(ethers.toBeHex(destinationDex, 4)),
  ]));
}

function getMasterWallet(): ethers.Wallet {
  const privateKey = optionalSecretEnv("CONSUMER_PK") ?? optionalSecretEnv("CCTP_WALLET_PK");
  if (!privateKey) {
    throw new HyperliquidFundingError("Funding commands require CONSUMER_PK or CCTP_WALLET_PK for the Hyperliquid master address");
  }
  return new ethers.Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

function getMasterAddress(): string {
  return ethers.getAddress(requiredConfigString(appConfig.hyperliquid.masterAddress, "hyperliquid.masterAddress"));
}

function getArbitrumSepoliaProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(appConfig.cctp.arbitrumSepoliaRpcUrl, 421614);
}

function keyLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

async function getHyperliquidState(user: string): Promise<{ accountValue: string; withdrawable: string }> {
  const response = await fetch(HYPERLIQUID_TESTNET_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new HyperliquidFundingError(`Hyperliquid state check failed: HTTP ${response.status}`);
  }
  const body = await response.json() as any;
  return {
    accountValue: String(body.marginSummary?.accountValue ?? "0.0"),
    withdrawable: String(body.withdrawable ?? "0.0"),
  };
}

async function getHyperliquidUserRole(endpoint: string, user: string): Promise<string> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "userRole", user }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return `http_${response.status}`;
  const body = await response.json() as any;
  return String(body.role ?? "unknown");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  });
}
