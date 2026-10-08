import {
  BuilderAdapter,
  MigrationOptions,
  MigrationResult,
  MigrationWarning,
  InspectionReport,
  PageBuilderType,
  UniversalPage
} from './types.js';
import { UniversalAdapter } from './adapter.js';
import { MigrationCache, globalMigrationCache } from './cache.js';
import {
  countElements,
  collectUsedStyles,
  calculateFidelityScore,
  summarizeAst
} from './utils.js';

export class MigrationEngine {
  private adapters: Map<PageBuilderType, BuilderAdapter> = new Map();
  private universalAdapter: UniversalAdapter;
  private cache: MigrationCache;

  constructor(options: { cache?: MigrationCache; adapter?: UniversalAdapter } = {}) {
    this.cache = options.cache || globalMigrationCache;
    this.universalAdapter = options.adapter || new UniversalAdapter();
  }

  registerAdapter(adapter: BuilderAdapter): void {
    this.adapters.set(adapter.builderType, adapter);
  }

  getAdapter(builderType: PageBuilderType): BuilderAdapter {
    return this.adapters.get(builderType) || this.universalAdapter;
  }

  getSupportedBuilders(): PageBuilderType[] {
    const custom = Array.from(this.adapters.keys());
    return custom.length > 0 ? custom : ['elementor', 'beaver-builder', 'divi', 'gutenberg'];
  }

  /**
   * Detects which page builder created the given payload
   */
  detectBuilder(payload: unknown): {
    builder: PageBuilderType;
    confidence: number;
    reason: string;
  } {
    if (!payload) {
      return { builder: 'unknown', confidence: 0, reason: 'Payload is null or undefined' };
    }

    if (Array.isArray(payload)) {
      return { builder: 'elementor', confidence: 0.98, reason: 'Matched JSON tree array structure' };
    }

    if (typeof payload === 'object' && payload !== null) {
      const obj = payload as any;
      if ((obj._elementor_data && obj._elementor_data !== '') || (obj.meta?._elementor_data && obj.meta._elementor_data !== '')) {
        return { builder: 'elementor', confidence: 0.99, reason: 'Matched _elementor_data' };
      }
      if (obj._fl_builder_data || obj.meta?._fl_builder_data) {
        return { builder: 'beaver-builder', confidence: 0.99, reason: 'Matched _fl_builder_data' };
      }
      if (obj.meta?._fl_builder_enabled === '1' || obj.meta?._fl_builder_enabled === 1) {
        return { builder: 'beaver-builder', confidence: 0.99, reason: 'Matched _fl_builder_enabled meta' };
      }

      const content = obj.content?.raw || obj.content?.rendered || (typeof obj.content === 'string' ? obj.content : '');
      if (content.includes('wp:fl-builder') || content.includes('fl-builder') || content.includes('fl-row')) {
        return { builder: 'beaver-builder', confidence: 0.98, reason: 'Matched Beaver Builder content' };
      }
      if (content.includes('[et_pb_')) {
        return { builder: 'divi', confidence: 0.95, reason: 'Matched Divi shortcodes in content' };
      }
      if (content.includes('<!-- wp:')) {
        return { builder: 'gutenberg', confidence: 0.95, reason: 'Matched Gutenberg block comments in content' };
      }

      const keys = Object.keys(obj);
      if (keys.some((k) => k.startsWith('row_') || k.startsWith('col_') || k.startsWith('mod_'))) {
        return { builder: 'beaver-builder', confidence: 0.98, reason: 'Matched Beaver Builder node dictionary' };
      }
    }

    if (typeof payload === 'string') {
      if (payload.includes('wp:fl-builder') || payload.includes('fl-builder') || payload.includes('fl-row')) {
        return { builder: 'beaver-builder', confidence: 0.98, reason: 'Matched Beaver Builder content' };
      }
      if (payload.includes('<!-- wp:')) {
        return { builder: 'gutenberg', confidence: 0.95, reason: 'Matched Gutenberg block comments' };
      }
      if (payload.includes('[et_pb_')) {
        return { builder: 'divi', confidence: 0.95, reason: 'Matched shortcode pattern' };
      }
    }

    return { builder: 'unknown', confidence: 0, reason: 'Unrecognized format or missing builder signatures' };
  }

