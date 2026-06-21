#!/usr/bin/env python3
"""
PolicyGate Case — Executa stdio tool plugin.

The plugin exposes one dispatcher method, ``case``, and persists structured
case state to ``~/.anna/policygate/state.json``. It searches local markdown
policy files, computes risk, drafts an evidence-backed recommendation, records
human decisions, and exports audit records. It does not send messages or
perform external side effects.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

try:
    from openai import OpenAI
    from pydantic import BaseModel, Field
except ImportError:  # dependency is installed by uv when the Executa runs
    OpenAI = None  # type: ignore[assignment]
    BaseModel = object  # type: ignore[assignment,misc]
    Field = None  # type: ignore[assignment]

MANIFEST: dict[str, Any] = {
    "display_name": "PolicyGate Case",
    "version": "1.0.0",
    "description": (
        "Policy-backed approval case analysis with local state, evidence "
        "retrieval, risk checks, drafts, decision recording, and audit export."
    ),
    "author": "PolicyGate",
    "homepage": "https://github.com/fozagtx/PolicyGate",
    "license": "MIT",
    "tags": ["approval", "policy", "risk", "audit", "anna-app"],
    "tools": [
        {
            "name": "case",
            "description": (
                "Dispatch PolicyGate case actions. Use action to select one "
                "of analyze_case, policy_search, risk_check, draft_reply, "
                "save_case, approve_action, send_simulated, export_audit, get_state."
            ),
            "parameters": [
                {
                    "name": "action",
                    "type": "string",
                    "description": "Dispatcher action name.",
                    "required": True,
                },
                {
                    "name": "case_id",
                    "type": "string",
                    "description": "Optional case id. Generated when absent.",
                    "required": False,
                },
                {
                    "name": "input",
                    "type": "string",
                    "description": "Raw case request text for analysis.",
                    "required": False,
                },
                {
                    "name": "query",
                    "type": "string",
                    "description": "Policy search query.",
                    "required": False,
                },
                {
                    "name": "decision",
                    "type": "string",
                    "description": "approved, rejected, or escalated.",
                    "required": False,
                },
                {
                    "name": "note",
                    "type": "string",
                    "description": "Human decision note.",
                    "required": False,
                },
                {
                    "name": "draft",
                    "type": "string",
                    "description": "Edited draft or action text to store.",
                    "required": False,
                },
                {
                    "name": "case",
                    "type": "object",
                    "description": "Structured case payload for save_case.",
                    "required": False,
                },
            ],
        }
    ],
    "runtime": {"type": "uv", "min_version": "0.1.0"},
}

STATE_DIR = Path(os.path.expanduser("~/.anna/policygate"))
STATE_FILE = STATE_DIR / "state.json"
AUDIT_DIR = STATE_DIR / "audits"
APP_DIR = Path(__file__).resolve().parents[2]
POLICY_DIR = APP_DIR / "policies"
MAX_CASES = 200
DEFAULT_OPENAI_MODEL = "gpt-5.5"

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "our",
    "that",
    "the",
    "this",
    "to",
    "was",
    "with",
}


class AiFacts(BaseModel):  # type: ignore[misc,valid-type]
    requester: str
    category: str
    amount: Optional[str] = None
    days_since_event: Optional[int] = None
    requested_action: str
    missing_info: list[str]
    summary: str
    confidence: str


class AiProposedAction(BaseModel):  # type: ignore[misc,valid-type]
    recommendation: str
    draft: str


class AiCaseAnalysis(BaseModel):  # type: ignore[misc,valid-type]
    facts: AiFacts
    proposed_action: AiProposedAction


def _now() -> float:
    return time.time()


def _iso(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or _now()))


def _safe_case_id(case_id: Optional[str] = None) -> str:
    raw = (case_id or "").strip()
    if raw:
        cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw)[:60].strip("-")
        if cleaned:
            return cleaned
    return f"CASE-{uuid.uuid4().hex[:8].upper()}"


def _load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {"cases": {}, "recent": [], "active_case_id": None}
    try:
        with STATE_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("state root must be an object")
        data.setdefault("cases", {})
        data.setdefault("recent", [])
        data.setdefault("active_case_id", None)
        return data
    except (json.JSONDecodeError, ValueError) as exc:
        backup = STATE_FILE.with_suffix(f".broken.{int(_now())}.json")
        try:
            STATE_FILE.rename(backup)
            print(
                f"[policygate-case] corrupt state moved to {backup}: {exc}",
                file=sys.stderr,
            )
        except OSError:
            pass
        return {"cases": {}, "recent": [], "active_case_id": None}


def _save_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    tmp.replace(STATE_FILE)


def _audit(case: dict[str, Any], kind: str, summary: str, payload: Optional[dict[str, Any]] = None) -> None:
    event = {
        "id": uuid.uuid4().hex[:12],
        "ts": _iso(),
        "kind": kind,
        "summary": summary,
        "payload": payload or {},
    }
    case.setdefault("audit", []).append(event)


def _tokens(text: str) -> set[str]:
    return {
        t
        for t in re.findall(r"[a-z0-9][a-z0-9_-]{2,}", text.lower())
        if t not in STOPWORDS
    }


def _money(text: str) -> Optional[str]:
    match = re.search(r"\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)", text)
    if not match:
        return None
    return f"${match.group(1)}"


def _money_value(amount: Optional[str]) -> float:
    if not amount:
        return 0.0
    try:
        return float(amount.replace("$", "").replace(",", ""))
    except ValueError:
        return 0.0


def _extract_days(text: str) -> Optional[int]:
    patterns = [
        r"after\s+(\d{1,3})\s+days?",
        r"(\d{1,3})\s+days?\s+(?:after|late|old)",
        r"day\s+(\d{1,3})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text.lower())
        if match:
            return int(match.group(1))
    return None


def _category(text: str) -> str:
    lowered = text.lower()
    categories = [
        ("refund", ["refund", "money back", "chargeback"]),
        ("cancellation", ["cancel", "cancellation", "booking"]),
        ("shipping", ["shipping", "delivery", "lost package", "tracking"]),
        ("privacy", ["privacy", "personal data", "delete my data", "gdpr", "ccpa"]),
        ("escalation", ["legal", "lawsuit", "attorney", "press", "chargeback"]),
        ("angry_customer", ["angry", "furious", "unacceptable", "complaint"]),
        ("exception", ["exception", "override", "manager", "special case"]),
    ]
    for name, words in categories:
        if any(word in lowered for word in words):
            return name
    return "general"


def _extract_facts(case_id: str, text: str) -> dict[str, Any]:
    email = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    order = re.search(r"\b(?:order|booking|case|ticket)[\s#:.-]*([A-Z0-9-]{4,})", text, re.I)
    requester = email.group(0) if email else "Unknown requester"
    days = _extract_days(text)
    amount = _money(text)
    missing = []
    if requester == "Unknown requester":
        missing.append("requester identity")
    if not order:
        missing.append("order or booking id")
    if _category(text) in {"refund", "cancellation"} and days is None:
        missing.append("purchase or request age")
    return {
        "case_id": case_id,
        "requester": requester,
        "order_ref": order.group(1) if order else None,
        "category": _category(text),
        "amount": amount,
        "days_since_event": days,
        "requested_action": _requested_action(text),
        "missing_info": missing,
        "summary": _summary(text),
        "confidence": _confidence(text, missing),
    }


def _requested_action(text: str) -> str:
    lowered = text.lower()
    if "refund" in lowered:
        return "refund"
    if "replacement" in lowered or "replace" in lowered:
        return "replacement"
    if "cancel" in lowered:
        return "cancellation"
    if "delete" in lowered and "data" in lowered:
        return "privacy request"
    return "review request"


def _summary(text: str) -> str:
    compact = " ".join(text.strip().split())
    if len(compact) <= 220:
        return compact
    return compact[:217].rstrip() + "..."


def _confidence(text: str, missing: list[str]) -> str:
    if len(text.strip()) < 60 or len(missing) >= 2:
        return "low"
    if missing:
        return "medium"
    return "high"


def _openai_enabled() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def _openai_model() -> str:
    return os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)


def _ai_case_analysis(
    text: str,
    facts: dict[str, Any],
    evidence: list[dict[str, Any]],
    risk: dict[str, Any],
) -> dict[str, Any]:
    if not _openai_enabled():
        raise ValueError(
            "OPENAI_API_KEY is required for analyze_case/draft_reply. "
            "Set it in the Executa environment; the browser UI must never hold the key."
        )
    if OpenAI is None:
        raise RuntimeError(
            "OPENAI_API_KEY is set, but the openai package is not installed. "
            "Run `uv sync` in executas/policygate-case-python or restart anna-app dev."
        )

    client = OpenAI()
    model = _openai_model()
    evidence_payload = [
        {
            "policy_id": item.get("policy_id"),
            "title": item.get("title"),
            "excerpt": item.get("excerpt"),
        }
        for item in evidence[:5]
    ]
    response = client.responses.parse(
        model=model,
        input=[
            {
                "role": "system",
                "content": (
                    "You are PolicyGate's case analysis engine. Extract stable "
                    "facts and draft an evidence-backed proposed action. Do not "
                    "claim anything was sent, refunded, cancelled, or executed. "
                    "The human must approve, reject, or escalate separately."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "raw_case": text,
                        "local_fact_seed": facts,
                        "policy_evidence": evidence_payload,
                        "risk": risk,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        text_format=AiCaseAnalysis,
    )
    parsed = response.output_parsed
    return {
        "model": model,
        "facts": parsed.facts.model_dump(),
        "proposed_action": parsed.proposed_action.model_dump(),
    }


def _load_policies() -> list[dict[str, Any]]:
    policies: list[dict[str, Any]] = []
    if not POLICY_DIR.exists():
        return policies
    for path in sorted(POLICY_DIR.glob("*.md")):
        content = path.read_text(encoding="utf-8")
        lines = [line.strip() for line in content.splitlines() if line.strip()]
        title = path.stem.replace("_", " ").title()
        for line in lines:
            if line.startswith("# "):
                title = line[2:].strip()
                break
        policies.append(
            {
                "id": path.stem,
                "title": title,
                "path": str(path),
                "content": content,
                "tokens": _tokens(content + " " + path.stem),
            }
        )
    return policies


def _policy_search(query: str, limit: int = 5) -> list[dict[str, Any]]:
    query_tokens = _tokens(query)
    results: list[dict[str, Any]] = []
    for policy in _load_policies():
        overlap = query_tokens & policy["tokens"]
        category_boost = 3 if policy["id"].replace("_", " ") in query.lower() else 0
        score = len(overlap) + category_boost
        if score <= 0:
            continue
        excerpt = _best_excerpt(policy["content"], query_tokens)
        results.append(
            {
                "policy_id": policy["id"],
                "title": policy["title"],
                "score": score,
                "matched_terms": sorted(overlap)[:8],
                "excerpt": excerpt,
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    return results[:limit]


def _best_excerpt(content: str, query_tokens: set[str]) -> str:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", content) if p.strip()]
    if not paragraphs:
        return ""
    best = max(paragraphs, key=lambda p: len(_tokens(p) & query_tokens))
    best = re.sub(r"\s+", " ", best)
    return best[:360].rstrip()


def _risk_check(facts: dict[str, Any], evidence: list[dict[str, Any]], text: str) -> dict[str, Any]:
    lowered = text.lower()
    reasons: list[str] = []
    score = 15
    if facts.get("confidence") == "low":
        score += 20
        reasons.append("low fact confidence")
    if facts.get("missing_info"):
        score += min(20, len(facts["missing_info"]) * 8)
        reasons.append("missing required case information")
    days = facts.get("days_since_event")
    if days and days > 30:
        score += 25
        reasons.append("request is outside the 30-day standard window")
    if _money_value(facts.get("amount")) >= 500:
        score += 20
        reasons.append("high-value request")
    if any(word in lowered for word in ["legal", "lawsuit", "attorney", "press", "chargeback"]):
        score += 35
        reasons.append("legal, press, or chargeback language")
    if any(word in lowered for word in ["angry", "furious", "unacceptable", "scam"]):
        score += 15
        reasons.append("heated customer tone")
    if facts.get("category") == "privacy":
        score += 20
        reasons.append("privacy request requires identity-safe handling")
    if not evidence:
        score += 10
        reasons.append("no matching policy evidence")
    score = max(0, min(100, score))
    level = "low"
    if score >= 70:
        level = "high"
    elif score >= 40:
        level = "medium"
    if not reasons:
        reasons.append("standard policy-backed approval")
    return {"level": level, "score": score, "reasons": reasons}


def _case_view(case: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": case["id"],
        "status": case.get("status", "draft"),
        "input": case.get("input", ""),
        "facts": case.get("facts", {}),
        "evidence": case.get("evidence", []),
        "policy_checks": case.get("policy_checks", []),
        "risk": case.get("risk", {}),
        "proposed_action": case.get("proposed_action", {}),
        "decision": case.get("decision"),
        "ai": case.get("ai", {}),
        "audit": case.get("audit", []),
        "created_at": case.get("created_at"),
        "updated_at": case.get("updated_at"),
    }


def _state_summary(state: dict[str, Any]) -> dict[str, Any]:
    cases = state.get("cases", {})
    recent_ids = state.get("recent", [])[:10]
    recent = [_case_view(cases[cid]) for cid in recent_ids if cid in cases]
    active_case = cases.get(state.get("active_case_id"))
    pending = [
        _case_view(case)
        for case in cases.values()
        if case.get("status") in {"draft", "pending_approval", "escalated"}
    ][:20]
    return {
        "active_case": _case_view(active_case) if active_case else None,
        "recent": recent,
        "pending": pending,
        "state_file": str(STATE_FILE),
    }


def _upsert_case(state: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    case["updated_at"] = _iso()
    state["cases"][case["id"]] = case
    recent = [case["id"]] + [cid for cid in state.get("recent", []) if cid != case["id"]]
    state["recent"] = recent[:MAX_CASES]
    state["active_case_id"] = case["id"]
    return case


def action_analyze_case(case_id: Optional[str] = None, input: str = "", **_kwargs: Any) -> dict[str, Any]:
    text = (input or "").strip()
    if not text:
        raise ValueError("input is required for analyze_case")
    state = _load_state()
    cid = _safe_case_id(case_id)
    case = state["cases"].get(
        cid,
        {
            "id": cid,
            "status": "draft",
            "created_at": _iso(),
            "audit": [],
        },
    )
    case["input"] = text
    _audit(case, "input", "Case input received", {"characters": len(text)})

    # Stage 1: tool-based fact extraction + policy search + risk scoring
    facts = _extract_facts(cid, text)
    case["facts"] = facts
    _audit(case, "facts", "Structured facts extracted", {"confidence": facts["confidence"]})

    evidence = _policy_search(text + " " + facts["category"] + " " + facts["requested_action"])
    case["evidence"] = evidence
    _audit(case, "tool.policy_search", f"Policy search returned {len(evidence)} evidence cards")

    risk = _risk_check(facts, evidence, text)
    case["risk"] = risk
    _audit(case, "tool.risk_check", f"Risk classified as {risk['level']}", {"score": risk["score"]})

    # Stage 2: AI enrichment — MANDATORY, requires OPENAI_API_KEY
    # No fallback, no mock, no template — real AI or hard error.
    ai = _ai_case_analysis(text, facts, evidence, risk)
    ai_facts = ai["facts"]
    facts.update(
        {
            "requester": ai_facts.get("requester") or facts.get("requester"),
            "category": ai_facts.get("category") or facts.get("category"),
            "amount": ai_facts.get("amount") or facts.get("amount"),
            "days_since_event": ai_facts.get("days_since_event"),
            "requested_action": ai_facts.get("requested_action") or facts.get("requested_action"),
            "missing_info": ai_facts.get("missing_info") or [],
            "summary": ai_facts.get("summary") or facts.get("summary"),
            "confidence": ai_facts.get("confidence") or facts.get("confidence"),
        }
    )
    facts["case_id"] = cid
    case["facts"] = facts
    proposed = ai["proposed_action"]
    case["ai"] = {"provider": "openai", "model": ai["model"]}
    _audit(
        case,
        "tool.openai.responses",
        f"OpenAI structured analysis completed with {ai['model']}",
        {"model": ai["model"]},
    )

    case["proposed_action"] = proposed
    case["policy_checks"] = _policy_checks(evidence, risk)
    case["status"] = "pending_approval"
    _audit(case, "draft", "Evidence-backed draft created", {"recommendation": proposed["recommendation"]})
    _upsert_case(state, case)
    _save_state(state)
    return {"case": _case_view(case), **_state_summary(state)}


def _policy_checks(evidence: list[dict[str, Any]], risk: dict[str, Any]) -> list[dict[str, Any]]:
    checks = [
        {
            "name": "Policy evidence present",
            "status": "pass" if evidence else "fail",
            "detail": f"{len(evidence)} matching policy document(s)",
        },
        {
            "name": "Human approval required",
            "status": "required",
            "detail": "PolicyGate records decisions only after explicit human action.",
        },
        {
            "name": "Risk gate",
            "status": "review" if risk["level"] in {"medium", "high"} else "pass",
            "detail": f"{risk['level']} risk, score {risk['score']}",
        },
    ]
    return checks


def action_policy_search(query: str = "", input: str = "", **_kwargs: Any) -> dict[str, Any]:
    q = (query or input or "").strip()
    if not q:
        raise ValueError("query or input is required for policy_search")
    return {"evidence": _policy_search(q)}


def action_risk_check(case_id: Optional[str] = None, input: str = "", **_kwargs: Any) -> dict[str, Any]:
    state = _load_state()
    case = _find_case(state, case_id)
    text = input or (case or {}).get("input", "")
    if not text:
        raise ValueError("input or existing case is required for risk_check")
    facts = (case or {}).get("facts") or _extract_facts(_safe_case_id(case_id), text)
    evidence = (case or {}).get("evidence") or _policy_search(text)
    return {"risk": _risk_check(facts, evidence, text)}


def action_draft_reply(case_id: Optional[str] = None, input: str = "", **_kwargs: Any) -> dict[str, Any]:
    state = _load_state()
    case = _find_case(state, case_id)
    text = input or (case or {}).get("input", "")
    if not text:
        raise ValueError("input or existing case is required for draft_reply")
    facts = (case or {}).get("facts") or _extract_facts(_safe_case_id(case_id), text)
    evidence = (case or {}).get("evidence") or _policy_search(text)
    risk = (case or {}).get("risk") or _risk_check(facts, evidence, text)
    ai = _ai_case_analysis(text, facts, evidence, risk)
    return {
        "proposed_action": ai["proposed_action"],
        "ai": {"provider": "openai", "model": ai["model"]},
    }


def action_save_case(case: Optional[dict[str, Any]] = None, **_kwargs: Any) -> dict[str, Any]:
    if not isinstance(case, dict):
        raise ValueError("case object is required for save_case")
    state = _load_state()
    cid = _safe_case_id(case.get("id") or case.get("case_id"))
    existing = state["cases"].get(cid, {"id": cid, "created_at": _iso(), "audit": []})
    existing.update(case)
    existing["id"] = cid
    _audit(existing, "save", "Case saved")
    _upsert_case(state, existing)
    _save_state(state)
    return {"case": _case_view(existing), **_state_summary(state)}


def action_approve_action(
    case_id: Optional[str] = None,
    decision: str = "",
    note: str = "",
    draft: str = "",
    **_kwargs: Any,
) -> dict[str, Any]:
    normalized = (decision or "").strip().lower()
    allowed = {"approved", "rejected", "escalated"}
    if normalized not in allowed:
        raise ValueError("decision must be approved, rejected, or escalated")
    state = _load_state()
    case = _find_case(state, case_id)
    if not case:
        raise ValueError("case not found")
    if draft:
        case.setdefault("proposed_action", {})["draft"] = draft[:4000]
    case["decision"] = {
        "decision": normalized,
        "note": (note or "").strip()[:1000],
        "decided_at": _iso(),
    }
    case["status"] = normalized
    _audit(
        case,
        "human_decision",
        f"Human decision recorded: {normalized}",
        {"note": case["decision"]["note"]},
    )
    _upsert_case(state, case)
    _save_state(state)
    return {"case": _case_view(case), **_state_summary(state)}


def action_export_audit(case_id: Optional[str] = None, **_kwargs: Any) -> dict[str, Any]:
    state = _load_state()
    case = _find_case(state, case_id)
    if not case:
        raise ValueError("case not found")
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    path = AUDIT_DIR / f"{case['id']}.md"
    content = _audit_markdown(case)
    path.write_text(content, encoding="utf-8")
    _audit(case, "export", "Audit markdown exported", {"path": str(path)})
    _upsert_case(state, case)
    _save_state(state)
    return {"case": _case_view(case), "export": {"path": str(path), "markdown": content}}


def action_send_simulated(
    case_id: Optional[str] = None,
    channel: str = "email",
    **_kwargs: Any,
) -> dict[str, Any]:
    """Simulate sending the approved draft. No real side effects — audit-only."""
    state = _load_state()
    case = _find_case(state, case_id)
    if not case:
        raise ValueError("case not found")
    decision = case.get("decision") or {}
    if decision.get("decision") != "approved":
        raise ValueError(
            f"send_simulated requires an approved case; current status: {case.get('status')}"
        )
    draft = (case.get("proposed_action") or {}).get("draft", "")
    simulated = {
        "channel": channel,
        "to": (case.get("facts") or {}).get("requester", "unknown"),
        "subject": f"Re: {case['id']} — {case.get('facts', {}).get('category', 'case')}",
        "body_preview": (draft or "")[:280],
        "sent_at": _iso(),
        "simulated": True,
    }
    _audit(
        case,
        "send_simulated",
        f"Simulated send via {channel} (no external side effect)",
        {"channel": channel},
    )
    case["status"] = "sent_simulated"
    _upsert_case(state, case)
    _save_state(state)
    return {"case": _case_view(case), "send": simulated, **_state_summary(state)}


def action_get_state(**_kwargs: Any) -> dict[str, Any]:
    return _state_summary(_load_state())


def _find_case(state: dict[str, Any], case_id: Optional[str]) -> Optional[dict[str, Any]]:
    cases = state.get("cases", {})
    if case_id and case_id in cases:
        return cases[case_id]
    active = state.get("active_case_id")
    if active and active in cases:
        return cases[active]
    return None


def _audit_markdown(case: dict[str, Any]) -> str:
    lines = [
        f"# PolicyGate Audit: {case['id']}",
        "",
        f"- Status: {case.get('status', 'unknown')}",
        f"- Created: {case.get('created_at', '')}",
        f"- Updated: {case.get('updated_at', '')}",
        "",
        "## Facts",
        "",
    ]
    for key, value in case.get("facts", {}).items():
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Evidence", ""])
    for item in case.get("evidence", []):
        lines.append(f"- {item.get('title')}: {item.get('excerpt')}")
    lines.extend(["", "## Decision", ""])
    lines.append(json.dumps(case.get("decision") or {}, indent=2))
    lines.extend(["", "## Timeline", ""])
    for event in case.get("audit", []):
        lines.append(f"- {event.get('ts')} [{event.get('kind')}] {event.get('summary')}")
    lines.append("")
    return "\n".join(lines)


TOOL_DISPATCH = {
    "case": lambda **kwargs: dispatch_case(**kwargs),
}

ACTION_DISPATCH = {
    "analyze_case": action_analyze_case,
    "policy_search": action_policy_search,
    "risk_check": action_risk_check,
    "draft_reply": action_draft_reply,
    "save_case": action_save_case,
    "approve_action": action_approve_action,
    "send_simulated": action_send_simulated,
    "export_audit": action_export_audit,
    "get_state": action_get_state,
}


def dispatch_case(action: str, **kwargs: Any) -> dict[str, Any]:
    fn = ACTION_DISPATCH.get(action)
    if fn is None:
        raise ValueError(
            "unknown action: "
            f"{action!r}; expected one of {', '.join(sorted(ACTION_DISPATCH))}"
        )
    return fn(**kwargs)


def handle_describe(_params: dict[str, Any]) -> dict[str, Any]:
    return MANIFEST


def handle_invoke(params: dict[str, Any]) -> Any:
    tool_name = params.get("tool")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        raise ValueError("`arguments` must be an object")
    fn = TOOL_DISPATCH.get(tool_name)
    if fn is None:
        raise ValueError(f"unknown tool: {tool_name!r}")
    try:
        payload = fn(**args)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"success": True, "data": payload}


def handle_health(_params: dict[str, Any]) -> dict[str, Any]:
    return {"status": "ok", "state_file": str(STATE_FILE), "policy_dir": str(POLICY_DIR)}


METHOD_DISPATCH = {
    "describe": handle_describe,
    "invoke": handle_invoke,
    "health": handle_health,
}


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    print(
        f"[policygate-case] {MANIFEST['display_name']} v{MANIFEST['version']} ready",
        file=sys.stderr,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"parse error: {exc}"},
                }
            )
            continue

        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        handler = METHOD_DISPATCH.get(method)
        if handler is None:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"method not found: {method}"},
                }
            )
            continue
        try:
            result = handler(params)
            send({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception as exc:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32000, "message": str(exc)},
                }
            )


if __name__ == "__main__":
    main()
