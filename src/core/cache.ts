import { createHash } from 'crypto';
import { MigrationResult } from './types.js';

export interface CacheMetrics {
  totalRequests: number;
  hits: number;
  misses: number;
  hitRatePercent: number;
  entriesCount: number;
  estimatedLlmCallsSaved: number;
  estimatedDollarsSaved: number; // in USD based on average LLM page migration cost
}

interface CacheEntry {
  result: MigrationResult;
  timestamp: number;
  expiresAt: number;
}

export class MigrationCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxEntries: number;
  private defaultTtlMs: number;
  private metrics = {
    totalRequests: 0,
    hits: 0,
    misses: 0,
    estimatedLlmCallsSaved: 0
  };

  // Average cost estimated per full page conversion if using an LLM ($0.015 per page ~3k tokens)
  private readonly ESTIMATED_COST_PER_PAGE_USD = 0.015;

  constructor(options: { maxEntries?: number; defaultTtlMs?: number } = {}) {
    this.maxEntries = options.maxEntries || 500;
    this.defaultTtlMs = options.defaultTtlMs || 24 * 60 * 60 * 1000; // 24 hours
  }

  generateKey(sourceBuilder: string, targetBuilder: string, payload: unknown, options?: any): string {
    const rawString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const optionsString = options ? JSON.stringify(options) : '';
    const hash = createHash('sha256')
      .update(`${sourceBuilder}::${targetBuilder}::${optionsString}::${rawString}`)
      .digest('hex');
    return `${sourceBuilder}_to_${targetBuilder}_${hash.slice(0, 16)}`;
  }

  get(key: string): MigrationResult | undefined {
    this.metrics.totalRequests++;
    const entry = this.cache.get(key);

    if (!entry) {
      this.metrics.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.metrics.misses++;
      return undefined;
    }

    this.metrics.hits++;
    this.metrics.estimatedLlmCallsSaved++;
    return {
      ...entry.result,
      cached: true,
      cacheKey: key
    };
  }

  set(key: string, result: MigrationResult, ttlMs?: number): void {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const expiresAt = Date.now() + (ttlMs || this.defaultTtlMs);
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      expiresAt
    });
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  getMetrics(): CacheMetrics {
    const total = this.metrics.totalRequests;
    const hitRate = total > 0 ? (this.metrics.hits / total) * 100 : 0;
    return {
      totalRequests: total,
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      hitRatePercent: parseFloat(hitRate.toFixed(2)),
      entriesCount: this.cache.size,
      estimatedLlmCallsSaved: this.metrics.estimatedLlmCallsSaved,
      estimatedDollarsSaved: parseFloat((this.metrics.estimatedLlmCallsSaved * this.ESTIMATED_COST_PER_PAGE_USD).toFixed(4))
    };
  }
}

export const globalMigrationCache = new MigrationCache();
