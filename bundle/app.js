/**
 * PolicyGate — Anna App bundle controller.
 *
 * Real RPC shape:
 *   anna.tools.invoke({
 *     tool_id: "<server-minted id>",
 *     method: "case",
 *     args: { action, ... },
 *   })
 */

import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const DEV_FALLBACK_TOOL_ID = "tool-test-policygate-case-12345678";
const TOOL_ID =
  (typeof window !== "undefined"
    && window.__ANNA_TOOL_IDS__
    && window.__ANNA_TOOL_IDS__["policygate-case"])
  || DEV_FALLBACK_TOOL_ID;
const TOOL_METHOD = "case";
const LAST_CASE_KEY = "policygate:last-case-id";

const $ = (sel) => document.querySelector(sel);

const els = {
  body: document.body,
  caseStatus: $("#case-status"),
  riskBadge: $("#risk-badge"),
  connStatus: $("#conn-status"),
  caseId: $("#case-id"),
  caseInput: $("#case-input"),
  analyzeBtn: $("#analyze-btn"),
  clearBtn: $("#clear-btn"),
  loadLastBtn: $("#load-last-btn"),
  sampleLowBtn: $("#sample-low-btn"),
  sampleHighBtn: $("#sample-high-btn"),
  errorBox: $("#error-box"),
  confidencePill: $("#confidence-pill"),
  factsList: $("#facts-list"),
  draftOutput: $("#draft-output"),
  recommendationPill: $("#recommendation-pill"),
  evidenceCount: $("#evidence-count"),
  evidenceList: $("#evidence-list"),
  policyCount: $("#policy-count"),
  policyList: $("#policy-list"),
  approveBtn: $("#approve-btn"),
  rejectBtn: $("#reject-btn"),
  escalateBtn: $("#escalate-btn"),
  sendBtn: $("#send-btn"),
  exportBtn: $("#export-btn"),
  decisionNote: $("#decision-note"),
  timelineCount: $("#timeline-count"),
  timeline: $("#timeline"),
};

let anna = null;
let activeCase = null;
let isCalling = false;

async function init() {
  bindUi();
  renderEmpty();
  try {
    anna = await AnnaAppRuntime.connect();
    setConnected(true);
    setStatus("Connected to PolicyGate dispatcher");
    await loadState();
  } catch (e) {
    setConnected(false);
    setStatus("Open in Anna to connect dispatcher");
    showError(`Anna runtime unavailable: ${e?.message || e}`);
  }
}

function bindUi() {
  els.analyzeBtn.addEventListener("click", analyzeCase);
  els.clearBtn.addEventListener("click", clearCase);
  els.loadLastBtn.addEventListener("click", loadState);
  els.sampleLowBtn.addEventListener("click", () => loadSample("low"));
  els.sampleHighBtn.addEventListener("click", () => loadSample("high"));
  els.approveBtn.addEventListener("click", () => recordDecision("approved"));
  els.rejectBtn.addEventListener("click", () => recordDecision("rejected"));
  els.escalateBtn.addEventListener("click", () => recordDecision("escalated"));
  els.sendBtn.addEventListener("click", sendSimulated);
  els.exportBtn.addEventListener("click", exportAudit);
}

async function callCase(action, extra = {}) {
  if (!anna) throw new Error("Anna runtime is not connected");
  if (isCalling) return null;
  isCalling = true;
  setBusy(true);
  hideError();
  try {
    return await anna.tools.invoke({
      tool_id: TOOL_ID,
      method: TOOL_METHOD,
      args: { action, ...extra },
    });
  } catch (e) {
    showError(e?.message || String(e));
    throw e;
  } finally {
    isCalling = false;
    setBusy(false);
  }
}

async function analyzeCase() {
  const input = els.caseInput.value.trim();
  if (!input) {
    showError("Paste a case before running analysis.");
    return;
  }
  try {
    const result = await callCase("analyze_case", {
      case_id: els.caseId.value.trim(),
      input,
    });
    if (!result) return;
    applyCase(result.case || result.active_case);
    if (anna && activeCase?.id) {
      try {
        await anna.storage.set({ key: LAST_CASE_KEY, value: activeCase.id });
      } catch {
        /* storage may be denied */
      }
    }
    try {
      await anna.window.set_title({ title: `${activeCase.id} — PolicyGate` });
    } catch {
      /* non-fatal */
    }
  } catch {
    /* surfaced */
  }
}

