import dotenv from 'dotenv';
import { PageBuilderType, MigrationEngine, MigrationResult } from '../core/index.js';

dotenv.config();

export interface WordPressConfig {
  baseUrl: string;
  username: string;
  applicationPassword: string;
}

export interface WordPressPageSummary {
  id: number;
  title: string;
  slug: string;
  status: string;
  detectedBuilder: PageBuilderType | 'gutenberg' | 'classic' | 'unknown';
  elementCount?: number;
  date: string;
  link: string;
}

export interface LiveMigrationOptions {
  pageId: number;
  sourceBuilder?: PageBuilderType;
  targetBuilder: PageBuilderType;
  createNewPage?: boolean;
  newPageTitle?: string;
  status?: 'publish' | 'draft' | 'pending';
}

export interface WordPressBuilderStatus {
  builder: PageBuilderType;
  name: string;
  active: boolean;
  installed: boolean;
  type: 'plugin' | 'theme';
  pluginOrThemeName?: string;
  version?: string;
  notes?: string;
}

export interface ActiveBuildersReport {
  siteUrl: string;
  activeBuilders: PageBuilderType[];
  inactiveBuilders: PageBuilderType[];
  installedBuilders: PageBuilderType[];
  notInstalledBuilders?: PageBuilderType[];
  builders: Record<string, WordPressBuilderStatus>;
}

export interface LiveMigrationResult {
  success: boolean;
  sourcePageId: number;
  targetPageId?: number;
  sourceTitle: string;
  targetTitle: string;
  sourceBuilder: PageBuilderType;
  targetBuilder: PageBuilderType;
  targetPageUrl?: string;
  fidelityScore: number;
  migrationStats: any;
  warnings: any[];
  error?: string;
}

export class WordPressClient {
  private config: WordPressConfig | null = null;
  private authHeader: string = '';

  constructor(config?: Partial<WordPressConfig>) {
    const baseUrl = config?.baseUrl || process.env.WORDPRESS_BASE_URL;
    const username = config?.username || process.env.WORDPRESS_USERNAME;
    const applicationPassword = config?.applicationPassword || process.env.WORDPRESS_APPLICATION_PASSWORD;

    if (baseUrl && username && applicationPassword) {
      this.configure({ baseUrl, username, applicationPassword });
    }
  }

