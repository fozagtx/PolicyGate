# PolicyGate

PolicyGate is an Anna app for policy-backed approval workflows. It turns an unstructured customer or operations request into structured facts, retrieves relevant policy evidence, drafts a recommended action, and keeps execution behind a human approval gate.

Repository: https://github.com/fozagtx/PolicyGate

## What It Does

- Extracts case facts from messy request text.
- Searches local markdown policy files for relevant evidence.
- Scores approval risk from amount, age, tone, missing information, and policy fit.
- Uses Anna host LLM sampling from the server-side Executa to draft a proposed action.
- Records approve, reject, escalate, and audit export events.
- Prevents real external side effects from happening without human review.

## Anna Package

PolicyGate ships as a complete Anna app package:

| Part | Path |
|------|------|
| App listing | `app.json` |
| Anna manifest | `manifest.json` |
| Static UI | `bundle/` |
| Case tool Executa | `executas/policygate-case-python/` |
| Behavior notes | `executas/policygate-ops/SKILL.md` |
| Policy corpus | `policies/` |
| Tests | `tests/` |

The installed chat trigger is `#policygate`.

## Requirements

- Node.js 22+
- pnpm
- Python 3.10+
- uv
- Anna CLI login with an account that is enabled as a Verified Developer

PolicyGate uses Anna's hosted LLM capability through Executa reverse RPC. You do not need to configure or ship a model API key.

## Local Development

Install JavaScript dependencies:

```bash
pnpm install
```

Run with Anna CLI:

```bash
pnpm dev
```

Or run the standalone development bridge:

```bash
cd executas/policygate-case-python
uv sync
cd ../..
node dev-server.js
```

Open `http://localhost:3456` when using the standalone bridge. The standalone bridge does not provide Anna host LLM sampling, so the Executa uses its local draft fallback there. Use `pnpm dev` for the real Anna-hosted LLM path.

## Validation

```bash
pnpm test
pnpm validate
printf '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}\n' | python3 executas/policygate-case-python/policygate_case_plugin.py
```

## Deploying

Validate the package first:

```bash
pnpm validate
```

Anna App publishing requires Anna to mark the account as a Verified Developer. Follow the beginner guide at https://forum.anna.partners/t/from-zero-to-your-first-anna-app-a-hands-on-beginners-guide/117 and the Developer Hub at https://anna.partners/developers while preparing the review package. Once the account flag is enabled, use the working draft flow:

```bash
pnpm exec anna-app apps push
pnpm exec anna-app apps cut 0.1.2
pnpm exec anna-app apps submit-review policygate
pnpm exec anna-app apps release 0.1.2
```

`apps push` resolves the bundled `policygate-case` Tool into a server-minted id, writes `.anna/executas.lock.json`, and writes `bundle/anna-tool-ids.js` for the UI.

## Safety Model

PolicyGate can recommend actions, but it does not commit refunds, send live messages, cancel orders, or create external tasks. The app records decisions only after explicit human approval, rejection, or escalation.
