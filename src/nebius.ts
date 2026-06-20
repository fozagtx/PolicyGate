/**
 * Nebius Token Factory reviewer implemented as a Vercel AI SDK agent.
 *
 * This is a live Nebius call through an OpenAI-compatible provider. When
 * enabled, request failures or invalid structured output fail the tick.
 */

import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { Output, ToolLoopAgent, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { ActionOutput, MarketResearchEvidence, MarketState, PortfolioState, Signal } from "./types.js";
import { appConfig, optionalSecretEnv, secretEnv } from "./config.js";

const reviewSchema = z.object({
  approved: z.boolean().describe("Whether the proposed action may continue to the local risk gate."),
  risk_level: z.enum(["low", "medium", "high"]).describe("Operational and trading risk level for this tick."),
  rationale: z.string().min(1).max(1000).describe("Short reason for approving or vetoing the action."),
  warnings: z.array(z.string().max(240)).max(8).describe("Concrete risks or operator notes."),
});

type NebiusReviewOutput = z.infer<typeof reviewSchema>;

export interface NebiusReview extends NebiusReviewOutput {
  provider: "nebius" | "openai";
  agent_framework: "vercel-ai-sdk";
  agent_id: string;
  model: string;
  tool_calls: string[];
  latency_ms: number;
  primary_provider_error?: string;
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
  marketResearch: MarketResearchEvidence | null;
};

export interface NebiusHealth {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_present: boolean;
  models_endpoint: {
    ok: boolean;
    status: number | null;
    model_available: boolean;
    available_model_count: number | null;
    error: string | null;
  };
  live_completion?: {
    ok: boolean;
    status: number | null;
    error: string | null;
  };
}

export class NebiusRiskAgent {
  private provider: OpenAICompatibleProvider<string, string, string, string>;
  private openAiProvider: OpenAIProvider | null = null;
  private model: string;
  private openAiModel: string;

  constructor() {
    this.model = appConfig.nebius.model;
    this.openAiModel = appConfig.secondaryReview.model;
    this.provider = createOpenAICompatible({
      name: "nebius-token-factory",
      apiKey: secretEnv("NEBIUS_API_KEY"),
      baseURL: appConfig.nebius.baseUrl,
      includeUsage: true,
    });
    const openAiKey = optionalSecretEnv("OPENAI_API_KEY");
    if (appConfig.secondaryReview.enabled && openAiKey) {
      this.openAiProvider = createOpenAI({
        apiKey: openAiKey,
        baseURL: appConfig.secondaryReview.baseUrl,
      });
    }
  }

  get modelName(): string {
    return this.model;
  }

  async reviewDecision(input: ReviewInput): Promise<NebiusReview> {
    try {
      return await this.runReview(input, {
        provider: "nebius",
        agentId: "hyperflow-nebius-risk-agent",
        modelName: this.model,
        model: this.provider(this.model),
        timeoutMs: appConfig.nebius.timeoutMs,
        maxOutputTokens: appConfig.nebius.maxTokens,
        temperature: appConfig.nebius.temperature,
      });
    } catch (primaryError) {
      const primaryMessage = formatProviderError(primaryError);
      if (!this.openAiProvider) {
        throw new Error(`Nebius AI SDK agent request failed: ${primaryMessage}`, { cause: primaryError });
      }

      try {
        const review = await this.runReview(input, {
          provider: "openai",
          agentId: "hyperflow-openai-risk-helper",
          modelName: this.openAiModel,
          model: this.openAiProvider.responses(this.openAiModel),
          timeoutMs: appConfig.secondaryReview.timeoutMs,
          maxOutputTokens: appConfig.secondaryReview.maxTokens,
          temperature: appConfig.secondaryReview.temperature,
        });
        return {
          ...review,
          primary_provider_error: primaryMessage,
        };
      } catch (secondaryError) {
        throw new Error(
          `Nebius AI SDK agent request failed: ${primaryMessage}; secondary model request failed: ${formatProviderError(secondaryError)}`,
          { cause: secondaryError },
        );
      }
    }
  }

  private async runReview(
    input: ReviewInput,
    providerConfig: {
      provider: "nebius" | "openai";
      agentId: string;
      modelName: string;
      model: LanguageModel;
      timeoutMs: number;
      maxOutputTokens: number;
      temperature: number;
    },
  ): Promise<NebiusReview> {
    const started = Date.now();
    const context = buildReviewContext(input);
    const tools = {
      inspectTradeContext: tool({
        description:
          "Inspect the exact HyperFlow paid signal, wallet spend receipt, Tavily source evidence, portfolio, market, proposed action, and risk snapshot for this decision tick.",
        inputSchema: z.object({
          section: z
            .enum(["full", "signal", "payment", "research", "portfolio", "market", "action", "risk"])
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
      id: providerConfig.agentId,
      model: providerConfig.model,
      instructions: [
        "You are HyperFlow's production risk-review agent.",
        "HyperFlow uses a Circle Agent Wallet to pay for market intelligence, then may execute on Hyperliquid.",
        "Do not invent prices, balances, receipts, positions, or transactions.",
        "Inspect the provided trade context and Tavily source evidence before producing the final structured review.",
        "Approve only when the proposed action is coherent with the paid signal, wallet spend, Tavily evidence, portfolio state, and risk snapshot.",
        "Veto obvious operational errors, impossible trades, missing payment context for trade actions, or risk-limit violations.",
        "For non-hold trade actions, treat missing Tavily evidence as an operational risk.",
      ].join(" "),
      tools,
      output,
      temperature: providerConfig.temperature,
      maxOutputTokens: providerConfig.maxOutputTokens,
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
      timeout: { totalMs: providerConfig.timeoutMs },
      prompt: [
        "Review this HyperFlow decision tick.",
        "First call inspectTradeContext, then return the structured review.",
        `Summary: ${JSON.stringify(buildPromptSummary(context))}`,
      ].join("\n"),
    }).catch((error: unknown) => {
      throw new Error(`${providerConfig.provider} AI SDK agent request failed: ${formatProviderError(error)}`, {
        cause: error,
      });
    });

    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ("toolName" in call ? String(call.toolName) : "unknown")),
    );
    if (!toolCalls.includes("inspectTradeContext")) {
      throw new Error("Nebius AI SDK agent did not inspect the trade context tool");
    }

    return {
      provider: providerConfig.provider,
      agent_framework: "vercel-ai-sdk",
      agent_id: providerConfig.agentId,
      model: providerConfig.modelName,
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

export async function checkNebiusHealth(liveCompletion: boolean = false): Promise<NebiusHealth> {
  const apiKey = secretEnv("NEBIUS_API_KEY");
  const health: NebiusHealth = {
    enabled: appConfig.nebius.enabled,
    base_url: appConfig.nebius.baseUrl,
    model: appConfig.nebius.model,
    api_key_present: apiKey.length > 0,
    models_endpoint: {
      ok: false,
      status: null,
      model_available: false,
      available_model_count: null,
      error: null,
    },
  };

  const baseUrl = appConfig.nebius.baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(appConfig.nebius.timeoutMs),
    });
    health.models_endpoint.status = response.status;
    const body = await response.text();
    if (!response.ok) {
      health.models_endpoint.error = sanitizeBody(body) || response.statusText;
    } else {
      const parsed = JSON.parse(body) as { data?: Array<{ id?: string }> };
      const modelIds = Array.isArray(parsed.data) ? parsed.data.map((model) => model.id).filter(Boolean) : [];
      health.models_endpoint.ok = true;
      health.models_endpoint.available_model_count = modelIds.length;
      health.models_endpoint.model_available = modelIds.includes(appConfig.nebius.model);
    }
  } catch (error) {
    health.models_endpoint.error = error instanceof Error ? error.message : String(error);
  }

  if (liveCompletion) {
    health.live_completion = await checkLiveCompletion(baseUrl, apiKey);
  }

  return health;
}

function buildReviewContext(input: ReviewInput): Record<string, unknown> {
  return {
    signal: input.signal,
    agent_wallet_spend: input.agentWalletSpend,
    market_research: input.marketResearch,
    portfolio: input.portfolio,
    market: input.market,
    proposed_action: input.action,
    risk_snapshot: input.riskSnapshot,
    policy: {
      live_responses_only: true,
      primary_review_provider: "nebius",
      secondary_review_provider: appConfig.secondaryReview.enabled ? "openai" : null,
      paid_signal_required_for_trade: input.action.side !== "hold",
      tavily_research_required_for_trade: appConfig.tavily.enabled && input.action.side !== "hold",
      all_model_failures_block_tick: true,
    },
  };
}

function buildPromptSummary(context: Record<string, unknown>): Record<string, unknown> {
  const signal = context.signal as Signal;
  const portfolio = context.portfolio as PortfolioState;
  const market = context.market as MarketState;
  const action = context.proposed_action as ActionOutput;
  const spend = context.agent_wallet_spend as Record<string, unknown> | null;
  const research = context.market_research as MarketResearchEvidence | null;

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
    tavily_source_count: research?.result_count ?? 0,
    tavily_top_urls: research?.sources.slice(0, 3).map((source) => source.url) ?? [],
  };
}

function selectContextSection(context: Record<string, unknown>, section: string): unknown {
  switch (section) {
    case "signal":
      return context.signal;
    case "payment":
      return context.agent_wallet_spend;
    case "research":
      return context.market_research;
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

async function checkLiveCompletion(baseUrl: string, apiKey: string): Promise<NonNullable<NebiusHealth["live_completion"]>> {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(appConfig.nebius.timeoutMs),
      body: JSON.stringify({
        model: appConfig.nebius.model,
        temperature: 0,
        max_tokens: 16,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return only JSON." },
          { role: "user", content: "{\"ok\":true}" },
        ],
      }),
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : sanitizeBody(body) || response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sanitizeBody(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").slice(0, 500);
}