const SAMPLES = {
  low: {
    id: "CASE-1042",
    input: `Customer jane.doe@example.com ordered #ORD-8821 (wireless keyboard, $49.99) 22 days ago. Product stopped pairing after 18 days. Customer requests a replacement. Has photos of the defect.`,
  },
  high: {
    id: "CASE-2091",
    input: `Customer mark.smith@email.com for order #ORD-9915 ($1,299 laptop) purchased 48 days ago. Says the product is "defective and unacceptable." Threatens chargeback and social media. Demands full refund plus free replacement. Mentions "my attorney."`,
  },
};

function loadSample(level) {
  const sample = SAMPLES[level];
  if (!sample) return;
  els.caseId.value = sample.id;
  els.caseInput.value = sample.input;
  hideError();
  setStatus(`Loaded sample: ${sample.id} (${level} risk)`);
}

async function sendSimulated() {
  if (!activeCase) return;
  try {
    const result = await callCase("send_simulated", {
      case_id: activeCase.id,
      channel: "email",
    });
    if (result?.case) applyCase(result.case);
    if (result?.send) {
      setStatus(`Simulated send to ${result.send.to} via ${result.send.channel}`);
    }
  } catch {
    /* surfaced */
  }
}

async function loadState() {
  if (!anna) return;
  try {
    const result = await callCase("get_state");
    let next = result?.active_case;
    if (!next) {
      const recent = Array.isArray(result?.recent) ? result.recent : [];
      next = recent[0] || null;
    }
    if (next) {
      applyCase(next);
      return;
    }
    renderEmpty();
  } catch {
    /* surfaced */
  }
}

async function recordDecision(decision) {
  if (!activeCase) return;
  const note = els.decisionNote.value.trim();
  try {
    const result = await callCase("approve_action", {
      case_id: activeCase.id,
      decision,
      note,
      draft: els.draftOutput.value,
    });
    if (result?.case) applyCase(result.case);
  } catch {
    /* surfaced */
  }
}

async function exportAudit() {
  if (!activeCase) return;
  try {
    const result = await callCase("export_audit", { case_id: activeCase.id });
    if (result?.case) applyCase(result.case);
    const path = result?.export?.path;
    if (path) {
      setStatus(`Audit exported: ${path}`);
      try {
        await anna.chat.write_message({
          role: "user",
          content: `PolicyGate audit exported for ${activeCase.id}: ${path}`,
        });
      } catch {
        /* chat may be denied */
      }
    }
  } catch {
    /* surfaced */
  }
}

function clearCase() {
  activeCase = null;
  els.caseId.value = "";
  els.caseInput.value = "";
  els.decisionNote.value = "";
  renderEmpty();
  hideError();
}

function applyCase(caseData) {
  if (!caseData) {
    renderEmpty();
    return;
  }
  activeCase = caseData;
  els.caseId.value = caseData.id || "";
  els.caseInput.value = caseData.input || "";
  renderFacts(caseData.facts || {});
  renderEvidence(caseData.evidence || []);
  renderPolicies(caseData.policy_checks || []);
  renderDraft(caseData.proposed_action || {});
  renderRisk(caseData.risk || {});
  renderTimeline(caseData.audit || []);
  updateDecisionState(caseData);
  setStatus(`${caseData.id} · ${labelize(caseData.status || "draft")}`);
}

function renderEmpty() {
  activeCase = null;
  renderFacts({});
  renderEvidence([]);
  renderPolicies([]);
  renderDraft({});
  renderRisk({});
  renderTimeline([]);
  updateDecisionState(null);
}

function renderFacts(facts) {
  const rows = [
    ["Requestor", facts.requester || "--"],
    ["Amount", facts.amount || "--"],
    ["Category", labelize(facts.category || "") || "--"],
    ["Deadline", facts.days_since_event ? `${facts.days_since_event} days` : "--"],
    ["Requested", labelize(facts.requested_action || "") || "--"],
    ["Order", facts.order_ref || "--"],
  ];
  els.factsList.innerHTML = "";
  for (const [term, value] of rows) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = String(value);
    wrap.append(dt, dd);
    els.factsList.appendChild(wrap);
  }
  const missing = Array.isArray(facts.missing_info) ? facts.missing_info : [];
  els.confidencePill.textContent = facts.confidence
    ? `${labelize(facts.confidence)} confidence`
    : "No analysis";
  els.confidencePill.title = missing.length ? `Missing: ${missing.join(", ")}` : "";
}

