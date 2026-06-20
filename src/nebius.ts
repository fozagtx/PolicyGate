/**
 * Nebius Token Factory reviewer implemented as a Vercel AI SDK agent.
 *
 * This is a live Nebius call through an OpenAI-compatible provider. When
 * enabled, request failures or invalid structured output fail the tick.
 */

import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { Output, ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { ActionOutput, MarketState, PortfolioState, Signal } from "./types.js";
import { appConfig, secretEnv } from "./config.js";

const reviewSchema = z.object({
  approved: z.boolean().describe("Whether the proposed action may continue to the local risk gate."),
  risk_level: z.enum(["low", "medium", "high"]).describe("Operational and trading risk level for this tick."),
  rationale: z.string().min(1).max(1000).describe("Short reason for approving or vetoing the action."),
  warnings: z.array(z.string().max(240)).max(8).describe("Concrete risks or operator notes."),
});

type NebiusReviewOutput = z.infer<typeof reviewSchema>;

export interface NebiusReview extends NebiusReviewOutput {
  provider: "nebius";
  agent_framework: "vercel-ai-sdk";
  agent_id: "hyperflow-nebius-risk-agent";
  model: string;
  tool_calls: string[];
  latency_ms: number;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
  };
}

type ReviewInput = {
  signal: Signal;
  portfolio: PortfolioState;
  market: MarketState;
  action: ActionOutput;
  riskSnapshot: Record<string, unknown>;
  agentWalletSpend: Record<string, unknown> | null;
};

export class NebiusRiskAgent {
  private provider: OpenAICompatibleProvider<string, string, string, string>;
  private model: string;

  constructor() {
    this.model = appConfig.nebius.model;
    this.provider = createOpenAICompatible({
      name: "nebius-token-factory",
      apiKey: secretEnv("NEBIUS_API_KEY"),
      baseURL: appConfig.nebius.baseUrl,
      includeUsage: true,
    });
  }

  get modelName(): string {
    return this.model;
  }

  async reviewDecision(input: ReviewInput): Promise<NebiusReview> {
    const started = Date.now();
    const context = buildReviewContext(input);
    const tools = {
      inspectTradeContext: tool({
        description:
          "Inspect the exact HyperFlow paid signal, wallet spend receipt, portfolio, market, proposed action, and risk snapshot for this decision tick.",
        inputSchema: z.object({
          section: z
            .enum(["full", "signal", "payment", "portfolio", "market", "action", "risk"])
            .optional()
            .describe("The context section to inspect. Use full unless narrowing a specific risk."),
        }),
        execute: async ({ section = "full" }) => selectContextSection(context, section),
      }),
    };

    const output = Output.object({
      name: "HyperFlowNebiusReview",
      description: "Approval, risk level, rationale, and warnings for one HyperFlow agent decision tick.",
      schema: reviewSchema,
    });

    const agent = new ToolLoopAgent({
      id: "hyperflow-nebius-risk-agent",
      model: this.provider(this.model),
      instructions: [
        "You are HyperFlow's production risk-review agent.",
        "HyperFlow uses a Circle Agent Wallet to pay for market intelligence, then may execute on Hyperliquid.",
        "Do not invent prices, balances, receipts, positions, or transactions.",
        "Inspect the provided trade context before producing the final structured review.",
        "Approve only when the proposed action is coherent with the paid signal, wallet spend, portfolio state, and risk snapshot.",
        "Veto obvious operational errors, impossible trades, missing payment context for trade actions, or risk-limit violations.",
      ].join(" "),
      tools,
      output,
      temperature: appConfig.nebius.temperature,
      maxOutputTokens: appConfig.nebius.maxTokens,
      stopWhen: stepCountIs(4),
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0
          ? {
              activeTools: ["inspectTradeContext"],
              toolChoice: { type: "tool", toolName: "inspectTradeContext" },
            }
          : {
              toolChoice: "none",
            },
    });

    const result = await agent.generate({
      timeout: { totalMs: appConfig.nebius.timeoutMs },
      prompt: [
        "Review this HyperFlow decision tick.",
        "First call inspectTradeContext, then return the structured review.",
        `Summary: ${JSON.stringify(buildPromptSummary(context))}`,
      ].join("\n"),
    }).catch((error: unknown) => {
      throw new Error(`Nebius AI SDK agent request failed: ${formatProviderError(error)}`, { cause: error });
    });

    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ("toolName" in call ? String(call.toolName) : "unknown")),
    );
    if (!toolCalls.includes("inspectTradeContext")) {
      throw new Error("Nebius AI SDK agent did not inspect the trade context tool");
    }

    return {
      provider: "nebius",
      agent_framework: "vercel-ai-sdk",
      agent_id: "hyperflow-nebius-risk-agent",
      model: this.model,
      approved: result.output.approved,
      risk_level: result.output.risk_level,
      rationale: result.output.rationale.slice(0, 1000),
      warnings: result.output.warnings.map(String).slice(0, 8),
      tool_calls: toolCalls,
      latency_ms: Date.now() - started,
      usage: {
        input_tokens: normalizeTokenCount(result.totalUsage.inputTokens),
        output_tokens: normalizeTokenCount(result.totalUsage.outputTokens),
        total_tokens: normalizeTokenCount(result.totalUsage.totalTokens),
      },
    };
  }
}

