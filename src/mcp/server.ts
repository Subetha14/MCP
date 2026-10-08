import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import { MigrationEngine, PageBuilderType, globalMigrationCache } from '../core/index.js';
import { WordPressClient } from '../wordpress/client.js';
import { globalLiteLLMClient } from '../ai/litellm.js';
import { CostEstimator } from '../ai/cost-estimator.js';

dotenv.config();

export function createPageBuilderMcpServer(
  engine?: MigrationEngine,
  wordPressClient?: WordPressClient,
  initialActiveBuilders?: PageBuilderType[]
): McpServer {
  const migrationEngine = engine || new MigrationEngine();
  const wpClient = wordPressClient || new WordPressClient();

  // Dynamically configure targetBuilder schema strictly from active page builders on this WordPress site.
  // Inactive or uninstalled page builders must NEVER be shown in target builders!
  const activeBuildersList: [string, ...string[]] = (initialActiveBuilders && initialActiveBuilders.length > 0)
    ? [initialActiveBuilders[0], ...initialActiveBuilders.slice(1)] as [string, ...string[]]
    : ['elementor', 'beaver-builder'];

  const targetBuilderSchema = z
    .enum(activeBuildersList)
    .describe('The target page builder to convert into (strictly only active page builders on this WordPress site)');

  const server = new McpServer({
    name: 'wordpress-page-builder-migrator',
    version: '1.0.0'
  });

  // -------------------------------------------------------------------------
  // TOOL: get_supported_builders
  // -------------------------------------------------------------------------
  server.tool(
    'get_supported_builders',
    'Returns supported WordPress page builders for the connected site, showing only installed builders (both active and inactive) and excluding uninstalled builders',
    {
      includeAllEngineBuilders: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true and WordPress is not connected, returns all theoretically supported builders')
    },
    async ({ includeAllEngineBuilders }) => {
      let activeReport: any = null;
      if (wpClient.isConfigured()) {
        try {
          activeReport = await wpClient.getActivePageBuilders();
        } catch {}
      }

      const installedOnSite = activeReport?.installedBuilders || [];
      const activeOnSite = activeReport?.activeBuilders || [];
      const inactiveOnSite = activeReport?.inactiveBuilders || []; // Only installed but inactive!

      // Only active builders are permitted as target builders!
      const targetBuilders =
        activeOnSite.length > 0
          ? activeOnSite
          : (wpClient.isConfigured() ? [] : migrationEngine.getSupportedBuilders());
      const supportedBuilders = targetBuilders;

      // Filter builderDetails to strictly include ONLY builders that are installed on WordPress
      const installedBuilderDetails: Record<string, any> = {};
      if (activeReport?.builders) {
        for (const [key, val] of Object.entries(activeReport.builders as Record<string, any>)) {
          if (val.installed) {
            installedBuilderDetails[key] = {
              builder: val.builder,
              name: val.name,
              active: val.active,
              installed: val.installed,
              status: val.active ? 'active' : 'inactive',
              type: val.type,
              notes: val.notes,
              pluginOrThemeName: val.pluginOrThemeName,
              version: val.version
            };
          }
        }
      }

      const KNOWN_STORAGE_FORMATS: Record<string, any> = {
        elementor: {
          location: 'postmeta',
          key: '_elementor_data',
          format: 'JSON array of sections, columns, and widgets'
        },
        'beaver-builder': {
          location: 'postmeta and post_content',
          metaKey: '_fl_builder_data',
          format: 'JSON map/dictionary of row, column-group, column, and module nodes',
          contentFormat: 'Rendered HTML fallback in post_content'
        },
        divi: {
          location: 'post_content and postmeta',
          contentFormat: 'Nested WordPress shortcodes ([et_pb_section][et_pb_row][et_pb_column]...)',
          metaKey: '_et_pb_use_builder = on'
        },
        gutenberg: {
          location: 'post_content',
          format: 'HTML with Gutenberg block comments <!-- wp:... -->'
        },
        brizy: {
          location: 'postmeta and post_content',
          key: 'brizy_post_uid',
          format: 'Brizy JSON project structure and compiled HTML'
        },
        oxygen: {
          location: 'postmeta',
          key: 'ct_builder_json',
          format: 'Oxygen JSON tree'
        },
        bricks: {
          location: 'postmeta',
          key: '_bricks_page_content_2',
          format: 'Bricks JSON element structure'
        }
      };

      // Only include storage formats for builders that are installed on this site
      const storageFormats: Record<string, any> = {};
      for (const b of supportedBuilders) {
        if (KNOWN_STORAGE_FORMATS[b]) {
          storageFormats[b] = {
            ...KNOWN_STORAGE_FORMATS[b],
            status: activeOnSite.includes(b) ? 'active' : 'inactive'
          };
        } else {
          storageFormats[b] = {
            location: 'post_content and postmeta',
            format: 'Standard WordPress post content and custom meta',
            status: activeOnSite.includes(b) ? 'active' : 'inactive'
          };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                targetBuilders,
                supportedBuilders,
                activeBuilders: activeOnSite,
                inactiveBuilders: inactiveOnSite,
                installedBuilders: installedOnSite,
                connectedWordPressSite: wpClient.getConfig().baseUrl || 'Not configured',
                builderDetails: installedBuilderDetails,
                supportedLayoutNodes: ['section', 'row', 'column', 'container'],
                supportedWidgets: [
                  'heading',
                  'text',
                  'image',
                  'button',
                  'video',
                  'divider',
                  'spacer',
                  'icon',
                  'icon-box (blurb/callout)',
                  'accordion',
                  'counter',
                  'raw-html'
                ],
                storageFormats
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_cache_stats
  // -------------------------------------------------------------------------
  server.tool(
    'get_cache_stats',
    'Returns migration cache performance metrics, hit rate, and estimated LLM / API dollar savings',
    {},
    async () => {
      const metrics = globalMigrationCache.getMetrics();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, cacheMetrics: metrics }, null, 2)
          }
        ]
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: clear_cache
  // -------------------------------------------------------------------------
  server.tool(
    'clear_cache',
    'Clears all cached page builder migrations',
    {},
    async () => {
      globalMigrationCache.clear();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'Migration cache cleared successfully.' }, null, 2)
          }
        ]
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: configure_wordpress
  // -------------------------------------------------------------------------
  server.tool(
    'configure_wordpress',
    'Configures WordPress REST API credentials (base URL, username, application password) and verifies connection',
    {
      baseUrl: z.string().describe('WordPress site URL (e.g. http://localhost/wordpress)'),
      username: z.string().describe('WordPress username with administrator/editor privileges'),
      applicationPassword: z.string().describe('WordPress application password')
    },
    async ({ baseUrl, username, applicationPassword }) => {
      wpClient.configure({ baseUrl, username, applicationPassword });
      const test = await wpClient.testConnection();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: test.success,
                message: test.success
                  ? `Successfully connected to WordPress site '${test.siteName}' as user '${test.user}'.`
                  : `Failed to connect to WordPress: ${test.error}`,
                siteName: test.siteName,
                user: test.user,
                error: test.error
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: list_wordpress_pages
  // -------------------------------------------------------------------------
  server.tool(
    'list_wordpress_pages',
    'Lists WordPress pages and identifies which page builder is active on each page (Elementor, Divi, Beaver Builder, Gutenberg, or Classic)',
    {
      perPage: z.number().optional().default(20).describe('Number of pages to retrieve (default: 20)'),
      page: z.number().optional().default(1).describe('Page number for pagination (default: 1)')
    },
    async ({ perPage, page }) => {
      try {
        const pages = await wpClient.listPages(perPage, page);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, count: pages.length, pages }, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }]
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: migrate_wordpress_page
  // -------------------------------------------------------------------------
  server.tool(
    'migrate_wordpress_page',
    'One-click WordPress page builder migration directly on a WordPress site. Reads page metadata, converts to target builder, and creates/updates the WordPress page.',
    {
      pageId: z.number().describe('WordPress page ID to migrate'),
      targetBuilder: targetBuilderSchema.describe('Target page builder installed on WordPress'),
      createNewPage: z.boolean().optional().default(true).describe('If true, creates a new migrated page clone. If false, updates the existing page in-place.'),
      newPageTitle: z.string().optional().describe('Optional custom title for the migrated page'),
      status: z.enum(['publish', 'draft', 'pending']).optional().default('publish').describe('Post status for the migrated page'),
      dryRun: z.boolean().optional().default(false).describe('If true, simulates the migration and returns preview stats without modifying the WordPress database')
    },
    async ({ pageId, targetBuilder, createNewPage, newPageTitle, status, dryRun }) => {
      try {
        if (dryRun) {
          const page = await wpClient.getPage(pageId);
          const meta = page.meta || {};
          const content = page.content?.raw || page.content?.rendered || '';

          let payload: any = meta._elementor_data || meta._fl_builder_data || content;
          try {
            if (typeof payload === 'string' && (payload.startsWith('{') || payload.startsWith('['))) {
              payload = JSON.parse(payload);
            }
          } catch {}

          const result = migrationEngine.migrate(payload, {
            targetBuilder: targetBuilder as PageBuilderType,
            pageTitle: newPageTitle || page.title?.raw || page.title?.rendered,
            useCache: true
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    dryRun: true,
                    pageId,
                    sourceTitle: page.title?.raw,
                    sourceBuilder: result.sourceBuilder,
                    targetBuilder: result.targetBuilder,
                    fidelityScore: result.stats.fidelityScore,
                    stats: result.stats,
                    warnings: result.warnings
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        const result = await wpClient.migrateLivePage(migrationEngine, {
          pageId,
          targetBuilder: targetBuilder as PageBuilderType,
          createNewPage,
          newPageTitle,
          status
        });

        const activeReport = await wpClient.getActivePageBuilders().catch(() => null);
        if (activeReport && !activeReport.activeBuilders.includes(targetBuilder as PageBuilderType)) {
          result.warnings = result.warnings || [];
          result.warnings.push({
            code: 'TARGET_BUILDER_NOT_ACTIVE_ON_WP',
            message: `Target builder '${targetBuilder}' is not currently active on this WordPress site (${activeReport.siteUrl}). Active builders on site: ${activeReport.activeBuilders.join(', ')}. The page was generated successfully, but '${targetBuilder}' must be active in WordPress to edit/render in its native editor.`
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }, null, 2) }]
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: check_litellm_status
  // -------------------------------------------------------------------------
  server.tool(
    'check_litellm_status',
    'Checks the status of the local LiteLLM proxy (http://localhost:4000) and DeepSeek API connectivity',
    {},
    async () => {
      const status = await globalLiteLLMClient.checkLocalLiteLLM();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, litellm: status }, null, 2)
          }
        ]
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: get_cost_estimation
  // -------------------------------------------------------------------------
  server.tool(
    'get_cost_estimation',
    'Calculates API token costs, credit estimations, and dollar savings comparing DeepSeek vs OpenAI / Anthropic',
    {
      promptTokens: z.number().optional().describe('Number of prompt/input tokens (optional if sampleText provided)'),
      completionTokens: z.number().optional().describe('Number of completion/output tokens'),
      sampleText: z.string().optional().describe('Sample text or JSON payload to estimate tokens from'),
      isCacheHit: z.boolean().optional().default(false).describe('Whether prompt cache hit is factored in')
    },
    async ({ promptTokens, completionTokens, sampleText, isCacheHit }) => {
      let inputTokens = promptTokens ?? 0;
      let outputTokens = completionTokens ?? 0;

      if (sampleText) {
        const estimated = CostEstimator.estimateTokens(sampleText);
        if (!inputTokens) inputTokens = estimated;
        if (!outputTokens) outputTokens = Math.ceil(estimated * 0.75);
      }

      if (inputTokens === 0 && outputTokens === 0) {
        inputTokens = 1500;
        outputTokens = 800;
      }

      const comparison = CostEstimator.compare(inputTokens, outputTokens, isCacheHit);
      const markdown = CostEstimator.formatReport(comparison);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, metrics: comparison, reportMarkdown: markdown }, null, 2)
          }
        ]
      };
    }
  );

  // -------------------------------------------------------------------------
  // TOOL: ai_convert_custom_widget
  // -------------------------------------------------------------------------
  server.tool(
    'ai_convert_custom_widget',
    'Translates an unmapped, proprietary, or complex third-party page builder widget into the target builder using DeepSeek / LiteLLM',
    {
      sourceBuilder: z.string().describe('Source builder name'),
      targetBuilder: targetBuilderSchema.describe('Target page builder installed on WordPress'),
      widgetName: z.string().describe('Widget or shortcode name (e.g. rev_slider, jet_engine_listing, etc.)'),
      rawWidgetData: z.string().describe('JSON string of the widget settings or raw shortcode string'),
      contextHtml: z.string().optional().describe('Optional rendered HTML context of the widget')
    },
    async ({ sourceBuilder, targetBuilder, widgetName, rawWidgetData, contextHtml }) => {
      let parsedData: any = rawWidgetData;
      try {
        parsedData = JSON.parse(rawWidgetData);
      } catch {}

      try {
        const result = await globalLiteLLMClient.convertCustomWidget({
          sourceBuilder,
          targetBuilder: targetBuilder as PageBuilderType,
          widgetName,
          rawWidgetData: parsedData,
          contextHtml
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, error: err.message }, null, 2)
            }
          ]
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // RESOURCES: Schemas and Mapping Tables
  // -------------------------------------------------------------------------
  server.resource(
    'builder-mapping-matrix',
    'builder://mappings',
    async () => {
      return {
        contents: [
          {
            uri: 'builder://mappings',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                mappings: [
                  { universal: 'heading', elementor: 'heading', divi: 'et_pb_text (heading)', beaver: 'heading' },
                  { universal: 'text', elementor: 'text-editor', divi: 'et_pb_text', beaver: 'rich-text' },
                  { universal: 'image', elementor: 'image', divi: 'et_pb_image', beaver: 'photo' },
                  { universal: 'button', elementor: 'button', divi: 'et_pb_button', beaver: 'button' },
                  { universal: 'video', elementor: 'video', divi: 'et_pb_video', beaver: 'video' },
                  { universal: 'divider', elementor: 'divider', divi: 'et_pb_divider', beaver: 'separator' },
                  { universal: 'spacer', elementor: 'spacer', divi: 'et_pb_divider (transparent)', beaver: 'separator' },
                  { universal: 'icon-box', elementor: 'icon-box', divi: 'et_pb_blurb', beaver: 'callout' },
                  { universal: 'accordion', elementor: 'accordion', divi: 'et_pb_accordion', beaver: 'accordion' },
                  { universal: 'counter', elementor: 'counter', divi: 'et_pb_number_counter', beaver: 'numbers' },
                  { universal: 'raw-html', elementor: 'html', divi: 'et_pb_code', beaver: 'html' }
                ]
              },
              null,
              2
            )
          }
        ]
      };
    }
  );


  // -------------------------------------------------------------------------
  // PROMPT TEMPLATES: Explanations and Custom Widgets for LLMs
  // -------------------------------------------------------------------------
  server.prompt(
    'explain_migration_diff',
    'Provides an explanation prompt to help users understand migration changes and fine-tune styling',
    {
      sourceBuilder: z.string().describe('Source page builder'),
      targetBuilder: z.string().describe('Target page builder'),
      migrationSummary: z.string().describe('JSON summary or warnings of the migration')
    },
    async ({ sourceBuilder, targetBuilder, migrationSummary }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `I just migrated a page from ${sourceBuilder} to ${targetBuilder}.
Here is the migration summary and warnings:
${migrationSummary}

Please review the differences, highlight any styling nuances (e.g. padding/margin units, custom fonts, buttons) between ${sourceBuilder} and ${targetBuilder}, and provide actionable advice on manual touch-ups.`
            }
          }
        ]
      };
    }
  );

  return server;
}

export async function runStdioServer() {
  const wpClient = new WordPressClient();
  let activeBuilders: PageBuilderType[] | undefined;
  if (wpClient.isConfigured()) {
    try {
      const report = await wpClient.getActivePageBuilders();
      if (report?.activeBuilders && report.activeBuilders.length > 0) {
        activeBuilders = report.activeBuilders;
      }
    } catch {}
  }
  const server = createPageBuilderMcpServer(undefined, wpClient, activeBuilders);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr to keep stdout clean for stdio JSON-RPC protocol
  console.error('WordPress Page Builder Migration MCP Server running on stdio');
}
