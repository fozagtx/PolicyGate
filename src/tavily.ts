import { tavily, type TavilyClient, type TavilySearchOptions, type TavilySearchResponse } from "@tavily/core";
import { appConfig, optionalSecretEnv } from "./config.js";
import type { ActionOutput, MarketResearchEvidence, MarketState, Signal } from "./types.js";

export class TavilyMarketResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TavilyMarketResearchError";
  }
}

export class TavilyMarketResearchClient {
  private client: TavilyClient;

  constructor(apiKey: string) {
    this.client = tavily({
      apiKey,
      projectId: appConfig.tavily.projectId || undefined,
      clientName: "hyperflow-agent",
    });
  }

  async researchDecision(input: {
    signal: Signal;
    market: MarketState;
    action: ActionOutput;
  }): Promise<MarketResearchEvidence> {
    const query = buildQuery(input.signal, input.market, input.action);
    const searchedAtMs = Date.now();
    const options: TavilySearchOptions = {
      topic: appConfig.tavily.topic,
      searchDepth: appConfig.tavily.searchDepth,
      timeRange: appConfig.tavily.timeRange,
      maxResults: appConfig.tavily.maxResults,
      includeAnswer: false,
      includeRawContent: false,
      includeImages: false,
      includeFavicon: true,
      includeUsage: true,
      timeout: Math.ceil(appConfig.tavily.timeoutMs / 1000),
    };

    let response: TavilySearchResponse;
    try {
      response = await this.client.search(query, options);
    } catch (error) {
      throw new TavilyMarketResearchError(formatTavilyError(error));
    }

    const sources = response.results.map((result) => ({
      title: String(result.title || "untitled").slice(0, 180),
      url: String(result.url || ""),
      content: String(result.content || "").slice(0, appConfig.tavily.maxSnippetChars),
      score: typeof result.score === "number" && Number.isFinite(result.score) ? result.score : null,
      published_date: typeof result.publishedDate === "string" && result.publishedDate ? result.publishedDate : null,
      favicon: typeof result.favicon === "string" && result.favicon ? result.favicon : null,
    })).filter((source) => source.url);

    return {
      provider: "tavily",
      query,
      topic: appConfig.tavily.topic,
      time_range: appConfig.tavily.timeRange,
      search_depth: appConfig.tavily.searchDepth,
      searched_at_ms: searchedAtMs,
      request_id: response.requestId || null,
      response_time_seconds: typeof response.responseTime === "number" ? response.responseTime : null,
      credits: typeof response.usage?.credits === "number" ? response.usage.credits : null,
      result_count: sources.length,
      sources,
    };
  }
}

export function createTavilyMarketResearchClient(): TavilyMarketResearchClient | null {
  if (!appConfig.tavily.enabled) return null;
  const apiKey = optionalSecretEnv("TAVILY_API_KEY");
  if (!apiKey) {
    throw new TavilyMarketResearchError("TAVILY_API_KEY missing");
  }
  return new TavilyMarketResearchClient(apiKey);
}

function buildQuery(signal: Signal, market: MarketState, action: ActionOutput): string {
  const symbol = signal.symbol.toUpperCase();
  const actionPart = action.side === "hold" ? "hold risk" : `${action.side} setup risk`;
  return [
    symbol,
    "crypto market news",
    signal.direction,
    actionPart,
    `price ${market.mid_px.toFixed(0)}`,
    "liquidity volatility macro catalysts",
  ].join(" ");
}

function formatTavilyError(error: unknown): string {
  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; data?: unknown };
    message?: unknown;
  };
  const status = typeof err.status === "number"
    ? err.status
    : typeof err.statusCode === "number"
      ? err.statusCode
      : typeof err.response?.status === "number"
        ? err.response.status
        : null;
  const message = typeof err.message === "string" ? err.message : String(error);
  const rawData = err.response?.data;
  const data = typeof rawData === "string" ? rawData : rawData ? JSON.stringify(rawData) : "";
  return `${status ? `HTTP ${status}: ` : ""}${message}${data ? ` - ${data.slice(0, 300)}` : ""}`.slice(0, 500);
}
