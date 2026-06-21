# PolicyGate Case Executa

Python stdio Executa for the PolicyGate Anna app.

It exposes one JSON-RPC tool method, `case`, with action-based dispatch:

- `analyze_case`
- `policy_search`
- `risk_check`
- `draft_reply`
- `save_case`
- `approve_action`
- `export_audit`
- `get_state`

State is persisted locally at `~/.anna/policygate/state.json`. Audit exports
are written under `~/.anna/policygate/audits/`.

OpenAI is required for `analyze_case` and `draft_reply`. Export
`OPENAI_API_KEY` in the Executa environment. The browser UI must never hold the
key.

The dispatcher uses the OpenAI Python SDK with:

```python
client.responses.parse(..., text_format=AiCaseAnalysis)
```

The default model is `gpt-5.5`; override it with `OPENAI_MODEL` if needed.
`policy_search`, `risk_check`, `save_case`, `approve_action`, `export_audit`,
and `get_state` are deterministic local tool actions.

This tool records approval decisions only. It does not send messages or execute
external side effects.