function renderEvidence(items) {
  els.evidenceCount.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
  els.evidenceList.innerHTML = "";
  els.evidenceList.classList.toggle("empty-state", items.length === 0);
  if (!items.length) {
    els.evidenceList.textContent = "No evidence returned yet.";
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "evidence-card";
    const head = document.createElement("div");
    head.className = "evidence-card__head";
    const title = document.createElement("h3");
    title.textContent = item.title || item.policy_id || "Policy";
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `score ${item.score ?? 0}`;
    head.append(title, score);
    const body = document.createElement("p");
    body.textContent = item.excerpt || "";
    const terms = document.createElement("small");
    terms.textContent = Array.isArray(item.matched_terms) && item.matched_terms.length
      ? item.matched_terms.join(", ")
      : "policy match";
    card.append(head, body, terms);
    els.evidenceList.appendChild(card);
  }
}

function renderPolicies(items) {
  els.policyCount.textContent = `${items.length} check${items.length === 1 ? "" : "s"}`;
  els.policyList.innerHTML = "";
  els.policyList.classList.toggle("empty-state", items.length === 0);
  if (!items.length) {
    els.policyList.textContent = "No policy checks returned yet.";
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = `check-card check-card--${item.status || "review"}`;
    const name = document.createElement("h3");
    name.textContent = item.name || "Policy check";
    const detail = document.createElement("p");
    detail.textContent = item.detail || "";
    card.append(name, detail);
    els.policyList.appendChild(card);
  }
}

function renderDraft(proposed) {
  const draft = proposed.draft || "";
  els.draftOutput.disabled = !draft;
  els.draftOutput.value = draft;
  els.recommendationPill.textContent = proposed.recommendation
    ? labelize(proposed.recommendation)
    : "Pending";
}

function renderRisk(risk) {
  const level = risk.level || "unknown";
  els.riskBadge.className = `risk-badge risk-badge--${level}`;
  els.riskBadge.textContent = risk.score == null
    ? "Risk pending"
    : `${labelize(level)} risk · ${risk.score}`;
  els.riskBadge.title = Array.isArray(risk.reasons) ? risk.reasons.join("; ") : "";
}

function renderTimeline(events) {
  els.timelineCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  els.timeline.innerHTML = "";
  if (!events.length) {
    const li = document.createElement("li");
    li.className = "timeline__empty";
    li.textContent = "Analysis and recorded decisions will appear here.";
    els.timeline.appendChild(li);
    return;
  }
  for (const event of events.slice().reverse()) {
    const li = document.createElement("li");
    li.className = "timeline__item";
    const meta = document.createElement("span");
    meta.className = "timeline__meta";
    meta.textContent = `${event.ts || ""} · ${event.kind || "event"}`;
    const summary = document.createElement("strong");
    summary.textContent = event.summary || "";
    li.append(meta, summary);
    els.timeline.appendChild(li);
  }
}

function updateDecisionState(caseData) {
  const hasCase = !!caseData;
  const canDecide = hasCase && ["draft", "pending_approval", "escalated"].includes(caseData.status || "draft");
  const canSend = hasCase && caseData.status === "approved";
  els.approveBtn.disabled = !canDecide;
  els.rejectBtn.disabled = !canDecide;
  els.escalateBtn.disabled = !canDecide;
  els.sendBtn.disabled = !canSend;
  els.exportBtn.disabled = !hasCase;
}

function setConnected(on) {
  els.connStatus.classList.toggle("conn--off", !on);
  els.connStatus.classList.toggle("conn--on", !!on);
  els.connStatus.title = on ? "Connected" : "Disconnected";
}

function setBusy(on) {
  els.body.classList.toggle("is-busy", !!on);
  for (const button of document.querySelectorAll("button")) {
    button.toggleAttribute("aria-busy", !!on);
  }
}

function setStatus(text) {
  els.caseStatus.textContent = text;
}

function showError(message) {
  els.errorBox.hidden = false;
  els.errorBox.textContent = message;
}

function hideError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = "";
}

function labelize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

document.addEventListener("DOMContentLoaded", init);