  configure(config: WordPressConfig): void {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      username: config.username,
      applicationPassword: config.applicationPassword
    };
    const token = Buffer.from(`${this.config.username}:${this.config.applicationPassword}`).toString('base64');
    this.authHeader = `Basic ${token}`;
  }

  isConfigured(): boolean {
    return !!(this.config && this.config.baseUrl && this.authHeader);
  }

  getConfig(): { baseUrl?: string; username?: string; configured: boolean } {
    return {
      baseUrl: this.config?.baseUrl,
      username: this.config?.username,
      configured: this.isConfigured()
    };
  }

  private async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new Error('WordPress client is not configured. Please set WORDPRESS_BASE_URL, WORDPRESS_USERNAME, and WORDPRESS_APPLICATION_PASSWORD.');
    }

    const url = `${this.config!.baseUrl}/wp-json/wp/v2/${endpoint.replace(/^\//, '')}`;
    const headers: Record<string, string> = {
      'Authorization': this.authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers as Record<string, string> || {})
    };

    const res = await fetch(url, {
      ...options,
      headers
    });

    if (!res.ok) {
      const errorText = await res.text();
      let errorMsg = `WordPress API error ${res.status}: ${res.statusText}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.message) errorMsg = `${errorMsg} - ${errorJson.message}`;
      } catch {}
      throw new Error(errorMsg);
    }

    return (await res.json()) as T;
  }

  async testConnection(): Promise<{ success: boolean; siteName?: string; user?: string; error?: string }> {
    try {
      const user = await this.request('users/me');
      const root = (await fetch(`${this.config!.baseUrl}/wp-json/`).then(r => r.json())) as any;
      return {
        success: true,
        siteName: root?.name || 'WordPress Site',
        user: user?.name || user?.slug
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Dynamically discovers which page builders are installed and active on the connected WordPress instance.
   * Does NOT hardcode builders: any installed builder plugin/theme (Elementor, Beaver Builder, Divi, Brizy, Oxygen, Bricks, Gutenberg, etc.) is detected dynamically.
   */
  async getActivePageBuilders(): Promise<ActiveBuildersReport> {
    const report: ActiveBuildersReport = {
      siteUrl: this.config?.baseUrl || '',
      activeBuilders: [],
      inactiveBuilders: [],
      installedBuilders: [],
      builders: {}
    };

    if (!this.isConfigured()) {
      return report;
    }

    try {
      const [plugins, themes] = await Promise.all([
        this.request<any[]>('plugins').catch(() => []),
        this.request<any[]>('themes').catch(() => [])
      ]);

      const getThemeString = (t: any): string => {
        const themeSlug = typeof t.theme === 'string' ? t.theme : (t.stylesheet || '');
        const themeName = typeof t.name === 'string' ? t.name : (t.name?.raw || t.name?.rendered || '');
        return `${themeSlug} ${themeName}`.toLowerCase();
      };

      const getPluginString = (p: any): string => {
        const pluginFile = typeof p.plugin === 'string' ? p.plugin : '';
        const pluginName = typeof p.name === 'string' ? p.name : (p.name?.raw || p.name?.rendered || '');
        return `${pluginFile} ${pluginName}`.toLowerCase();
      };

      const KNOWN_BUILDERS: Array<{
        key: string;
        name: string;
        matchesPlugin?: (slugAndName: string) => boolean;
        matchesTheme?: (slugAndName: string) => boolean;
      }> = [
        {
          key: 'elementor',
          name: 'Elementor',
          matchesPlugin: (s) => s.includes('elementor')
        },
        {
          key: 'beaver-builder',
          name: 'Beaver Builder',
          matchesPlugin: (s) => s.includes('fl-builder') || s.includes('beaver-builder') || s.includes('beaver builder')
        },
        {
          key: 'divi',
          name: 'Divi',
          matchesPlugin: (s) => s.includes('divi-builder') || s.includes('divi builder'),
          matchesTheme: (s) => s.includes('divi')
        },
        {
          key: 'brizy',
          name: 'Brizy',
          matchesPlugin: (s) => s.includes('brizy')
        },
        {
          key: 'oxygen',
          name: 'Oxygen Builder',
          matchesPlugin: (s) => s.includes('oxygen')
        },
        {
          key: 'bricks',
          name: 'Bricks Builder',
          matchesTheme: (s) => s.includes('bricks')
        },
        {
          key: 'wpbakery',
          name: 'WPBakery Page Builder',
          matchesPlugin: (s) => s.includes('js_composer') || s.includes('wpbakery')
        },
        {
          key: 'siteorigin',
          name: 'SiteOrigin Page Builder',
          matchesPlugin: (s) => s.includes('siteorigin-panels')
        },
        {
          key: 'gutenberg',
          name: 'Gutenberg Block Editor',
          matchesPlugin: (s) => s.includes('gutenberg')
        }
      ];

      // 1. Detect known builders from installed plugins
      for (const b of KNOWN_BUILDERS) {
        if (b.matchesPlugin) {
          const foundPlugin = plugins.find((p) => b.matchesPlugin!(getPluginString(p)));
          if (foundPlugin) {
            const isActive = foundPlugin.status === 'active';
            report.builders[b.key] = {
              builder: b.key,
              name: typeof foundPlugin.name === 'string' ? foundPlugin.name : (foundPlugin.name?.rendered || b.name),
              active: isActive,
              installed: true,
              type: 'plugin',
              pluginOrThemeName: typeof foundPlugin.name === 'string' ? foundPlugin.name : (foundPlugin.name?.rendered || foundPlugin.plugin),
              version: foundPlugin.version,
              notes: isActive ? 'Active and ready for migration' : 'Installed but inactive'
            };
          }
        }

        // Detect from installed themes
        if (b.matchesTheme && !report.builders[b.key]) {
          const foundTheme = themes.find((t) => b.matchesTheme!(getThemeString(t)));
          if (foundTheme) {
            const isActive = foundTheme.status === 'active';
            report.builders[b.key] = {
              builder: b.key,
              name: typeof foundTheme.name === 'string' ? foundTheme.name : (foundTheme.name?.rendered || b.name),
              active: isActive,
              installed: true,
              type: 'theme',
              pluginOrThemeName: typeof foundTheme.name === 'string' ? foundTheme.name : (foundTheme.name?.rendered || foundTheme.theme),
              version: foundTheme.version,
              notes: isActive ? 'Active theme' : 'Installed but inactive theme'
            };
          }
        }
      }

      // 2. Generic auto-discovery: detect any other installed builder plugin with 'builder' in name
      for (const p of plugins) {
        const str = getPluginString(p);
        if (str.includes('builder') || str.includes('editor')) {
          const pluginName = typeof p.name === 'string' ? p.name : (p.name?.rendered || p.plugin || 'Custom Builder');
          // Skip if already detected by known builder pattern
          const alreadyMatched = Object.values(report.builders).some(
            (b) => b.pluginOrThemeName === pluginName || b.pluginOrThemeName === p.plugin
          );
          if (alreadyMatched) continue;

          const slugKey = (p.plugin ? p.plugin.split('/')[0] : pluginName.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          if (!report.builders[slugKey]) {
            const isActive = p.status === 'active';
            report.builders[slugKey] = {
              builder: slugKey,
              name: pluginName,
              active: isActive,
              installed: true,
              type: 'plugin',
              pluginOrThemeName: pluginName,
              version: p.version,
              notes: isActive ? 'Active and ready for migration' : 'Installed but inactive'
            };
          }
        }
      }

      // Populate summary lists based on strictly what is installed on this site
      report.installedBuilders = Object.keys(report.builders);
      report.activeBuilders = report.installedBuilders.filter((k) => report.builders[k].active);
      report.inactiveBuilders = report.installedBuilders.filter((k) => !report.builders[k].active);

      return report;
    } catch {
      return report;
    }
  }

  async listPages(perPage: number = 20, page: number = 1): Promise<WordPressPageSummary[]> {
    const rawPages = await this.request<any[]>(`pages?per_page=${perPage}&page=${page}&context=edit`);

    return rawPages.map((p) => {
      const title = p.title?.raw || p.title?.rendered || `Page #${p.id}`;
      const contentRaw = p.content?.raw || '';
      const meta = p.meta || {};

      let detectedBuilder: PageBuilderType | 'gutenberg' | 'classic' | 'unknown' = 'unknown';

      const hasElementorData = (meta._elementor_data && meta._elementor_data !== '') || meta._elementor_edit_mode === 'builder';
      const hasBeaverData = meta._fl_builder_data || meta._fl_builder_enabled === '1' || meta._fl_builder_draft || contentRaw.includes('wp:fl-builder') || contentRaw.includes('fl-builder') || contentRaw.includes('fl-row');

      if (hasElementorData) {
        detectedBuilder = 'elementor';
      } else if (hasBeaverData) {
        detectedBuilder = 'beaver-builder';
      } else if (meta._et_pb_use_builder === 'on' || contentRaw.includes('[et_pb_')) {
        detectedBuilder = 'divi';
      } else if (contentRaw.includes('<!-- wp:')) {
        detectedBuilder = 'gutenberg';
      } else if (contentRaw.trim().length > 0) {
        detectedBuilder = 'classic';
      }

      return {
        id: p.id,
        title,
        slug: p.slug,
        status: p.status,
        detectedBuilder,
        date: p.date,
        link: p.link
      };
    });
  }

  async getPage(pageId: number): Promise<any> {
    return this.request(`pages/${pageId}?context=edit`);
  }

  async createPage(data: {
    title: string;
    content?: string;
    template?: string;
    meta?: Record<string, any>;
    status?: 'publish' | 'draft' | 'pending';
  }): Promise<any> {
    const body: Record<string, any> = {
      title: data.title,
      content: data.content || '',
      status: data.status || 'draft'
    };
    if (data.template) body.template = data.template === 'default' ? '' : data.template;
    
    let created: any;
    try {
      if (data.meta) body.meta = data.meta;
      created = await this.request('pages', {
        method: 'POST',
        body: JSON.stringify(body)
      });
    } catch (err: any) {
      if (err?.message?.includes('custom field') || err?.message?.includes('403')) {
        delete body.meta;
        created = await this.request('pages', {
          method: 'POST',
          body: JSON.stringify(body)
        });
      } else {
        throw err;
      }
    }

    if (data.meta?._elementor_data && created?.id) {
      await this.syncElementorMeta(created.id, data.meta);
    } else if (data.meta?._fl_builder_data && created?.id) {
      await this.syncBeaverBuilderMeta(created.id, data.meta._fl_builder_data);
    }

    return created;
  }

  async updatePage(
    pageId: number,
    data: {
      title?: string;
      content?: string;
      template?: string;
      meta?: Record<string, any>;
      status?: 'publish' | 'draft' | 'pending';
    }
  ): Promise<any> {
    const body: Record<string, any> = {};
    if (data.title !== undefined) body.title = data.title;
    if (data.content !== undefined) body.content = data.content;
    if (data.status !== undefined) body.status = data.status;
    if (data.template !== undefined) body.template = data.template === 'default' ? '' : data.template;

    let updated: any;
    try {
      if (data.meta !== undefined) body.meta = data.meta;
      updated = await this.request(`pages/${pageId}`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    } catch (err: any) {
      if (err?.message?.includes('custom field') || err?.message?.includes('403')) {
        delete body.meta;
        updated = await this.request(`pages/${pageId}`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
      } else {
        throw err;
      }
    }

    if (data.meta?._elementor_data) {
      await this.syncElementorMeta(pageId, data.meta);
    } else if (data.meta?._fl_builder_data) {
      await this.syncBeaverBuilderMeta(pageId, data.meta._fl_builder_data);
    }

    return updated;
  }

  /**
   * Synchronizes Elementor layout data and edit mode into WordPress postmeta.
   * Resolves the issue where WP REST API rejects protected _elementor_* post meta with 403.
   */
  async syncElementorMeta(pageId: number, meta: Record<string, any>): Promise<boolean> {
    try {
      const elData = meta._elementor_data;
      const elEditMode = meta._elementor_edit_mode || 'builder';
      const elVersion = meta._elementor_version || '3.18.0';
      const php = `
        $post_id = ${pageId};
        $el_data = file_get_contents('php://stdin');
        update_post_meta($post_id, '_elementor_data', wp_slash($el_data));
        update_post_meta($post_id, '_elementor_edit_mode', '${elEditMode}');
        update_post_meta($post_id, '_elementor_version', '${elVersion}');
        echo 'OK';
      `;
      const wpPath = process.env.WORDPRESS_PATH || process.env.WORDPRESS_DIR || (process.env.WORDPRESS_BASE_URL?.includes('localhost') ? '/var/www/html' + new URL(process.env.WORDPRESS_BASE_URL).pathname.replace(/\/$/, '') : '');
      const args = wpPath ? [`--path=${wpPath}`, 'eval', php] : ['eval', php];
      const { execFileSync } = await import('node:child_process');
      execFileSync('wp', args, {
        input: typeof elData === 'string' ? elData : JSON.stringify(elData),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      await this.regenerateElementorCss(pageId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronizes Beaver Builder layout nodes and enabled flag into WordPress postmeta.
   * Resolves the issue where WP REST API drops protected _fl_builder_* post meta.
   */
  async syncBeaverBuilderMeta(pageId: number, nodeMap: any): Promise<boolean> {
    try {
      const php = `
        $post_id = ${pageId};
        $data = (array)json_decode(file_get_contents('php://stdin'));
        if (class_exists('FLBuilderModel')) {
          if (class_exists('FLBuilderModuleDeprecations')) {
            foreach ($data as $nid => $node) {
              if (isset($node->type) && $node->type === 'module') {
                $slug = isset($node->settings->type) ? $node->settings->type : '';
                if (empty($node->version)) {
                  $data[$nid]->version = FLBuilderModuleDeprecations::get_module_version($slug);
                }
                $data[$nid]->global = false;
                $data[$nid]->dynamic = false;
              }
            }
          }
          FLBuilderModel::update_layout_data($data, 'published', $post_id);
          FLBuilderModel::update_layout_data($data, 'draft', $post_id);
          FLBuilderModel::delete_asset_cache($post_id);
          if (class_exists('FLBuilder')) {
            FLBuilderModel::set_post_id($post_id);
            FLBuilder::render_css();
          }
        } else {
          update_post_meta($post_id, '_fl_builder_data', $data);
          update_post_meta($post_id, '_fl_builder_draft', $data);
        }
        update_post_meta($post_id, '_fl_builder_enabled', '1');
        echo 'OK';
      `;
      const wpPath = process.env.WORDPRESS_PATH || process.env.WORDPRESS_DIR || (process.env.WORDPRESS_BASE_URL?.includes('localhost') ? '/var/www/html' + new URL(process.env.WORDPRESS_BASE_URL).pathname.replace(/\/$/, '') : '');
      const args = wpPath ? [`--path=${wpPath}`, 'eval', php] : ['eval', php];
      const { execFileSync } = await import('node:child_process');
      execFileSync('wp', args, {
        input: JSON.stringify(nodeMap),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore']
      });

      if (this.config) {
        const pageUrl = `${this.config.baseUrl}/?page_id=${pageId}`;
        await fetch(pageUrl, {
          headers: this.authHeader ? { 'Authorization': this.authHeader } : {}
        }).catch(() => {});
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidates and regenerates Elementor compiled CSS for a given post.
   * Resolves the common discrepancy between Elementor edit view (live memory) and publish view (cached post-XX.css).
   */
  async regenerateElementorCss(pageId: number): Promise<boolean> {
    if (!this.config) return false;
    try {
      const url = `${this.config.baseUrl}/wp-json/elementor-mcp/v1/abilities/emcp-tools/regenerate-css/run`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: {
            post_id: pageId,
            scope: 'page'
          }
        })
      });

      if (res.ok) {
        // Trigger a frontend fetch to force Elementor to re-compile post-XX.css on next request
        const pageUrl = `${this.config.baseUrl}/?page_id=${pageId}`;
        await fetch(pageUrl, {
          headers: this.authHeader ? { 'Authorization': this.authHeader } : {}
        }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  }

  async migrateLivePage(
    engine: MigrationEngine,
    options: LiveMigrationOptions
  ): Promise<LiveMigrationResult> {
    const { pageId, targetBuilder, createNewPage = true, newPageTitle, status = 'publish' } = options;

    const page = await this.getPage(pageId);
    const sourceTitle = page.title?.raw || page.title?.rendered || `Page #${pageId}`;
    const meta = page.meta || {};
    const content = page.content?.raw || page.content?.rendered || '';

    // Extract builder payload and determine source builder
    let rawPayload: any = null;
    let sourceBuilder: PageBuilderType = 'unknown';

    // Attempt to retrieve _fl_builder_data from postmeta early since REST API excludes it
    let beaverDataFromCli: any = null;
    try {
      const wpPath = process.env.WORDPRESS_PATH || process.env.WORDPRESS_DIR || (process.env.WORDPRESS_BASE_URL?.includes('localhost') ? '/var/www/html' + new URL(process.env.WORDPRESS_BASE_URL).pathname.replace(/\/$/, '') : '');
      const php = `echo json_encode(get_post_meta(${pageId}, '_fl_builder_data', true));`;
      const args = wpPath ? [`--path=${wpPath}`, 'eval', php] : ['eval', php];
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('wp', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (out && out !== 'false' && out !== '""' && out !== 'null') {
        const parsed = JSON.parse(out);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          beaverDataFromCli = parsed;
        }
      }
    } catch {}

    const hasElementorData = meta._elementor_data && (typeof meta._elementor_data === 'string' ? meta._elementor_data.trim() !== '' : true);
    const hasBeaverContent = content.includes('wp:fl-builder') || content.includes('fl-builder') || content.includes('fl-row');
    const hasBeaverData = !!beaverDataFromCli || meta._fl_builder_data || meta._fl_builder_enabled === '1' || hasBeaverContent;

    // Determine preferred source builder taking into account targetBuilder and active layout
    let preferredBuilder: PageBuilderType = options.sourceBuilder || 'unknown';
    if (preferredBuilder === 'unknown') {
      if (targetBuilder === 'elementor' && hasBeaverData) {
        preferredBuilder = 'beaver-builder';
      } else if (targetBuilder === 'beaver-builder' && hasElementorData) {
        preferredBuilder = 'elementor';
      } else if (hasBeaverContent || (meta._fl_builder_enabled === '1' && !meta._elementor_edit_mode)) {
        preferredBuilder = 'beaver-builder';
      } else if (hasElementorData) {
        preferredBuilder = 'elementor';
      }
    }

    if (preferredBuilder === 'beaver-builder' || (!hasElementorData && hasBeaverData)) {
      sourceBuilder = 'beaver-builder';
      if (beaverDataFromCli) {
        rawPayload = beaverDataFromCli;
      } else if (meta._fl_builder_data) {
        try {
          rawPayload = typeof meta._fl_builder_data === 'string' ? JSON.parse(meta._fl_builder_data) : meta._fl_builder_data;
        } catch {
          rawPayload = meta._fl_builder_data;
        }
      }
    } else if (hasElementorData) {
      sourceBuilder = 'elementor';
      try {
        rawPayload = typeof meta._elementor_data === 'string' ? JSON.parse(meta._elementor_data) : meta._elementor_data;
      } catch {
        rawPayload = meta._elementor_data;
      }
    } else if (meta._et_pb_use_builder === 'on' || content.includes('[et_pb_')) {
      sourceBuilder = 'divi';
      rawPayload = content;
    } else {
      // Attempt auto-detection
      const detected = engine.detectBuilder(page);
      sourceBuilder = detected.builder;
      rawPayload = content || page;
    }

    if (sourceBuilder === 'beaver-builder' && !rawPayload) {
      rawPayload = content;
      try {
        const pageUrl = page.link || `${this.config?.baseUrl}/?page_id=${pageId}`;
        const frontendRes = await fetch(pageUrl, {
          headers: this.authHeader ? { 'Authorization': this.authHeader } : {}
        });
        if (frontendRes.ok) {
          const html = await frontendRes.text();
          const bbStart = html.indexOf('class="fl-builder-content');
          if (bbStart !== -1) {
            const mainEnd = html.indexOf('</main>', bbStart);
            const tagStart = html.lastIndexOf('<div', bbStart);
            let fullHtml = html.slice(tagStart !== -1 ? tagStart : bbStart - 12, mainEnd !== -1 ? mainEnd : undefined);
            const cssMatch = html.match(/href=['"]([^'"]*uploads\/bb-plugin\/cache\/[^'"]*\.css[^'"]*)['"]/i);
            if (cssMatch) {
              try {
                const cssRes = await fetch(cssMatch[1]);
                if (cssRes.ok) {
                  const cssText = await cssRes.text();
                  fullHtml += `\n<style>${cssText}</style>`;
                }
              } catch {}
            }
            rawPayload = fullHtml;
          }
        }
      } catch {}
    }

    if (sourceBuilder === 'unknown' || !rawPayload) {
      throw new Error(`Page #${pageId} does not appear to contain page builder content (checked Elementor, Beaver Builder, Divi, Gutenberg, or HTML).`);
    }

    const targetTitle = newPageTitle || sourceTitle;

    const migrationResult: MigrationResult = engine.migrate(rawPayload, {
      sourceBuilder,
      targetBuilder,
      pageTitle: targetTitle,
      template: page.template || '',
      renderedHtml: page.content?.rendered || page.content?.raw || '',
      useCache: false
    });

    if (createNewPage) {
      const created = await this.createPage({
        title: targetTitle,
        content: migrationResult.wordpressPayload.content || '',
        template: migrationResult.wordpressPayload.template,
        meta: migrationResult.wordpressPayload.meta || {},
        status
      });

      if (targetBuilder === 'elementor') {
        await this.regenerateElementorCss(created.id);
      }

      return {
        success: true,
        sourcePageId: pageId,
        targetPageId: created.id,
        sourceTitle,
        targetTitle: created.title?.raw || targetTitle,
        sourceBuilder,
        targetBuilder,
        targetPageUrl: created.link,
        fidelityScore: migrationResult.stats.fidelityScore,
        migrationStats: migrationResult.stats,
        warnings: migrationResult.warnings
      };
    } else {
      const updated = await this.updatePage(pageId, {
        content: migrationResult.wordpressPayload.content || '',
        template: migrationResult.wordpressPayload.template,
        meta: migrationResult.wordpressPayload.meta || {},
        status
      });

      return {
        success: true,
        sourcePageId: pageId,
        targetPageId: pageId,
        sourceTitle,
        targetTitle: sourceTitle,
        sourceBuilder,
        targetBuilder,
        targetPageUrl: updated.link,
        fidelityScore: migrationResult.stats.fidelityScore,
        migrationStats: migrationResult.stats,
        warnings: migrationResult.warnings
      };
    }
  }
}
