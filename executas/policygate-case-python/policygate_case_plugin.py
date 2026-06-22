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

import asyncio
import json
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

PROTOCOL_VERSION_V2 = "2.0"
METHOD_SAMPLING_CREATE_MESSAGE = "sampling/createMessage"
SAMPLING_ERR_NOT_NEGOTIATED = -32008
SAMPLING_ERR_TIMEOUT = -32009


class SamplingError(Exception):
    def __init__(self, code: int, message: str, data: Optional[dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class _Pending:
    def __init__(self, future: asyncio.Future[dict[str, Any]]) -> None:
        self.future = future


class SamplingClient:
    def __init__(self, *, write_frame) -> None:
        self._write_frame = write_frame
        self._pending: dict[str, _Pending] = {}
        self._lock = threading.Lock()
        self._sampling_disabled_reason: Optional[str] = (
            "host sampling has not been negotiated; call initialize with protocolVersion='2.0'"
        )

    def enable(self) -> None:
        self._sampling_disabled_reason = None

    def disable(self, reason: str) -> None:
        self._sampling_disabled_reason = reason

    async def create_message(
        self,
        *,
        messages: list[dict[str, Any]],
        max_tokens: int,
        system_prompt: Optional[str] = None,
        temperature: Optional[float] = None,
        response_format: Optional[dict[str, Any]] = None,
        timeout: float = 90.0,
    ) -> dict[str, Any]:
        if self._sampling_disabled_reason:
            raise SamplingError(SAMPLING_ERR_NOT_NEGOTIATED, self._sampling_disabled_reason)
        if not messages:
            raise ValueError("messages must be a non-empty list")
        if max_tokens <= 0:
            raise ValueError("max_tokens must be positive")

        loop = asyncio.get_running_loop()
        req_id = uuid.uuid4().hex
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        with self._lock:
            self._pending[req_id] = _Pending(future)

        params: dict[str, Any] = {
            "messages": messages,
            "maxTokens": max_tokens,
            "includeContext": "none",
            "_clientTimeoutS": float(timeout),
        }
        if system_prompt is not None:
            params["systemPrompt"] = system_prompt
        if temperature is not None:
            params["temperature"] = temperature
        if response_format is not None:
            params["responseFormat"] = response_format
            params["onUnsupported"] = "json_object"

        self._write_frame(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": METHOD_SAMPLING_CREATE_MESSAGE,
                "params": params,
            }
        )
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            with self._lock:
                self._pending.pop(req_id, None)
            raise SamplingError(
                SAMPLING_ERR_TIMEOUT,
                f"sampling/createMessage timed out after {timeout}s",
            ) from exc

    def dispatch_response(self, message: dict[str, Any]) -> bool:
        if not isinstance(message, dict) or "method" in message:
            return False
        req_id = message.get("id")
        if not req_id:
            return False
        with self._lock:
            pending = self._pending.pop(req_id, None)
        if pending is None:
            return False

        loop = pending.future.get_loop()
        if "error" in message:
            error = message.get("error") or {}
            exc = SamplingError(
                int(error.get("code") or -32000),
                str(error.get("message") or "sampling/createMessage failed"),
                error.get("data") if isinstance(error.get("data"), dict) else None,
            )
            loop.call_soon_threadsafe(pending.future.set_exception, exc)
        else:
            loop.call_soon_threadsafe(pending.future.set_result, message.get("result") or {})
        return True


_stdout_lock = threading.Lock()


def _write_frame(message: dict[str, Any]) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


sampling = SamplingClient(write_frame=_write_frame)

MANIFEST: dict[str, Any] = {
    "display_name": "PolicyGate Case",
    "version": "1.0.1",
    "description": (
        "Policy-backed approval case analysis with local state, evidence "
        "retrieval, risk checks, drafts, decision recording, and audit export."
    ),
    "author": "PolicyGate",
    "homepage": "https://github.com/fozagtx/PolicyGate",
    "license": "MIT",
    "tags": ["approval", "policy", "risk", "audit", "anna-app"],
    "host_capabilities": ["llm.sample"],
    "tools": [
        {
            "name": "case",
            "description": (
                "Dispatch PolicyGate case actions. Use action to select one "
                "of analyze_case, policy_search, risk_check, draft_reply, "
                "save_case, approve_action, export_audit, get_state."
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


def _sampling_text(result: dict[str, Any]) -> str:
    content = result.get("content") or {}
    if isinstance(content, dict) and content.get("type") == "text":
        return str(content.get("text") or "")
    return ""


def _json_from_model_text(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise ValueError("host LLM did not return JSON")
        parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError("host LLM JSON response must be an object")
    return parsed


def _fallback_case_analysis(
    facts: dict[str, Any],
    evidence: list[dict[str, Any]],
    risk: dict[str, Any],
    warning: Optional[str] = None,
) -> dict[str, Any]:
    recommendation = "escalate" if risk.get("level") in {"medium", "high"} else "approve"
    if risk.get("level") == "medium":
        recommendation = "review"
    evidence_titles = ", ".join(item.get("title", "policy") for item in evidence[:3]) or "no matching policy"
    reasons = "; ".join(risk.get("reasons", [])[:3]) or "standard policy-backed approval"
    action = facts.get("requested_action") or "review request"
    draft = (
        f"Recommended action: {recommendation} the {action}. "
        f"Risk is {risk.get('level', 'unknown')} ({risk.get('score', 0)}/100): {reasons}. "
        f"Policy evidence checked: {evidence_titles}. "
        "Record a human decision before any external action."
    )
    result = {
        "provider": "local",
        "model": "policygate-local-fallback",
        "facts": facts,
        "proposed_action": {
            "recommendation": recommendation,
            "draft": draft,
        },
    }
    if warning:
        result["warning"] = warning
    return result


async def _host_case_analysis(
    text: str,
    facts: dict[str, Any],
    evidence: list[dict[str, Any]],
    risk: dict[str, Any],
) -> dict[str, Any]:
    evidence_payload = [
        {
            "policy_id": item.get("policy_id"),
            "title": item.get("title"),
            "excerpt": item.get("excerpt"),
        }
        for item in evidence[:5]
    ]
    prompt = json.dumps(
        {
            "raw_case": text,
            "local_fact_seed": facts,
            "policy_evidence": evidence_payload,
            "risk": risk,
            "required_json_shape": {
                "facts": {
                    "requester": "string",
                    "category": "string",
                    "amount": "string or null",
                    "days_since_event": "integer or null",
                    "requested_action": "string",
                    "missing_info": ["string"],
                    "summary": "string",
                    "confidence": "low|medium|high",
                },
                "proposed_action": {
                    "recommendation": "approve|reject|escalate|review",
                    "draft": "string",
                },
            },
        },
        ensure_ascii=False,
    )
    result = await sampling.create_message(
        messages=[
            {
                "role": "user",
                "content": {"type": "text", "text": prompt},
            }
        ],
        max_tokens=900,
        system_prompt=(
            "You are PolicyGate's case analysis engine. Return only valid JSON. "
            "Extract stable facts and draft an evidence-backed proposed action. "
            "Never claim anything was sent, refunded, cancelled, or executed. "
            "The human must approve, reject, or escalate separately."
        ),
        temperature=0.2,
        response_format={"type": "json_object"},
        timeout=90.0,
    )
    parsed = _json_from_model_text(_sampling_text(result))
    return {
        "provider": "anna-host",
        "model": result.get("model") or "anna-default",
        "usage": result.get("usage"),
        "facts": parsed.get("facts") if isinstance(parsed.get("facts"), dict) else facts,
        "proposed_action": (
            parsed.get("proposed_action")
            if isinstance(parsed.get("proposed_action"), dict)
            else _fallback_case_analysis(facts, evidence, risk)["proposed_action"]
        ),
    }


def _ai_case_analysis(
    text: str,
    facts: dict[str, Any],
    evidence: list[dict[str, Any]],
    risk: dict[str, Any],
    credentials: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    _ = credentials
    if sampling is None:
        return _fallback_case_analysis(
            facts,
            evidence,
            risk,
            "host sampling is unavailable; using local fallback",
        )

    future = asyncio.run_coroutine_threadsafe(
        _host_case_analysis(text, facts, evidence, risk),
        _loop,
    )
    try:
        return future.result(timeout=100.0)
    except SamplingError as exc:
        message = getattr(exc, "message", str(exc))
        return _fallback_case_analysis(facts, evidence, risk, message)
    except Exception as exc:  # noqa: BLE001
        return _fallback_case_analysis(facts, evidence, risk, f"{type(exc).__name__}: {exc}")


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


def action_analyze_case(
    case_id: Optional[str] = None,
    input: str = "",
    credentials: Optional[dict[str, Any]] = None,
    **_kwargs: Any,
) -> dict[str, Any]:
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

    # Stage 2: Anna host LLM enrichment when available; local fallback otherwise.
    ai = _ai_case_analysis(text, facts, evidence, risk, credentials=credentials)
    ai_facts = ai["facts"]
    facts.update(
        {
            "requester": ai_facts.get("requester") or facts.get("requester"),
            "category": ai_facts.get("category") or facts.get("category"),
            "amount": ai_facts.get("amount") or facts.get("amount"),
            "days_since_event": ai_facts.get("days_since_event") or facts.get("days_since_event"),
            "requested_action": ai_facts.get("requested_action") or facts.get("requested_action"),
            "missing_info": ai_facts.get("missing_info") or facts.get("missing_info") or [],
            "summary": ai_facts.get("summary") or facts.get("summary"),
            "confidence": ai_facts.get("confidence") or facts.get("confidence"),
        }
    )
    facts["case_id"] = cid
    case["facts"] = facts
    proposed = ai["proposed_action"]
    case["ai"] = {
        "provider": ai.get("provider", "anna-host"),
        "model": ai.get("model"),
        "usage": ai.get("usage"),
        "warning": ai.get("warning"),
    }
    audit_kind = "tool.anna.sampling" if ai.get("provider") == "anna-host" else "tool.local_draft"
    _audit(
        case,
        audit_kind,
        f"Case draft generated via {case['ai']['provider']}",
        {"model": ai.get("model"), "warning": ai.get("warning")},
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


def action_draft_reply(
    case_id: Optional[str] = None,
    input: str = "",
    credentials: Optional[dict[str, Any]] = None,
    **_kwargs: Any,
) -> dict[str, Any]:
    state = _load_state()
    case = _find_case(state, case_id)
    text = input or (case or {}).get("input", "")
    if not text:
        raise ValueError("input or existing case is required for draft_reply")
    facts = (case or {}).get("facts") or _extract_facts(_safe_case_id(case_id), text)
    evidence = (case or {}).get("evidence") or _policy_search(text)
    risk = (case or {}).get("risk") or _risk_check(facts, evidence, text)
    ai = _ai_case_analysis(text, facts, evidence, risk, credentials=credentials)
    return {
        "proposed_action": ai["proposed_action"],
        "ai": {
            "provider": ai.get("provider", "anna-host"),
            "model": ai.get("model"),
            "usage": ai.get("usage"),
            "warning": ai.get("warning"),
        },
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


def handle_initialize(params: dict[str, Any]) -> dict[str, Any]:
    proto = (params or {}).get("protocolVersion") or "1.1"
    if proto == PROTOCOL_VERSION_V2:
        sampling.enable()
    else:
        sampling.disable(
            f"host did not negotiate protocol 2.0 (offered {proto!r}); "
            "Anna host LLM sampling is disabled for this process"
        )
    return {
        "protocolVersion": proto if proto in {"1.1", "2.0"} else PROTOCOL_VERSION_V2,
        "serverInfo": {"name": MANIFEST["display_name"], "version": MANIFEST["version"]},
        "client_capabilities": {"sampling": {}} if proto == PROTOCOL_VERSION_V2 else {},
        "capabilities": {},
    }


def handle_describe(_params: dict[str, Any]) -> dict[str, Any]:
    return MANIFEST


def handle_invoke(params: dict[str, Any]) -> Any:
    tool_name = params.get("tool")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        raise ValueError("`arguments` must be an object")
    context = params.get("context") or {}
    credentials = context.get("credentials") if isinstance(context, dict) else {}
    if not isinstance(credentials, dict):
        credentials = {}
    fn = TOOL_DISPATCH.get(tool_name)
    if fn is None:
        raise ValueError(f"unknown tool: {tool_name!r}")
    try:
        payload = fn(**args, credentials=credentials)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"success": True, "data": payload}


def handle_health(_params: dict[str, Any]) -> dict[str, Any]:
    return {"status": "ok", "state_file": str(STATE_FILE), "policy_dir": str(POLICY_DIR)}


METHOD_DISPATCH = {
    "initialize": handle_initialize,
    "describe": handle_describe,
    "invoke": handle_invoke,
    "health": handle_health,
    "shutdown": lambda _params: {"ok": True},
}


def send(message: dict[str, Any]) -> None:
    _write_frame(message)


_loop = asyncio.new_event_loop()
_loop_thread = threading.Thread(target=_loop.run_forever, daemon=True)
_loop_thread.start()


def handle_request(request: dict[str, Any]) -> None:
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
        return
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


def main() -> None:
    print(
        f"[policygate-case] {MANIFEST['display_name']} v{MANIFEST['version']} ready",
        file=sys.stderr,
    )
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="policygate-invoke")
    try:
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

            if "method" not in request:
                if sampling is not None and sampling.dispatch_response(request):
                    continue
                print(f"[policygate-case] unmatched host response id={request.get('id')!r}", file=sys.stderr)
                continue

            pool.submit(handle_request, request)
    finally:
        pool.shutdown(wait=True)
        _loop.call_soon_threadsafe(_loop.stop)


if __name__ == "__main__":
    main()