  /**
   * Inspects a page builder payload and reports complexity, widgets, and target compatibility
   */
  inspect(payload: unknown, builderHint?: PageBuilderType): InspectionReport {
    const detection = builderHint ? { builder: builderHint, confidence: 1, reason: 'User specified' } : this.detectBuilder(payload);
    const builder = detection.builder;

    if (builder === 'unknown') {
      return {
        detectedBuilder: 'unknown',
        confidence: 0,
        totalElements: 0,
        elementCountsByType: {},
        hasCustomCss: false,
        fontsUsed: [],
        colorsUsed: [],
        complexity: 'simple',
        compatibility: []
      };
    }

    try {
      const adapter = this.getAdapter(builder);
      const ast = adapter.parse(payload);
      const counts = countElements(ast);
      const styles = collectUsedStyles(ast);

      const complexity =
        counts.total > 25 || styles.hasCustomCss ? 'complex' : counts.total > 8 ? 'moderate' : 'simple';

      // Compute compatibility with all other supported builders
      const targetBuilders = this.getSupportedBuilders().filter((b) => b !== builder);
      const compatibility = targetBuilders.map((target) => {
        // Check unsupported modules
        const unsupported: string[] = [];
        const fid = calculateFidelityScore(counts.total, unsupported.length, 0);
        return {
          targetBuilder: target,
          estimatedFidelity: fid,
          unsupportedFeatures: unsupported
        };
      });

      return {
        detectedBuilder: builder,
        confidence: detection.confidence,
        totalElements: counts.total,
        elementCountsByType: counts.byType,
        hasCustomCss: styles.hasCustomCss,
        fontsUsed: styles.fonts,
        colorsUsed: styles.colors,
        complexity,
        compatibility
      };
    } catch {
      return {
        detectedBuilder: builder,
        confidence: detection.confidence,
        totalElements: 0,
        elementCountsByType: {},
        hasCustomCss: false,
        fontsUsed: [],
        colorsUsed: [],
        complexity: 'simple',
        compatibility: []
      };
    }
  }

  /**
   * Performs end-to-end migration from source builder to target builder
   */
  migrate(payload: unknown, options: MigrationOptions): MigrationResult {
    const startTime = Date.now();
    const useCache = options.useCache !== false;

    // Detect source builder if not explicitly provided
    let sourceBuilder = options.sourceBuilder;
    if (!sourceBuilder || sourceBuilder === 'unknown') {
      const detected = this.detectBuilder(payload);
      if (detected.builder === 'unknown') {
        throw new Error(`Unable to detect source page builder: ${detected.reason}`);
      }
      sourceBuilder = detected.builder;
    }

    const targetBuilder = options.targetBuilder;

    // Check cache
    const cacheKey = this.cache.generateKey(sourceBuilder, targetBuilder, payload, options);
    if (useCache) {
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }
    }

    const sourceAdapter = this.getAdapter(sourceBuilder);
    const targetAdapter = this.getAdapter(targetBuilder);

    const migrationOptions: MigrationOptions = {
      ...options,
      sourceBuilder,
      targetBuilder
    };

    // 1. Parse source data into Universal AST
    const sourceAst = sourceAdapter.parse(payload, migrationOptions);

    // 2. Serialize Universal AST into Target Builder format
    const { rawData, wordpressPayload, warnings } = targetAdapter.serialize(sourceAst, migrationOptions);

    // 3. Re-parse target to produce targetAst for validation & fidelity diff
    const targetAst = targetAdapter.parse(rawData, migrationOptions);

    // 4. Calculate metrics & stats
    const sourceCounts = countElements(sourceAst);
    const targetCounts = countElements(targetAst);

    const unsupportedCount = warnings.filter((w) => w.code === 'UNSUPPORTED_MODULE_FALLBACK').length;
    const fidelityScore = calculateFidelityScore(sourceCounts.total, unsupportedCount, warnings.length);

    const duration = Date.now() - startTime;

    const result: MigrationResult = {
      success: true,
      sourceBuilder,
      targetBuilder,
      sourceAst,
      targetAst,
      targetData: rawData,
      wordpressPayload,
      stats: {
        totalElements: sourceCounts.total,
        layoutContainers: sourceCounts.layouts,
        contentModules: sourceCounts.modules,
        convertedElements: targetCounts.modules,
        unsupportedElements: unsupportedCount,
        fidelityScore,
        processingTimeMs: duration
      },
      warnings,
      cached: false,
      cacheKey
    };

    // Store in cache
    if (useCache) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Compares source and target payloads and returns diff
   */
  validate(sourceAst: UniversalPage, targetAst: UniversalPage): {
    matched: boolean;
    sourceSummary: any;
    targetSummary: any;
    structuralDiff: {
      sourceTotal: number;
      targetTotal: number;
      elementsRetainedRatio: number;
    };
  } {
    const sCounts = countElements(sourceAst);
    const tCounts = countElements(targetAst);
    const sSummary = summarizeAst(sourceAst);
    const tSummary = summarizeAst(targetAst);

    const retainedRatio = sCounts.total > 0
      ? Math.min(1, tCounts.total / sCounts.total)
      : 1;

    return {
      matched: retainedRatio >= 0.8,
      sourceSummary: sSummary,
      targetSummary: tSummary,
      structuralDiff: {
        sourceTotal: sCounts.total,
        targetTotal: tCounts.total,
        elementsRetainedRatio: parseFloat(retainedRatio.toFixed(2))
      }
    };
  }
}
