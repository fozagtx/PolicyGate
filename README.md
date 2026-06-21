# PolicyGate

PolicyGate is an Anna app for policy-backed approval workflows. It turns an unstructured customer or operations request into structured facts, retrieves relevant policy evidence, drafts a recommended action, and keeps execution behind a human approval gate.

Repository: https://github.com/fozagtx/PolicyGate

## What It Does

- Extracts case facts from messy request text.
- Searches local markdown policy files for relevant evidence.
- Scores approval risk from amount, age, tone, missing information, and policy fit.
- Uses OpenAI structured outputs in the server-side Executa to draft a proposed action.
- Records approve, reject, escalate, simulated send, and audit export events.
- Prevents real external side effects from happening without human review.

## Anna Package

PolicyGate ships as a complete Anna app package:

| Part | Path |
|------|------|
| App listing | `app.json` |
| Anna manifest | `manifest.json` |
| Static UI | `bundle/` |
| Case tool Executa | `executas/policygate-case-python/` |
| AI behavior playbook | `executas/policygate-ops/SKILL.md` |
| Policy corpus | `policies/` |
| Tests | `tests/` |

The installed chat trigger is `#policygate`.

## Requirements

- Node.js 18+
- pnpm
- Python 3.10+
- `OPENAI_API_KEY` in the Executa/server environment for analysis and drafting

The browser UI never receives the OpenAI key.

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
pip install openai pydantic
cd ../..

export OPENAI_API_KEY="sk-..."
node dev-server.js
```

Open `http://localhost:3456` when using the standalone bridge.

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

Then publish through Anna Host in the Developer Hub at https://anna.partners/developers. The package declares the static UI, host permissions, bundled `policygate-case` Executa, and `policygate-ops` playbook needed for Anna to run it.

## Safety Model

PolicyGate can recommend actions, but it does not commit refunds, send live messages, cancel orders, or create external tasks. The app records decisions only after explicit human approval, rejection, or escalation.