export const NebiusReasoner = NebiusRiskAgent;

export function isNebiusEnabled(): boolean {
  return appConfig.nebius.enabled;
}

export function isNebiusVetoEnabled(): boolean {
  return appConfig.nebius.vetoEnabled;
}

function buildReviewContext(input: ReviewInput): Record<string, unknown> {
  return {
    signal: input.signal,
    agent_wallet_spend: input.agentWalletSpend,
    portfolio: input.portfolio,
    market: input.market,
    proposed_action: input.action,
    risk_snapshot: input.riskSnapshot,
    policy: {
      live_responses_only: true,
      nebius_review_required: true,
      paid_signal_required_for_trade: input.action.side !== "hold",
      nebius_failure_blocks_tick: true,
    },
  };
}

function buildPromptSummary(context: Record<string, unknown>): Record<string, unknown> {
  const signal = context.signal as Signal;
  const portfolio = context.portfolio as PortfolioState;
  const market = context.market as MarketState;
  const action = context.proposed_action as ActionOutput;
  const spend = context.agent_wallet_spend as Record<string, unknown> | null;

  return {
    symbol: signal.symbol,
    signal_direction: signal.direction,
    signal_confidence: signal.confidence,
    payment_tx_hash: signal.tx_hash || spend?.tx_hash || null,
    account_value_usd: portfolio.account_value_usd,
    free_margin_usd: portfolio.free_margin_usd,
    mid_px: market.mid_px,
    proposed_side: action.side,
    proposed_size_usd: action.size_usd,
    proposed_leverage: action.leverage,
    hold_reason: action.hold_reason,
  };
}

function selectContextSection(context: Record<string, unknown>, section: string): unknown {
  switch (section) {
    case "signal":
      return context.signal;
    case "payment":
      return context.agent_wallet_spend;
    case "portfolio":
      return context.portfolio;
    case "market":
      return context.market;
    case "action":
      return context.proposed_action;
    case "risk":
      return context.risk_snapshot;
    default:
      return context;
  }
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatProviderError(error: unknown): string {
  const err = error as { statusCode?: unknown; responseBody?: unknown; message?: unknown };
  const status = typeof err.statusCode === "number" ? `${err.statusCode} ` : "";
  const body = typeof err.responseBody === "string" ? err.responseBody : "";
  const message = typeof err.message === "string" ? err.message : "unknown provider error";
  return `${status}${message}${body ? ` - ${body.slice(0, 300)}` : ""}`;
}
