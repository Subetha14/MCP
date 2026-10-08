export interface ModelPricing {
  modelName: string;
  provider: 'deepseek' | 'openai' | 'anthropic';
  inputCostPer1M: number;
  inputCacheHitCostPer1M?: number;
  outputCostPer1M: number;
}

export const PRICING_CATALOG: Record<string, ModelPricing> = {
  'deepseek-chat': {
    modelName: 'DeepSeek-V3 (deepseek-chat)',
    provider: 'deepseek',
    inputCostPer1M: 0.14,
    inputCacheHitCostPer1M: 0.014,
    outputCostPer1M: 0.28
  },
  'deepseek-coder': {
    modelName: 'DeepSeek Coder V2 (deepseek-coder)',
    provider: 'deepseek',
    inputCostPer1M: 0.14,
    inputCacheHitCostPer1M: 0.014,
    outputCostPer1M: 0.28
  },
  'gpt-4o': {
    modelName: 'OpenAI GPT-4o',
    provider: 'openai',
    inputCostPer1M: 2.50,
    outputCostPer1M: 10.00
  },
  'gpt-4o-mini': {
    modelName: 'OpenAI GPT-4o-mini',
    provider: 'openai',
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  'claude-3-5-sonnet': {
    modelName: 'Anthropic Claude 3.5 Sonnet',
    provider: 'anthropic',
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  }
};

export interface CostEstimateComparison {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  deepseekCost: number;
  openaiGpt4oCost: number;
  openaiMiniCost: number;
  claudeSonnetCost: number;
  savingsVsGpt4oUsd: number;
  savingsVsGpt4oPercent: number;
  savingsVsMiniUsd: number;
  pagesPerOneDollarDeepSeek: number;
}

export class CostEstimator {
  /**
   * Estimates token count based on standard English/JSON character ratio (~4 chars per token)
   */
  static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 3.8);
  }

  /**
   * Calculates the exact USD cost for a given model and token counts
   */
  static calculateCost(
    modelKey: string,
    inputTokens: number,
    outputTokens: number,
    isCacheHit: boolean = false
  ): number {
    const pricing = PRICING_CATALOG[modelKey] || PRICING_CATALOG['deepseek-chat'];
    const inputRate = (isCacheHit && pricing.inputCacheHitCostPer1M !== undefined)
      ? pricing.inputCacheHitCostPer1M
      : pricing.inputCostPer1M;

    const inputCost = (inputTokens / 1_000_000) * inputRate;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;

    return parseFloat((inputCost + outputCost).toFixed(6));
  }

  /**
   * Generates a comparative cost analysis between DeepSeek and OpenAI/Claude
   */
  static compare(
    inputTokens: number,
    outputTokens: number,
    isCacheHit: boolean = false
  ): CostEstimateComparison {
    const deepseekCost = this.calculateCost('deepseek-chat', inputTokens, outputTokens, isCacheHit);
    const gpt4oCost = this.calculateCost('gpt-4o', inputTokens, outputTokens, false);
    const gptMiniCost = this.calculateCost('gpt-4o-mini', inputTokens, outputTokens, false);
    const claudeCost = this.calculateCost('claude-3-5-sonnet', inputTokens, outputTokens, false);

    const savingsVsGpt4oUsd = parseFloat(Math.max(0, gpt4oCost - deepseekCost).toFixed(6));
    const savingsVsGpt4oPercent = gpt4oCost > 0
      ? parseFloat(((savingsVsGpt4oUsd / gpt4oCost) * 100).toFixed(1))
      : 0;

    const savingsVsMiniUsd = parseFloat(Math.max(0, gptMiniCost - deepseekCost).toFixed(6));

    // Number of migrations/operations possible for $1 USD with DeepSeek
    const costPerCall = Math.max(deepseekCost, 0.00001);
    const pagesPerOneDollarDeepSeek = Math.floor(1 / costPerCall);

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      deepseekCost,
      openaiGpt4oCost: gpt4oCost,
      openaiMiniCost: gptMiniCost,
      claudeSonnetCost: claudeCost,
      savingsVsGpt4oUsd,
      savingsVsGpt4oPercent,
      savingsVsMiniUsd,
      pagesPerOneDollarDeepSeek
    };
  }

  /**
   * Returns a markdown formatted table of token costs and savings
   */
  static formatReport(comparison: CostEstimateComparison): string {
    return [
      `### 💰 Token Usage & Cost Estimation Report`,
      ``,
      `| Metric | Value |`,
      `| :--- | :--- |`,
      `| **Estimated Input Tokens** | ${comparison.inputTokens.toLocaleString()} |`,
      `| **Estimated Output Tokens** | ${comparison.outputTokens.toLocaleString()} |`,
      `| **Total Tokens** | ${comparison.totalTokens.toLocaleString()} |`,
      `| **DeepSeek Cost** | **$${comparison.deepseekCost.toFixed(6)}** |`,
      `| **OpenAI GPT-4o Cost** | $${comparison.openaiGpt4oCost.toFixed(6)} |`,
      `| **OpenAI GPT-4o-mini Cost** | $${comparison.openaiMiniCost.toFixed(6)} |`,
      `| **Anthropic Claude 3.5 Cost** | $${comparison.claudeSonnetCost.toFixed(6)} |`,
      `| **Cost Savings vs GPT-4o** | **${comparison.savingsVsGpt4oPercent}% ($${comparison.savingsVsGpt4oUsd.toFixed(6)})** |`,
      `| **Estimated Pages per $1 Credit** | **~${comparison.pagesPerOneDollarDeepSeek.toLocaleString()} pages** |`,
      ``,
      `> ⚡ *Deterministic AST conversion handles 95%+ of elements locally with $0 API cost. DeepSeek is only invoked for unsupported custom shortcodes or custom widget translation.*`
    ].join('\n');
  }
}
