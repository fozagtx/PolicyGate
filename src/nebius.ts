/**
 * Nebius Token Factory client for live reasoning annotations.
 *
 * Uses Nebius' OpenAI-compatible API. This never fabricates a local response:
 * when enabled, missing credentials or request failures surface as errors.
 */

import OpenAI from "openai";
import type { ActionOutput, MarketState, PortfolioState, Signal } from "./types.js";
import { appConfig, secretEnv } from "./config.js";

export interface NebiusReview {
  provider: "nebius";
  model: string;
  approved: boolean;
  risk_level: "low" | "medium" | "high";
  rationale: string;
  warnings: string[];
  latency_ms: number;
}

export class NebiusReasoner {
  private client: OpenAI;
  private model: string;

  constructor() {
    this.model = appConfig.nebius.model;
    this.client = new OpenAI({
      apiKey: secretEnv("NEBIUS_API_KEY"),
      baseURL: appConfig.nebius.baseUrl,
      timeout: appConfig.nebius.timeoutMs,
    });
  }

  get modelName(): string {
    return this.model;
  }

  async reviewDecision(input: {
    signal: Signal;
    portfolio: PortfolioState;
    market: MarketState;
    action: ActionOutput;
    riskSnapshot: Record<string, unknown>;
  }): Promise<NebiusReview> {
    const started = Date.now();
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: appConfig.nebius.temperature,
      max_tokens: appConfig.nebius.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a production trading risk reviewer.",
            "Return only JSON with keys: approved, risk_level, rationale, warnings.",
            "approved must be false only for obvious operational or risk violations.",
            "risk_level must be low, medium, or high.",
            "Do not invent market data. Use only the provided JSON.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            signal: input.signal,
            portfolio: input.portfolio,
            market: input.market,
            action: input.action,
            risk: input.riskSnapshot,
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Nebius returned an empty response");
    }

    const parsed = JSON.parse(content) as Partial<NebiusReview>;
    const riskLevel = normalizeRiskLevel(parsed.risk_level);
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map(String).slice(0, 8)
      : [];

    return {
      provider: "nebius",
      model: this.model,
      approved: Boolean(parsed.approved),
      risk_level: riskLevel,
      rationale: String(parsed.rationale ?? "").slice(0, 1000),
      warnings,
      latency_ms: Date.now() - started,
    };
  }
}

export function isNebiusEnabled(): boolean {
  return appConfig.nebius.enabled;
}

export function isNebiusVetoEnabled(): boolean {
  return appConfig.nebius.vetoEnabled;
}

function normalizeRiskLevel(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}
