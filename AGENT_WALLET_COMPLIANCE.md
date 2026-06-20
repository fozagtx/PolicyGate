# Circle Agent Wallet Compliance

HyperFlow uses Circle Agent Wallet in the TypeScript agent workflow.

## Workflow

1. The agent calls `circle services pay` through `CircleAgentWalletClient`.
2. Circle CLI uses the logged-in Circle Agent Wallet session and wallet address from `config/hyperflow.config.json`.
3. The wallet pays the x402 signal endpoint with `--max-amount`.
4. The CLI returns `{ response, payment }`.
5. The agent stores the payment receipt and response in SQLite.
6. The paid signal drives the Hyperliquid decision loop.

## Required Circle Agent Stack Elements

| Requirement | Implementation |
| --- | --- |
| Circle Agent Wallet | `config.circleAgentWallet.address` + Circle CLI agent session |
| Wallet action | `circle services pay` from [circle-agent-wallet.ts](src/circle-agent-wallet.ts) |
| Crosschain wallet action | `circle bridge transfer` from [circle-bridge.ts](src/circle-bridge.ts) for Arc Testnet -> Base Sepolia Agent Wallet top-ups |
| Agent workflow | [loop.ts](src/loop.ts) buys a signal, records spend, then decides/trades |
| Budget / cap | `config.circleAgentWallet.maxUsdcPerCall` maps to `--max-amount` |
| Receipt / ledger | SQLite table `agent_wallet_spend_ledger` |
| User-visible API | `GET /agent-wallet` and `/state.agent_wallet` |
| Starter-kit pattern | Framework-agnostic Circle CLI wrapper, matching `packages/circle-tools` in the Agent Stack ecosystem kits |

## Environment

Use [config/hyperflow.config.json](config/hyperflow.config.json) for public runtime settings and [.env.example](.env.example) for secrets.

There is no `CIRCLE_API_KEY` in this flow. Circle Agent Stack authentication is the Circle CLI agent-wallet login/session:

```bash
npm install -g @circle-fin/cli
circle wallet login <email> --type agent --init
circle wallet login --type agent --request <request-id> --otp <code>
circle wallet create --output json
circle wallet list --chain BASE-SEPOLIA --type agent --output json
circle wallet balance --address <address> --chain BASE-SEPOLIA --output json
```

Then put the wallet address and chain in `config/hyperflow.config.json`.

## Proof Surfaces

- `/agent-wallet`: wallet address, chain, spend cap, balance, recent spend ledger
- `/state`: includes `agent_wallet.spend`, `cctp.bridges`, and `circle_bridge.transfers`
- `traces.execution_result.agent_wallet_spend`: per-decision receipt link between payment and trade decision
- dashboard Agent Wallet bridge panel: Arc Testnet -> Base Sepolia transfer ledger and trigger button

## Sources

- Circle Agent Stack docs: https://developers.circle.com/agent-stack
- Starter kits: https://github.com/akelani-circle/agent-stack-ecosystem-kits
