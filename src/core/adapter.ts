import {
  BuilderAdapter,
  MigrationOptions,
  MigrationWarning,
  WordPressPayload,
  UniversalPage,
  UniversalNode,
  UniversalNodeType,
  UniversalStyles,
  PageBuilderType
} from './types.js';
import {
  createDefaultPage,
  createNode,
  generateShortId,
  normalizeColor,
  isDarkColor,
  parseElementorSpacing,
  formatElementorSpacing,
  parseDimension,
  parseInlineCss,
  formatCssSpacing,
  formatCssRadius,
  formatCssBorder,
  formatDiviSpacing,
  parseDiviSpacing,
  parseShortcodeAttributes,
  parseDiviColumnSpan,
  formatDiviColumnType,
  formatDiviRowColumns
} from './utils.js';

/**
 * Universal Page Builder Adapter
 * 
 * Replaces hardcoded per-builder folders with a unified migration engine.
 * Dynamically parses and serializes ANY WordPress page builder (Elementor, Beaver Builder,
 * Gutenberg, Divi, Brizy, Oxygen, Bricks, or any custom builder) via Universal AST.
 */
export class UniversalAdapter implements BuilderAdapter {
  builderType: PageBuilderType = 'universal';

  canHandle(payload: unknown): boolean {
    if (!payload) return false;
    if (typeof payload === 'object') return true;
    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
        try {
          JSON.parse(trimmed);
          return true;
        } catch {
          return false;
        }
      }
      return trimmed.includes('<!-- wp:') || trimmed.includes('[et_pb_') || trimmed.includes('fl-builder');
    }
    return false;
  }

  /**
   * Universal Parser: Automatically detects the format (JSON tree, blocks, shortcodes, or raw HTML)
   * and normalizes it into a UniversalPage AST.
   */
  parse(payload: unknown, options?: Partial<MigrationOptions>): UniversalPage {
    const pageTitle = options?.pageTitle || 'Migrated Page';
    const detectedBuilder = options?.sourceBuilder || this.detectFormat(payload);
    const page = createDefaultPage(pageTitle, detectedBuilder);

    this.fallbackImages = [];
    this.fallbackVideos = [];
    this.fallbackAudios = [];
    const contextHtml = (options as any)?.renderedHtml || (typeof payload === 'object' && payload !== null ? ((payload as any).content?.rendered || (payload as any).content?.raw || '') : (typeof payload === 'string' && payload.includes('<') ? payload : ''));
    this.contextHtml = contextHtml;
    if (contextHtml) {
      const imgMatches = [...contextHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
      this.fallbackImages = imgMatches.map((m) => m[1]);

      const sourceMatches = [...contextHtml.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*>/gi)];
      const videoTagMatches = [...contextHtml.matchAll(/<video[^>]+src=["']([^"']+)["'][^>]*>/gi)];
      const iframeMatches = [...contextHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi)];
      const scMatches = [...contextHtml.matchAll(/\[video[^\]]+src=["']([^"']+)["'][^\]]*\]/gi)];
      this.fallbackVideos = [
        ...sourceMatches.map((m) => m[1]),
        ...videoTagMatches.map((m) => m[1]),
        ...iframeMatches.map((m) => m[1]),
        ...scMatches.map((m) => m[1]),
      ];

      const audioTagMatches = [...contextHtml.matchAll(/<audio[^>]+src=["']([^"']+)["'][^>]*>/gi)];
      const audioSourceMatches = [...contextHtml.matchAll(/<source[^>]+src=["']([^"']+\.(?:mp3|wav|ogg|m4a|aac)[^"']*)["'][^>]*>/gi)];
      const audioScMatches = [...contextHtml.matchAll(/\[audio[^\]]+src=["']([^"']+)["'][^\]]*\]/gi)];
      const audioMetaMatches = [...contextHtml.matchAll(/<meta[^>]+itemprop=["']url["'][^>]+content=["']([^"']+\.(?:mp3|wav|ogg|m4a|aac))["']/gi)];
      this.fallbackAudios = [
        ...audioTagMatches.map((m) => m[1]),
        ...audioSourceMatches.map((m) => m[1]),
        ...audioScMatches.map((m) => m[1]),
        ...audioMetaMatches.map((m) => m[1]),
      ];
    }

    let rawData: any = payload;
    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
        try {
          rawData = JSON.parse(payload);
        } catch {
          rawData = payload;
        }
      }
    } else if (typeof payload === 'object' && payload !== null) {
      const obj = payload as any;
      if (obj.meta?._elementor_data) {
        try { rawData = JSON.parse(obj.meta._elementor_data); } catch { rawData = obj.meta._elementor_data; }
      } else if (obj._elementor_data) {
        try { rawData = JSON.parse(obj._elementor_data); } catch { rawData = obj._elementor_data; }
      } else if (obj.meta?._fl_builder_data) {
        try { rawData = JSON.parse(obj.meta._fl_builder_data); } catch { rawData = obj.meta._fl_builder_data; }
      } else if (obj._fl_builder_data) {
        try { rawData = JSON.parse(obj._fl_builder_data); } catch { rawData = obj._fl_builder_data; }
      } else if (obj.content?.raw) {
        rawData = obj.content.raw;
      }
    }

    // 1. JSON Array format (Elementor, Brizy, etc.)
    if (Array.isArray(rawData)) {
      this.parseJsonArray(rawData, page.root);
      return page;
    }

    // 2. Node Dictionary format (Beaver Builder, etc.)
    if (typeof rawData === 'object' && rawData !== null && !Array.isArray(rawData)) {
      this.parseNodeMap(rawData, page.root);
      return page;
    }

    // 3. String format (Blocks, Shortcodes, or HTML)
    if (typeof rawData === 'string') {
      if (rawData.includes('wp:fl-builder') || rawData.includes('fl-builder') || rawData.includes('fl-row')) {
        this.parseBeaverHtml(rawData, page.root);
      } else if (rawData.includes('<!-- wp:')) {
        this.parseGutenbergBlocks(rawData, page.root);
      } else if (rawData.includes('[et_pb_') || rawData.includes('[vc_')) {
        this.parseShortcodes(rawData, page.root);
      } else {
        this.parseHtmlFallback(rawData, page.root);
      }
      return page;
    }

    return page;
  }

  /**
   * Universal Serializer: Serializes UniversalPage AST into the target builder format.
   * Handles elementor, beaver-builder, gutenberg, and any other target builder dynamically.
   */
  serialize(
    page: UniversalPage,
    options?: Partial<MigrationOptions>
  ): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  } {
    const target = (options?.targetBuilder || 'elementor').toLowerCase();
    const warnings: MigrationWarning[] = [];

    if (target.includes('beaver')) {
      return this.serializeToBeaver(page, warnings);
    } else if (target.includes('elementor')) {
      return this.serializeToElementor(page, warnings, options);
    } else if (target.includes('divi')) {
      return this.serializeToDivi(page, warnings, options);
    } else if (target.includes('gutenberg') || target.includes('block')) {
      return this.serializeToGutenberg(page, warnings, options);
    } else {
      const rawSource = options?.sourceBuilder || page.sourceBuilder || 'Elementor';
      const formatBuilderName = (name: string) => {
        if (!name) return 'Unknown';
        const lower = name.toLowerCase().trim();
        if (lower === 'elementor') return 'Elementor';
        if (lower.includes('beaver')) return 'Beaver Builder';
        if (lower === 'divi') return 'Divi';
        if (lower === 'gutenberg') return 'Gutenberg';
        return name.charAt(0).toUpperCase() + name.slice(1);
      };
      const sourceName = formatBuilderName(rawSource);
      const targetName = formatBuilderName(options?.targetBuilder || target);
      throw new Error(
        `Unsupported migration:\n${sourceName} → ${targetName} is not currently supported.`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // FORMAT DETECTION
  // ---------------------------------------------------------------------------
  private detectFormat(payload: unknown): string {
    if (!payload) return 'unknown';
    if (Array.isArray(payload)) return 'elementor';
    if (typeof payload === 'object') {
      const obj = payload as any;
      if ((obj._elementor_data && obj._elementor_data !== '') || (obj.meta?._elementor_data && obj.meta._elementor_data !== '')) return 'elementor';
      if (obj._fl_builder_data || obj.meta?._fl_builder_data || obj.meta?._fl_builder_enabled === '1') return 'beaver-builder';
      const content = obj.content?.raw || obj.content?.rendered || '';
      if (content.includes('wp:fl-builder') || content.includes('fl-builder') || content.includes('fl-row')) return 'beaver-builder';
      if (content.includes('[et_pb_')) return 'divi';
      if (content.includes('<!-- wp:')) return 'gutenberg';
      const keys = Object.keys(obj);
      if (keys.some((k) => k.startsWith('row_') || k.startsWith('col_') || k.startsWith('mod_'))) {
        return 'beaver-builder';
      }
    }
    if (typeof payload === 'string') {
      if (payload.includes('wp:fl-builder') || payload.includes('fl-builder') || payload.includes('fl-row')) return 'beaver-builder';
      if (payload.includes('<!-- wp:')) return 'gutenberg';
      if (payload.includes('[et_pb_')) return 'divi';
      if (payload.includes('elementor')) return 'elementor';
    }
    return 'custom';
  }

  // ---------------------------------------------------------------------------
  private contextHtml: string = '';
  private fallbackImages: string[] = [];
  private fallbackVideos: string[] = [];
  private fallbackAudios: string[] = [];

  private extractHtmlByNodeId(id: string): string {
    if (!this.contextHtml || !id) return '';
    const cleanId = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanId) return '';
    const startRegex = new RegExp(`<([a-zA-Z0-9]+)[^>]*?(?:data-id=["']${cleanId}["']|elementor-element-${cleanId}|fl-node-${cleanId}|data-node=["']${cleanId}["'])[^>]*>`, 'i');
    const startMatch = startRegex.exec(this.contextHtml);
    if (!startMatch) return '';

    const tagName = startMatch[1].toLowerCase();
    const startIndex = startMatch.index;

    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    if (voidTags.has(tagName) || startMatch[0].endsWith('/>')) {
      return this.contextHtml.substring(startIndex, startIndex + startMatch[0].length);
    }

    let depth = 0;
    const tagRegex = new RegExp(`<(/?)${tagName}(?:\\s[^>]*)?>`, 'gi');
    tagRegex.lastIndex = startIndex;
    let match;
    while ((match = tagRegex.exec(this.contextHtml)) !== null) {
      if (match[1] === '/') {
        depth--;
        if (depth === 0) {
          return this.contextHtml.substring(startIndex, tagRegex.lastIndex);
        }
      } else {
        if (!match[0].endsWith('/>')) {
          depth++;
        }
      }
    }
    const endTagIndex = this.contextHtml.indexOf(`</${tagName}>`, startIndex + startMatch[0].length);
    if (endTagIndex !== -1) {
      return this.contextHtml.substring(startIndex, endTagIndex + `</${tagName}>`.length);
    }
    return startMatch[0];
  }

  private extractElementorValue(val: any): any {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string' || typeof val === 'number') return val;
    if (typeof val === 'object') {
      if (val.$$type === 'escaped-html' || val.$$type === 'text') return val.value || '';
      if (val.value !== undefined) return this.extractElementorValue(val.value);
      if (val.url !== undefined) return val.url;
      if (val.src !== undefined) return this.extractElementorValue(val.src);
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // JSON ARRAY PARSING (Elementor-style trees)
  // ---------------------------------------------------------------------------
  private parseJsonArray(elements: any[], parentNode: UniversalNode): void {
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      const rawElType = el.elType || (el.widgetType ? 'widget' : 'section');
      const elType = (rawElType === 'e-flexbox' || rawElType === 'e-div') ? 'container' : rawElType;
      const settings = Array.isArray(el.settings) ? {} : (el.settings || {});

      if (elType === 'section' || elType === 'container') {
        const isDirectSection = parentNode.type === 'page';
        const targetNodeType = isDirectSection ? 'section' : 'column';
        const node = createNode(targetNodeType, {}, {}, [], {
          originalBuilder: 'elementor',
          originalType: elType,
          rawSettings: settings
        });
        this.extractElementorStyles(settings, node.styles);
        if (targetNodeType === 'section') {
          if (settings.content_width?.size) {
            node.styles.maxWidth = `${settings.content_width.size}${settings.content_width.unit || 'px'}`;
          } else if (settings.boxed_width?.size) {
            node.styles.maxWidth = `${settings.boxed_width.size}${settings.boxed_width.unit || 'px'}`;
          } else if (settings.width?.size) {
            node.styles.maxWidth = `${settings.width.size}${settings.width.unit || 'px'}`;
          } else if (typeof settings.content_width === 'number') {
            node.styles.maxWidth = `${settings.content_width}px`;
          }
        } else {
          const colWidth = settings._column_size || settings.width || 100;
          node.metadata = { ...node.metadata, columnSpan: colWidth };
          node.styles.width = `${colWidth}%`;
        }
        parentNode.children.push(node);

        if (Array.isArray(el.elements)) {
          this.parseJsonArray(el.elements, node);
        }
      } else if (elType === 'column') {
        const colWidth = settings._column_size || settings.width || 100;
        const colNode = createNode('column', {}, {}, [], {
          originalBuilder: 'elementor',
          originalType: 'column',
          columnSpan: colWidth,
          rawSettings: settings
        });
        this.extractElementorStyles(settings, colNode.styles);
        colNode.styles.width = `${colWidth}%`;
        parentNode.children.push(colNode);

        if (Array.isArray(el.elements)) {
          this.parseJsonArray(el.elements, colNode);
        }
      } else if (elType === 'widget') {
        const widgetType = el.widgetType || 'text';
        const widgetNode = this.parseElementorWidget(widgetType, settings, el);
        if (widgetNode) {
          parentNode.children.push(widgetNode);
        }
      }
    }
  }

  private parseElementorWidget(widgetType: string, s: any, rawEl?: any): UniversalNode | null {
    let nodeType: UniversalNodeType = 'unknown';
    let properties: Record<string, any> = {};

    const cleanWidgetType = widgetType.startsWith('e-') ? widgetType.replace(/^e-/, '') : widgetType;

    switch (cleanWidgetType) {
      case 'heading': {
        const rawTitle = this.extractElementorValue(s.title) || s.heading_title || '';
        if (typeof rawTitle === 'string' && (rawTitle.includes('wp:fl-builder') || rawTitle.trim() === '')) {
          return null;
        }
        nodeType = 'heading';
        properties = {
          text: rawTitle,
          level: s.header_size || 'h2',
          link: s.link?.url ? { url: s.link.url, openInNewTab: s.link.is_external === 'on' || s.link.isTargetBlank === true } : undefined
        };
        break;
      }
      case 'text-editor':
      case 'text': {
        const rawText = this.extractElementorValue(s.editor) || this.extractElementorValue(s.text) || '';
        if (typeof rawText === 'string' && (rawText.includes('wp:fl-builder') || rawText.trim() === '')) {
          return null;
        }
        nodeType = 'text';
        properties = { text: rawText };
        break;
      }
      case 'button': {
        nodeType = 'button';
        const rawBtnText = this.extractElementorValue(s.text) || 'Click Here';
        const rawBtnUrl = this.extractElementorValue(s.link?.url || s.link) || '#';
        properties = {
          text: rawBtnText,
          link: { url: rawBtnUrl, openInNewTab: s.link?.is_external === 'on' || s.link?.isTargetBlank === true },
          size: s.size || 'medium',
          icon: s.selected_icon?.value || s.icon
        };
        break;
      }
      case 'image': {
        nodeType = 'image';
        let imgUrl = this.extractElementorValue(s.image?.url || s.image?.src || s.image) || '';
        if (!imgUrl && this.fallbackImages.length > 0) {
          const attachmentId = s.image?.value?.src?.value?.id?.value || s.image?.id;
          if (attachmentId) {
            const match = this.fallbackImages.find((img) => img.includes(`/${attachmentId}/`) || img.includes(`id=${attachmentId}`) || img.includes(String(attachmentId)));
            if (match) imgUrl = match;
          }
          if (!imgUrl) {
            imgUrl = this.fallbackImages[0];
          }
        }
        properties = {
          url: imgUrl,
          alt: s.image?.alt || '',
          caption: s.caption || '',
          link: s.link?.url ? { url: s.link.url } : undefined
        };
        break;
      }
      case 'video':
      case 'self-hosted-video': {
        nodeType = 'video';
        let videoUrl = this.extractElementorValue(s.youtube_url) ||
          this.extractElementorValue(s.vimeo_url) ||
          this.extractElementorValue(s.hosted_url?.url) ||
          this.extractElementorValue(s.external_url?.url) ||
          this.extractElementorValue(s.source?.value?.url) ||
          this.extractElementorValue(s.video?.url) ||
          '';

        const attachmentId = s.source?.value?.id?.value || s.hosted_url?.id || s.video?.id || (typeof s.source?.value?.id === 'number' ? s.source.value.id : undefined);

        if (!videoUrl && this.fallbackVideos.length > 0) {
          if (attachmentId) {
            const match = this.fallbackVideos.find((v) => v.includes(`/${attachmentId}/`) || v.includes(`id=${attachmentId}`) || v.includes(String(attachmentId)));
            if (match) videoUrl = match;
          }
          if (!videoUrl) {
            videoUrl = this.fallbackVideos[0];
          }
        }

        const cleanUrl = typeof videoUrl === 'string' ? videoUrl.replace(/#t=\d+$/, '') : '';

        properties = {
          url: cleanUrl || videoUrl,
          attachmentId: attachmentId,
          autoplay: s.autoplay === 'yes' || s.autoplay === true,
          loop: s.loop === 'yes' || s.loop === true,
          controls: s.controls !== 'no' && s.controls !== false
        };
        break;
      }
      case 'divider': {
        nodeType = 'divider';
        const divColor = normalizeColor(s.color || s.border_color);
        properties = {
          style: s.style || 'solid',
          weight: s.weight?.size || (typeof s.weight === 'number' ? s.weight : 1),
          width: s.width?.size ? `${s.width.size}${s.width.unit || '%'}` : (s.width || '100%'),
          color: divColor
        };
        break;
      }
      case 'spacer':
        nodeType = 'spacer';
        properties = { height: s.space?.size ? `${s.space.size}${s.space.unit || 'px'}` : '50px' };
        break;
      case 'icon': {
        nodeType = 'icon';
        const rawIconName = s.selected_icon?.value || s.icon || 'star';
        properties = {
          icon: rawIconName,
          name: rawIconName,
          link: s.link?.url ? { url: s.link.url } : undefined,
          view: s.view || 'default',
          shape: s.shape || 'circle'
        };
        break;
      }
      case 'icon-box': {
        nodeType = 'icon-box';
        const ibPos = s.position || 'top';
        const ibAlign = s.text_align || s.align || s.alignment || (ibPos === 'top' ? 'center' : 'left');
        properties = {
          icon: s.selected_icon?.value || s.icon || 'star',
          title: s.title_text || s.title || '',
          description: s.description_text || s.description || '',
          link: s.link?.url ? { url: s.link.url } : undefined,
          iconColor: normalizeColor(s.primary_color || s.icon_color || s.icon_primary_color || s.color),
          titleColor: normalizeColor(s.title_color),
          descriptionColor: normalizeColor(s.description_color),
          position: ibPos,
          align: ibAlign
        };
        break;
      }
      case 'accordion':
        nodeType = 'accordion';
        properties = {
          items: Array.isArray(s.tabs)
            ? s.tabs.map((t: any) => ({ title: t.tab_title || '', content: t.tab_content || '' }))
            : []
        };
        break;
      case 'counter':
        nodeType = 'counter';
        properties = {
          startNumber: s.starting_number || 0,
          endNumber: s.ending_number || 100,
          prefix: s.prefix || '',
          suffix: s.suffix || '',
          title: s.title || '',
          numberColor: normalizeColor(s.number_color),
          titleColor: normalizeColor(s.title_color)
        };
        break;
      case 'wp-widget-media_audio':
      case 'audio':
      case 'soundcloud': {
        nodeType = 'audio';
        let audioUrl = this.extractElementorValue(
          s.audio?.url ||
          s.hosted_url?.url ||
          s.external_url?.url ||
          s.link?.url ||
          s.source?.value?.url ||
          s.wp?.url ||
          s.url ||
          ''
        );
        const attId = s.audio?.id || s.hosted_url?.id || s.source?.value?.id?.value || s.wp?.attachment_id;
        if (!audioUrl && this.fallbackAudios.length > 0) {
          if (attId) {
            const match = this.fallbackAudios.find((a) => a.includes(`/${attId}/`) || a.includes(`id=${attId}`) || a.includes(String(attId)));
            if (match) audioUrl = match;
          }
          if (!audioUrl) audioUrl = this.fallbackAudios[0];
        }
        properties = {
          url: audioUrl,
          attachmentId: attId ? Number(attId) : undefined,
          title: s.wp?.title || s.title || ''
        };
        break;
      }
      case 'progress':
      case 'progress-bar': {
        nodeType = 'counter';
        const percent = typeof s.percent === 'object' ? (s.percent?.size || 50) : (parseInt(String(s.percent || '50'), 10) || 50);
        properties = {
          startNumber: 0,
          endNumber: percent,
          prefix: '',
          suffix: '%',
          title: s.title || ''
        };
        break;
      }
      case 'star-rating':
      case 'rating': {
        nodeType = 'star-rating';
        properties = {
          rating: s.rating || s.rating_scale || 5,
          maxRating: s.rating_scale || 5,
          title: s.title || ''
        };
        break;
      }
      case 'image-box': {
        nodeType = 'icon-box';
        const imgPos = s.position || 'top';
        const imgAlign = s.text_align || s.align || (imgPos === 'top' ? 'center' : 'left');
        properties = {
          title: s.title_text || '',
          description: s.description_text || '',
          image: this.extractElementorValue(s.image?.url || s.image?.src || s.image || ''),
          link: s.link?.url ? { url: s.link.url } : undefined,
          position: imgPos,
          align: imgAlign
        };
        break;
      }
      case 'callout':
      case 'cta': {
        nodeType = 'icon-box';
        const ctaPos = s.position || 'top';
        const ctaAlign = s.text_align || s.align || (ctaPos === 'top' ? 'center' : 'left');
        properties = {
          title: s.title || '',
          description: s.description || '',
          link: s.link?.url ? { url: s.link.url } : undefined,
          position: ctaPos,
          align: ctaAlign
        };
        break;
      }
      case 'toggle':
      case 'tabs': {
        nodeType = 'accordion';
        properties = {
          items: Array.isArray(s.tabs)
            ? s.tabs.map((t: any) => ({ title: t.tab_title || '', content: t.tab_content || '' }))
            : []
        };
        break;
      }
      case 'social-icons': {
        nodeType = 'social-icons';
        properties = {
          icons: Array.isArray(s.social_icon_list)
            ? s.social_icon_list.map((i: any) => ({
                name: i.social_icon?.value || 'fab fa-facebook',
                link: i.link?.url || '#',
                color: normalizeColor(i.item_icon_secondary_color || s.icon_secondary_color),
                backgroundColor: normalizeColor(i.item_icon_primary_color || s.icon_primary_color)
              }))
            : []
        };
        break;
      }
      case 'shortcode': {
        nodeType = 'raw-html';
        properties = { html: s.shortcode || '' };
        break;
      }
      case 'alert': {
        nodeType = 'text';
        const alertTitle = s.alert_title ? `<strong>${s.alert_title}</strong> ` : '';
        properties = { text: `${alertTitle}${s.alert_description || ''}` };
        break;
      }
      case 'testimonial':
      case 'testimonials':
      case 'testimonial-carousel':
      case 'reviews': {
        nodeType = 'text';
        const tContent = s.testimonial_content || s.content || '';
        const tName = s.testimonial_name || s.name || '';
        const tJob = s.testimonial_job || s.job || '';
        properties = {
          text: tContent ? `<blockquote><p>${tContent}</p><cite>${tName}${tJob ? ` (${tJob})` : ''}</cite></blockquote>` : ''
        };
        break;
      }
      case 'icon-list': {
        nodeType = 'text';
        properties = {
          html: Array.isArray(s.icon_list) ? `<ul style="list-style: none; padding-left: 0;">${s.icon_list.map((i: any) => `<li style="margin-bottom: 8px;">${i.text || ''}</li>`).join('')}</ul>` : ''
        };
        break;
      }
      case 'google-maps':
      case 'google_maps': {
        nodeType = 'map';
        const address = s.address || '';
        properties = {
          address,
          html: address ? `<iframe width="100%" height="400" frameborder="0" src="https://maps.google.com/maps?q=${encodeURIComponent(address)}&output=embed"></iframe>` : ''
        };
        break;
      }
      case 'html':
      case 'code': {
        const rawContent = s.html || s.code || '';
        if (rawContent.includes('<audio') || rawContent.includes('[audio')) {
          const srcMatch = rawContent.match(/src=["']([^"']+)["']/i);
          if (srcMatch) {
            nodeType = 'audio';
            properties = { url: srcMatch[1] };
            break;
          }
        }
        if (rawContent.includes('<video') || rawContent.includes('[video')) {
          const srcMatch = rawContent.match(/src=["']([^"']+)["']/i);
          if (srcMatch) {
            nodeType = 'video';
            properties = { url: srcMatch[1] };
            break;
          }
        }
        nodeType = 'raw-html';
        properties = { html: rawContent };
        break;
      }
      default: {
        const snippet = (rawEl as any)?.id ? this.extractHtmlByNodeId((rawEl as any).id) : '';
        if (snippet) {
          nodeType = 'raw-html';
          properties = { html: snippet };
        } else {
          let fallbackHtml = s.html || s.code || s.custom_html || s.shortcode || '';
          if (!fallbackHtml) {
            const title = this.extractElementorValue(s.title || s.heading || s.heading_title || s.title_text || s.caption);
            const body = this.extractElementorValue(s.editor || s.text || s.content || s.description || s.desc || s.subtitle);
            const img = this.extractElementorValue(s.image?.url || s.image?.src || s.image || s.photo || s.img);
            const linkUrl = this.extractElementorValue(s.link?.url || s.link || s.url);
            const btnText = this.extractElementorValue(s.button_text || s.btn_text || s.text);

            if (title || body || img || (btnText && linkUrl)) {
              const parts: string[] = [];
              if (img) parts.push(`<div style="margin-bottom: 12px;"><img src="${img}" style="max-width: 100%; height: auto;" /></div>`);
              if (title) parts.push(`<h3 style="margin: 0 0 8px 0;">${title}</h3>`);
              if (body) parts.push(`<div style="margin-bottom: 8px;">${body}</div>`);
              if (btnText && linkUrl) parts.push(`<div><a href="${linkUrl}" style="display: inline-block; padding: 8px 16px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 4px;">${btnText}</a></div>`);
              fallbackHtml = `<div class="migrated-widget-fallback migrated-${cleanWidgetType}">${parts.join('')}</div>`;
            }
          }
          if (fallbackHtml) {
            nodeType = 'raw-html';
            properties = { html: fallbackHtml };
          } else {
            const items = s.items || s.list || s.tabs;
            if (Array.isArray(items) && items.length > 0) {
              nodeType = 'raw-html';
              properties = {
                html: `<div class="migrated-widget-list">${items.map((it: any) => `<div>${it.title || it.text || it.name || it.label || ''}</div>`).join('')}</div>`
              };
            } else {
              nodeType = 'raw-html';
              properties = { html: '' };
            }
          }
        }
        break;
      }
    }

    const node = createNode(nodeType, properties, {}, [], {
      originalBuilder: 'elementor',
      originalType: widgetType,
      rawSettings: s
    });

    this.extractElementorStyles(s, node.styles);

    // Extract Atomic / Elementor V2 styles from rawEl.styles
    if (rawEl?.styles && typeof rawEl.styles === 'object') {
      for (const styleObj of Object.values(rawEl.styles as Record<string, any>)) {
        if (Array.isArray(styleObj?.variants)) {
          for (const variant of styleObj.variants) {
            const bgVal = variant?.props?.background?.value?.color?.value || variant?.props?.background?.color;
            if (bgVal) node.styles.backgroundColor = normalizeColor(bgVal);
            const colorVal = variant?.props?.color?.value || variant?.props?.color;
            if (colorVal) node.styles.color = normalizeColor(colorVal);
          }
        }
      }
    }

    if (cleanWidgetType === 'text-editor' || cleanWidgetType === 'text') {
      const textVal = properties.text || '';
      if (!node.styles.color && typeof textVal === 'string') {
        const colorMatch = textVal.match(/color:\s*([^;"]+)/i);
        if (colorMatch) node.styles.color = normalizeColor(colorMatch[1].trim());
      }
      if (!node.styles.typography?.fontSize && typeof textVal === 'string') {
        const fontMatch = textVal.match(/font-size:\s*(\d+)px/i);
        if (fontMatch) {
          node.styles.typography = { ...node.styles.typography, fontSize: parseInt(fontMatch[1], 10), fontSizeUnit: 'px' };
        }
      }
      if (!node.styles.alignment && typeof textVal === 'string') {
        const alignMatch = textVal.match(/text-align:\s*(center|left|right|justify)/i);
        if (alignMatch) node.styles.alignment = alignMatch[1].toLowerCase() as 'left' | 'right' | 'center' | 'justify';
      }
      if (!node.styles.typography?.lineHeight && typeof textVal === 'string') {
        const lhMatch = textVal.match(/line-height:\s*([0-9.]+(?:px|em)?)/i);
        if (lhMatch) {
          node.styles.typography = { ...node.styles.typography, lineHeight: lhMatch[1].trim() };
        }
      }
    }

    if (cleanWidgetType === 'divider') {
      if (properties.color) {
        node.styles.color = properties.color;
        node.styles.border = { ...node.styles.border, color: properties.color, style: properties.style || 'solid' };
      }
    }

    if (cleanWidgetType === 'counter') {
      if (properties.numberColor) {
        node.styles.color = properties.numberColor;
      }
      const countAlign = s.number_alignment || s.title_horizontal_alignment || s.align || s.alignment;
      if (countAlign) {
        node.styles.alignment = countAlign as 'left' | 'center' | 'right' | 'justify';
      }
    }

    if (cleanWidgetType === 'icon-box') {
      node.styles.color = properties.titleColor || undefined;
      const ibAlign = properties.align || s.text_align || s.align || (properties.position === 'top' ? 'center' : 'left');
      node.styles.alignment = ibAlign as 'left' | 'right' | 'center' | 'justify';
    }

    if (cleanWidgetType === 'icon') {
      if (s.view === 'stacked' && !s.secondary_color) {
        node.styles.color = '#ffffff';
      }
      if (s.shape === 'circle' || s.shape_circle || s.view === 'stacked') {
        node.styles.border = { radius: { top: 50, right: 50, bottom: 50, left: 50, unit: '%' } };
      }
      node.styles.alignment = s.align || s.alignment || 'center';
      if (s.size?.size) {
        node.styles.typography = { ...node.styles.typography, fontSize: s.size.size, fontSizeUnit: s.size.unit || 'px' };
      }
    }

    if (cleanWidgetType === 'button') {
      if (s.align || s.alignment) {
        node.styles.alignment = s.align || s.alignment;
      }
      if (!node.styles.backgroundColor && s.button_type) {
        const typeColors: Record<string, string> = {
          info: '#5bc0de',
          success: '#5cb85c',
          warning: '#f0ad4e',
          danger: '#d9534f'
        };
        if (typeColors[s.button_type]) {
          node.styles.backgroundColor = typeColors[s.button_type];
        }
      }
      if (!node.styles.padding && widgetType === 'e-button') {
        node.styles.padding = { top: 12, right: 24, bottom: 12, left: 24, unit: 'px' };
      }
      if (!node.styles.border?.radius && widgetType === 'e-button') {
        node.styles.border = { ...node.styles.border, radius: { top: 2, right: 2, bottom: 2, left: 2, unit: 'px' } };
      }
    }

    return node;
  }

  private extractElementorStyles(s: any, styles: UniversalStyles): void {
    if (s.background_color) styles.backgroundColor = normalizeColor(s.background_color);
    if (s.background_image?.url) styles.backgroundImage = s.background_image.url;
    if (s.title_color || s.text_color || s.color || s.button_text_color || s.number_color) {
      styles.color = normalizeColor(s.title_color || s.text_color || s.color || s.button_text_color || s.number_color);
    }
    if (s.align || s.text_align || s.alignment) {
      styles.alignment = s.align || s.text_align || s.alignment;
    }
    if (s.padding || s._padding || s.button_padding) {
      styles.padding = parseElementorSpacing(s.button_padding || s._padding || s.padding);
    }
    if (s.margin || s._margin) {
      styles.margin = parseElementorSpacing(s._margin || s.margin);
    }
    if (s.border_radius || s._border_radius || s.image_border_radius || s.button_border_radius) {
      styles.border = styles.border || {};
      styles.border.radius = parseElementorSpacing(s.button_border_radius || s.image_border_radius || s._border_radius || s.border_radius);
    }
    const fontFam = s.typography_number_font_family || s.typography_font_family;
    if (fontFam) {
      styles.typography = styles.typography || {};
      styles.typography.fontFamily = fontFam;
    }
    const fontSizeObj = s.typography_number_font_size || s.typography_font_size;
    if (fontSizeObj?.size) {
      styles.typography = styles.typography || {};
      styles.typography.fontSize = fontSizeObj.size;
      styles.typography.fontSizeUnit = fontSizeObj.unit || 'px';
    }
    const fontWt = s.typography_number_font_weight || s.typography_font_weight;
    if (fontWt) {
      styles.typography = styles.typography || {};
      styles.typography.fontWeight = String(fontWt);
    }
    const fontSt = s.typography_number_font_style || s.typography_font_style;
    if (fontSt) {
      styles.typography = styles.typography || {};
      styles.typography.fontStyle = fontSt;
    }
    const lineHt = s.typography_number_line_height || s.typography_line_height;
    if (lineHt?.size) {
      styles.typography = styles.typography || {};
      styles.typography.lineHeight = `${lineHt.size}${lineHt.unit || 'em'}`;
    }
    const letterSp = s.typography_number_letter_spacing || s.typography_letter_spacing;
    if (letterSp?.size) {
      styles.typography = styles.typography || {};
      styles.typography.letterSpacing = `${letterSp.size}${letterSp.unit || 'px'}`;
    }
    const textTrans = s.typography_number_text_transform || s.typography_text_transform;
    if (textTrans) {
      styles.typography = styles.typography || {};
      styles.typography.textTransform = textTrans;
    }
    const textDec = s.typography_number_text_decoration || s.typography_text_decoration;
    if (textDec) {
      styles.typography = styles.typography || {};
      styles.typography.textDecoration = textDec;
    }
    if (s.button_background_color) {
      styles.backgroundColor = normalizeColor(s.button_background_color);
    }
    if (s.border_border || s.border_style || s._border_border) {
      styles.border = styles.border || {};
      styles.border.style = (s.border_border || s.border_style || s._border_border) as any;
    }
    if (s.border_color || s._border_color) {
      styles.border = styles.border || {};
      styles.border.color = normalizeColor(s.border_color || s._border_color);
    }
    if (s.border_width || s._border_width) {
      styles.border = styles.border || {};
      styles.border.width = parseElementorSpacing(s.border_width || s._border_width) as any;
    }
    if (s.primary_color) {
      if (s.view === 'stacked') {
        styles.backgroundColor = normalizeColor(s.primary_color);
      } else {
        styles.color = normalizeColor(s.primary_color);
      }
    }
    if (s.secondary_color) {
      styles.color = normalizeColor(s.secondary_color);
    }
    if (s.size?.size) {
      styles.typography = styles.typography || {};
      styles.typography.fontSize = s.size.size;
      styles.typography.fontSizeUnit = s.size.unit || 'px';
    }
    if (s.width?.size) {
      styles.width = `${s.width.size}${s.width.unit || '%'}`;
    }
  }

  // ---------------------------------------------------------------------------
  // NODE DICTIONARY PARSING (Beaver Builder-style maps)
  // ---------------------------------------------------------------------------
  private parseNodeMap(nodeMap: Record<string, any>, parentNode: UniversalNode): void {
    const nodes = Object.values(nodeMap);
    const rows = nodes.filter((n) => n.type === 'row').sort((a, b) => (a.position || 0) - (b.position || 0));

    if (rows.length === 0) {
      const modules = nodes.filter((n) => n.type === 'module' || n.settings?.type).sort((a, b) => (a.position || 0) - (b.position || 0));
      if (modules.length > 0) {
        const sectionNode = createNode('section', {}, {}, [], { originalBuilder: 'beaver-builder', originalType: 'row' });
        const colNode = createNode('column', {}, {}, [], { originalBuilder: 'beaver-builder', originalType: 'column', columnSpan: 100 });
        sectionNode.children.push(colNode);
        parentNode.children.push(sectionNode);
        for (const mod of modules) {
          const modNode = this.parseBeaverModule(mod.settings || mod);
          colNode.children.push(modNode);
        }
        return;
      }
    }

    for (const row of rows) {
      const rSettings = row.settings || {};
      const rowStyles: UniversalNode['styles'] = {};
      if (rSettings.bg_color) rowStyles.backgroundColor = normalizeColor(rSettings.bg_color);
      if (rSettings.color || rSettings.text_color) rowStyles.color = normalizeColor(rSettings.color || rSettings.text_color);
      const rowMaxW = rSettings.max_content_width || rSettings.max_width || (rSettings.content_width && rSettings.content_width !== 'fixed' && rSettings.content_width !== 'full' ? rSettings.content_width : undefined);
      if (rowMaxW) {
        const cleanW = String(rowMaxW).trim();
        rowStyles.maxWidth = `${cleanW}${cleanW.endsWith('px') || cleanW.endsWith('%') ? '' : 'px'}`;
      }
      if (rSettings.padding_top || rSettings.padding_bottom) {
        rowStyles.padding = {
          top: rSettings.padding_top || '80',
          bottom: rSettings.padding_bottom || '80',
          left: rSettings.padding_left || '20',
          right: rSettings.padding_right || '20',
          unit: 'px'
        };
      }

      const colGroups = nodes.filter((n) => n.type === 'column-group' && (n.parent === (row.node || row.id) || (row.groups && row.groups.includes(n.node || n.id)))).sort((a, b) => (a.position || 0) - (b.position || 0));
      if (colGroups.length > 0) {
        for (const cg of colGroups) {
          const sectionNode = createNode('section', {}, { ...rowStyles }, [], {
            originalBuilder: 'beaver-builder',
            originalType: 'row',
            rawSettings: row.settings || {}
          });
          parentNode.children.push(sectionNode);

          const cols = nodes.filter((n) => n.type === 'column' && (n.parent === (cg.node || cg.id) || (cg.cols && cg.cols.includes(n.node || n.id)))).sort((a, b) => (a.position || 0) - (b.position || 0));
          for (const col of cols) {
            const span = col.settings?.size || 100;
            const colNode = createNode('column', {}, {}, [], {
              originalBuilder: 'beaver-builder',
              originalType: 'column',
              columnSpan: span,
              rawSettings: col.settings || {}
            });
            colNode.styles.width = `${span}%`;
            sectionNode.children.push(colNode);

            const modules = nodes.filter((n) => (n.type === 'module' || !['row', 'column-group', 'column'].includes(n.type)) && (n.parent === (col.node || col.id) || (col.modules && col.modules.includes(n.node || n.id)))).sort((a, b) => (a.position || 0) - (b.position || 0));
            for (const mod of modules) {
              const modNode = this.parseBeaverModule(mod.settings ? { ...mod.settings, type: mod.settings.type || mod.type, node: mod.node || mod.id } : mod);
              colNode.children.push(modNode);
            }
          }
        }
      } else {
        const sectionNode = createNode('section', {}, { ...rowStyles }, [], {
          originalBuilder: 'beaver-builder',
          originalType: 'row',
          rawSettings: row.settings || {}
        });
        parentNode.children.push(sectionNode);
        const cols = nodes.filter((n) => n.type === 'column' && (n.parent === (row.node || row.id) || (row.cols && row.cols.includes(n.node || n.id)))).sort((a, b) => (a.position || 0) - (b.position || 0));
        if (cols.length > 0) {
          for (const col of cols) {
            const colNode = createNode('column', {}, {}, [], {
              originalBuilder: 'beaver-builder',
              originalType: 'column',
              columnSpan: col.settings?.size || 100,
              rawSettings: col.settings || {}
            });
            colNode.styles.width = `${col.settings?.size || 100}%`;
            sectionNode.children.push(colNode);

            const modules = nodes.filter((n) => (n.type === 'module' || !['row', 'column-group', 'column'].includes(n.type)) && (n.parent === (col.node || col.id) || (col.modules && col.modules.includes(n.node || n.id)))).sort((a, b) => (a.position || 0) - (b.position || 0));
            for (const mod of modules) {
              const modNode = this.parseBeaverModule(mod.settings ? { ...mod.settings, type: mod.settings.type || mod.type, node: mod.node || mod.id } : mod);
              colNode.children.push(modNode);
            }
          }
        } else {
          const modules = nodes.filter((n) => (n.type === 'module' || !['row', 'column-group', 'column'].includes(n.type)) && (n.parent === (row.node || row.id) || (row.modules && row.modules.includes(n.node || n.id)))).sort((a, b) => (a.position || 0) - (b.position || 0));
          if (modules.length > 0) {
            const colNode = createNode('column', {}, {}, [], {
              originalBuilder: 'beaver-builder',
              originalType: 'column',
              columnSpan: 100
            });
            sectionNode.children.push(colNode);
            for (const mod of modules) {
              const modNode = this.parseBeaverModule(mod.settings ? { ...mod.settings, type: mod.settings.type || mod.type, node: mod.node || mod.id } : mod);
              colNode.children.push(modNode);
            }
          }
        }
      }
    }
  }

  private parseBeaverModule(s: any): UniversalNode {
    const modType = s.type || 'rich-text';
    let nodeType: UniversalNodeType = 'unknown';
    let properties: Record<string, any> = {};

    switch (modType) {
      case 'heading':
        nodeType = 'heading';
        properties = { text: s.heading || '', level: s.tag || 'h2' };
        break;
      case 'button':
        nodeType = 'button';
        properties = {
          text: s.text || 'Click',
          link: { url: s.link || '#', openInNewTab: s.link_target === '_blank' },
          width: s.width || 'auto'
        };
        break;
      case 'photo':
      case 'image':
        nodeType = 'image';
        properties = {
          url: s.photo_src || s.photo_url || (typeof s.data === 'object' ? s.data?.url : '') || '',
          alt: s.alt || (typeof s.data === 'object' ? s.data?.alt : '') || ''
        };
        break;
      case 'icon':
        nodeType = 'icon';
        properties = {
          name: s.icon || 'fab fa-wordpress',
          link: s.link ? { url: s.link } : undefined
        };
        break;
      case 'video': {
        nodeType = 'video';
        let beaverVideoUrl = '';
        if (s.video_type === 'embed') {
          const rawEmbed = s.embed_code || '';
          const srcMatch = rawEmbed.match(/src=["']([^"']+)["']/i);
          if (srcMatch && !rawEmbed.includes('<iframe')) {
            beaverVideoUrl = srcMatch[1];
          } else {
            beaverVideoUrl = (typeof s.data === 'object' && s.data?.url) ? s.data.url : rawEmbed;
          }
        } else {
          beaverVideoUrl = (typeof s.data === 'object' ? s.data?.url : '') || (typeof s.video === 'string' && s.video.startsWith('http') ? s.video : '') || '';
        }
        const attId = typeof s.video === 'number' ? s.video : (s.data?.id || undefined);
        if (!beaverVideoUrl && this.fallbackVideos.length > 0) {
          if (attId) {
            const match = this.fallbackVideos.find((v) => v.includes(`/${attId}/`) || v.includes(`id=${attId}`) || v.includes(String(attId)));
            if (match) beaverVideoUrl = match;
          }
          if (!beaverVideoUrl) beaverVideoUrl = this.fallbackVideos[0];
        }
        properties = {
          url: beaverVideoUrl,
          attachmentId: attId,
          autoplay: s.autoplay === 'yes' || s.autoplay === true,
          loop: s.loop === 'yes' || s.loop === true
        };
        break;
      }
      case 'separator':
      case 'divider':
        nodeType = 'divider';
        properties = {
          style: s.style || 'solid',
          color: s.color || '',
          weight: parseInt(s.height || s.weight || '1', 10) || 1
        };
        break;
      case 'audio': {
        nodeType = 'audio';
        let audioUrl = (typeof s.data === 'object' && s.data?.url ? s.data.url : '') || s.link || s.audio || s.embed_code || '';
        const attId = Array.isArray(s.audios) && s.audios.length > 0 ? s.audios[0] : (typeof s.data === 'object' && s.data?.id ? s.data.id : undefined);
        if (!audioUrl && this.fallbackAudios.length > 0) {
          if (attId) {
            const match = this.fallbackAudios.find((a) => a.includes(`/${attId}/`) || a.includes(`id=${attId}`) || a.includes(String(attId)));
            if (match) audioUrl = match;
          }
          if (!audioUrl) audioUrl = this.fallbackAudios[0];
        }
        properties = {
          url: audioUrl,
          attachmentId: attId
        };
        break;
      }
      case 'numbers':
      case 'counter':
      case 'progress-bar':
      case 'progress': {
        nodeType = 'counter';
        const numVal = parseInt(String(s.number ?? s.ending_number ?? s.endNumber ?? '100'), 10) || 100;
        let titleText = s.title || s.text || '';
        let prefixText = s.prefix || '';
        let suffixText = s.after_number_text || s.suffix || '';

        if (!titleText && s.before_number_text) {
          const bText = String(s.before_number_text).trim();
          if (bText.length > 3 || bText.includes(' ')) {
            titleText = bText;
          } else {
            prefixText = bText;
          }
        } else if (!prefixText && s.before_number_text) {
          prefixText = s.before_number_text;
        }

        if (!suffixText && (s.number_type === 'percent' || s.layout === 'percent')) {
          suffixText = '%';
        }

        properties = {
          startNumber: parseInt(String(s.start_number || 0), 10) || 0,
          endNumber: numVal,
          prefix: prefixText,
          suffix: suffixText,
          title: titleText,
          numberColor: normalizeColor(s.number_color),
          titleColor: normalizeColor(s.text_color)
        };
        break;
      }
      case 'callout': {
        nodeType = 'icon-box';
        const ibPos = s.icon_position === 'above-title' ? 'top' : (s.icon_position === 'right' || s.icon_position === 'right-title' ? 'right' : 'left');
        properties = {
          title: s.title || '',
          description: s.text || '',
          icon: s.icon || 'star',
          image: s.photo_src || s.photo || (typeof s.data === 'object' ? s.data?.url : undefined),
          link: (s.link || s.url) ? { url: s.link || s.url } : undefined,
          position: ibPos,
          align: s.align || (ibPos === 'top' ? 'center' : 'left')
        };
        break;
      }
      case 'cta': {
        nodeType = 'icon-box';
        properties = {
          title: s.title || '',
          description: s.text || '',
          buttonText: s.btn_text || '',
          link: (s.btn_link || s.link) ? { url: s.btn_link || s.link } : undefined
        };
        break;
      }
      case 'star-rating':
      case 'rating': {
        nodeType = 'star-rating';
        properties = {
          rating: parseFloat(String(s.rating || '5')) || 5,
          maxRating: s.max_rating || s.maxRating || 5,
          title: s.title || ''
        };
        break;
      }
      case 'spacer': {
        nodeType = 'spacer';
        properties = { height: s.height || '50px' };
        break;
      }
      case 'accordion':
      case 'tabs':
      case 'toggle': {
        nodeType = 'accordion';
        const rawItems = Array.isArray(s.items) ? s.items : (Array.isArray(s.tabs) ? s.tabs : []);
        properties = {
          items: rawItems.map((it: any) => ({
            title: it.label || it.title || it.tab_title || '',
            content: it.content || it.tab_content || it.text || ''
          }))
        };
        break;
      }
      case 'social-links':
      case 'social-buttons':
      case 'social-icons': {
        nodeType = 'social-icons';
        const rawLinks = Array.isArray(s.links) ? s.links : (Array.isArray(s.items) ? s.items : (Array.isArray(s.social_icons) ? s.social_icons : []));
        properties = {
          icons: rawLinks.map((i: any) => ({
            name: i.icon || i.service || i.name || (i.platform ? `fab fa-${i.platform}` : 'fab fa-facebook'),
            link: i.link || i.url || '#'
          }))
        };
        break;
      }
      case 'map':
      case 'google-map':
      case 'google-maps': {
        nodeType = 'map';
        properties = {
          address: s.address || '',
          html: s.address ? `<iframe width="100%" height="400" frameborder="0" src="https://maps.google.com/maps?q=${encodeURIComponent(s.address)}&output=embed"></iframe>` : ''
        };
        break;
      }
      case 'testimonials':
      case 'testimonial': {
        nodeType = 'text';
        let formatted = '';
        if (Array.isArray(s.testimonials)) {
          formatted = s.testimonials.map((t: any) => `<blockquote><p>${t.testimonial || t.text || ''}</p><cite>${t.heading || t.name || ''} ${t.title || t.job ? `(${t.title || t.job})` : ''}</cite></blockquote>`).join('');
        } else {
          formatted = `<blockquote><p>${s.text || s.testimonial || ''}</p><cite>${s.heading || s.name || ''}</cite></blockquote>`;
        }
        properties = { text: formatted };
        break;
      }
      case 'html':
      case 'code': {
        nodeType = 'raw-html';
        properties = { html: s.html || s.code || '' };
        break;
      }
      case 'rich-text':
      default: {
        const snippet = (s?.node || s?.id) ? this.extractHtmlByNodeId(s.node || s.id) : '';
        if (snippet && modType !== 'rich-text') {
          nodeType = 'raw-html';
          properties = { html: snippet };
        } else if (modType === 'rich-text') {
          nodeType = 'text';
          properties = { text: s.text || snippet || '' };
        } else {
          // Unrecognized Beaver Builder module: extract fallback properties so content is not lost
          let fallbackHtml = s.html || s.code || '';
          const title = s.title || s.heading || s.caption;
          const body = s.text || s.description || s.content || s.desc;
          if (!fallbackHtml) {
            const img = s.photo_src || s.photo || (typeof s.data === 'object' ? s.data?.url : '');
            const linkUrl = s.link || s.url || s.btn_link;
            const btnText = s.btn_text || s.button_text;
            if (title || body || img || (btnText && linkUrl)) {
              const parts: string[] = [];
              if (img) parts.push(`<div style="margin-bottom: 12px;"><img src="${img}" style="max-width: 100%; height: auto;" /></div>`);
              if (title) parts.push(`<h3 style="margin: 0 0 8px 0;">${title}</h3>`);
              if (body) parts.push(`<div style="margin-bottom: 8px;">${body}</div>`);
              if (btnText && linkUrl) parts.push(`<div><a href="${linkUrl}" style="display: inline-block; padding: 8px 16px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 4px;">${btnText}</a></div>`);
              fallbackHtml = `<div class="migrated-module-fallback migrated-${modType}">${parts.join('')}</div>`;
            } else if (body) {
              fallbackHtml = body;
            }
          } else if (title && !fallbackHtml.includes(title)) {
            fallbackHtml = `<h3 style="margin: 0 0 8px 0;">${title}</h3>` + fallbackHtml;
          }
          if (fallbackHtml) {
            nodeType = 'raw-html';
            properties = { html: fallbackHtml };
          } else {
            nodeType = 'text';
            properties = { text: s.text || '' };
          }
        }
        break;
      }
    }

    const node = createNode(nodeType, properties, {}, [], {
      originalBuilder: 'beaver-builder',
      originalType: modType,
      rawSettings: s
    });

    if (s.number_color || s.color || s.text_color) {
      node.styles.color = normalizeColor(s.number_color || s.color || s.text_color);
    } else if (modType === 'button') {
      node.styles.color = '#333333';
    }
    if (s.bg_color || s.background_color) {
      node.styles.backgroundColor = normalizeColor(s.bg_color || s.background_color);
    }
    if (modType === 'button') {
      if (s.width === 'full') {
        node.styles.width = '100%';
        node.styles.alignment = 'justify';
      } else if (s.align || s.alignment || s.btn_align) {
        node.styles.alignment = s.align || s.alignment || s.btn_align;
      }
    } else if (modType === 'numbers' || modType === 'counter') {
      const numAlign = s.number_typography?.text_align || s.align || s.alignment || 'center';
      node.styles.alignment = numAlign as 'left' | 'center' | 'right' | 'justify';
    } else if (s.align || s.alignment || s.btn_align) {
      node.styles.alignment = s.align || s.alignment || s.btn_align;
    }
    if (s.border_radius) {
      node.styles.border = node.styles.border || {};
      const rad = String(s.border_radius).replace('px', '').trim();
      node.styles.border.radius = { top: rad, right: rad, bottom: rad, left: rad, unit: 'px' };
    }
    if (s.border_size) {
      node.styles.border = node.styles.border || {};
      node.styles.border.width = String(s.border_size).replace('px', '').trim();
      node.styles.border.style = 'solid';
    }
    if (s.border_color) {
      node.styles.border = node.styles.border || {};
      node.styles.border.color = normalizeColor(s.border_color);
    }
    if (s.font_size) {
      node.styles.typography = node.styles.typography || {};
      if (typeof s.font_size === 'object') {
        node.styles.typography.fontSize = s.font_size.length || s.font_size.size;
        node.styles.typography.fontSizeUnit = s.font_size.unit || 'px';
      } else {
        const dim = parseDimension(s.font_size);
        if (dim) {
          node.styles.typography.fontSize = dim.size;
          node.styles.typography.fontSizeUnit = dim.unit;
        }
      }
    }
    if (s.typography) {
      node.styles.typography = node.styles.typography || {};
      if (s.typography.font_size?.length) {
        node.styles.typography.fontSize = parseFloat(s.typography.font_size.length);
        node.styles.typography.fontSizeUnit = s.typography.font_size.unit || 'px';
      }
      if (s.typography.font_family && s.typography.font_family !== 'Default') {
        node.styles.typography.fontFamily = s.typography.font_family;
      }
      if (s.typography.font_weight) {
        node.styles.typography.fontWeight = String(s.typography.font_weight);
      }
      if (s.typography.line_height) {
        node.styles.typography.lineHeight = String(s.typography.line_height);
      }
      if (s.typography.letter_spacing) {
        node.styles.typography.letterSpacing = String(s.typography.letter_spacing);
      }
      if (s.typography.text_transform) {
        node.styles.typography.textTransform = s.typography.text_transform;
      }
      if (s.typography.text_align) {
        node.styles.alignment = s.typography.text_align;
      }
    }
    if (s.number_typography) {
      node.styles.typography = node.styles.typography || {};
      if (s.number_typography.font_size?.length) {
        node.styles.typography.fontSize = parseFloat(s.number_typography.font_size.length);
        node.styles.typography.fontSizeUnit = s.number_typography.font_size.unit || 'px';
      }
      if (s.number_typography.font_family && s.number_typography.font_family !== 'Default') {
        node.styles.typography.fontFamily = s.number_typography.font_family;
      }
      if (s.number_typography.font_weight && s.number_typography.font_weight !== 'default') {
        node.styles.typography.fontWeight = String(s.number_typography.font_weight);
      }
      if (s.number_typography.line_height?.length) {
        node.styles.typography.lineHeight = String(s.number_typography.line_height.length);
      }
      if (s.number_typography.letter_spacing?.length) {
        node.styles.typography.letterSpacing = String(s.number_typography.letter_spacing.length);
      }
      if (s.number_typography.text_align) {
        node.styles.alignment = s.number_typography.text_align;
      }
    }
    if (s.btn_typography) {
      node.styles.typography = node.styles.typography || {};
      if (s.btn_typography.font_size?.length) {
        node.styles.typography.fontSize = parseFloat(s.btn_typography.font_size.length);
        node.styles.typography.fontSizeUnit = s.btn_typography.font_size.unit || 'px';
      }
      if (s.btn_typography.font_family && s.btn_typography.font_family !== 'Default') {
        node.styles.typography.fontFamily = s.btn_typography.font_family;
      }
      if (s.btn_typography.font_weight) {
        node.styles.typography.fontWeight = String(s.btn_typography.font_weight);
      }
    }
    if (s.padding_top || s.padding_bottom) {
      node.styles.padding = {
        top: s.padding_top || '0',
        bottom: s.padding_bottom || '0',
        left: s.padding_left || '0',
        right: s.padding_right || '0',
        unit: 'px'
      };
    }
    if (s.margin_top || s.margin_bottom) {
      node.styles.margin = {
        top: s.margin_top || '0',
        bottom: s.margin_bottom || '0',
        left: s.margin_left || '0',
        right: s.margin_right || '0',
        unit: 'px'
      };
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // GUTENBERG / BLOCKS PARSING
  // ---------------------------------------------------------------------------
  private parseGutenbergBlockList(html: string): Array<{ name: string; attrs: any; innerContent: string; innerBlocks: string }> {
    const blocks: Array<{ name: string; attrs: any; innerContent: string; innerBlocks: string }> = [];
    const openTagRegex = /<!--\s+wp:([a-z0-9\/-]+)\s*(\{.*?\})?\s*(\/)?-->/g;
    let match;

    while ((match = openTagRegex.exec(html)) !== null) {
      const blockName = match[1];
      const attrJson = match[2];
      const isSelfClosing = match[3] === '/';
      const tagEndIndex = openTagRegex.lastIndex;

      let attrs: any = {};
      if (attrJson) {
        try { attrs = JSON.parse(attrJson); } catch { }
      }

      if (isSelfClosing) {
        blocks.push({ name: blockName, attrs, innerContent: '', innerBlocks: '' });
        continue;
      }

      const closeTag = `<!-- /wp:${blockName} -->`;
      const openTagPrefix = `<!-- wp:${blockName}`;
      let depth = 1;
      let searchPos = tagEndIndex;
      let closeIndex = -1;

      while (depth > 0 && searchPos < html.length) {
        const nextOpen = html.indexOf(openTagPrefix, searchPos);
        const nextClose = html.indexOf(closeTag, searchPos);

        if (nextClose === -1) break;

        if (nextOpen !== -1 && nextOpen < nextClose) {
          const subOpenEnd = html.indexOf('-->', nextOpen);
          if (subOpenEnd !== -1 && html.slice(nextOpen, subOpenEnd + 3).includes('/-->')) {
            searchPos = subOpenEnd + 3;
            continue;
          }
          depth++;
          searchPos = subOpenEnd !== -1 ? subOpenEnd + 3 : nextOpen + openTagPrefix.length;
        } else {
          depth--;
          if (depth === 0) {
            closeIndex = nextClose;
            break;
          }
          searchPos = nextClose + closeTag.length;
        }
      }

      if (closeIndex !== -1) {
        const inner = html.slice(tagEndIndex, closeIndex);
        blocks.push({ name: blockName, attrs, innerContent: inner, innerBlocks: inner });
        openTagRegex.lastIndex = closeIndex + closeTag.length;
      }
    }

    return blocks;
  }

  private parseGutenbergBlocks(html: string, parentNode: UniversalNode): void {
    const blocks = this.parseGutenbergBlockList(html);
    if (blocks.length === 0) {
      this.parseHtmlFallback(html, parentNode);
      return;
    }

    for (const b of blocks) {
      if (b.name === 'group' || b.name === 'columns') {
        const secStyles: UniversalStyles = {};
        if (b.attrs.style?.color?.background) secStyles.backgroundColor = normalizeColor(b.attrs.style.color.background);
        if (b.attrs.layout?.contentSize) secStyles.maxWidth = b.attrs.layout.contentSize;
        const sectionNode = createNode('section', {}, secStyles, [], { originalBuilder: 'gutenberg', originalType: b.name });
        parentNode.children.push(sectionNode);

        const innerBlocks = this.parseGutenbergBlockList(b.innerBlocks);
        if (innerBlocks.some((ib) => ib.name === 'columns' || ib.name === 'column')) {
          for (const ib of innerBlocks) {
            if (ib.name === 'columns') {
              const colBlocks = this.parseGutenbergBlockList(ib.innerBlocks);
              for (const cb of colBlocks) {
                const colSpan = cb.attrs.width ? parseFloat(cb.attrs.width) : (100 / Math.max(colBlocks.length, 1));
                const colNode = createNode('column', {}, { width: `${colSpan}%` }, [], { originalBuilder: 'gutenberg', originalType: 'column', columnSpan: colSpan });
                sectionNode.children.push(colNode);
                this.parseGutenbergLeafBlocks(cb.innerBlocks, colNode);
              }
            } else if (ib.name === 'column') {
              const colSpan = ib.attrs.width ? parseFloat(ib.attrs.width) : 100;
              const colNode = createNode('column', {}, { width: `${colSpan}%` }, [], { originalBuilder: 'gutenberg', originalType: 'column', columnSpan: colSpan });
              sectionNode.children.push(colNode);
              this.parseGutenbergLeafBlocks(ib.innerBlocks, colNode);
            }
          }
        } else {
          const colNode = createNode('column', {}, { width: '100%' }, [], { originalBuilder: 'gutenberg', originalType: 'column', columnSpan: 100 });
          sectionNode.children.push(colNode);
          this.parseGutenbergLeafBlocks(b.innerBlocks, colNode);
        }
      } else {
        let targetCol: UniversalNode;
        if (parentNode.children.length > 0 && parentNode.children[parentNode.children.length - 1].type === 'section') {
          const lastSec = parentNode.children[parentNode.children.length - 1];
          targetCol = lastSec.children[0];
        } else {
          const sec = createNode('section', {}, {}, [], { originalBuilder: 'gutenberg' });
          targetCol = createNode('column', {}, { width: '100%' }, [], { originalBuilder: 'gutenberg', columnSpan: 100 });
          sec.children.push(targetCol);
          parentNode.children.push(sec);
        }
        this.parseGutenbergSingleBlock(b, targetCol);
      }
    }
  }

  private parseGutenbergLeafBlocks(html: string, colNode: UniversalNode): void {
    const blocks = this.parseGutenbergBlockList(html);
    for (const b of blocks) {
      this.parseGutenbergSingleBlock(b, colNode);
    }
  }

  private parseGutenbergSingleBlock(
    b: { name: string; attrs: any; innerContent: string; innerBlocks: string },
    colNode: UniversalNode
  ): void {
    const styles: UniversalStyles = {};
    if (b.attrs.style?.color?.text) styles.color = normalizeColor(b.attrs.style.color.text);
    if (b.attrs.style?.color?.background) styles.backgroundColor = normalizeColor(b.attrs.style.color.background);
    if (b.attrs.textAlign || b.attrs.align) styles.alignment = b.attrs.textAlign || b.attrs.align;
    if (b.attrs.style?.typography) {
      styles.typography = {};
      if (b.attrs.style.typography.fontSize) {
        const dim = parseDimension(b.attrs.style.typography.fontSize);
        styles.typography.fontSize = dim?.size;
        styles.typography.fontSizeUnit = dim?.unit || 'px';
      }
      if (b.attrs.style.typography.fontFamily) styles.typography.fontFamily = b.attrs.style.typography.fontFamily;
      if (b.attrs.style.typography.fontWeight) styles.typography.fontWeight = String(b.attrs.style.typography.fontWeight);
      if (b.attrs.style.typography.lineHeight) styles.typography.lineHeight = String(b.attrs.style.typography.lineHeight);
      if (b.attrs.style.typography.letterSpacing) styles.typography.letterSpacing = String(b.attrs.style.typography.letterSpacing);
    }

    const inlineStyleMatch = b.innerContent.match(/style=["'](.*?)["']/i);
    if (inlineStyleMatch) {
      const inlineStyles = parseInlineCss(inlineStyleMatch[1]);
      Object.assign(styles, { ...inlineStyles, ...styles });
    }

    const blockName = b.name.replace(/^core\//, '');

    if (blockName === 'heading') {
      const text = b.innerContent.replace(/<[^>]+>/g, '').trim();
      const levelMatch = b.innerContent.match(/<h([1-6])/i);
      const level = levelMatch ? `h${levelMatch[1]}` : (b.attrs.level ? `h${b.attrs.level}` : 'h2');
      colNode.children.push(createNode('heading', { text, level }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'paragraph') {
      const text = b.innerContent.replace(/<[^>]+>/g, '').trim();
      colNode.children.push(createNode('text', { text }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'buttons') {
      const btnBlocks = this.parseGutenbergBlockList(b.innerBlocks || b.innerContent);
      const parentAlign = b.attrs.layout?.justifyContent || b.attrs.align || '';
      for (const btnBlock of btnBlocks) {
        if (parentAlign && !btnBlock.attrs.align) {
          btnBlock.attrs.align = parentAlign;
        }
        this.parseGutenbergSingleBlock(btnBlock, colNode);
      }
    } else if (blockName === 'button') {
      const text = b.innerContent.replace(/<[^>]+>/g, '').trim();
      const hrefMatch = b.innerContent.match(/href=["'](.*?)["']/i);
      const isFull = b.attrs.width === 100 || b.attrs.className?.includes('wp-block-button__width-100') || b.innerContent.includes('wp-block-button__width-100');
      if (isFull) {
        styles.width = '100%';
        styles.alignment = 'justify';
      }
      colNode.children.push(createNode('button', {
        text,
        link: { url: hrefMatch ? hrefMatch[1] : (b.attrs.url || '#') },
        width: isFull ? 'full' : 'auto'
      }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'image') {
      const srcMatch = b.innerContent.match(/src=["'](.*?)["']/);
      const altMatch = b.innerContent.match(/alt=["'](.*?)["']/);
      colNode.children.push(createNode('image', { url: srcMatch ? srcMatch[1] : (b.attrs.url || ''), alt: altMatch ? altMatch[1] : (b.attrs.alt || '') }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'video') {
      const srcMatch = b.innerContent.match(/src=["'](.*?)["']/i);
      const url = b.attrs.src || (srcMatch ? srcMatch[1] : '');
      colNode.children.push(createNode('video', { url }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'embed') {
      const urlMatch = b.innerContent.match(/https?:\/\/[^\s<"']+/i);
      const url = b.attrs.url || (urlMatch ? urlMatch[0] : '');
      const provider = (b.attrs.providerNameSlug || '').toLowerCase();
      if (provider === 'audio' || provider === 'soundcloud') {
        colNode.children.push(createNode('audio', { url }, styles, [], { originalBuilder: 'gutenberg' }));
      } else {
        colNode.children.push(createNode('video', { url }, styles, [], { originalBuilder: 'gutenberg' }));
      }
    } else if (blockName === 'audio') {
      const srcMatch = b.innerContent.match(/src=["'](.*?)["']/i);
      const url = b.attrs.src || (srcMatch ? srcMatch[1] : '');
      colNode.children.push(createNode('audio', { url }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'separator') {
      colNode.children.push(createNode('divider', { style: 'solid', weight: 1, width: '100%' }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'spacer') {
      const hMatch = b.innerContent.match(/height:\s*([0-9]+(?:px|em|rem)?)/i);
      const height = b.attrs.height ? (typeof b.attrs.height === 'number' ? `${b.attrs.height}px` : b.attrs.height) : (hMatch ? hMatch[1] : '50px');
      colNode.children.push(createNode('spacer', { height }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'details') {
      const sumMatch = b.innerContent.match(/<summary>([\s\S]*?)<\/summary>/i);
      const summary = sumMatch ? sumMatch[1].replace(/<[^>]+>/g, '').trim() : 'Details';
      const content = b.innerContent.replace(/<summary>[\s\S]*?<\/summary>/i, '').replace(/<\/?details[^>]*>/gi, '').trim();
      colNode.children.push(createNode('accordion', {
        items: [{ title: summary, content }]
      }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'social-links') {
      const linkBlocks = this.parseGutenbergBlockList(b.innerBlocks || b.innerContent);
      const icons: Array<{ name: string; link: string }> = [];
      for (const lb of linkBlocks) {
        if (lb.name.includes('social-link')) {
          const service = lb.attrs.service || 'facebook';
          const url = lb.attrs.url || '#';
          icons.push({ name: `fab fa-${service}`, link: url });
        }
      }
      if (icons.length === 0) {
        const linkRegex = /<!--\s+wp:(?:core\/)?social-link\s*(\{.*?\})?\s*\/-->/g;
        let lm;
        while ((lm = linkRegex.exec(b.innerContent)) !== null) {
          try {
            const json = JSON.parse(lm[1]);
            icons.push({ name: `fab fa-${json.service || 'facebook'}`, link: json.url || '#' });
          } catch { }
        }
      }
      colNode.children.push(createNode('social-icons', { icons }, styles, [], { originalBuilder: 'gutenberg' }));
    } else if (blockName === 'group') {
      if (b.attrs.className?.includes('wp-block-counter') || b.innerContent.includes('counter-number')) {
        const numMatch = b.innerContent.match(/<p[^>]*class=["'][^"']*counter-number[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
        const titleMatch = b.innerContent.match(/<p[^>]*class=["'][^"']*counter-title[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
        const numText = numMatch ? numMatch[1].replace(/<[^>]+>/g, '').trim() : '100';
        const parsedDigits = numText.match(/^([^0-9]*)([0-9]+)([^0-9]*)$/);
        const prefix = parsedDigits ? parsedDigits[1] : '';
        const endNumber = parsedDigits ? parseInt(parsedDigits[2], 10) : (parseInt(numText, 10) || 100);
        const suffix = parsedDigits ? parsedDigits[3] : '';
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        colNode.children.push(createNode('counter', { startNumber: 0, endNumber, prefix, suffix, title }, styles, [], { originalBuilder: 'gutenberg' }));
      } else if (b.attrs.className?.includes('wp-block-icon-box') || b.innerContent.includes('wp-block-icon-box')) {
        const titleMatch = b.innerContent.match(/<h[1-6][^>]*class=["'][^"']*icon-box-title[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i);
        const descMatch = b.innerContent.match(/<p[^>]*class=["'][^"']*icon-box-desc[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
        const iconMatch = b.innerContent.match(/<i[^>]*class=["']([^"']+)["']/i);
        const isFlexRow = b.innerContent.includes('display:flex') || b.innerContent.includes('gap:');
        colNode.children.push(createNode('icon-box', {
          title: titleMatch ? titleMatch[1].trim() : '',
          description: descMatch ? descMatch[1].trim() : '',
          icon: iconMatch ? iconMatch[1] : 'star',
          position: isFlexRow ? 'left' : 'top'
        }, styles, [], { originalBuilder: 'gutenberg' }));
      } else {
        this.parseGutenbergLeafBlocks(b.innerBlocks || b.innerContent, colNode);
      }
    } else if (blockName === 'html' || blockName === 'code') {
      const raw = b.innerContent || '';
      if (raw.includes('<audio') || raw.includes('[audio')) {
        const srcMatch = raw.match(/src=["']([^"']+)["']/i);
        colNode.children.push(createNode('audio', { url: srcMatch ? srcMatch[1] : '' }, styles, [], { originalBuilder: 'gutenberg' }));
      } else if (raw.includes('<video') || raw.includes('[video')) {
        const srcMatch = raw.match(/src=["']([^"']+)["']/i);
        colNode.children.push(createNode('video', { url: srcMatch ? srcMatch[1] : '' }, styles, [], { originalBuilder: 'gutenberg' }));
      } else if (raw.includes('maps.google.com')) {
        const addrMatch = raw.match(/q=([^&"']+)/i);
        const address = addrMatch ? decodeURIComponent(addrMatch[1]) : '';
        colNode.children.push(createNode('map', { address, html: raw }, styles, [], { originalBuilder: 'gutenberg' }));
      } else if (raw.includes('wp-block-star-rating') || raw.includes('★')) {
        const starCount = (raw.match(/★/g) || []).length;
        const titleMatch = raw.match(/<strong>([\s\S]*?)<\/strong>/i);
        colNode.children.push(createNode('star-rating', {
          rating: starCount || 5,
          maxRating: 5,
          title: titleMatch ? titleMatch[1].trim() : ''
        }, styles, [], { originalBuilder: 'gutenberg' }));
      } else if (raw.includes('wp-block-icon')) {
        const iconMatch = raw.match(/<i[^>]*class=["']([^"']+)["']/i);
        colNode.children.push(createNode('icon', {
          name: iconMatch ? iconMatch[1] : 'fab fa-wordpress',
          icon: iconMatch ? iconMatch[1] : 'fab fa-wordpress'
        }, styles, [], { originalBuilder: 'gutenberg' }));
      } else {
        colNode.children.push(createNode('raw-html', { html: raw }, styles, [], { originalBuilder: 'gutenberg' }));
      }
    } else if (blockName === 'list' || blockName === 'quote' || blockName === 'pullquote') {
      colNode.children.push(createNode('text', { text: b.innerContent }, styles, [], { originalBuilder: 'gutenberg' }));
    } else {
      const text = b.innerContent.replace(/<[^>]+>/g, '').trim();
      if (text) {
        colNode.children.push(createNode('text', { text }, styles, [], { originalBuilder: 'gutenberg' }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SHORTCODE PARSING (Divi and generic shortcodes)
  // ---------------------------------------------------------------------------
  private parseShortcodes(text: string, parentNode: UniversalNode): void {
    if (!text.includes('[et_pb_')) {
      const section = createNode('section', {}, {}, [], { originalBuilder: 'shortcode', originalType: 'section' });
      const col = createNode('column', {}, {}, [], { originalBuilder: 'shortcode', originalType: 'column', columnSpan: 100 });
      section.children.push(col);

      const titleMatch = text.match(/title=["'](.*?)["']/);
      if (titleMatch) {
        col.children.push(createNode('heading', { text: titleMatch[1], level: 'h2' }, {}, [], { originalBuilder: 'shortcode' }));
      }
      const buttonMatch = text.match(/button_text=["'](.*?)["']/);
      if (buttonMatch) {
        col.children.push(createNode('button', { text: buttonMatch[1], link: { url: '#' } }, {}, [], { originalBuilder: 'shortcode' }));
      }
      const plain = text.replace(/\[\/?et_pb_[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain) {
        col.children.push(createNode('text', { text: plain }, {}, [], { originalBuilder: 'shortcode' }));
      }
      parentNode.children.push(section);
      return;
    }

    // Match sections: [et_pb_section ...] ... [/et_pb_section]
    const sectionRegex = /\[et_pb_section([^\]]*)\]([\s\S]*?)\[\/et_pb_section\]/gi;
    let secMatch;
    let foundSection = false;

    while ((secMatch = sectionRegex.exec(text)) !== null) {
      foundSection = true;
      const secAttrs = parseShortcodeAttributes(secMatch[1]);
      const secContent = secMatch[2];

      const secStyles: UniversalStyles = {};
      if (secAttrs.background_color) secStyles.backgroundColor = normalizeColor(secAttrs.background_color);
      if (secAttrs.custom_padding) secStyles.padding = parseDiviSpacing(secAttrs.custom_padding);
      if (secAttrs.custom_margin) secStyles.margin = parseDiviSpacing(secAttrs.custom_margin);
      if (secAttrs.max_width) secStyles.maxWidth = secAttrs.max_width;

      // Match rows inside section: [et_pb_row ...] ... [/et_pb_row]
      const rowRegex = /\[et_pb_row([^\]]*)\]([\s\S]*?)\[\/et_pb_row\]/gi;
      let rowMatch;
      const rowMatches: Array<{ attrs: any; content: string }> = [];

      while ((rowMatch = rowRegex.exec(secContent)) !== null) {
        rowMatches.push({
          attrs: parseShortcodeAttributes(rowMatch[1]),
          content: rowMatch[2]
        });
      }

      if (rowMatches.length === 0) {
        const sectionNode = createNode('section', {}, secStyles, [], {
          originalBuilder: 'divi',
          originalType: 'section',
          rawAttrs: secAttrs
        });
        const colNode = createNode('column', {}, { width: '100%' }, [], {
          originalBuilder: 'divi',
          originalType: 'column',
          columnSpan: 100
        });
        sectionNode.children.push(colNode);
        parentNode.children.push(sectionNode);
        this.parseDiviModules(secContent, colNode);
      } else {
        for (const rowItem of rowMatches) {
          const rowAttrs = rowItem.attrs;
          const rowContent = rowItem.content;
          const rStyles: UniversalStyles = { ...secStyles };
          if (rowAttrs.max_width) {
            rStyles.maxWidth = rowAttrs.max_width;
          }

          const sectionNode = createNode('section', {}, rStyles, [], {
            originalBuilder: 'divi',
            originalType: 'section',
            rawAttrs: secAttrs,
            rowAttrs
          });
          parentNode.children.push(sectionNode);

          // Match columns inside row: [et_pb_column ...] ... [/et_pb_column]
          const colRegex = /\[et_pb_column([^\]]*)\]([\s\S]*?)\[\/et_pb_column\]/gi;
          let colMatch;
          let foundCol = false;

          while ((colMatch = colRegex.exec(rowContent)) !== null) {
            foundCol = true;
            const colAttrs = parseShortcodeAttributes(colMatch[1]);
            const colContent = colMatch[2];
            const colSpan = parseDiviColumnSpan(colAttrs.type);

            const colStyles: UniversalStyles = { width: `${colSpan}%` };
            if (colAttrs.custom_padding) colStyles.padding = parseDiviSpacing(colAttrs.custom_padding);

            const colNode = createNode('column', {}, colStyles, [], {
              originalBuilder: 'divi',
              originalType: 'column',
              columnSpan: colSpan,
              rawAttrs: colAttrs
            });
            sectionNode.children.push(colNode);

            this.parseDiviModules(colContent, colNode);
          }

          if (!foundCol) {
            const colNode = createNode('column', {}, { width: '100%' }, [], {
              originalBuilder: 'divi',
              originalType: 'column',
              columnSpan: 100
            });
            sectionNode.children.push(colNode);
            this.parseDiviModules(rowContent, colNode);
          }
        }
      }
    }

    if (!foundSection) {
      const sectionNode = createNode('section', {}, {}, [], { originalBuilder: 'divi', originalType: 'section' });
      const colNode = createNode('column', {}, { width: '100%' }, [], { originalBuilder: 'divi', originalType: 'column', columnSpan: 100 });
      sectionNode.children.push(colNode);
      parentNode.children.push(sectionNode);
      this.parseDiviModules(text, colNode);
    }
  }

  private parseDiviModules(content: string, colNode: UniversalNode): void {
    const moduleRegex = /\[et_pb_([a-zA-Z0-9_-]+)([^\]]*)\](?:([\s\S]*?)\[\/et_pb_\1\])?/gi;
    let match;

    while ((match = moduleRegex.exec(content)) !== null) {
      const modType = match[1].toLowerCase();
      const attrStr = match[2];
      const inner = (match[3] || '').trim();
      const attrs = parseShortcodeAttributes(attrStr);

      if (modType === 'section' || modType === 'row' || modType === 'column') {
        continue;
      }

      if (modType === 'heading') {
        const text = attrs.title || inner.replace(/<[^>]+>/g, '').trim();
        const level = attrs.title_level || 'h2';
        const styles: UniversalStyles = {};
        if (attrs.title_text_color) styles.color = normalizeColor(attrs.title_text_color);
        if (attrs.title_font_size) {
          const dim = parseDimension(attrs.title_font_size);
          styles.typography = { fontSize: dim?.size, fontSizeUnit: dim?.unit || 'px' };
        }
        if (attrs.title_font) {
          styles.typography = styles.typography || {};
          styles.typography.fontFamily = attrs.title_font;
        }
        if (attrs.title_font_weight) {
          styles.typography = styles.typography || {};
          styles.typography.fontWeight = attrs.title_font_weight;
        }
        if (attrs.title_text_align) styles.alignment = attrs.title_text_align as any;
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        if (attrs.custom_padding) styles.padding = parseDiviSpacing(attrs.custom_padding);

        colNode.children.push(createNode('heading', { text, level }, styles, [], { originalBuilder: 'divi', originalType: 'heading' }));
      } else if (modType === 'text') {
        const hMatch = inner.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i);
        if (hMatch || attrs.header_text_color || attrs.header_font_size) {
          const level = hMatch ? `h${hMatch[1]}` : 'h2';
          const text = (hMatch ? hMatch[2] : inner).replace(/<[^>]+>/g, '').trim();
          const styles: UniversalStyles = {};
          if (attrs.header_text_color) styles.color = normalizeColor(attrs.header_text_color);
          if (attrs.header_font_size) {
            const dim = parseDimension(attrs.header_font_size);
            styles.typography = { fontSize: dim?.size, fontSizeUnit: dim?.unit || 'px' };
          }
          if (attrs.header_font) {
            styles.typography = styles.typography || {};
            styles.typography.fontFamily = attrs.header_font;
          }
          if (attrs.header_font_weight) {
            styles.typography = styles.typography || {};
            styles.typography.fontWeight = attrs.header_font_weight;
          }
          if (attrs.header_line_height) {
            styles.typography = styles.typography || {};
            styles.typography.lineHeight = attrs.header_line_height;
          }
          if (attrs.header_letter_spacing) {
            styles.typography = styles.typography || {};
            styles.typography.letterSpacing = attrs.header_letter_spacing;
          }
          if (attrs.text_orientation || attrs.header_text_align) {
            styles.alignment = (attrs.header_text_align || attrs.text_orientation) as any;
          }
          if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
          if (attrs.custom_padding) styles.padding = parseDiviSpacing(attrs.custom_padding);

          colNode.children.push(createNode('heading', { text, level }, styles, [], { originalBuilder: 'divi', originalType: 'text' }));
        } else {
          const text = inner || attrs.content || '';
          const styles: UniversalStyles = {};
          if (attrs.text_text_color) styles.color = normalizeColor(attrs.text_text_color);
          if (attrs.text_font_size) {
            const dim = parseDimension(attrs.text_font_size);
            styles.typography = { fontSize: dim?.size, fontSizeUnit: dim?.unit || 'px' };
          }
          if (attrs.text_font) {
            styles.typography = styles.typography || {};
            styles.typography.fontFamily = attrs.text_font;
          }
          if (attrs.text_font_weight) {
            styles.typography = styles.typography || {};
            styles.typography.fontWeight = attrs.text_font_weight;
          }
          if (attrs.text_line_height) {
            styles.typography = styles.typography || {};
            styles.typography.lineHeight = attrs.text_line_height;
          }
          if (attrs.text_letter_spacing) {
            styles.typography = styles.typography || {};
            styles.typography.letterSpacing = attrs.text_letter_spacing;
          }
          if (attrs.text_orientation) styles.alignment = attrs.text_orientation as any;
          if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
          if (attrs.custom_padding) styles.padding = parseDiviSpacing(attrs.custom_padding);

          colNode.children.push(createNode('text', { text }, styles, [], { originalBuilder: 'divi', originalType: 'text' }));
        }
      } else if (modType === 'button') {
        const text = attrs.button_text || 'Click Here';
        const url = attrs.button_url || '#';
        const openInNewTab = attrs.url_new_window === 'on';

        const styles: UniversalStyles = {};
        if (attrs.button_text_color) styles.color = normalizeColor(attrs.button_text_color);
        if (attrs.button_bg_color) styles.backgroundColor = normalizeColor(attrs.button_bg_color);
        if (attrs.button_border_color) {
          styles.border = styles.border || {};
          styles.border.color = normalizeColor(attrs.button_border_color);
        }
        if (attrs.button_border_width) {
          styles.border = styles.border || {};
          styles.border.width = attrs.button_border_width.replace('px', '').trim();
          styles.border.style = 'solid';
        }
        if (attrs.button_border_radius) {
          styles.border = styles.border || {};
          const rad = attrs.button_border_radius.replace('px', '').trim();
          styles.border.radius = { top: rad, right: rad, bottom: rad, left: rad, unit: 'px' };
        }
        if (attrs.button_font_size) {
          const dim = parseDimension(attrs.button_font_size);
          styles.typography = { fontSize: dim?.size, fontSizeUnit: dim?.unit || 'px' };
        }
        if (attrs.button_font) {
          styles.typography = styles.typography || {};
          styles.typography.fontFamily = attrs.button_font;
        }
        if (attrs.button_font_weight) {
          styles.typography = styles.typography || {};
          styles.typography.fontWeight = attrs.button_font_weight;
        }
        const isFull = attrs.button_alignment === 'justify' || attrs.custom_css_main_element?.includes('100%');
        if (isFull) {
          styles.width = '100%';
          styles.alignment = 'justify';
        } else if (attrs.button_alignment) {
          styles.alignment = attrs.button_alignment as any;
        }
        if (attrs.custom_padding) styles.padding = parseDiviSpacing(attrs.custom_padding);
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);

        colNode.children.push(createNode('button', {
          text,
          link: { url, openInNewTab },
          width: isFull ? 'full' : 'auto'
        }, styles, [], { originalBuilder: 'divi', originalType: 'button' }));
      } else if (modType === 'image') {
        const url = attrs.src || '';
        const alt = attrs.alt || '';
        const styles: UniversalStyles = {};
        if (attrs.align) styles.alignment = attrs.align as any;
        if (attrs.max_width || attrs.width) styles.maxWidth = attrs.max_width || attrs.width;
        if (attrs.border_radii) {
          const parts = attrs.border_radii.split('|');
          const rad = (parts[1] || '0').replace('px', '').trim();
          styles.border = { radius: { top: rad, right: rad, bottom: rad, left: rad, unit: 'px' } };
        }
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);

        colNode.children.push(createNode('image', { url, alt }, styles, [], { originalBuilder: 'divi', originalType: 'image' }));
      } else if (modType === 'blurb' || modType === 'icon') {
        const iconCode = attrs.font_icon || '&#x57;';
        const color = normalizeColor(attrs.icon_color || '#000000');
        const sizeDim = parseDimension(attrs.font_size || attrs.image_icon_width || '30px');
        const pos = attrs.icon_placement === 'left' ? 'left' : (attrs.icon_placement === 'right' ? 'right' : 'top');
        const align = (attrs.icon_alignment || attrs.text_orientation || (pos === 'top' ? 'center' : 'left')) as any;

        const styles: UniversalStyles = {
          color,
          alignment: align,
          typography: { fontSize: sizeDim?.size || 30, fontSizeUnit: sizeDim?.unit || 'px' }
        };

        if (attrs.title) {
          colNode.children.push(createNode('icon-box', {
            title: attrs.title,
            description: inner.replace(/<[^>]+>/g, '').trim(),
            icon: iconCode,
            position: pos,
            align
          }, styles, [], { originalBuilder: 'divi', originalType: 'blurb' }));
        } else {
          colNode.children.push(createNode('icon', {
            name: iconCode,
            icon: iconCode
          }, styles, [], { originalBuilder: 'divi', originalType: 'icon' }));
        }
      } else if (modType === 'video') {
        const url = attrs.src || attrs.src_webm || inner.replace(/<[^>]+>/g, '').trim() || '';
        const styles: UniversalStyles = {};
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        colNode.children.push(createNode('video', {
          url,
          autoplay: attrs.play_on_hover === 'on',
          loop: attrs.loop_bkg === 'on'
        }, styles, [], { originalBuilder: 'divi', originalType: 'video' }));
      } else if (modType === 'audio') {
        const url = attrs.audio || attrs.audio_url || attrs.src || inner.replace(/<[^>]+>/g, '').trim() || '';
        const title = attrs.title || '';
        const styles: UniversalStyles = {};
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        colNode.children.push(createNode('audio', { url, title }, styles, [], { originalBuilder: 'divi', originalType: 'audio' }));
      } else if (modType === 'accordion') {
        const items: Array<{ title: string; content: string }> = [];
        const itemRegex = /\[et_pb_accordion_item([^\]]*)\]([\s\S]*?)\[\/et_pb_accordion_item\]/gi;
        let itemMatch;
        while ((itemMatch = itemRegex.exec(inner)) !== null) {
          const itemAttrs = parseShortcodeAttributes(itemMatch[1]);
          items.push({
            title: itemAttrs.title || '',
            content: itemMatch[2].trim()
          });
        }
        const styles: UniversalStyles = {};
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        colNode.children.push(createNode('accordion', { items }, styles, [], { originalBuilder: 'divi', originalType: 'accordion' }));
      } else if (modType === 'toggle') {
        const styles: UniversalStyles = {};
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        colNode.children.push(createNode('accordion', {
          items: [{ title: attrs.title || '', content: inner.trim() }]
        }, styles, [], { originalBuilder: 'divi', originalType: 'toggle' }));
      } else if (modType === 'number_counter' || modType === 'circle_counter') {
        const endNumber = parseInt(attrs.number || '100', 10) || 100;
        const title = attrs.title || '';
        const suffix = attrs.percent_sign === 'on' ? '%' : '';
        const styles: UniversalStyles = {};
        if (attrs.number_text_color) styles.color = normalizeColor(attrs.number_text_color);
        if (attrs.text_orientation) styles.alignment = attrs.text_orientation as any;
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        if (attrs.number_font_size) {
          const dim = parseDimension(attrs.number_font_size);
          if (dim) {
            styles.typography = { fontSize: dim.size, fontSizeUnit: dim.unit };
          }
        }
        colNode.children.push(createNode('counter', {
          startNumber: 0,
          endNumber,
          title,
          suffix,
          prefix: '',
          numberColor: styles.color
        }, styles, [], { originalBuilder: 'divi', originalType: modType }));
      } else if (modType === 'counters' || modType === 'bar_counters') {
        const counterRegex = /\[et_pb_counter([^\]]*)\]([\s\S]*?)\[\/et_pb_counter\]/gi;
        let cMatch;
        let found = false;
        while ((cMatch = counterRegex.exec(inner)) !== null) {
          found = true;
          const cAttrs = parseShortcodeAttributes(cMatch[1]);
          const percent = parseInt(cAttrs.percent || '100', 10) || 100;
          const title = cMatch[2].replace(/<[^>]+>/g, '').trim();
          colNode.children.push(createNode('counter', { startNumber: 0, endNumber: percent, title, suffix: '%' }, {}, [], { originalBuilder: 'divi', originalType: 'counter' }));
        }
        if (!found) {
          colNode.children.push(createNode('counter', { startNumber: 0, endNumber: 100, title: '' }, {}, [], { originalBuilder: 'divi', originalType: modType }));
        }
      } else if (modType === 'social_media_follow') {
        const icons: Array<{ name: string; link: string }> = [];
        const netRegex = /\[et_pb_social_media_follow_network([^\]]*)\]([\s\S]*?)\[\/et_pb_social_media_follow_network\]/gi;
        let netMatch;
        while ((netMatch = netRegex.exec(inner)) !== null) {
          const netAttrs = parseShortcodeAttributes(netMatch[1]);
          const platform = netAttrs.social_network || 'facebook';
          icons.push({
            name: `fab fa-${platform}`,
            link: netAttrs.url || '#'
          });
        }
        const styles: UniversalStyles = {};
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        colNode.children.push(createNode('social-icons', { icons }, styles, [], { originalBuilder: 'divi', originalType: 'social_media_follow' }));
      } else if (modType === 'map') {
        const pinMatch = inner.match(/pin_address=["']([^"']+)["']/i);
        const address = attrs.address || (pinMatch ? pinMatch[1] : '');
        const styles: UniversalStyles = {};
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        colNode.children.push(createNode('map', {
          address,
          html: address ? `<iframe width="100%" height="400" frameborder="0" src="https://maps.google.com/maps?q=${encodeURIComponent(address)}&output=embed"></iframe>` : ''
        }, styles, [], { originalBuilder: 'divi', originalType: 'map' }));
      } else if (modType === 'code') {
        colNode.children.push(createNode('raw-html', { html: inner }, {}, [], { originalBuilder: 'divi', originalType: 'code' }));
      } else if (modType === 'testimonial') {
        const author = attrs.author || '';
        const job = attrs.job_title || '';
        const company = attrs.company_name || '';
        const quote = inner.replace(/<[^>]+>/g, '').trim();
        const formatted = `<blockquote><p>${quote}</p><cite>${author}${job ? ` (${job}${company ? `, ${company}` : ''})` : ''}</cite></blockquote>`;
        colNode.children.push(createNode('text', { text: formatted }, {}, [], { originalBuilder: 'divi', originalType: 'testimonial' }));
      } else if (modType === 'divider') {
        const styles: UniversalStyles = {};
        if (attrs.color) styles.color = normalizeColor(attrs.color);
        if (attrs.custom_margin) styles.margin = parseDiviSpacing(attrs.custom_margin);
        if (attrs.show_divider === 'off' || attrs.divider_style === 'none') {
          const height = attrs.height || attrs.divider_weight || '50px';
          colNode.children.push(createNode('spacer', { height }, styles, [], { originalBuilder: 'divi', originalType: 'divider' }));
        } else {
          const weight = attrs.divider_weight ? parseInt(attrs.divider_weight, 10) : 1;
          const width = attrs.max_width || attrs.width || '100%';
          colNode.children.push(createNode('divider', { style: 'solid', weight, width, color: styles.color }, styles, [], { originalBuilder: 'divi', originalType: 'divider' }));
        }
      } else if (inner.trim()) {
        colNode.children.push(createNode('raw-html', { html: inner.trim() }, {}, [], { originalBuilder: 'divi', originalType: modType }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // BEAVER BUILDER HTML PARSING
  // ---------------------------------------------------------------------------
  private parseBeaverHtml(html: string, parentNode: UniversalNode): void {
    const cleanHtml = html
      .replace(/<!--\s*\/?wp:fl-builder\/layout\s*-->/g, '')
      .trim();

    // Extract CSS rules from any embedded <style> blocks
    const cssMap: Record<string, UniversalStyles> = {};
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleRegex.exec(cleanHtml)) !== null) {
      const cssContent = styleMatch[1];
      const ruleRegex = /\.fl-node-([a-zA-Z0-9_-]+)[^{]*\{([^}]+)\}/gi;
      let ruleMatch;
      while ((ruleMatch = ruleRegex.exec(cssContent)) !== null) {
        const nodeId = ruleMatch[1];
        const declarations = parseInlineCss(ruleMatch[2]);
        cssMap[nodeId] = { ...(cssMap[nodeId] || {}), ...declarations };
      }
    }

    // Extract default button text color from embedded stylesheet (e.g. .fl-button ... color: #333)
    let defaultButtonColor = '#333333';
    const btnColorMatch = cleanHtml.match(/\.fl-button[^{]*\{[^}]*color:\s*([^;}\s]+)/i);
    if (btnColorMatch) {
      defaultButtonColor = btnColorMatch[1].trim();
    }

    // 1. If HTML contains Beaver Builder row structure (fl-row)
    if (cleanHtml.includes('fl-row')) {
      const rowRegex = /<div\s+([^>]*class=["'][^"']*(?<!\w|-)fl-row(?!\w|-)[^"']*["'][^>]*)>([\s\S]*?)(?=<div\s+[^>]*class=["'][^"']*(?<!\w|-)fl-row(?!\w|-)|$)/gi;
      let rowMatch;
      let foundRows = false;

      while ((rowMatch = rowRegex.exec(cleanHtml)) !== null) {
        foundRows = true;
        const rowAttrs = rowMatch[1];
        const rowContent = rowMatch[2];
        const styleMatch = rowAttrs.match(/style=["'](.*?)["']/i);
        const rowStyles = parseInlineCss(styleMatch ? styleMatch[1] : '');

        if (!rowStyles.alignment) {
          const rowAlignMatch = rowAttrs.match(/text-align:\s*(center|left|right)/i);
          if (rowAlignMatch) {
            rowStyles.alignment = rowAlignMatch[1].toLowerCase() as any;
          }
        }
        rowStyles.maxWidth = '680px';

        const section = createNode('section', {}, rowStyles, [], {
          originalBuilder: 'beaver-builder',
          originalType: 'row',
          rawStyles: rowStyles
        });
        parentNode.children.push(section);

        // Check for columns inside this row
        const colRegex = /<div\s+([^>]*class=["'][^"']*(?<!\w|-)fl-col(?!\w|-)[^"']*["'][^>]*)>([\s\S]*?)(?=<div\s+[^>]*class=["'][^"']*(?<!\w|-)fl-col(?!\w|-)|$)/gi;
        let colMatch;
        let foundCols = false;

        while ((colMatch = colRegex.exec(rowContent)) !== null) {
          foundCols = true;
          const colAttrs = colMatch[1];
          const colContent = colMatch[2];
          const colStyleMatch = colAttrs.match(/style=["'](.*?)["']/i);
          const colStyles = parseInlineCss(colStyleMatch ? colStyleMatch[1] : '');

          let colSpan = 100;
          const widthMatch = (colStyleMatch?.[1] || '').match(/max-width:\s*([0-9.]+)%/i) || (colStyleMatch?.[1] || '').match(/flex:\s*[0-9.\s]+([0-9.]+)%/i);
          if (widthMatch) {
            colSpan = Math.round(parseFloat(widthMatch[1]));
          }

          const col = createNode('column', {}, colStyles, [], {
            originalBuilder: 'beaver-builder',
            originalType: 'column',
            columnSpan: colSpan
          });
          section.children.push(col);

          this.parseElementsFromHtml(colContent, col, rowStyles, cssMap, defaultButtonColor);
        }

        if (!foundCols) {
          const col = createNode('column', {}, {}, [], {
            originalBuilder: 'beaver-builder',
            originalType: 'column',
            columnSpan: 100
          });
          section.children.push(col);
          this.parseElementsFromHtml(rowContent, col, rowStyles, cssMap, defaultButtonColor);
        }
      }

      if (foundRows) return;
    }

    // 2. Fallback: parse element by element
    this.parseElementsFallback(cleanHtml, parentNode, cssMap, defaultButtonColor);
  }

  private parseElementsFromHtml(
    html: string,
    parentCol: UniversalNode,
    inheritedStyles?: UniversalStyles,
    cssMap: Record<string, UniversalStyles> = {},
    defaultButtonColor: string = '#333333'
  ): void {
    // If Beaver Builder modules exist (fl-module), parse by module block
    if (html.includes('fl-module')) {
      const moduleRegex = /<(div|figure|h[1-6])\s+[^>]*class=["']([^"']*fl-module[^"']*)["'][^>]*data-node=["']([a-zA-Z0-9_-]+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
      let modMatch;
      let foundModule = false;

      while ((modMatch = moduleRegex.exec(html)) !== null) {
        foundModule = true;
        const tag = modMatch[1].toLowerCase();
        const modClasses = modMatch[2];
        const nodeId = modMatch[3];
        const modContent = modMatch[4];
        const nodeCss = cssMap[nodeId] || {};

        if (modClasses.includes('fl-module-heading') || tag.startsWith('h') || /<h[1-6]/i.test(modContent)) {
          const hMatch = modContent.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i);
          const level = hMatch ? `h${hMatch[1]}` : (tag.startsWith('h') ? tag : 'h2');
          const text = (hMatch ? hMatch[2] : modContent).replace(/<[^>]+>/g, '').trim();
          const alignment = nodeCss.alignment || (modClasses.includes('fl-heading-center') ? 'center' : (modClasses.includes('fl-heading-right') ? 'right' : (inheritedStyles?.alignment || 'left')));
          const styles: UniversalStyles = {
            alignment: alignment as any,
            color: nodeCss.color || inheritedStyles?.color || '#1e293b'
          };
          parentCol.children.push(createNode('heading', { text, level }, styles, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-rich-text') || modClasses.includes('fl-rich-text')) {
          const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
          let pMatch;
          let foundP = false;
          while ((pMatch = pRegex.exec(modContent)) !== null) {
            foundP = true;
            const text = pMatch[1].replace(/<[^>]+>/g, '').trim();
            if (text) {
              const alignment = nodeCss.alignment || (modClasses.includes('fl-text-center') ? 'center' : (modClasses.includes('fl-text-right') ? 'right' : (inheritedStyles?.alignment || 'left')));
              const styles: UniversalStyles = {
                alignment: alignment as any,
                color: nodeCss.color || inheritedStyles?.color || '#334155'
              };
              parentCol.children.push(createNode('text', { text }, styles, [], { originalBuilder: 'beaver-builder' }));
            }
          }
          if (!foundP) {
            const cleanText = modContent.replace(/<[^>]+>/g, '').trim();
            if (cleanText) {
              const alignment = nodeCss.alignment || (inheritedStyles?.alignment || 'left');
              parentCol.children.push(createNode('text', { text: cleanText }, { alignment: alignment as any }, [], { originalBuilder: 'beaver-builder' }));
            }
          }
        } else if (modClasses.includes('fl-module-photo') || modClasses.includes('fl-photo') || tag === 'figure') {
          const imgMatch = modContent.match(/<img[^>]*src=["']([^"']+)["'][^>]*/i);
          const altMatch = modContent.match(/alt=["']([^"']*)["']/i);
          if (imgMatch) {
            const alignment = nodeCss.alignment || (modClasses.includes('fl-photo-align-center') ? 'center' : (modClasses.includes('fl-photo-align-right') ? 'right' : 'left'));
            const styles: UniversalStyles = {
              alignment: alignment as any
            };
            parentCol.children.push(createNode('image', { url: imgMatch[1], alt: altMatch ? altMatch[1] : '' }, styles, [], { originalBuilder: 'beaver-builder' }));
          }
        } else if (modClasses.includes('fl-module-icon') || modClasses.includes('fl-icon')) {
          const iconMatch = modContent.match(/class=["']([^"']*(?:dashicons-[a-z0-9-]+|fa-[a-z0-9-]+)[^"']*)["']/i);
          const iconClass = iconMatch ? iconMatch[1] : 'dashicons-wordpress-alt';
          const iconName = iconClass.includes('wordpress') ? 'fab fa-wordpress' : iconClass;
          const alignment = nodeCss.alignment || (modClasses.includes('fl-icon-center') ? 'center' : (modClasses.includes('fl-icon-right') ? 'right' : (inheritedStyles?.alignment || 'left')));
          const styles: UniversalStyles = {
            alignment: alignment as any,
            color: nodeCss.color || '#000000',
            typography: { fontSize: parseInt(String(nodeCss.typography?.fontSize || '30'), 10) || 30, fontSizeUnit: 'px' }
          };
          parentCol.children.push(createNode('icon', { name: iconName, icon: iconName }, styles, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-button') || modClasses.includes('fl-button')) {
          const btnMatch = modContent.match(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
          const url = btnMatch ? btnMatch[1] : '#';
          const text = (btnMatch ? btnMatch[2] : modContent).replace(/<[^>]+>/g, '').trim() || 'Click Here';
          const aStyleMatch = (btnMatch ? btnMatch[0] : '').match(/style=["'](.*?)["']/i);
          const aStyles = parseInlineCss(aStyleMatch ? aStyleMatch[1] : '');

          const alignment = aStyles.alignment || nodeCss.alignment || (modClasses.includes('fl-button-center') ? 'center' : (modClasses.includes('fl-button-right') ? 'right' : (inheritedStyles?.alignment || 'center')));
          const btnColor = aStyles.color || nodeCss.color || defaultButtonColor;
          const btnBg = aStyles.backgroundColor || nodeCss.backgroundColor || '#3fc1d5';
          const btnBorderColor = (aStyles.border && typeof aStyles.border === 'object' ? aStyles.border.color : undefined)
            || (nodeCss.border && typeof nodeCss.border === 'object' ? nodeCss.border.color : undefined)
            || '#33b5c9';

          const styles: UniversalStyles = {
            alignment: alignment as any,
            backgroundColor: btnBg,
            color: btnColor,
            border: { color: btnBorderColor }
          };
          parentCol.children.push(createNode('button', { text, link: { url } }, styles, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-video') || modClasses.includes('fl-video')) {
          const videoMatch = modContent.match(/<source[^>]*src=["']([^"']+)["']/i)
            || modContent.match(/<video[^>]*src=["']([^"']+)["']/i)
            || modContent.match(/<iframe[^>]*src=["']([^"']+)["']/i)
            || modContent.match(/<a[^>]*href=["']([^"']+\.(?:mp4|mov|webm|ogg))["']/i)
            || modContent.match(/\[video[^\]]*src=["']([^"']+)["']/i);
          let videoUrl = videoMatch ? videoMatch[1] : '';
          if (!videoUrl && this.fallbackVideos.length > 0) {
            videoUrl = this.fallbackVideos[0];
          }
          if (videoUrl) {
            parentCol.children.push(createNode('video', { url: videoUrl.replace(/#t=\d+$/, '') }, {}, [], { originalBuilder: 'beaver-builder' }));
          }
        } else if (modClasses.includes('fl-module-separator') || modClasses.includes('fl-separator')) {
          parentCol.children.push(createNode('divider', {}, {}, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-numbers')) {
          const numMatch = modContent.match(/class=["'][^"']*fl-number-string[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          const rawNum = numMatch ? numMatch[1].replace(/<[^>]+>/g, '').trim() : '100';
          const textMatch = modContent.match(/class=["'][^"']*fl-number-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          const title = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
          const endNum = parseInt(rawNum.replace(/\D/g, ''), 10) || 100;
          parentCol.children.push(createNode('counter', { endNumber: endNum, title }, {}, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-callout') || modClasses.includes('fl-callout')) {
          const titleMatch = modContent.match(/class=["'][^"']*fl-callout-title[^"']*["'][^>]*>([\s\S]*?)<\/(?:h[1-6]|div)>/i);
          const descMatch = modContent.match(/class=["'][^"']*fl-callout-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          const iconMatch = modContent.match(/class=["']([^"']*(?:dashicons-[a-z0-9-]+|fa-[a-z0-9-]+)[^"']*)["']/i);
          parentCol.children.push(createNode('icon-box', {
            title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '',
            description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '',
            icon: iconMatch ? iconMatch[1] : 'star'
          }, {}, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-audio')) {
          const audioMatch = modContent.match(/<source[^>]*src=["']([^"']+)["']/i) || modContent.match(/<audio[^>]*src=["']([^"']+)["']/i);
          parentCol.children.push(createNode('audio', { url: audioMatch ? audioMatch[1] : '' }, {}, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-star-rating')) {
          parentCol.children.push(createNode('star-rating', { rating: 5 }, {}, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-spacer')) {
          const hMatch = modContent.match(/height:\s*([^;"]+)/i);
          parentCol.children.push(createNode('spacer', { height: hMatch ? hMatch[1].trim() : '50px' }, {}, [], { originalBuilder: 'beaver-builder' }));
        } else if (modClasses.includes('fl-module-html')) {
          const rawHtml = modContent.replace(/<div class="fl-module-content[^"]*">([\s\S]*?)<\/div>/i, '$1').trim();
          parentCol.children.push(createNode('raw-html', { html: rawHtml }, {}, [], { originalBuilder: 'beaver-builder' }));
        } else {
          // Any other unrecognized Beaver module: preserve as raw-html
          const rawHtml = modContent.replace(/<div class="fl-module-content[^"]*">([\s\S]*?)<\/div>/i, '$1').trim();
          if (rawHtml) {
            parentCol.children.push(createNode('raw-html', { html: rawHtml }, {}, [], { originalBuilder: 'beaver-builder' }));
          }
        }
      }

      if (foundModule) return;
    }

    // Generic HTML tags parsing (h1-h6, p, img, i, span, a, video, audio, shortcodes)
    const elemRegex = /<(h[1-6]|p|a|img|i|span|video|audio)([^>]*)>([\s\S]*?)<\/\1>|<(img)([^>]*)\/?>|\[(audio|video)([^\]]*)\]/gi;
    let match;
    let found = false;

    while ((match = elemRegex.exec(html)) !== null) {
      found = true;
      if (match[6] === 'audio') {
        const srcMatch = (match[7] || '').match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          parentCol.children.push(createNode('audio', { url }, {}, [], { originalBuilder: 'beaver-builder' }));
        }
        continue;
      } else if (match[6] === 'video') {
        const srcMatch = (match[7] || '').match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          parentCol.children.push(createNode('video', { url }, {}, [], { originalBuilder: 'beaver-builder' }));
        }
        continue;
      }

      const tag = (match[1] || match[4] || '').toLowerCase();
      const attrs = match[2] || match[5] || '';
      const inner = (match[3] || '').trim();

      const styleMatch = attrs.match(/style=["'](.*?)["']/i);
      const styles = parseInlineCss(styleMatch ? styleMatch[1] : '');

      if (!styles.color && inheritedStyles?.color) {
        styles.color = inheritedStyles.color;
      }
      if (!styles.alignment && inheritedStyles?.alignment) {
        styles.alignment = inheritedStyles.alignment;
      }

      if (tag.startsWith('h')) {
        const text = inner.replace(/<[^>]+>/g, '').trim();
        parentCol.children.push(createNode('heading', { text, level: tag }, styles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag === 'p') {
        const text = inner.trim();
        if (text) {
          parentCol.children.push(createNode('text', { text }, styles, [], { originalBuilder: 'beaver-builder' }));
        }
      } else if (tag === 'i' || (tag === 'span' && (attrs.includes('icon') || attrs.includes('fa') || attrs.includes('dashicons')))) {
        const iconMatch = attrs.match(/class=["']([^"']*(?:fa-[a-z0-9-]+|dashicons-[a-z0-9-]+)[^"']*)["']/i);
        const iconClasses = iconMatch ? iconMatch[1] : 'dashicons-wordpress-alt';
        const iconName = iconClasses.includes('wordpress') ? 'fab fa-wordpress' : (iconClasses.match(/fa-([a-z0-9-]+)/)?.[0] || 'fab fa-wordpress');
        const iStyles: UniversalStyles = { ...styles };
        if (html.includes('fl-icon-center')) iStyles.alignment = 'center';
        parentCol.children.push(createNode('icon', { name: iconName, icon: iconName }, iStyles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag === 'a') {
        const hrefMatch = attrs.match(/href=["'](.*?)["']/i);
        const url = hrefMatch ? hrefMatch[1] : '#';
        const text = inner.replace(/<[^>]+>/g, '').trim() || 'Learn More';
        const btnStyles: UniversalStyles = { ...styles };
        if (html.includes('fl-button-center') || attrs.includes('center')) btnStyles.alignment = 'center';
        const bgMatch = attrs.match(/background(?:-color)?:\s*([^;"]+)/i) || html.match(/background(?:-color)?:\s*([^;"]+)/i);
        btnStyles.backgroundColor = bgMatch ? normalizeColor(bgMatch[1].trim()) : (btnStyles.backgroundColor || '#3fc1d5');
        btnStyles.color = btnStyles.color || '#ffffff';
        btnStyles.border = { color: '#33b5c9' };
        parentCol.children.push(createNode('button', { text, link: { url } }, btnStyles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag === 'img') {
        const srcMatch = attrs.match(/src=["'](.*?)["']/i);
        const altMatch = attrs.match(/alt=["'](.*?)["']/i);
        if (srcMatch) {
          const imgStyles: UniversalStyles = { ...styles };
          if (html.includes('fl-photo-align-center')) imgStyles.alignment = 'center';
          parentCol.children.push(createNode('image', { url: srcMatch[1], alt: altMatch ? altMatch[1] : '' }, imgStyles, [], { originalBuilder: 'beaver-builder' }));
        }
      } else if (tag === 'video') {
        const srcMatch = attrs.match(/src=["'](.*?)["']/i) || inner.match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          parentCol.children.push(createNode('video', { url: url.replace(/#t=\d+$/, '') }, styles, [], { originalBuilder: 'beaver-builder' }));
        }
      } else if (tag === 'audio') {
        const srcMatch = attrs.match(/src=["'](.*?)["']/i) || inner.match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          parentCol.children.push(createNode('audio', { url }, styles, [], { originalBuilder: 'beaver-builder' }));
        }
      }
    }

    if (!found && html.trim()) {
      parentCol.children.push(createNode('raw-html', { html: html.trim() }, {}, [], { originalBuilder: 'beaver-builder' }));
    }
  }

  private parseElementsFallback(
    cleanHtml: string,
    parentNode: UniversalNode,
    cssMap: Record<string, UniversalStyles> = {},
    defaultButtonColor: string = '#333333'
  ): void {
    const regex = /<(h[1-6]|p|a|img|i|span|video|audio)([^>]*)>([\s\S]*?)<\/\1>|<(img)([^>]*)\/?>|\[(audio|video)([^\]]*)\]/gi;
    let match;
    let currentSection: UniversalNode | null = null;
    let currentCol: UniversalNode | null = null;
    let foundElements = false;

    const ensureSectionAndCol = () => {
      if (!currentSection || !currentCol) {
        currentSection = createNode('section', {}, {}, [], { originalBuilder: 'beaver-builder', originalType: 'row' });
        currentSection.styles.maxWidth = '680px';
        currentCol = createNode('column', {}, {}, [], { originalBuilder: 'beaver-builder', originalType: 'column', columnSpan: 100 });
        currentSection.children.push(currentCol);
        parentNode.children.push(currentSection);
      }
    };

    while ((match = regex.exec(cleanHtml)) !== null) {
      foundElements = true;
      if (match[6] === 'audio') {
        const srcMatch = (match[7] || '').match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          ensureSectionAndCol();
          currentCol!.children.push(createNode('audio', { url }, {}, [], { originalBuilder: 'beaver-builder' }));
        }
        continue;
      } else if (match[6] === 'video') {
        const srcMatch = (match[7] || '').match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          ensureSectionAndCol();
          currentCol!.children.push(createNode('video', { url }, {}, [], { originalBuilder: 'beaver-builder' }));
        }
        continue;
      }

      const tag = (match[1] || match[4] || '').toLowerCase();
      const attrs = match[2] || match[5] || '';
      const inner = (match[3] || '').trim();

      const styleMatch = attrs.match(/style=["'](.*?)["']/i);
      const styles = parseInlineCss(styleMatch ? styleMatch[1] : '');

      if (tag === 'h1' || tag === 'h2') {
        if (currentSection && currentCol && currentCol.children.length > 0) {
          currentSection = createNode('section', {}, {}, [], { originalBuilder: 'beaver-builder', originalType: 'row' });
          currentSection.styles.maxWidth = '680px';
          currentCol = createNode('column', {}, {}, [], { originalBuilder: 'beaver-builder', originalType: 'column', columnSpan: 100 });
          currentSection.children.push(currentCol);
          parentNode.children.push(currentSection);
        } else {
          ensureSectionAndCol();
        }

        const text = inner.replace(/<[^>]+>/g, '').trim();
        styles.color = styles.color || '#1e293b';
        currentCol!.children.push(createNode('heading', { text, level: tag }, styles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag.startsWith('h')) {
        ensureSectionAndCol();
        const text = inner.replace(/<[^>]+>/g, '').trim();
        styles.color = styles.color || '#1e293b';
        currentCol!.children.push(createNode('heading', { text, level: tag }, styles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag === 'p') {
        const text = inner.trim();
        if (text) {
          ensureSectionAndCol();
          currentCol!.children.push(createNode('text', { text }, styles, [], { originalBuilder: 'beaver-builder' }));
        }
      } else if (tag === 'i' || (tag === 'span' && (attrs.includes('icon') || attrs.includes('fa') || attrs.includes('dashicons')))) {
        ensureSectionAndCol();
        const iconMatch = attrs.match(/class=["']([^"']*(?:fa-[a-z0-9-]+|dashicons-[a-z0-9-]+|fl-icon)[^"']*)["']/i);
        const iconClasses = iconMatch ? iconMatch[1] : 'dashicons-wordpress-alt';
        const iconName = iconClasses.includes('wordpress') ? 'fab fa-wordpress' : (iconClasses.match(/fa-([a-z0-9-]+)/)?.[0] || 'fab fa-wordpress');
        const iStyles: UniversalStyles = { ...styles };
        if (cleanHtml.includes('fl-icon-center')) iStyles.alignment = 'center';
        iStyles.typography = { fontSize: 30, fontSizeUnit: 'px' };
        currentCol!.children.push(createNode('icon', { name: iconName, icon: iconName }, iStyles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag === 'a') {
        const hrefMatch = attrs.match(/href=["'](.*?)["']/i);
        const url = hrefMatch ? hrefMatch[1] : '#';
        const text = inner.replace(/<[^>]+>/g, '').trim() || 'Learn More';
        ensureSectionAndCol();
        const aStyles: UniversalStyles = { ...styles };
        if (cleanHtml.includes('fl-button-center') || attrs.includes('center') || true) aStyles.alignment = 'center';
        const bgMatch = attrs.match(/background(?:-color)?:\s*([^;"]+)/i) || cleanHtml.match(/background(?:-color)?:\s*([^;"]+)/i);
        aStyles.backgroundColor = bgMatch ? normalizeColor(bgMatch[1].trim()) : '#3fc1d5';
        aStyles.color = aStyles.color || defaultButtonColor;
        aStyles.border = { color: '#33b5c9' };
        currentCol!.children.push(createNode('button', { text, link: { url } }, aStyles, [], { originalBuilder: 'beaver-builder' }));
      } else if (tag === 'img') {
        const srcMatch = attrs.match(/src=["'](.*?)["']/i);
        const altMatch = attrs.match(/alt=["'](.*?)["']/i);
        if (srcMatch) {
          ensureSectionAndCol();
          const imgStyles: UniversalStyles = { ...styles };
          if (cleanHtml.includes('fl-photo-align-center') || true) imgStyles.alignment = 'center';
          currentCol!.children.push(createNode('image', { url: srcMatch[1], alt: altMatch ? altMatch[1] : '' }, imgStyles, [], { originalBuilder: 'beaver-builder' }));
        }
      } else if (tag === 'video') {
        const srcMatch = attrs.match(/src=["'](.*?)["']/i) || inner.match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          ensureSectionAndCol();
          currentCol!.children.push(createNode('video', { url: url.replace(/#t=\d+$/, '') }, styles, [], { originalBuilder: 'beaver-builder' }));
        }
      } else if (tag === 'audio') {
        const srcMatch = attrs.match(/src=["'](.*?)["']/i) || inner.match(/src=["'](.*?)["']/i);
        const url = srcMatch ? srcMatch[1] : '';
        if (url) {
          ensureSectionAndCol();
          currentCol!.children.push(createNode('audio', { url }, styles, [], { originalBuilder: 'beaver-builder' }));
        }
      }
    }

    if (!foundElements) {
      this.parseHtmlFallback(cleanHtml, parentNode);
    }
  }

  // ---------------------------------------------------------------------------
  // HTML FALLBACK PARSING
  // ---------------------------------------------------------------------------
  private parseHtmlFallback(html: string, parentNode: UniversalNode): void {
    const section = createNode('section', {}, {}, [], { originalBuilder: 'html', originalType: 'section' });
    const col = createNode('column', {}, {}, [], { originalBuilder: 'html', originalType: 'column', columnSpan: 100 });
    col.children.push(createNode('raw-html', { html }, {}, [], { originalBuilder: 'html' }));
    section.children.push(col);
    parentNode.children.push(section);
  }

  // ---------------------------------------------------------------------------
  // SERIALIZATION: TO BEAVER BUILDER
  // ---------------------------------------------------------------------------
  private serializeToBeaver(
    page: UniversalPage,
    warnings: MigrationWarning[]
  ): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  } {
    const nodeMap: Record<string, any> = {};
    const rowHtmlBlocks: string[] = [];

    const rawSections = page.root.children.filter((c) => c.type === 'section' || c.type === 'container');
    const sections: UniversalNode[] = [];

    for (const sec of rawSections) {
      if (sec.children.length === 0) continue;
      sections.push({ ...sec, children: [...sec.children] });
    }

    for (let rIdx = 0; rIdx < sections.length; rIdx++) {
      const section = sections[rIdx];
      const rowId = `row_${generateShortId(8)}`;
      const colGroupId = `cg_${generateShortId(8)}`;

      const bgColor = section.styles.backgroundColor || '';
      const isDark = isDarkColor(bgColor);
      const textColor = section.styles.color || (isDark ? '#ffffff' : '');

      nodeMap[rowId] = {
        node: rowId,
        type: 'row',
        parent: null,
        position: rIdx,
        settings: {
          width: 'full',
          full_width: 'default',
          bg_color: bgColor || undefined,
          bg_type: bgColor ? 'color' : undefined,
          padding_top: section.styles.padding?.top ? String(section.styles.padding.top) : undefined,
          padding_bottom: section.styles.padding?.bottom ? String(section.styles.padding.bottom) : undefined,
          padding_left: section.styles.padding?.left ? String(section.styles.padding.left) : undefined,
          padding_right: section.styles.padding?.right ? String(section.styles.padding.right) : undefined,
          max_content_width: section.styles.maxWidth ? String(section.styles.maxWidth).replace('px', '') : undefined,
          max_width: section.styles.maxWidth || undefined,
          content_width: section.styles.maxWidth ? 'fixed' : 'full'
        }
      };

      nodeMap[colGroupId] = {
        node: colGroupId,
        type: 'column-group',
        parent: rowId,
        position: 0,
        settings: {}
      };

      let columns = section.children.filter((c) => c.type === 'column');
      const directWidgets = section.children.filter((c) => c.type !== 'column');
      if (directWidgets.length > 0) {
        const autoCol = createNode('column', {}, { width: '100%' }, directWidgets, { columnSpan: 100 });
        columns = [...columns, autoCol];
      }
      if (columns.length === 0 || columns.every((c) => c.children.length === 0)) {
        continue;
      }
      const colCount = Math.max(columns.length, 1);
      const colHtmlList: string[] = [];

      for (let cIdx = 0; cIdx < columns.length; cIdx++) {
        const col = columns[cIdx];
        const colSpan = col.metadata?.columnSpan || (col.styles.width ? parseFloat(col.styles.width) : Number((100 / colCount).toFixed(2)));
        const colId = `col_${generateShortId(8)}`;
        const colBg = col.styles.backgroundColor || '';
        const colPad = col.styles.padding;
        const isColDark = colBg ? isDarkColor(colBg) : isDark;

        nodeMap[colId] = {
          node: colId,
          type: 'column',
          parent: colGroupId,
          position: cIdx,
          settings: {
            size: colSpan,
            bg_color: colBg || undefined,
            bg_type: colBg ? 'color' : undefined,
            padding_top: colPad?.top ? String(colPad.top) : undefined,
            padding_bottom: colPad?.bottom ? String(colPad.bottom) : undefined,
            padding_left: colPad?.left ? String(colPad.left) : undefined,
            padding_right: colPad?.right ? String(colPad.right) : undefined
          }
        };

        const moduleHtmlList: string[] = [];
        for (let mIdx = 0; mIdx < col.children.length; mIdx++) {
          const mod = col.children[mIdx];
          const modId = `mod_${generateShortId(8)}`;
          const { settings, html } = this.serializeBeaverModule(mod, modId, colId, mIdx, isColDark);
          nodeMap[modId] = settings;
          moduleHtmlList.push(html);
        }

        const colBgStyle = colBg ? `background-color: ${colBg};` : '';
        const colPadStyle = colPad ? `padding: ${formatCssSpacing(colPad)};` : '';
        const colRadiusStyle = col.styles.border?.radius ? `border-radius: ${formatCssRadius(col.styles.border.radius)};` : (colBg ? 'border-radius: 8px;' : '');
        const colWidthStyle = colCount === 1
          ? 'width: 100%; flex: 1 1 100%;'
          : `width: ${colSpan}%; flex: 0 0 ${colSpan}%; max-width: ${colSpan}%; min-width: 0; padding: 0 8px;`;

        colHtmlList.push(
          `      <div class="fl-col" style="${colWidthStyle} box-sizing: border-box; ${colBgStyle} ${colPadStyle} ${colRadiusStyle} display: flex; flex-direction: column;">\n` +
          `        <div class="fl-col-content" style="width: 100%; box-sizing: border-box;">\n` +
          `${moduleHtmlList.map((h) => `          ${h}`).join('\n')}\n` +
          `        </div>\n` +
          `      </div>`
        );
      }

      const padStyle = section.styles.padding
        ? `padding: ${section.styles.padding.top ?? 0}${section.styles.padding.unit || 'px'} ${section.styles.padding.right ?? 0}${section.styles.padding.unit || 'px'} ${section.styles.padding.bottom ?? 0}${section.styles.padding.unit || 'px'} ${section.styles.padding.left ?? 0}${section.styles.padding.unit || 'px'};`
        : '';
      const maxW = section.styles.maxWidth ? `max-width: ${section.styles.maxWidth};` : 'max-width: 1140px;';
      const bgStyle = bgColor ? `background-color: ${bgColor};` : '';
      const colorStyle = textColor ? `color: ${textColor};` : '';

      rowHtmlBlocks.push(
        `  <div class="fl-row fl-row-full-width fl-row-bg-color" style="${bgStyle} ${colorStyle} ${padStyle} box-sizing: border-box; width: 100%;">\n` +
        `    <div class="fl-row-content-wrap" style="${maxW} margin: 0 auto; width: 100%;">\n` +
        `      <div class="fl-col-group" style="display: flex; flex-wrap: wrap; width: 100%; box-sizing: border-box; align-items: stretch;">\n` +
        `${colHtmlList.join('\n')}\n` +
        `      </div>\n` +
        `    </div>\n` +
        `  </div>`
      );
    }

    const fallbackHtml = `<!-- wp:fl-builder/layout -->\n<div class="fl-builder-content fl-builder-content-rendered" style="width: 100%; margin: 0; padding: 0;">\n${rowHtmlBlocks.join('\n\n')}\n</div>\n<!-- /wp:fl-builder/layout -->`;

    return {
      rawData: nodeMap,
      wordpressPayload: {
        title: page.title,
        content: fallbackHtml,
        meta: {
          _fl_builder_data: nodeMap,
          _fl_builder_enabled: '1',
          _fl_builder_draft: false
        }
      },
      warnings
    };
  }

  private serializeBeaverModule(
    node: UniversalNode,
    modId: string,
    parentId: string,
    position: number,
    isDarkBg: boolean
  ): { settings: any; html: string } {
    const primaryText = isDarkBg ? '#ffffff' : '#1e293b';

    switch (node.type) {
      case 'heading': {
        const text = node.properties.text || '';
        const level = node.properties.level || 'h2';
        const headColor = node.styles.color || (isDarkBg ? '#ffffff' : undefined);
        const align = node.styles.alignment || '';
        const fontSize = node.styles.typography?.fontSize ? `${node.styles.typography.fontSize}${node.styles.typography.fontSizeUnit || 'px'}` : '';
        const fontFamily = node.styles.typography?.fontFamily ? `font-family: ${node.styles.typography.fontFamily};` : '';
        const fontWeight = node.styles.typography?.fontWeight ? `font-weight: ${node.styles.typography.fontWeight};` : '';
        const fontStyle = node.styles.typography?.fontStyle ? `font-style: ${node.styles.typography.fontStyle};` : '';
        const textTransform = node.styles.typography?.textTransform ? `text-transform: ${node.styles.typography.textTransform};` : '';
        const letterSpacing = node.styles.typography?.letterSpacing ? `letter-spacing: ${node.styles.typography.letterSpacing};` : '';
        const lineHeight = node.styles.typography?.lineHeight ? `line-height: ${node.styles.typography.lineHeight};` : '';
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : '';
        const padding = node.styles.padding ? `padding: ${formatCssSpacing(node.styles.padding)};` : '';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'heading',
              heading: text,
              tag: level,
              color: headColor || undefined,
              align: align || undefined,
              font_size: fontSize || undefined,
              typography: {
                font_family: node.styles.typography?.fontFamily || undefined,
                font_size: node.styles.typography?.fontSize ? { length: String(node.styles.typography.fontSize), unit: node.styles.typography?.fontSizeUnit || 'px' } : undefined,
                font_weight: node.styles.typography?.fontWeight ? String(node.styles.typography.fontWeight) : undefined,
                line_height: node.styles.typography?.lineHeight ? { length: String(node.styles.typography.lineHeight).replace(/[^0-9.]/g, ''), unit: '' } : undefined,
                letter_spacing: node.styles.typography?.letterSpacing ? { length: String(node.styles.typography.letterSpacing).replace(/[^0-9.]/g, ''), unit: 'px' } : undefined,
                text_transform: node.styles.typography?.textTransform || undefined,
                text_align: align || undefined
              }
            }
          },
          html: `<div class="fl-module fl-module-heading" style="${align ? `text-align: ${align};` : ''}"><${level} style="${headColor ? `color: ${headColor};` : ''} ${fontSize ? `font-size: ${fontSize};` : ''} ${fontFamily} ${fontWeight} ${fontStyle} ${textTransform} ${letterSpacing} ${lineHeight} ${margin} ${padding} ${align ? `text-align: ${align};` : ''}">${text}</${level}></div>`
        };
      }
      case 'button': {
        const text = node.properties.text || '';
        const url = node.properties.link?.url || '#';
        const btnBg = node.styles.backgroundColor;
        const btnColor = node.styles.color || (btnBg ? '#ffffff' : primaryText);
        const rawAlign = node.styles.alignment || '';
        const isFull = node.styles.width === '100%' || node.properties.width === 'full' || rawAlign === 'justify';
        const align = isFull ? 'center' : (rawAlign || 'center');
        const fontSize = node.styles.typography?.fontSize ? `font-size: ${node.styles.typography.fontSize}${node.styles.typography.fontSizeUnit || 'px'};` : '';
        const fontFamily = node.styles.typography?.fontFamily ? `font-family: ${node.styles.typography.fontFamily};` : '';
        const fontWeight = node.styles.typography?.fontWeight ? `font-weight: ${node.styles.typography.fontWeight};` : '';
        const fontStyle = node.styles.typography?.fontStyle ? `font-style: ${node.styles.typography.fontStyle};` : '';
        const textTransform = node.styles.typography?.textTransform ? `text-transform: ${node.styles.typography.textTransform};` : '';
        const letterSpacing = node.styles.typography?.letterSpacing ? `letter-spacing: ${node.styles.typography.letterSpacing};` : '';
        const hasBorderStyle = node.styles.border?.style && node.styles.border.style !== 'none';
        const border = hasBorderStyle ? `border: ${formatCssBorder(node.styles.border)};` : (btnBg ? 'border: none;' : '');
        const radius = node.styles.border?.radius ? `border-radius: ${formatCssRadius(node.styles.border.radius)};` : '';
        const padding = node.styles.padding ? `padding: ${formatCssSpacing(node.styles.padding)};` : '';
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : '';
        const bgStyle = btnBg ? `background-color: ${btnBg} !important;` : '';
        const colorStyle = btnColor ? `color: ${btnColor} !important;` : '';

        const radiusStr = node.styles.border?.radius
          ? (typeof node.styles.border.radius === 'object' ? String(node.styles.border.radius.top || '') : String(node.styles.border.radius).replace('px', '').trim())
          : '';

        const buttonWidthClass = isFull ? 'fl-button-width-full' : 'fl-button-width-auto';
        const fullLinkStyle = isFull ? 'width: 100%; text-align: center; display: block;' : 'display: inline-block;';

        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'button',
              text,
              link: url,
              width: isFull ? 'full' : 'auto',
              style: btnBg ? 'flat' : undefined,
              bg_color: btnBg || undefined,
              bg_hover_color: btnBg || undefined,
              text_color: btnColor || undefined,
              text_hover_color: btnColor || undefined,
              align: isFull ? 'center' : (rawAlign || undefined),
              button_transition: 'enable',
              btn_typography: {
                font_family: node.styles.typography?.fontFamily || undefined,
                font_weight: node.styles.typography?.fontWeight ? String(node.styles.typography.fontWeight) : undefined,
                font_size: node.styles.typography?.fontSize ? { length: String(node.styles.typography.fontSize), unit: node.styles.typography.fontSizeUnit || 'px' } : undefined
              },
              border: node.styles.border ? {
                style: node.styles.border.style || '',
                color: node.styles.border.color || '',
                width: typeof (node.styles.border.width as any) === 'object' && (node.styles.border.width as any) !== null
                  ? {
                    top: String((node.styles.border.width as any).top || ''),
                    right: String((node.styles.border.width as any).right || ''),
                    bottom: String((node.styles.border.width as any).bottom || ''),
                    left: String((node.styles.border.width as any).left || '')
                  }
                  : {
                    top: String(node.styles.border.width || ''),
                    right: String(node.styles.border.width || ''),
                    bottom: String(node.styles.border.width || ''),
                    left: String(node.styles.border.width || '')
                  },
                radius: radiusStr ? {
                  top_left: radiusStr,
                  top_right: radiusStr,
                  bottom_left: radiusStr,
                  bottom_right: radiusStr
                } : undefined
              } : undefined,
              padding_top: node.styles.padding?.top ? String(node.styles.padding.top) : undefined,
              padding_bottom: node.styles.padding?.bottom ? String(node.styles.padding.bottom) : undefined,
              padding_left: node.styles.padding?.left ? String(node.styles.padding.left) : undefined,
              padding_right: node.styles.padding?.right ? String(node.styles.padding.right) : undefined
            }
          },
          html: `<div class="fl-module fl-module-button" style="${margin} ${isFull ? 'width: 100%;' : (align ? `text-align: ${align};` : '')}"><div class="fl-button-wrap ${buttonWidthClass} ${align === 'center' ? 'fl-button-center' : (align === 'right' ? 'fl-button-right' : 'fl-button-left')}"><a href="${url}" class="fl-button" style="${fullLinkStyle} ${bgStyle} ${colorStyle} ${fontSize} ${fontFamily} ${fontWeight} ${fontStyle} ${textTransform} ${letterSpacing} ${border} ${radius} ${padding} text-decoration: none;"><span class="fl-button-text" style="${colorStyle}">${text}</span></a></div></div>`
        };
      }
      case 'icon': {
        const rawIcon = node.properties.name || node.properties.icon || '';
        const iconName = rawIcon.includes('wordpress') ? 'fab fa-wordpress' : rawIcon;
        const bgColor = node.styles.backgroundColor || '';
        const color = node.styles.color || '';
        const align = node.styles.alignment || '';
        const size = node.styles.typography?.fontSize ? Number(node.styles.typography.fontSize) : 30;
        const isCircle = node.styles.border?.radius ? true : (node.properties.shape === 'circle');

        const circleStyle = bgColor
          ? `display: inline-flex; align-items: center; justify-content: center; ${size ? `width: ${size * 2}px; height: ${size * 2}px;` : 'padding: 0.5em;'} background-color: ${bgColor}; ${isCircle ? 'border-radius: 50%;' : ''} ${color ? `color: ${color};` : ''}`
          : (color ? `color: ${color};` : '');

        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'icon',
              icon: iconName,
              color: color || undefined,
              bg_color: bgColor || undefined,
              size: size || undefined,
              size_unit: 'px',
              align: align || undefined,
              three_d: '0'
            }
          },
          html: `<div class="fl-module fl-module-icon" style="${align ? `text-align: ${align};` : ''}"><div class="fl-icon-wrap" style="display: inline-block;"><span class="fl-icon" style="${circleStyle}"><i class="${iconName}" style="${size ? `font-size: ${size}px;` : ''} ${color ? `color: ${color};` : ''}" aria-hidden="true"></i></span></div></div>`
        };
      }
      case 'image': {
        const url = node.properties.url || '';
        const align = node.styles.alignment || '';
        const maxW = node.styles.maxWidth || node.styles.width || '100%';
        const radius = node.styles.border?.radius ? `border-radius: ${formatCssRadius(node.styles.border.radius)};` : '';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: { type: 'photo', photo_src: url, align }
          },
          html: `<div class="fl-module fl-module-photo" style="margin: 0 0 16px 0; ${align ? `text-align: ${align};` : ''}"><img src="${url}" alt="" style="max-width: ${maxW}; height: auto; ${radius}" /></div>`
        };
      }
      case 'video': {
        const url = node.properties.url || '';
        const cleanUrl = url.replace(/#t=\d+$/, '');
        const isEmbed = cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be') || cleanUrl.includes('vimeo.com') || cleanUrl.includes('<iframe');
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const parts = cleanUrl.split('.');
        const ext = parts.length > 1 ? parts.pop()?.toLowerCase() || 'mp4' : 'mp4';
        const attachmentId = node.properties.attachmentId || undefined;

        const videoHtml = `<video controls style="max-width: 100%; height: auto;" preload="metadata"><source src="${cleanUrl}" /></video>`;
        const settings: any = {
          type: 'video',
          video_type: 'embed',
          embed_code: isEmbed ? cleanUrl : videoHtml,
          video_lightbox: 'no',
          video: attachmentId || cleanUrl,
          data: {
            url: cleanUrl,
            extension: ext,
            filename: cleanUrl.split('/').pop() || ''
          }
        };

        let moduleHtml = '';
        if (isEmbed) {
          moduleHtml = `<div class="fl-module fl-module-video fl-video" style="${margin}"><div class="fl-video fl-wp-video">${cleanUrl.startsWith('<iframe') ? cleanUrl : `<iframe src="${cleanUrl}" frameborder="0" allowfullscreen style="width: 100%; aspect-ratio: 16/9;"></iframe>`}</div></div>`;
        } else {
          moduleHtml = `<div class="fl-module fl-module-video fl-video" style="${margin}"><div class="fl-video fl-wp-video"><video controls style="max-width: 100%; height: auto;"><source src="${cleanUrl}" type="video/${ext === 'mov' ? 'quicktime' : (ext === 'mp4' ? 'mp4' : ext)}" /></video></div></div>`;
        }

        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings
          },
          html: moduleHtml
        };
      }
      case 'divider': {
        const color = node.styles.border?.color || node.styles.color || node.properties.color || (isDarkBg ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)');
        const height = node.properties.weight || (typeof node.styles.border?.width === 'number' ? node.styles.border.width : 2);
        const width = node.properties.width || '100%';
        const align = node.styles.alignment || 'center';
        const marginAlign = align === 'center' ? '0 auto' : (align === 'right' ? '0 0 0 auto' : '0 auto 0 0');
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const html = `<div class="fl-module fl-module-separator" style="${margin} text-align: ${align};"><div class="fl-separator" style="border-top: ${height}px ${node.properties.style || 'solid'} ${color}; width: ${width}; margin: ${marginAlign};"></div></div>`;
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'html',
              html,
              color,
              height: String(height),
              style: node.properties.style || 'solid',
              width
            }
          },
          html
        };
      }
      case 'raw-html': {
        const rawContent = node.properties.html || node.properties.code || '';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'html',
              html: rawContent
            }
          },
          html: `<div class="fl-module fl-module-html">${rawContent}</div>`
        };
      }
      case 'audio': {
        const url = node.properties.url || '';
        const attId = node.properties.attachmentId;
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'audio',
              audio_type: attId ? 'media_library' : 'link',
              link: url,
              audios: attId ? [attId] : [],
              data: {
                id: attId || 0,
                url
              }
            }
          },
          html: `<div class="fl-module fl-module-audio" style="${margin}"><audio controls style="width: 100%;"><source src="${url}" type="audio/mpeg" /></audio></div>`
        };
      }
      case 'counter': {
        const endNum = node.properties.endNumber ?? node.properties.number ?? 100;
        const prefix = node.properties.prefix || '';
        const suffix = node.properties.suffix || '';
        const title = node.properties.title || '';
        const align = node.styles.alignment || 'center';
        const isPercent = suffix === '%' || node.properties.numberType === 'percent';
        const numColor = node.properties.numberColor || node.styles.color || (isDarkBg ? '#ffffff' : primaryText);
        const titColor = node.properties.titleColor || (isDarkBg ? 'rgba(255,255,255,0.7)' : undefined);
        const fontSize = node.styles.typography?.fontSize ? String(node.styles.typography.fontSize) : '32';
        const fontUnit = node.styles.typography?.fontSizeUnit || 'px';
        const fontWeight = node.styles.typography?.fontWeight || '800';
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'numbers',
              layout: 'default',
              number: endNum,
              before_number_text: prefix,
              after_number_text: suffix,
              number_type: isPercent ? 'percent' : 'standard',
              text: title,
              title: title,
              number_color: numColor || undefined,
              text_color: titColor || undefined,
              number_typography: {
                font_size: { length: fontSize, unit: fontUnit },
                font_weight: fontWeight,
                text_align: align
              },
              text_typography: {
                font_size: { length: '16', unit: 'px' },
                font_weight: '500',
                text_align: align
              }
            }
          },
          html: `<div class="fl-module fl-module-numbers" style="${margin} text-align: ${align};"><div class="fl-number-string" style="font-size: ${fontSize}${fontUnit}; font-weight: ${fontWeight}; ${numColor ? `color: ${numColor};` : ''}">${prefix}${endNum}${suffix}</div>${title ? `<div class="fl-number-text" style="font-size: 16px; font-weight: 500; ${titColor ? `color: ${titColor};` : ''} margin-top: 8px;">${title}</div>` : ''}</div>`
        };
      }
      case 'icon-box': {
        const title = node.properties.title || '';
        const desc = node.properties.description || '';
        const rawIcon = node.properties.icon || 'star';
        const iconName = rawIcon.includes('wordpress') ? 'fab fa-wordpress' : (rawIcon.startsWith('fa') ? rawIcon : `fas fa-${rawIcon}`);
        const pos = node.properties.position;
        const iconPosition = pos === 'left' ? 'left' : (pos === 'right' ? 'right' : 'above-title');
        const align = node.styles.alignment || (iconPosition === 'above-title' ? 'center' : 'left');
        const icoColor = node.properties.iconColor || node.styles.color || primaryText;
        const titColor = node.properties.titleColor || (isDarkBg ? '#ffffff' : primaryText);
        const txtColor = node.properties.descriptionColor || (isDarkBg ? 'rgba(255,255,255,0.7)' : undefined);
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const linkUrl = node.properties.link?.url;
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'callout',
              title,
              title_tag: 'h3',
              text: desc,
              image_type: 'icon',
              icon: iconName,
              icon_position: iconPosition,
              align,
              link: linkUrl || undefined,
              link_type: linkUrl ? 'url' : undefined,
              icon_color: icoColor || undefined,
              title_color: titColor || undefined,
              content_color: txtColor || undefined,
              title_typography: {
                font_size: { length: '20', unit: 'px' },
                font_weight: '700',
                text_align: align
              },
              content_typography: {
                font_size: { length: '15', unit: 'px' },
                text_align: align
              }
            }
          },
          html: `<div class="fl-module fl-module-callout" style="${margin} text-align: ${align};"><div class="fl-callout-icon" style="font-size: 36px; margin-bottom: 12px; ${icoColor ? `color: ${icoColor};` : ''}"><i class="${iconName}" style="${icoColor ? `color: ${icoColor};` : ''} font-size: 36px;"></i></div><h3 class="fl-callout-title" style="margin: 0 0 8px 0; ${titColor ? `color: ${titColor};` : ''} font-size: 20px; font-weight: 700; text-align: ${align};">${title}</h3><div class="fl-callout-text" style="${txtColor ? `color: ${txtColor};` : ''} font-size: 15px; line-height: 1.6; text-align: ${align};">${desc}</div></div>`
        };
      }
      case 'accordion': {
        const items: Array<{ title?: string; label?: string; content: string }> = Array.isArray(node.properties.items) ? node.properties.items : [];
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const itemsHtml = items.map((it, idx) => `
          <details class="fl-accordion-item" style="border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px; background: #ffffff; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);" ${idx === 0 ? 'open' : ''}>
            <summary class="fl-accordion-button" style="padding: 16px 20px; font-weight: 600; font-size: 16px; color: #1e293b; background: #f8fafc; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center;">
              <span>${it.title || it.label || `Item ${idx + 1}`}</span>
              <span style="font-size: 18px; color: currentColor; opacity: 0.7;">▾</span>
            </summary>
            <div class="fl-accordion-content" style="padding: 16px 20px; color: #475569; font-size: 15px; line-height: 1.6; border-top: 1px solid #e2e8f0;">${it.content || ''}</div>
          </details>
        `).join('');
        const html = `<div class="fl-module fl-module-accordion" style="${margin}"><div class="fl-accordion">${itemsHtml}</div></div>`;
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'accordion',
              items: items.map(it => ({ label: it.title || it.label || '', content: it.content || '' })),
              html
            }
          },
          html
        };
      }
      case 'spacer': {
        const h = node.properties.height || '50px';
        const heightNum = parseInt(String(h).replace('px', ''), 10) || 50;
        const html = `<div class="fl-module fl-module-spacer" style="height: ${heightNum}px;"></div>`;
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'spacer',
              height: heightNum,
              html
            }
          },
          html
        };
      }
      case 'star-rating': {
        const r = Math.min(Math.max(node.properties.rating || 5, 0), 5);
        const title = node.properties.title || '';
        const color = isDarkBg ? '#f8fafc' : '#1e293b';
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const align = node.styles.alignment || 'center';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'star-rating',
              rating: r,
              title: title || undefined
            }
          },
          html: `<div class="fl-module fl-module-star-rating" style="${margin} text-align: ${align};">${title ? `<div style="font-weight: 600; font-size: 16px; margin-bottom: 8px; color: ${color};">${title}</div>` : ''}<span style="color: #f59e0b; font-size: 26px; letter-spacing: 2px;">${'★'.repeat(Math.round(r))}${'☆'.repeat(5 - Math.round(r))}</span></div>`
        };
      }
      case 'social-icons': {
        const icons: Array<any> = Array.isArray(node.properties.icons) ? node.properties.icons : (Array.isArray(node.properties.items) ? node.properties.items : []);
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const align = node.styles.alignment || 'center';
        const brandColors: Record<string, string> = {
          facebook: '#1877f2',
          twitter: '#1da1f2',
          x: '#000000',
          instagram: '#e4405f',
          youtube: '#cd201f',
          linkedin: '#0077b5',
          github: '#333333',
          wordpress: '#21759b',
          pinterest: '#bd081c',
          tiktok: '#000000'
        };
        const iconsHtml = icons.map(i => {
          const iconName = i.name || i.icon || (i.platform ? `fab fa-${i.platform}` : 'fab fa-facebook');
          const href = i.link || i.url || '#';
          const iconKey = Object.keys(brandColors).find(k => iconName.toLowerCase().includes(k));
          const bg = i.backgroundColor || node.styles.backgroundColor || (iconKey ? brandColors[iconKey] : 'currentColor');
          const fg = i.color || node.styles.color || '#ffffff';
          return `<a href="${href}" style="display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin: 0 6px; font-size: 20px; color: ${fg}; background: ${bg}; border-radius: 50%; text-decoration: none; transition: transform 0.2s;" target="_blank" rel="noopener noreferrer"><i class="${iconName}"></i></a>`;
        }).join('');
        const html = `<div class="fl-module fl-module-social-icons" style="${margin} text-align: ${align};"><div class="fl-social-icons" style="display: flex; justify-content: ${align === 'left' ? 'flex-start' : (align === 'right' ? 'flex-end' : 'center')}; gap: 8px;">${iconsHtml}</div></div>`;
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'social-links',
              links: icons.map(i => ({
                link: i.link || i.url || '#',
                service: i.name || i.icon || (i.platform ? `fab fa-${i.platform}` : 'fab fa-facebook')
              })),
              html
            }
          },
          html
        };
      }
      case 'map': {
        const address = node.properties.address || '';
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const html = `<div class="fl-module fl-module-map" style="${margin}"><iframe width="100%" height="360" frameborder="0" src="https://maps.google.com/maps?q=${encodeURIComponent(address)}&output=embed" style="border-radius: 8px; border: 0; width: 100%;"></iframe></div>`;
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'map',
              address,
              html
            }
          },
          html
        };
      }
      case 'text':
      default: {
        if (node.type !== 'text' && node.properties.html && !node.properties.text) {
          const rawHtml = node.properties.html;
          const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : '';
          return {
            settings: {
              node: modId,
              type: 'module',
              parent: parentId,
              position,
              settings: {
                type: 'html',
                html: rawHtml
              }
            },
            html: `<div class="fl-module fl-module-html" style="${margin}">${rawHtml}</div>`
          };
        }
        const text = node.properties.text || node.properties.html || '';
        const explicitColor = node.styles.color;
        const textColor = explicitColor || (isDarkBg ? '#ffffff' : undefined);
        const align = node.styles.alignment || '';
        const fontSize = node.styles.typography?.fontSize ? `font-size: ${node.styles.typography.fontSize}${node.styles.typography.fontSizeUnit || 'px'};` : '';
        const fontFamily = node.styles.typography?.fontFamily ? `font-family: ${node.styles.typography.fontFamily};` : '';
        const fontWeight = node.styles.typography?.fontWeight ? `font-weight: ${node.styles.typography.fontWeight};` : '';
        const fontStyle = node.styles.typography?.fontStyle ? `font-style: ${node.styles.typography.fontStyle};` : '';
        const textTransform = node.styles.typography?.textTransform ? `text-transform: ${node.styles.typography.textTransform};` : '';
        const letterSpacing = node.styles.typography?.letterSpacing ? `letter-spacing: ${node.styles.typography.letterSpacing};` : '';
        const lineHeight = node.styles.typography?.lineHeight ? `line-height: ${node.styles.typography.lineHeight};` : 'line-height: 1.6;';
        const margin = node.styles.margin ? `margin: ${formatCssSpacing(node.styles.margin)};` : 'margin: 0 0 16px 0;';
        const padding = node.styles.padding ? `padding: ${formatCssSpacing(node.styles.padding)};` : '';
        return {
          settings: {
            node: modId,
            type: 'module',
            parent: parentId,
            position,
            settings: {
              type: 'rich-text',
              text,
              color: textColor || undefined,
              typography: {
                font_family: node.styles.typography?.fontFamily || undefined,
                font_size: node.styles.typography?.fontSize ? { length: String(node.styles.typography.fontSize), unit: node.styles.typography.fontSizeUnit || 'px' } : undefined,
                font_weight: node.styles.typography?.fontWeight ? String(node.styles.typography.fontWeight) : undefined,
                line_height: node.styles.typography?.lineHeight ? { length: String(node.styles.typography.lineHeight).replace(/[^0-9.]/g, ''), unit: '' } : undefined,
                letter_spacing: node.styles.typography?.letterSpacing ? { length: String(node.styles.typography.letterSpacing).replace(/[^0-9.]/g, ''), unit: 'px' } : undefined,
                text_transform: node.styles.typography?.textTransform || undefined,
                text_align: align || undefined
              }
            }
          },
          html: `<div class="fl-module fl-module-rich-text fl-rich-text" style="${textColor ? `color: ${textColor};` : ''} ${fontSize} ${fontFamily} ${fontWeight} ${fontStyle} ${textTransform} ${letterSpacing} ${lineHeight} ${margin} ${padding} ${align ? `text-align: ${align};` : ''}">${text}</div>`
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SERIALIZATION: TO ELEMENTOR
  // ---------------------------------------------------------------------------
  private serializeToElementor(
    page: UniversalPage,
    warnings: MigrationWarning[],
    options?: Partial<MigrationOptions>
  ): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  } {
    const elementorElements: any[] = [];
    const sections = page.root.children.filter((c) => c.type === 'section' || c.type === 'container');

    for (const section of sections) {
      const sectionId = generateShortId(7);
      const sectionSettings: any = {};
      if (section.styles.gradient) {
        sectionSettings.background_background = 'gradient';
        sectionSettings.background_color = section.styles.gradient.colorA;
        sectionSettings.background_color_b = section.styles.gradient.colorB;
        sectionSettings.background_gradient_type = 'linear';
        sectionSettings.background_gradient_angle = { unit: 'deg', size: section.styles.gradient.angle || 135 };
      } else if (section.styles.backgroundColor) {
        sectionSettings.background_background = 'classic';
        sectionSettings.background_color = section.styles.backgroundColor;
      }
      if (section.styles.backgroundImage) {
        sectionSettings.background_background = 'classic';
        sectionSettings.background_image = { url: section.styles.backgroundImage };
      }
      if (section.styles.padding) sectionSettings.padding = formatElementorSpacing(section.styles.padding);
      sectionSettings.layout = 'boxed';
      if (section.styles.maxWidth) {
        const parsed = parseInt(section.styles.maxWidth, 10);
        if (parsed > 0) {
          sectionSettings.content_width = { size: parsed, unit: 'px' };
          sectionSettings.boxed_width = { size: parsed, unit: 'px' };
          sectionSettings.width = { size: parsed, unit: 'px' };
        }
      } else {
        sectionSettings.content_width = { size: 680, unit: 'px' };
        sectionSettings.boxed_width = { size: 680, unit: 'px' };
        sectionSettings.width = { size: 680, unit: 'px' };
      }

      const sectionObj: any = {
        id: sectionId,
        elType: 'section',
        settings: sectionSettings,
        elements: []
      };

      let columns = section.children.filter((c) => c.type === 'column');
      const directWidgets = section.children.filter((c) => c.type !== 'column');
      if (directWidgets.length > 0) {
        const autoCol = createNode('column', {}, { width: '100%' }, directWidgets, { columnSpan: 100 });
        columns = [...columns, autoCol];
      }
      if (columns.length === 0 || columns.every((c) => c.children.length === 0)) {
        continue;
      }
      for (const col of columns) {
        const colId = generateShortId(7);
        const span = col.metadata?.columnSpan || 100;
        const colSettings: any = {
          _column_size: span,
          _inline_size: span
        };
        if (col.styles.gradient) {
          colSettings.background_background = 'gradient';
          colSettings.background_color = col.styles.gradient.colorA;
          colSettings.background_color_b = col.styles.gradient.colorB;
          colSettings.background_gradient_type = 'linear';
          colSettings.background_gradient_angle = { unit: 'deg', size: col.styles.gradient.angle || 135 };
        } else if (col.styles.backgroundColor) {
          colSettings.background_background = 'classic';
          colSettings.background_color = col.styles.backgroundColor;
        }
        if (col.styles.padding) colSettings.padding = formatElementorSpacing(col.styles.padding);

        const colObj: any = {
          id: colId,
          elType: 'column',
          settings: colSettings,
          elements: []
        };

        for (const child of col.children) {
          const widgetId = generateShortId(7);
          const widgetObj = this.serializeElementorWidget(child, widgetId);
          colObj.elements.push(widgetObj);
        }

        sectionObj.elements.push(colObj);
      }

      elementorElements.push(sectionObj);
    }

    const template = options?.template !== undefined
      ? options.template
      : ((page.root.properties as any)?.template || (page as any).template || '');
    const isCanvas = template === 'elementor_canvas';
    const wpTemplate = isCanvas ? 'elementor_canvas' : (template || 'default');

    const perSectionCss = sections.map((sec, idx) => {
      const el = elementorElements[idx];
      const w = sec.styles.maxWidth ? parseInt(sec.styles.maxWidth, 10) : 0;
      if (w > 0 && el?.id) {
        return `.elementor-element-${el.id}.elementor-section-boxed > .elementor-container { max-width: ${w}px !important; }`;
      }
      return '';
    }).filter(Boolean).join('\n');

    const fallbackW = sections[0]?.styles.maxWidth ? parseInt(sections[0].styles.maxWidth, 10) : 1100;
    const scopedCss = `<style>
${perSectionCss || `.elementor-section.elementor-section-boxed > .elementor-container { max-width: ${fallbackW}px !important; }`}
.elementor-widget-icon .elementor-icon {
  color: inherit;
}
.elementor-widget-wp-widget-media_audio {
  width: 100%;
}
.elementor-widget-wp-widget-media_audio .mejs-container {
  width: 100% !important;
  max-width: 100% !important;
  border-radius: 8px !important;
}
.elementor-widget-wp-widget-media_audio .mejs-controls {
  overflow: visible !important;
}
.elementor-widget-wp-widget-media_audio .mejs-time {
  box-sizing: content-box !important;
  height: 24px !important;
  padding: 16px 6px 0 !important;
  line-height: normal !important;
  overflow: visible !important;
}
.elementor-widget-wp-widget-media_audio .mejs-time * {
  box-sizing: content-box !important;
  line-height: normal !important;
}
.elementor-widget-wp-widget-media_audio .mejs-horizontal-volume-slider {
  box-sizing: content-box !important;
  max-width: 50px !important;
}
</style>`;

    return {
      rawData: elementorElements,
      wordpressPayload: {
        title: page.title,
        content: scopedCss,
        template: isCanvas ? 'elementor_canvas' : (template || ''),
        meta: {
          _elementor_data: JSON.stringify(elementorElements),
          _elementor_edit_mode: 'builder',
          _elementor_version: '3.20.0',
          _wp_page_template: wpTemplate,
          _elementor_page_settings: { hide_title: isCanvas ? 'yes' : 'no' }
        }
      },
      warnings
    };
  }

  private serializeElementorWidget(node: UniversalNode, id: string): any {
    switch (node.type) {
      case 'heading': {
        const settings: any = {
          title: node.properties.text || '',
          header_size: node.properties.level || 'h2'
        };
        const titleColor = node.styles.color || '#1e293b';
        if (titleColor) settings.title_color = titleColor;
        if (node.styles.alignment) settings.align = node.styles.alignment;
        if (node.styles.typography) {
          settings.typography_typography = 'custom';
          if (node.styles.typography.fontSize) {
            settings.typography_font_size = { size: node.styles.typography.fontSize, unit: node.styles.typography.fontSizeUnit || 'px' };
          }
          if (node.styles.typography.fontFamily) settings.typography_font_family = node.styles.typography.fontFamily;
          if (node.styles.typography.fontWeight) settings.typography_font_weight = String(node.styles.typography.fontWeight);
          if (node.styles.typography.fontStyle) settings.typography_font_style = node.styles.typography.fontStyle;
          if (node.styles.typography.lineHeight) settings.typography_line_height = { size: parseFloat(String(node.styles.typography.lineHeight)), unit: 'em' };
          if (node.styles.typography.letterSpacing) settings.typography_letter_spacing = { size: parseFloat(String(node.styles.typography.letterSpacing)), unit: 'px' };
          if (node.styles.typography.textTransform) settings.typography_text_transform = node.styles.typography.textTransform;
          if (node.styles.typography.textDecoration) settings.typography_text_decoration = node.styles.typography.textDecoration;
        }
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        if (node.styles.padding) settings._padding = formatElementorSpacing(node.styles.padding as any);
        if (node.properties.link?.url) {
          settings.link = { url: node.properties.link.url, is_external: node.properties.link.openInNewTab ? 'on' : undefined };
        }
        return {
          id,
          elType: 'widget',
          widgetType: 'heading',
          settings
        };
      }
      case 'button': {
        const rawAlign = node.styles.alignment || (node.metadata?.rawSettings as any)?.align || (node.metadata?.rawSettings as any)?.btn_align || '';
        const isFull = node.styles.width === '100%' || node.properties.width === 'full' || rawAlign === 'justify';
        const finalAlign = isFull ? 'justify' : (rawAlign || 'left');
        const btnBg = node.styles.backgroundColor || '#3fc1d5';
        const btnColor = node.styles.color || '#333333';
        const settings: any = {
          text: node.properties.text || 'Button',
          link: {
            url: node.properties.link?.url || '#',
            is_external: node.properties.link?.openInNewTab ? 'on' : undefined
          },
          align: finalAlign,
          background_background: 'classic',
          background_color: btnBg,
          button_background_color: btnBg,
          button_text_color: btnColor
        };
        if (node.styles.border && node.styles.border.style && node.styles.border.style !== 'none') {
          settings.border_border = node.styles.border.style;
          if (node.styles.border.color) settings.border_color = node.styles.border.color;
        }
        if (node.styles.border?.width) {
          if (typeof node.styles.border.width === 'object') {
            settings.border_width = formatElementorSpacing(node.styles.border.width as any);
          } else {
            const w = String(node.styles.border.width).replace('px', '').trim();
            settings.border_width = { top: w, right: w, bottom: w, left: w, unit: 'px', isLinked: true };
          }
        }
        if (node.styles.border?.radius) {
          if (typeof node.styles.border.radius === 'object') {
            settings.border_radius = formatElementorSpacing(node.styles.border.radius as any);
          } else {
            const rad = String(node.styles.border.radius).replace('px', '').trim();
            settings.border_radius = { top: rad, right: rad, bottom: rad, left: rad, unit: 'px', isLinked: true };
          }
        }
        if (node.styles.typography) {
          settings.typography_typography = 'custom';
          if (node.styles.typography.fontSize) {
            settings.typography_font_size = { size: node.styles.typography.fontSize, unit: node.styles.typography.fontSizeUnit || 'px' };
          }
          if (node.styles.typography.fontFamily) settings.typography_font_family = node.styles.typography.fontFamily;
          if (node.styles.typography.fontWeight) settings.typography_font_weight = String(node.styles.typography.fontWeight);
          if (node.styles.typography.fontStyle) settings.typography_font_style = node.styles.typography.fontStyle;
          if (node.styles.typography.lineHeight) settings.typography_line_height = { size: parseFloat(String(node.styles.typography.lineHeight)), unit: 'em' };
          if (node.styles.typography.letterSpacing) settings.typography_letter_spacing = { size: parseFloat(String(node.styles.typography.letterSpacing)), unit: 'px' };
          if (node.styles.typography.textTransform) settings.typography_text_transform = node.styles.typography.textTransform;
          if (node.styles.typography.textDecoration) settings.typography_text_decoration = node.styles.typography.textDecoration;
        }
        if (node.styles.padding) settings.button_padding = formatElementorSpacing(node.styles.padding as any);
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        if (!isFull) settings._element_width = 'auto';
        return {
          id,
          elType: 'widget',
          widgetType: 'button',
          settings
        };
      }
      case 'icon': {
        const rawIcon = node.properties.name || node.properties.icon || 'fab fa-wordpress';
        const iconValue = rawIcon.includes('wordpress') ? 'fab fa-wordpress' : rawIcon;
        const library = iconValue.startsWith('fab') ? 'fa-brands' : (iconValue.startsWith('far') ? 'fa-regular' : 'fa-solid');
        const settings: any = {
          selected_icon: {
            value: iconValue,
            library
          },
          view: 'default',
          align: node.styles.alignment || 'left'
        };
        if (node.styles.color) settings.primary_color = node.styles.color;
        if (node.styles.typography?.fontSize) {
          settings.size = { size: node.styles.typography.fontSize, unit: 'px' };
        } else {
          settings.size = { size: 30, unit: 'px' };
        }
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        return {
          id,
          elType: 'widget',
          widgetType: 'icon',
          settings
        };
      }
      case 'image': {
        const settings: any = {
          image: { url: node.properties.url || '' },
          image_size: 'full',
          align: node.styles.alignment || 'center'
        };
        if (node.styles.maxWidth || node.styles.width) {
          const w = parseInt(node.styles.maxWidth || node.styles.width || '', 10);
          if (w && w <= 100) settings.width = { size: w, unit: '%' };
        }
        if (node.styles.border?.radius) {
          settings.image_border_radius = formatElementorSpacing(node.styles.border.radius as any);
        }
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        if (node.properties.link?.url) {
          settings.link_to = 'custom';
          settings.link = { url: node.properties.link.url };
        }
        return {
          id,
          elType: 'widget',
          widgetType: 'image',
          settings
        };
      }
      case 'video': {
        const url = node.properties.url || '';
        const cleanUrl = url.replace(/#t=\d+$/, '');
        const isSelfHosted = !cleanUrl.includes('youtube.com') && !cleanUrl.includes('youtu.be') && !cleanUrl.includes('vimeo.com') && !cleanUrl.includes('dailymotion.com');
        const settings: any = {
          video_type: isSelfHosted ? 'hosted' : (cleanUrl.includes('vimeo.com') ? 'vimeo' : 'youtube')
        };
        if (isSelfHosted) {
          settings.hosted_url = {
            url: cleanUrl,
            id: node.properties.attachmentId || ''
          };
          settings.source = {
            $$type: 'video-src',
            value: {
              id: node.properties.attachmentId ? { $$type: 'video-attachment-id', value: node.properties.attachmentId } : null,
              url: cleanUrl
            }
          };
        } else if (cleanUrl.includes('vimeo.com')) {
          settings.vimeo_url = cleanUrl;
        } else {
          settings.youtube_url = cleanUrl;
        }

        if (node.properties.autoplay) settings.autoplay = 'yes';
        if (node.properties.loop) settings.loop = 'yes';
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        if (node.styles.padding) settings._padding = formatElementorSpacing(node.styles.padding as any);

        return {
          id,
          elType: 'widget',
          widgetType: 'video',
          settings
        };
      }
      case 'divider': {
        const settings: any = {
          style: node.properties.style || 'solid',
          weight: { size: node.properties.weight || 1, unit: 'px' },
          width: { size: 100, unit: '%' }
        };
        if (node.styles.border?.color || node.styles.color) {
          settings.color = node.styles.border?.color || node.styles.color;
        }
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        return {
          id,
          elType: 'widget',
          widgetType: 'divider',
          settings
        };
      }
      case 'raw-html': {
        const content = node.properties.html || node.properties.code || '';
        if (content.trim().startsWith('[') && content.trim().endsWith(']')) {
          return {
            id,
            elType: 'widget',
            widgetType: 'shortcode',
            settings: { shortcode: content.trim() }
          };
        }
        return {
          id,
          elType: 'widget',
          widgetType: 'html',
          settings: { html: content }
        };
      }
      case 'map': {
        return {
          id,
          elType: 'widget',
          widgetType: 'google-maps',
          settings: { address: node.properties.address || '' }
        };
      }
      case 'counter': {
        const align = node.styles.alignment || 'center';
        const numColor = node.styles.color || node.properties.numberColor || '#1e293b';
        const numFontSize = node.styles.typography?.fontSize;
        const numFontWeight = node.styles.typography?.fontWeight;
        const numFontFamily = node.styles.typography?.fontFamily;
        const endNumber = node.properties.endNumber ?? node.properties.number ?? 100;

        const settings: any = {
          starting_number: node.properties.startNumber || 0,
          ending_number: endNumber,
          prefix: node.properties.prefix || '',
          suffix: node.properties.suffix || '',
          title: node.properties.title || '',
          title_position: 'top',
          title_horizontal_alignment: align,
          number_alignment: align,
          number_color: numColor
        };
        if (numFontSize) {
          settings.typography_number_typography = 'custom';
          settings.typography_number_font_size = {
            size: typeof numFontSize === 'number' ? numFontSize : parseFloat(String(numFontSize)),
            unit: node.styles.typography?.fontSizeUnit || 'px'
          };
        }
        if (numFontWeight && numFontWeight !== 'default') {
          settings.typography_number_typography = 'custom';
          settings.typography_number_font_weight = numFontWeight;
        }
        if (numFontFamily && numFontFamily !== 'Default') {
          settings.typography_number_typography = 'custom';
          settings.typography_number_font_family = numFontFamily;
        }
        if (node.properties.titleColor) {
          settings.title_color = node.properties.titleColor;
        }
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        return {
          id,
          elType: 'widget',
          widgetType: 'counter',
          settings
        };
      }
      case 'icon-box': {
        const rawIcon = node.properties.icon || 'star';
        const iconValue = rawIcon.includes('wordpress') ? 'fab fa-wordpress' : (rawIcon.startsWith('fa') ? rawIcon : `fas fa-${rawIcon}`);
        const library = iconValue.startsWith('fab') ? 'fa-brands' : (iconValue.startsWith('far') ? 'fa-regular' : 'fa-solid');
        const pos = node.properties.position || (node.styles.alignment === 'left' ? 'left' : (node.styles.alignment === 'right' ? 'right' : 'top'));
        const align = node.styles.alignment || (pos === 'top' ? 'center' : 'left');
        const settings: any = {
          selected_icon: { value: iconValue, library },
          title_text: node.properties.title || '',
          description_text: node.properties.description || '',
          position: pos,
          text_align: align
        };
        if (node.properties.link?.url) settings.link = { url: node.properties.link.url };
        if (node.styles.color) settings.title_color = node.styles.color;
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        return {
          id,
          elType: 'widget',
          widgetType: 'icon-box',
          settings
        };
      }
      case 'accordion': {
        const items = Array.isArray(node.properties.items) ? node.properties.items : [];
        const settings: any = {
          tabs: items.map((it: any) => ({ tab_title: it.title || it.label || '', tab_content: it.content || '' }))
        };
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        return {
          id,
          elType: 'widget',
          widgetType: 'accordion',
          settings
        };
      }
      case 'audio': {
        const url = node.properties.url || '';
        const attachmentId = node.properties.attachmentId ? Number(node.properties.attachmentId) : 0;
        if (url.includes('soundcloud.com')) {
          return {
            id,
            elType: 'widget',
            widgetType: 'audio',
            settings: {
              link: { url }
            }
          };
        }
        return {
          id,
          elType: 'widget',
          widgetType: 'wp-widget-media_audio',
          settings: {
            wp: {
              title: node.properties.title || '',
              attachment_id: attachmentId,
              url,
              preload: 'none'
            }
          }
        };
      }
      case 'spacer': {
        const size = parseInt(String(node.properties.height || '50').replace('px', ''), 10) || 50;
        return {
          id,
          elType: 'widget',
          widgetType: 'spacer',
          settings: { space: { size, unit: 'px' } }
        };
      }
      case 'star-rating': {
        const rating = node.properties.rating || 5;
        return {
          id,
          elType: 'widget',
          widgetType: 'star-rating',
          settings: { rating: Number(rating), rating_scale: 5, title: node.properties.title || '' }
        };
      }
      case 'social-icons': {
        const icons = Array.isArray(node.properties.icons) ? node.properties.icons : (Array.isArray(node.properties.items) ? node.properties.items : []);
        return {
          id,
          elType: 'widget',
          widgetType: 'social-icons',
          settings: {
            social_icon_list: icons.map((i: any) => ({
              social_icon: {
                value: i.name || i.icon || (i.platform ? `fab fa-${i.platform}` : 'fab fa-facebook'),
                library: 'fa-brands'
              },
              link: { url: i.link || i.url || '#' }
            }))
          }
        };
      }
      case 'text':
      default: {
        if (node.type !== 'text' && node.properties.html && !node.properties.text) {
          const content = node.properties.html;
          if (content.trim().startsWith('[') && content.trim().endsWith(']')) {
            return {
              id,
              elType: 'widget',
              widgetType: 'shortcode',
              settings: { shortcode: content.trim() }
            };
          }
          return {
            id,
            elType: 'widget',
            widgetType: 'html',
            settings: { html: content }
          };
        }
        const settings: any = {
          editor: node.properties.text || node.properties.html || ''
        };
        if (node.styles.color) settings.text_color = node.styles.color;
        if (node.styles.alignment) settings.align = node.styles.alignment;
        if (node.styles.typography) {
          settings.typography_typography = 'custom';
          if (node.styles.typography.fontSize) {
            settings.typography_font_size = { size: node.styles.typography.fontSize, unit: node.styles.typography.fontSizeUnit || 'px' };
          }
          if (node.styles.typography.fontFamily) settings.typography_font_family = node.styles.typography.fontFamily;
          if (node.styles.typography.fontWeight) settings.typography_font_weight = String(node.styles.typography.fontWeight);
          if (node.styles.typography.fontStyle) settings.typography_font_style = node.styles.typography.fontStyle;
          if (node.styles.typography.lineHeight) settings.typography_line_height = { size: parseFloat(String(node.styles.typography.lineHeight)), unit: 'em' };
          if (node.styles.typography.letterSpacing) settings.typography_letter_spacing = { size: parseFloat(String(node.styles.typography.letterSpacing)), unit: 'px' };
          if (node.styles.typography.textTransform) settings.typography_text_transform = node.styles.typography.textTransform;
          if (node.styles.typography.textDecoration) settings.typography_text_decoration = node.styles.typography.textDecoration;
        }
        if (node.styles.margin) settings._margin = formatElementorSpacing(node.styles.margin as any);
        if (node.styles.padding) settings._padding = formatElementorSpacing(node.styles.padding as any);
        return {
          id,
          elType: 'widget',
          widgetType: 'text-editor',
          settings
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SERIALIZATION: TO GENERIC / BLOCK / OTHER BUILDERS
  // ---------------------------------------------------------------------------
  private serializeToGeneric(
    page: UniversalPage,
    targetBuilder: string,
    warnings: MigrationWarning[]
  ): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  } {
    const htmlBlocks: string[] = [];
    const sections = page.root.children.filter((c) => c.type === 'section' || c.type === 'container');

    for (const section of sections) {
      const bg = section.styles.backgroundColor || '#ffffff';
      const columns = section.children.filter((c) => c.type === 'column');
      const colCount = Math.max(columns.length, 1);
      const colWidth = Number((100 / colCount).toFixed(2));

      const colHtml = columns.map((col) => {
        const widgetsHtml = col.children.map((w) => {
          if (w.type === 'heading') return `<${w.properties.level || 'h2'}>${w.properties.text || ''}</${w.properties.level || 'h2'}>`;
          if (w.type === 'button') return `<a href="${w.properties.link?.url || '#'}" class="wp-button" style="display: inline-block; padding: 12px 24px; background: #0073aa; color: #fff; text-decoration: none; border-radius: 4px;">${w.properties.text || 'Button'}</a>`;
          if (w.type === 'image') return `<img src="${w.properties.url || ''}" alt="" style="max-width: 100%; height: auto;" />`;
          return `<div>${w.properties.text || w.properties.html || ''}</div>`;
        }).join('\n');

        return `<div style="flex: 1 1 ${colWidth}%; min-width: 280px;">\n${widgetsHtml}\n</div>`;
      }).join('\n');

      htmlBlocks.push(
        `<section style="background-color: ${bg}; padding: 60px 20px;">\n` +
        `  <div style="max-width: 1200px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 24px;">\n` +
        `${colHtml}\n` +
        `  </div>\n` +
        `</section>`
      );
    }

    const content = htmlBlocks.join('\n\n');
    return {
      rawData: { builder: targetBuilder, sections: htmlBlocks.length, content },
      wordpressPayload: {
        title: page.title,
        content,
        meta: {
          [`_${targetBuilder}_migrated`]: 'true'
        }
      },
      warnings
    };
  }

  // ---------------------------------------------------------------------------
  // SERIALIZATION: TO DIVI
  // ---------------------------------------------------------------------------
  private serializeToDivi(
    page: UniversalPage,
    warnings: MigrationWarning[],
    options?: Partial<MigrationOptions>
  ): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  } {
    const sectionBlocks: string[] = [];
    const sections = page.root.children.filter((c) => c.type === 'section' || c.type === 'container');

    for (const section of sections) {
      const bgAttr = section.styles.backgroundColor ? ` background_color="${section.styles.backgroundColor}"` : '';
      const padAttr = section.styles.padding ? ` custom_padding="${formatDiviSpacing(section.styles.padding)}"` : '';
      const marAttr = section.styles.margin ? ` custom_margin="${formatDiviSpacing(section.styles.margin)}"` : '';
      const maxW = section.styles.maxWidth || '1140px';
      const rowMaxWAttr = ` max_width="${maxW.endsWith('px') || maxW.endsWith('%') ? maxW : `${maxW}px`}"`;

      let columns = section.children.filter((c) => c.type === 'column');
      const directWidgets = section.children.filter((c) => c.type !== 'column');
      if (directWidgets.length > 0) {
        const autoCol = createNode('column', {}, { width: '100%' }, directWidgets, { columnSpan: 100 });
        columns = [...columns, autoCol];
      }
      if (columns.length === 0 || columns.every((c) => c.children.length === 0)) {
        continue;
      }
      const colBlocks: string[] = [];

      const colSpans = columns.map((col) => col.metadata?.columnSpan || (col.styles.width ? parseFloat(col.styles.width) : 100));
      const colTypes = formatDiviRowColumns(colSpans);

      for (let cIdx = 0; cIdx < columns.length; cIdx++) {
        const col = columns[cIdx];
        const colType = colTypes[cIdx] || '4_4';
        const colPadAttr = col.styles.padding ? ` custom_padding="${formatDiviSpacing(col.styles.padding)}"` : '';

        const modBlocks: string[] = [];
        for (const child of col.children) {
          modBlocks.push(this.serializeDiviModule(child));
        }

        colBlocks.push(
          `    [et_pb_column type="${colType}" _builder_version="4.25.0"${colPadAttr}]\n` +
          modBlocks.map((m) => `      ${m}`).join('\n') +
          `\n    [/et_pb_column]`
        );
      }

      sectionBlocks.push(
        `[et_pb_section fb_built="1" _builder_version="4.25.0"${bgAttr}${padAttr}${marAttr}]\n` +
        `  [et_pb_row _builder_version="4.25.0"${rowMaxWAttr}]\n` +
        colBlocks.join('\n') +
        `\n  [/et_pb_row]\n` +
        `[/et_pb_section]`
      );
    }

    const shortcodes = sectionBlocks.join('\n\n');

    return {
      rawData: shortcodes,
      wordpressPayload: {
        title: page.title,
        content: shortcodes,
        meta: {
          _et_pb_use_builder: 'on',
          _et_builder_version: '4.25.0',
          _et_pb_old_content: ''
        }
      },
      warnings
    };
  }

  private serializeDiviModule(node: UniversalNode): string {
    switch (node.type) {
      case 'heading': {
        const level = node.properties.level || 'h2';
        const text = node.properties.text || '';
        const color = node.styles.color || '#1e293b';
        const align = node.styles.alignment || 'left';
        const fontSize = node.styles.typography?.fontSize ? `${node.styles.typography.fontSize}${node.styles.typography.fontSizeUnit || 'px'}` : '32px';
        const fontFamily = node.styles.typography?.fontFamily || '';
        const fontWeight = node.styles.typography?.fontWeight || '700';
        const lineHeight = node.styles.typography?.lineHeight ? ` header_line_height="${node.styles.typography.lineHeight}"` : '';
        const letterSpacing = node.styles.typography?.letterSpacing ? ` header_letter_spacing="${node.styles.typography.letterSpacing}"` : '';
        const margin = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';

        const fontAttr = fontFamily ? ` header_font="${fontFamily}"` : '';
        const weightAttr = fontWeight ? ` header_font_weight="${fontWeight}"` : '';

        return `[et_pb_text _builder_version="4.25.0" header_text_color="${color}" header_font_size="${fontSize}"${fontAttr}${weightAttr}${lineHeight}${letterSpacing} header_text_align="${align}" text_orientation="${align}"${margin}]<${level} style="color: ${color}; font-size: ${fontSize}; ${fontFamily ? `font-family: ${fontFamily};` : ''} font-weight: ${fontWeight}; text-align: ${align}; margin: 0;">${text}</${level}>[/et_pb_text]`;
      }
      case 'button': {
        const text = node.properties.text || 'Click Here';
        const url = node.properties.link?.url || '#';
        const newTab = node.properties.link?.openInNewTab ? 'on' : 'off';
        const rawAlign = node.styles.alignment || 'center';
        const isFull = node.styles.width === '100%' || node.properties.width === 'full' || rawAlign === 'justify';
        const align = isFull ? 'center' : (rawAlign || 'center');
        const btnBg = node.styles.backgroundColor || '#2563eb';
        const btnColor = node.styles.color || '#ffffff';
        const fontSize = node.styles.typography?.fontSize ? `${node.styles.typography.fontSize}${node.styles.typography.fontSizeUnit || 'px'}` : '16px';
        const fontFamily = node.styles.typography?.fontFamily || '';
        const fontWeight = node.styles.typography?.fontWeight || '700';
        const fontAttr = fontFamily ? ` button_font="${fontFamily}"` : '';
        const weightAttr = fontWeight ? ` button_font_weight="${fontWeight}"` : '';
        const border = node.styles.border;
        const borderWidth = border?.width ? `${border.width}px` : (border?.style === 'none' ? '0px' : '');
        const borderAttr = borderWidth ? ` button_border_width="${borderWidth}"` : '';
        const borderColor = border?.color ? ` button_border_color="${border.color}"` : '';
        const borderRadius = border?.radius ? (typeof border.radius === 'object' ? `${border.radius.top || 0}px` : `${border.radius}px`) : '';
        const radiusAttr = borderRadius ? ` button_border_radius="${borderRadius}"` : '';
        const padAttr = node.styles.padding ? ` custom_padding="${formatDiviSpacing(node.styles.padding)}"` : '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        const fullCssAttr = isFull ? ` custom_css_main_element="width: 100%; display: block;"` : '';

        return `[et_pb_button button_url="${url}" button_text="${text}" url_new_window="${newTab}" button_alignment="${align}" custom_button="on" button_text_color="${btnColor}" button_bg_color="${btnBg}"${borderAttr}${borderColor}${radiusAttr} button_font_size="${fontSize}"${fontAttr}${weightAttr} button_use_icon="off"${fullCssAttr}${padAttr}${marAttr} _builder_version="4.25.0"][/et_pb_button]`;
      }
      case 'icon': {
        const iconCode = '&#x57;';
        const color = node.styles.color || '#000000';
        const size = node.styles.typography?.fontSize ? `${node.styles.typography.fontSize}px` : '30px';
        const align = node.styles.alignment || 'left';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_blurb use_icon="on" font_icon="${iconCode}" icon_color="${color}" icon_placement="top" image_icon_width="${size}" content_max_width="100%" text_orientation="${align}"${marAttr} _builder_version="4.25.0"][/et_pb_blurb]`;
      }
      case 'icon-box': {
        const title = node.properties.title || '';
        const desc = node.properties.description || '';
        const color = node.styles.color || '#1e293b';
        const align = node.styles.alignment || 'left';
        const pos = node.properties.position === 'left' ? 'left' : (node.properties.position === 'right' ? 'right' : 'top');
        const iconCode = '&#x57;';
        const url = node.properties.link?.url || '';
        const urlAttr = url ? ` url="${url}"` : '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_blurb title="${title}"${urlAttr} use_icon="on" font_icon="${iconCode}" icon_color="${color}" icon_placement="${pos}" text_orientation="${align}"${marAttr} _builder_version="4.25.0"]<p>${desc}</p>[/et_pb_blurb]`;
      }
      case 'image': {
        const url = node.properties.url || '';
        const alt = node.properties.alt || '';
        const align = node.styles.alignment || 'center';
        const maxW = node.styles.maxWidth || node.styles.width || '100%';
        const border = node.styles.border;
        const rad = border?.radius ? (typeof border.radius === 'object' ? `${border.radius.top || 0}px` : `${border.radius}px`) : '0px';
        const radAttr = rad !== '0px' ? ` border_radii="on|${rad}|${rad}|${rad}|${rad}"` : '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_image src="${url}" alt="${alt}" align="${align}" max_width="${maxW}"${radAttr}${marAttr} _builder_version="4.25.0"][/et_pb_image]`;
      }
      case 'divider': {
        const color = node.styles.color || '#cbd5e1';
        const weight = node.properties.weight ? `${node.properties.weight}px` : '1px';
        const width = node.properties.width || '100%';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_divider color="${color}" divider_weight="${weight}" max_width="${width}"${marAttr} _builder_version="4.25.0"][/et_pb_divider]`;
      }
      case 'spacer': {
        const h = node.properties.height || '50px';
        const heightStr = String(h).includes('px') ? String(h) : `${h}px`;
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_divider show_divider="off" height="${heightStr}"${marAttr} _builder_version="4.25.0"][/et_pb_divider]`;
      }
      case 'video': {
        const url = node.properties.url || '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_video src="${url}"${marAttr} _builder_version="4.25.0"][/et_pb_video]`;
      }
      case 'audio': {
        const url = node.properties.url || '';
        const title = node.properties.title || '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_audio audio="${url}" title="${title}"${marAttr} _builder_version="4.25.0"][/et_pb_audio]`;
      }
      case 'accordion': {
        const items: Array<{ title: string; content: string }> = Array.isArray(node.properties.items) ? node.properties.items : [];
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        const itemCodes = items.map((it: any, idx: number) => {
          const open = idx === 0 ? 'on' : 'off';
          const itemTitle = it.title || it.label || `Item ${idx + 1}`;
          const itemContent = it.content || '';
          return `[et_pb_accordion_item title="${itemTitle}" open="${open}" _builder_version="4.25.0"]${itemContent}[/et_pb_accordion_item]`;
        }).join('');
        return `[et_pb_accordion${marAttr} _builder_version="4.25.0"]${itemCodes}[/et_pb_accordion]`;
      }
      case 'counter': {
        const endNum = node.properties.endNumber ?? node.properties.number ?? 100;
        const title = node.properties.title || '';
        const suffix = node.properties.suffix || '';
        const color = node.styles.color || '#1e293b';
        const align = node.styles.alignment || 'center';
        const fontSize = node.styles.typography?.fontSize;
        const fontAttr = fontSize ? ` number_font_size="${fontSize}${node.styles.typography?.fontSizeUnit || 'px'}"` : '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_number_counter title="${title}" number="${endNum}" percent_sign="${suffix === '%' ? 'on' : 'off'}" text_orientation="${align}" number_text_color="${color}"${fontAttr}${marAttr} _builder_version="4.25.0"][/et_pb_number_counter]`;
      }
      case 'star-rating': {
        const rating = Math.min(Math.max(node.properties.rating || 5, 0), 5);
        const title = node.properties.title || '';
        const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_text${marAttr} _builder_version="4.25.0"]<div class="et_pb_star_rating">${title ? `<strong>${title}</strong><br/>` : ''}<span style="color: #f59e0b; font-size: 20px;">${stars}</span></div>[/et_pb_text]`;
      }
      case 'social-icons': {
        const icons = Array.isArray(node.properties.icons) ? node.properties.icons : (Array.isArray(node.properties.items) ? node.properties.items : []);
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        const netCodes = icons.map((i: any) => {
          const rawName = (i.name || i.icon || i.platform || 'facebook').toLowerCase();
          let net = 'facebook';
          if (rawName.includes('twitter') || rawName.includes('x')) net = 'twitter';
          else if (rawName.includes('instagram')) net = 'instagram';
          else if (rawName.includes('linkedin')) net = 'linkedin';
          else if (rawName.includes('youtube')) net = 'youtube';
          else if (rawName.includes('github')) net = 'github';
          else if (rawName.includes('pinterest')) net = 'pinterest';
          const url = i.link || i.url || '#';
          return `[et_pb_social_media_follow_network social_network="${net}" url="${url}" _builder_version="4.25.0"]${net}[/et_pb_social_media_follow_network]`;
        }).join('');
        return `[et_pb_social_media_follow${marAttr} _builder_version="4.25.0"]${netCodes}[/et_pb_social_media_follow]`;
      }
      case 'map': {
        const address = node.properties.address || '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';
        return `[et_pb_map address="${address}"${marAttr} _builder_version="4.25.0"][et_pb_map_pin pin_address="${address}" _builder_version="4.25.0"][/et_pb_map_pin][/et_pb_map]`;
      }
      case 'raw-html': {
        const html = node.properties.html || node.properties.code || '';
        return `[et_pb_code _builder_version="4.25.0"]${html}[/et_pb_code]`;
      }
      case 'text':
      default: {
        const text = node.properties.text || node.properties.html || '';
        const color = node.styles.color || '#334155';
        const align = node.styles.alignment || 'left';
        const fontSize = node.styles.typography?.fontSize ? `${node.styles.typography.fontSize}${node.styles.typography.fontSizeUnit || 'px'}` : '16px';
        const fontFamily = node.styles.typography?.fontFamily || '';
        const fontWeight = node.styles.typography?.fontWeight || '400';
        const lineHeight = node.styles.typography?.lineHeight ? ` text_line_height="${node.styles.typography.lineHeight}"` : '';
        const letterSpacing = node.styles.typography?.letterSpacing ? ` text_letter_spacing="${node.styles.typography.letterSpacing}"` : '';
        const fontAttr = fontFamily ? ` text_font="${fontFamily}"` : '';
        const weightAttr = fontWeight ? ` text_font_weight="${fontWeight}"` : '';
        const marAttr = node.styles.margin ? ` custom_margin="${formatDiviSpacing(node.styles.margin)}"` : '';

        return `[et_pb_text _builder_version="4.25.0" text_text_color="${color}" text_font_size="${fontSize}"${fontAttr}${weightAttr}${lineHeight}${letterSpacing} text_orientation="${align}"${marAttr}]<p style="color: ${color}; font-size: ${fontSize}; ${fontFamily ? `font-family: ${fontFamily};` : ''} font-weight: ${fontWeight}; text-align: ${align}; margin: 0;">${text}</p>[/et_pb_text]`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SERIALIZATION: TO GUTENBERG
  // ---------------------------------------------------------------------------
  private serializeToGutenberg(
    page: UniversalPage,
    warnings: MigrationWarning[],
    options?: Partial<MigrationOptions>
  ): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  } {
    const blocks: string[] = [];
    const sections = page.root.children.filter((c) => c.type === 'section' || c.type === 'container');

    for (const section of sections) {
      const maxW = section.styles.maxWidth || '1140px';
      const bg = section.styles.backgroundColor;
      let columns = section.children.filter((c) => c.type === 'column');
      const directWidgets = section.children.filter((c) => c.type !== 'column');
      if (directWidgets.length > 0) {
        const autoCol = createNode('column', {}, { width: '100%' }, directWidgets, { columnSpan: 100 });
        columns = [...columns, autoCol];
      }
      if (columns.length === 0 || columns.every((c) => c.children.length === 0)) {
        continue;
      }
      const colBlocks: string[] = [];
      for (const col of columns) {
        const colWidth = col.metadata?.columnSpan || (col.styles.width ? parseFloat(col.styles.width) : 100);
        const widgetBlocks: string[] = [];

        for (const child of col.children) {
          if (child.type === 'heading') {
            const levelNum = child.properties.level ? parseInt(child.properties.level.replace('h', ''), 10) || 2 : 2;
            const text = child.properties.text || '';
            const color = child.styles.color || '';
            const align = child.styles.alignment || '';
            const fontSize = child.styles.typography?.fontSize ? `${child.styles.typography.fontSize}${child.styles.typography.fontSizeUnit || 'px'}` : '';
            const fontFamily = child.styles.typography?.fontFamily || '';
            const fontWeight = child.styles.typography?.fontWeight || '';

            const styleObj: any = {};
            if (color) styleObj.color = { text: color };
            if (fontSize || fontFamily || fontWeight) {
              styleObj.typography = {};
              if (fontSize) styleObj.typography.fontSize = fontSize;
              if (fontFamily) styleObj.typography.fontFamily = fontFamily;
              if (fontWeight) styleObj.typography.fontWeight = fontWeight;
            }

            const styleAttr = Object.keys(styleObj).length > 0 ? ` ${JSON.stringify({ textAlign: align || undefined, style: styleObj })}` : (align ? ` {"textAlign":"${align}"}` : '');
            widgetBlocks.push(`<!-- wp:heading${styleAttr} -->\n<h${levelNum} class="${align ? `has-text-align-${align}` : ''}" style="${color ? `color:${color};` : ''} ${fontSize ? `font-size:${fontSize};` : ''}">${text}</h${levelNum}>\n<!-- /wp:heading -->`);
          } else if (child.type === 'button') {
            const text = child.properties.text || 'Button';
            const url = child.properties.link?.url || '#';
            const bg = child.styles.backgroundColor || '#2563eb';
            const color = child.styles.color || '#ffffff';
            const rawAlign = child.styles.alignment || 'center';
            const isFull = child.properties.width === 'full' || child.styles.width === '100%' || rawAlign === 'justify';
            const align = isFull ? 'center' : (rawAlign || 'center');
            const fontSize = child.styles.typography?.fontSize ? `${child.styles.typography.fontSize}${child.styles.typography.fontSizeUnit || 'px'}` : '';
            const fontFamily = child.styles.typography?.fontFamily || '';
            const fontWeight = child.styles.typography?.fontWeight || '';
            const padding = child.styles.padding ? formatCssSpacing(child.styles.padding) : '';
            const radius = child.styles.border?.radius ? formatCssRadius(child.styles.border.radius) : '';
            const border = child.styles.border ? formatCssBorder(child.styles.border) : '';

            const inlineBtnStyle = [
              `background-color:${bg}`,
              `color:${color}`,
              fontSize ? `font-size:${fontSize}` : '',
              fontFamily ? `font-family:${fontFamily}` : '',
              fontWeight ? `font-weight:${fontWeight}` : '',
              padding ? `padding:${padding}` : '',
              radius ? `border-radius:${radius}` : '',
              border ? `border:${border}` : '',
              isFull ? 'width:100%;text-align:center;' : ''
            ].filter(Boolean).join(';');

            const btnWidthClass = isFull ? ' has-custom-width wp-block-button__width-100' : '';

            widgetBlocks.push(
              `<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"${align}"}} -->\n` +
              `<div class="wp-block-buttons">\n` +
              `<!-- wp:button {${isFull ? `"width":100,` : ''}"style":{"color":{"background":"${bg}","text":"${color}"}}} -->\n` +
              `<div class="wp-block-button${btnWidthClass}"><a class="wp-block-button__link has-text-color has-background" href="${url}" style="${inlineBtnStyle}">${text}</a></div>\n` +
              `<!-- /wp:button -->\n` +
              `</div>\n` +
              `<!-- /wp:buttons -->`
            );
          } else if (child.type === 'image') {
            const url = child.properties.url || '';
            const alt = child.properties.alt || '';
            widgetBlocks.push(`<!-- wp:image {"sizeSlug":"full"} -->\n<figure class="wp-block-image size-full"><img src="${url}" alt="${alt}"/></figure>\n<!-- /wp:image -->`);
          } else if (child.type === 'video') {
            const url = child.properties.url || '';
            const isEmbed = url.includes('youtube.com') || url.includes('youtu.be') || url.includes('vimeo.com');
            if (isEmbed) {
              const provider = url.includes('vimeo') ? 'vimeo' : 'youtube';
              widgetBlocks.push(`<!-- wp:embed {"url":"${url}","type":"video","providerNameSlug":"${provider}","responsive":true,"className":"wp-embed-aspect-16-9 wp-has-aspect-ratio"} -->\n<figure class="wp-block-embed is-type-video is-provider-${provider} wp-block-embed-${provider} wp-embed-aspect-16-9 wp-has-aspect-ratio"><div class="wp-block-embed__wrapper">\n${url}\n</div></figure>\n<!-- /wp:embed -->`);
            } else {
              widgetBlocks.push(`<!-- wp:video -->\n<figure class="wp-block-video"><video controls src="${url}"></video></figure>\n<!-- /wp:video -->`);
            }
          } else if (child.type === 'audio') {
            const url = child.properties.url || '';
            widgetBlocks.push(`<!-- wp:audio -->\n<figure class="wp-block-audio"><audio controls src="${url}"></audio></figure>\n<!-- /wp:audio -->`);
          } else if (child.type === 'divider') {
            widgetBlocks.push(`<!-- wp:separator {"className":"is-style-wide"} -->\n<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>\n<!-- /wp:separator -->`);
          } else if (child.type === 'spacer') {
            const h = child.properties.height || '50px';
            const heightNum = parseInt(String(h).replace('px', ''), 10) || 50;
            widgetBlocks.push(`<!-- wp:spacer {"height":"${heightNum}px"} -->\n<div style="height:${heightNum}px" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`);
          } else if (child.type === 'icon') {
            const rawIcon = child.properties.name || child.properties.icon || 'fab fa-wordpress';
            const color = child.styles.color || '';
            const size = child.styles.typography?.fontSize ? `${child.styles.typography.fontSize}px` : '32px';
            widgetBlocks.push(`<!-- wp:html -->\n<div class="wp-block-icon" style="display:inline-block;${color ? `color:${color};` : ''}font-size:${size};"><i class="${rawIcon}"></i></div>\n<!-- /wp:html -->`);
          } else if (child.type === 'icon-box') {
            const title = child.properties.title || '';
            const desc = child.properties.description || '';
            const rawIcon = child.properties.icon || 'star';
            const iconName = rawIcon.startsWith('fa') ? rawIcon : `fas fa-${rawIcon}`;
            const color = child.styles.color || '';
            const align = child.styles.alignment || 'left';
            const pos = child.properties.position === 'left' ? 'left' : 'top';
            if (pos === 'left') {
              widgetBlocks.push(
                `<!-- wp:group {"className":"wp-block-icon-box"} -->\n` +
                `<div class="wp-block-group wp-block-icon-box" style="display:flex;align-items:flex-start;gap:16px;margin-bottom:16px;text-align:${align};">\n` +
                `<div class="icon-box-icon" style="font-size:32px;line-height:1;flex-shrink:0;${color ? `color:${color};` : ''}"><i class="${iconName}"></i></div>\n` +
                `<div class="icon-box-content">\n` +
                `<h3 class="icon-box-title" style="margin:0 0 8px 0;${color ? `color:${color};` : ''}">${title}</h3>\n` +
                `<p class="icon-box-desc" style="margin:0;">${desc}</p>\n` +
                `</div>\n</div>\n<!-- /wp:group -->`
              );
            } else {
              widgetBlocks.push(
                `<!-- wp:group {"className":"wp-block-icon-box"} -->\n` +
                `<div class="wp-block-group wp-block-icon-box" style="margin-bottom:16px;text-align:${align};">\n` +
                `<div class="icon-box-icon" style="font-size:32px;margin-bottom:8px;${color ? `color:${color};` : ''}"><i class="${iconName}"></i></div>\n` +
                `<h3 class="icon-box-title" style="${color ? `color:${color};` : ''}">${title}</h3>\n` +
                `<p class="icon-box-desc">${desc}</p>\n` +
                `</div>\n<!-- /wp:group -->`
              );
            }
          } else if (child.type === 'accordion') {
            const items = Array.isArray(child.properties.items) ? child.properties.items : [];
            const detailsBlocks = items.map((it: any) => {
              const itemTitle = it.title || it.label || 'Details';
              const itemContent = it.content || '';
              return `<!-- wp:details {"summary":"${itemTitle}"} -->\n<details class="wp-block-details"><summary>${itemTitle}</summary>${itemContent}</details>\n<!-- /wp:details -->`;
            }).join('\n');
            widgetBlocks.push(detailsBlocks || `<!-- wp:paragraph --><p></p><!-- /wp:paragraph -->`);
          } else if (child.type === 'counter') {
            const endNum = child.properties.endNumber ?? child.properties.number ?? 100;
            const prefix = child.properties.prefix || '';
            const suffix = child.properties.suffix || '';
            const title = child.properties.title || '';
            const color = child.styles.color || '';
            const align = child.styles.alignment || 'center';
            const fontSize = child.styles.typography?.fontSize ? `${child.styles.typography.fontSize}${child.styles.typography.fontSizeUnit || 'px'}` : '32px';
            const fontWeight = child.styles.typography?.fontWeight || '700';
            widgetBlocks.push(
              `<!-- wp:group {"className":"wp-block-counter","layout":{"type":"flex","orientation":"vertical","justifyContent":"center"}} -->\n` +
              `<div class="wp-block-group wp-block-counter" style="text-align:${align};">\n` +
              `<p class="counter-number" style="font-size:${fontSize};font-weight:${fontWeight};${color ? `color:${color};` : ''}">${prefix}${endNum}${suffix}</p>\n` +
              (title ? `<p class="counter-title" style="font-size:16px;">${title}</p>\n` : '') +
              `</div>\n<!-- /wp:group -->`
            );
          } else if (child.type === 'star-rating') {
            const rating = Math.min(Math.max(child.properties.rating || 5, 0), 5);
            const title = child.properties.title || '';
            const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
            widgetBlocks.push(
              `<!-- wp:html -->\n<div class="wp-block-star-rating">${title ? `<strong>${title}</strong><br/>` : ''}<span style="color:#f59e0b;font-size:20px;">${stars}</span></div>\n<!-- /wp:html -->`
            );
          } else if (child.type === 'social-icons') {
            const icons = Array.isArray(child.properties.icons) ? child.properties.icons : (Array.isArray(child.properties.items) ? child.properties.items : []);
            const iconBlocks = icons.map((i: any) => {
              const rawName = (i.name || i.icon || i.platform || 'facebook').toLowerCase();
              let service = 'facebook';
              if (rawName.includes('twitter') || rawName.includes('x')) service = 'twitter';
              else if (rawName.includes('instagram')) service = 'instagram';
              else if (rawName.includes('linkedin')) service = 'linkedin';
              else if (rawName.includes('youtube')) service = 'youtube';
              else if (rawName.includes('github')) service = 'github';
              const url = i.link || i.url || '#';
              return `<!-- wp:social-link {"url":"${url}","service":"${service}"} /-->`;
            }).join('\n');
            widgetBlocks.push(
              `<!-- wp:social-links -->\n<ul class="wp-block-social-links">\n${iconBlocks}\n</ul>\n<!-- /wp:social-links -->`
            );
          } else if (child.type === 'map') {
            const address = child.properties.address || '';
            widgetBlocks.push(
              `<!-- wp:html -->\n<div class="wp-block-map"><iframe width="100%" height="400" frameborder="0" src="https://maps.google.com/maps?q=${encodeURIComponent(address)}&output=embed"></iframe></div>\n<!-- /wp:html -->`
            );
          } else if (child.type === 'raw-html') {
            const raw = child.properties.html || child.properties.code || '';
            widgetBlocks.push(`<!-- wp:html -->\n${raw}\n<!-- /wp:html -->`);
          } else {
            const text = child.properties.text || child.properties.html || '';
            const color = child.styles.color || '';
            const align = child.styles.alignment || '';
            const fontSize = child.styles.typography?.fontSize ? `${child.styles.typography.fontSize}${child.styles.typography.fontSizeUnit || 'px'}` : '';

            const styleObj: any = {};
            if (color) styleObj.color = { text: color };
            if (fontSize) styleObj.typography = { fontSize };
            const styleAttr = Object.keys(styleObj).length > 0 ? ` ${JSON.stringify({ align: align || undefined, style: styleObj })}` : (align ? ` {"align":"${align}"}` : '');

            widgetBlocks.push(`<!-- wp:paragraph${styleAttr} -->\n<p class="${align ? `has-text-align-${align}` : ''}" style="${color ? `color:${color};` : ''} ${fontSize ? `font-size:${fontSize};` : ''}">${text}</p>\n<!-- /wp:paragraph -->`);
          }
        }

        colBlocks.push(
          `<!-- wp:column {"width":"${colWidth}%"} -->\n` +
          `<div class="wp-block-column" style="flex-basis:${colWidth}%">\n` +
          widgetBlocks.join('\n') +
          `\n</div>\n` +
          `<!-- /wp:column -->`
        );
      }

      blocks.push(
        `<!-- wp:group {"layout":{"type":"constrained","contentSize":"${maxW}"}} -->\n` +
        `<div class="wp-block-group" style="${bg ? `background-color:${bg};` : ''}">\n` +
        `<!-- wp:columns -->\n` +
        `<div class="wp-block-columns">\n` +
        colBlocks.join('\n') +
        `\n</div>\n` +
        `<!-- /wp:columns -->\n` +
        `</div>\n` +
        `<!-- /wp:group -->`
      );
    }

    const content = blocks.join('\n\n');
    return {
      rawData: content,
      wordpressPayload: {
        title: page.title,
        content
      },
      warnings
    };
  }
}
