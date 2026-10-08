import { CostEstimator, CostEstimateComparison } from './cost-estimator.js';
import { PageBuilderType } from '../core/types.js';
import crypto from 'node:crypto';

export interface LiteLLMConfig {
  baseUrl?: string; // e.g. http://localhost:4000 or custom LiteLLM proxy
  apiKey?: string;  // DeepSeek or LiteLLM key
  model?: string;   // deepseek-chat, deepseek-coder, etc.
  timeoutMs?: number;
}

export interface AIWidgetConversionRequest {
  sourceBuilder: PageBuilderType;
  targetBuilder: PageBuilderType;
  rawWidgetData: any;
  widgetName: string;
  contextHtml?: string;
}

export interface AIWidgetConversionResponse {
  success: boolean;
  targetBuilder: PageBuilderType;
  convertedModule: any;
  explanation: string;
  tokensUsed: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  costEstimate: CostEstimateComparison;
  cached: boolean;
}

export class LiteLLMClient {
  private litellmBaseUrl: string;
  private deepseekBaseUrl: string = 'https://api.deepseek.com/v1';
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  private memoryCache: Map<string, { response: any; timestamp: number }> = new Map();

  constructor(config?: Partial<LiteLLMConfig>) {
    this.litellmBaseUrl = config?.baseUrl || process.env.LITELLM_BASE_URL || 'http://localhost:4000';
    this.apiKey = config?.apiKey || process.env.DEEPSEEK_API_KEY || process.env.LITELLM_API_KEY || '';
    this.model = config?.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.timeoutMs = config?.timeoutMs || 15000;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Probes the local LiteLLM proxy server (http://localhost:4000/health)
   */
  async checkLocalLiteLLM(): Promise<{
    running: boolean;
    url: string;
    statusText: string;
    availableModels: string[];
    recommendation: string;
  }> {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(`${this.litellmBaseUrl.replace(/\/$/, '')}/health`, {
        signal: controller.signal
      });
      clearTimeout(id);

      if (res.ok) {
        // Try getting model list
        let models: string[] = [];
        try {
          const mRes = await fetch(`${this.litellmBaseUrl.replace(/\/$/, '')}/models`);
          if (mRes.ok) {
            const data = (await mRes.json()) as any;
            models = (data.data || []).map((m: any) => m.id);
          }
        } catch {}

        return {
          running: true,
          url: this.litellmBaseUrl,
          statusText: 'LiteLLM proxy is running locally and healthy.',
          availableModels: models,
          recommendation: 'Local LiteLLM proxy detected. Requests will route via LiteLLM.'
        };
      }
    } catch {}

    return {
      running: false,
      url: this.litellmBaseUrl,
      statusText: 'No local LiteLLM proxy listening on ' + this.litellmBaseUrl,
      availableModels: [],
      recommendation: this.apiKey
        ? 'Direct DeepSeek API (https://api.deepseek.com/v1) is available and will be used as primary endpoint.'
        : 'To use local LiteLLM proxy, run: "litellm --model deepseek/deepseek-chat --port 4000". Or provide a DEEPSEEK_API_KEY for direct cloud connection.'
    };
  }

  /**
   * Generates a deterministic SHA-256 cache key for AI prompts
   */
  private generatePromptHash(prompt: string, model: string): string {
    return crypto.createHash('sha256').update(`${model}:${prompt}`).digest('hex');
  }

  /**
   * Executes a chat completion via LiteLLM or direct DeepSeek API
   */
  async complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      model?: string;
    }
  ): Promise<{
    content: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    cached: boolean;
  }> {
    const activeModel = options?.model || this.model;
    const promptString = JSON.stringify(messages);
    const cacheKey = this.generatePromptHash(promptString, activeModel);

    // Check memory cache
    const cached = this.memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 86400000) {
      return {
        content: cached.response.content,
        model: activeModel,
        usage: cached.response.usage,
        cached: true
      };
    }

    // Determine target URL: Check if LiteLLM is reachable, otherwise direct DeepSeek
    let targetBaseUrl = this.deepseekBaseUrl;
    const litellmCheck = await this.checkLocalLiteLLM();
    if (litellmCheck.running) {
      targetBaseUrl = this.litellmBaseUrl;
    }

    if (!this.apiKey && !litellmCheck.running) {
      throw new Error(
        'DeepSeek API key is not configured and local LiteLLM proxy is offline. ' +
        'Please set DEEPSEEK_API_KEY in .env or start LiteLLM on port 4000.'
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const endpoint = `${targetBaseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey || 'sk-local-litellm'}`
      },
      body: JSON.stringify({
        model: activeModel,
        messages,
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens ?? 2000
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API returned status ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as any;
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {
      prompt_tokens: CostEstimator.estimateTokens(promptString),
      completion_tokens: CostEstimator.estimateTokens(content),
      total_tokens: CostEstimator.estimateTokens(promptString) + CostEstimator.estimateTokens(content)
    };

    const result = {
      content,
      model: data.model || activeModel,
      usage,
      cached: false
    };

    // Save in cache
    this.memoryCache.set(cacheKey, { response: result, timestamp: Date.now() });

    return result;
  }

  /**
   * AI-assisted translation for complex, proprietary or unmapped page builder widgets
   */
  async convertCustomWidget(request: AIWidgetConversionRequest): Promise<AIWidgetConversionResponse> {
    const { sourceBuilder, targetBuilder, widgetName, rawWidgetData, contextHtml } = request;

    const systemPrompt = `You are an expert WordPress Page Builder conversion engine specializing in Elementor, Divi, and Beaver Builder.
Your task is to convert an unmapped custom widget or shortcode from ${sourceBuilder} into valid, high-fidelity ${targetBuilder} format.
Rules:
1. Preserve all text, links, image URLs, colors, and layout intent.
2. Return ONLY a JSON object with two fields:
   - "convertedModule": The exact target data representation (e.g. Divi shortcode string, or Beaver Builder node object, or Elementor widget JSON).
   - "explanation": Brief explanation of how styles and structure were mapped.
3. Output no surrounding markdown or explanation outside the JSON.`;

    const userPrompt = `Source Builder: ${sourceBuilder}
Target Builder: ${targetBuilder}
Widget / Module Name: ${widgetName}
Raw Widget Data:
${JSON.stringify(rawWidgetData, null, 2)}
${contextHtml ? `Context HTML:\n${contextHtml}` : ''}

Convert this widget into ${targetBuilder} format.`;

    const response = await this.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      { temperature: 0.1 }
    );

    let parsed: any;
    try {
      const cleanJson = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      parsed = {
        convertedModule: response.content,
        explanation: 'Converted as raw markup.'
      };
    }

    const costEstimate = CostEstimator.compare(
      response.usage.prompt_tokens,
      response.usage.completion_tokens,
      response.cached
    );

    return {
      success: true,
      targetBuilder,
      convertedModule: parsed.convertedModule,
      explanation: parsed.explanation || 'Widget translated by AI',
      tokensUsed: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      },
      costEstimate,
      cached: response.cached
    };
  }
}

export const globalLiteLLMClient = new LiteLLMClient();
