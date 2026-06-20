# Railway Deployment

Use Railway for HyperFlow when you want the dashboard and agent loop online from one service.

## Required Railway Setup

| Item | Value |
| --- | --- |
| Deploy type | Dockerfile from repo root |
| Volume mount | `/data` |
| Start command | Docker `CMD` runs `scripts/railway-start.sh` |
| Dashboard port | Railway `PORT`, falling back to `8086` locally |
| SQLite path in app | `./data/hyperflow.sqlite`, symlinked to `/data/app-data/hyperflow.sqlite` in Docker |
| Circle CLI session | stored under `/data/home/.circle-cli` because Docker sets `HOME=/data/home` |

## Railway Variables

Set these in Railway project variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `HL_API_WALLET_PK` | Yes | Hyperliquid API wallet private key |
| `NEBIUS_API_KEY` | Yes | Nebius Token Factory key for DeepSeek V4 Pro |
| `CONSUMER_PK` | If CCTP enabled | Arc source signer for direct CCTP |
| `CCTP_WALLET_PK` | If using `npm run cctp` | Standalone CCTP command signer |
| `X402_FACILITATOR_PK` | Only if serving seller-side x402 | Not needed for buying paid signals |
| `TG_BOT_TOKEN`, `TG_CHAT_ID` | Optional | Telegram alerts |

Do not set a `CIRCLE_API_KEY`. HyperFlow uses Circle CLI Agent Wallet auth.

## Circle CLI Session

The deployed service must have a valid Circle CLI agent-wallet session before `circle services pay` can work.

You have two workable options:

| Option | How |
| --- | --- |
| Railway shell | Open a shell for the deployed service and run `circle wallet login <email> --type agent --init`, then complete OTP with `circle wallet login --type agent --request <request-id> --otp <code>` |
| Volume upload | Upload a prepared `.circle-cli` profile into `/data/home/.circle-cli` using Railway volume tooling |

After auth, verify from the Railway shell:

```bash
circle wallet status --type agent --output json
circle wallet list --chain ARC-TESTNET --type agent --output json
circle wallet balance --address <agent-wallet-address> --chain ARC-TESTNET --output json
```

## Deploy Steps

1. Push `main` to GitHub.
2. Create a Railway project from `https://github.com/fozagtx/hyperflow`.
3. Add a Volume mounted at `/data`.
4. Add the variables above.
5. Deploy.
6. Open a Railway shell and complete Circle CLI agent-wallet login.
7. Restart the service.
8. Check `/health`, `/state`, and `/agent-wallet`.

Nebius checks:

```bash
curl https://YOUR-RAILWAY-DOMAIN/nebius/health
curl https://YOUR-RAILWAY-DOMAIN/nebius/health?live=1
```

The first command checks whether the deployed API key can see `deepseek-ai/DeepSeek-V4-Pro`. The second makes one tiny live completion request and will show `402` if the key/project budget cannot spend.

## Important

The agent loop buys paid signals. Do not leave it running with a broken Circle/Nebius/Hyperliquid setup, because it can keep paying for signal calls while failing later in the tick.

Before leaving the Railway service running:

| Check | Why |
| --- | --- |
| Nebius budget funded | Nebius returns `402 Payment Required` when the account budget is exhausted, and HyperFlow blocks the tick |
| Hyperliquid testnet account funded | HyperFlow skips paid signal purchases while the Hyperliquid account value is zero |
| Circle Agent Wallet funded on configured chain | `circle services pay` needs spendable USDC on `circleAgentWallet.chain` |
| `/agent-wallet` shows balance and ledger | Confirms Circle CLI auth and wallet address are usable in the deployed container |
