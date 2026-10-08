/**
 * Unified Core Page Builder & AST Types
 */

export type PageBuilderType = string;

export type UniversalNodeType =
  // Layout nodes
  | 'page'
  | 'section'
  | 'row'
  | 'column'
  | 'container'
  // Content / widget nodes
  | 'heading'
  | 'text'
  | 'image'
  | 'button'
  | 'video'
  | 'audio'
  | 'divider'
  | 'spacer'
  | 'icon'
  | 'icon-box'
  | 'accordion'
  | 'counter'
  | 'star-rating'
  | 'social-icons'
  | 'map'
  | 'raw-html'
  | 'unknown';

export interface SpacingUnit {
  top?: string | number;
  right?: string | number;
  bottom?: string | number;
  left?: string | number;
  unit?: 'px' | '%' | 'em' | 'rem' | 'vh' | 'vw';
}

export interface BorderStyle {
  style?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
  width?: string | number;
  color?: string;
  radius?: SpacingUnit | string | number;
}

export interface TypographyStyle {
  fontFamily?: string;
  fontSize?: string | number;
  fontSizeUnit?: string;
  fontWeight?: string | number;
  fontStyle?: 'normal' | 'italic' | 'oblique';
  textTransform?: 'none' | 'capitalize' | 'uppercase' | 'lowercase';
  lineHeight?: string | number;
  letterSpacing?: string | number;
  textDecoration?: 'none' | 'underline' | 'overline' | 'line-through';
}

export interface UniversalStyles {
  color?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  backgroundSize?: 'auto' | 'cover' | 'contain';
  backgroundPosition?: string;
  backgroundRepeat?: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y';
  opacity?: number;
  padding?: SpacingUnit;
  margin?: SpacingUnit;
  border?: BorderStyle;
  typography?: TypographyStyle;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  width?: string;
  maxWidth?: string;
  minHeight?: string;
  customCss?: string;
  customClasses?: string[];
  flex?: {
    direction?: 'row' | 'row-reverse' | 'column' | 'column-reverse';
    wrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
    justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
    align?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
    gap?: string | number;
  };
  gradient?: {
    type?: 'linear' | 'radial';
    angle?: number;
    colorA?: string;
    colorB?: string;
  };
}

export interface UniversalLink {
  url: string;
  isExternal?: boolean;
  nofollow?: boolean;
  title?: string;
}

export interface HeadingProperties {
  text: string;
  level?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'div' | 'p' | 'span';
  link?: UniversalLink;
}

export interface TextProperties {
  content: string; // HTML or Markdown
}

export interface ImageProperties {
  url: string;
  alt?: string;
  title?: string;
  caption?: string;
  link?: UniversalLink;
  width?: number | string;
  height?: number | string;
}

export interface ButtonProperties {
  text: string;
  link: UniversalLink;
  icon?: string;
  iconPosition?: 'before' | 'after';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

export interface VideoProperties {
  url: string;
  sourceType?: 'youtube' | 'vimeo' | 'self-hosted' | 'external';
  autoplay?: boolean;
  loop?: boolean;
  controls?: boolean;
}

export interface DividerProperties {
  style?: 'solid' | 'double' | 'dotted' | 'dashed';
  weight?: number;
  width?: string;
  color?: string;
}

export interface SpacerProperties {
  height: number | string;
}

export interface IconProperties {
  name: string;
  link?: UniversalLink;
}

export interface IconBoxProperties {
  title: string;
  description: string;
  icon?: string;
  iconPosition?: 'top' | 'left' | 'right';
  link?: UniversalLink;
}

export interface AccordionItem {
  id?: string;
  title: string;
  content: string;
}

export interface AccordionProperties {
  items: AccordionItem[];
  defaultActive?: number;
  multiExpand?: boolean;
}

export interface CounterProperties {
  start?: number;
  end: number;
  prefix?: string;
  suffix?: string;
  title?: string;
  duration?: number;
}

export interface SocialIconItem {
  platform: string;
  url: string;
  icon?: string;
}

export interface SocialIconsProperties {
  items: SocialIconItem[];
}

export interface RawHtmlProperties {
  html: string;
}

export type UniversalProperties = Record<string, any>;

export interface UniversalNodeMetadata {
  originalBuilder?: PageBuilderType;
  originalType?: string;
  originalId?: string;
  columnSpan?: number; // e.g. 100% or 50%
  columnWidthPercent?: number;
  rawSettings?: Record<string, any>;
  [key: string]: any;
}

export interface UniversalNode {
  id: string;
  type: UniversalNodeType;
  properties: UniversalProperties;
  styles: UniversalStyles;
  children: UniversalNode[];
  metadata?: UniversalNodeMetadata;
}

export interface UniversalPage {
  title?: string;
  version: string;
  sourceBuilder?: PageBuilderType;
  root: UniversalNode;
}

export interface WordPressPayload {
  postId?: number | string;
  title?: string;
  content?: string;
  template?: string;
  meta?: Record<string, any>;
}

export interface MigrationOptions {
  sourceBuilder?: PageBuilderType;
  targetBuilder: PageBuilderType;
  preserveCustomCss?: boolean;
  normalizeFonts?: boolean;
  generateFallbackHtml?: boolean;
  useCache?: boolean;
  postId?: number | string;
  pageTitle?: string;
  template?: string;
  renderedHtml?: string;
}

export interface MigrationWarning {
  code: string;
  message: string;
  elementId?: string;
  nodeType?: UniversalNodeType;
  originalType?: string;
  suggestedAction?: string;
}

export interface MigrationStats {
  totalElements: number;
  layoutContainers: number;
  contentModules: number;
  convertedElements: number;
  unsupportedElements: number;
  fidelityScore: number; // 0 to 100
  processingTimeMs: number;
}

export interface MigrationResult {
  success: boolean;
  sourceBuilder: PageBuilderType;
  targetBuilder: PageBuilderType;
  sourceAst: UniversalPage;
  targetAst: UniversalPage;
  targetData: any; // Raw representation for the target builder
  wordpressPayload: WordPressPayload;
  stats: MigrationStats;
  warnings: MigrationWarning[];
  cached: boolean;
  cacheKey?: string;
}

export interface BuilderAdapter {
  builderType: PageBuilderType;
  canHandle(payload: unknown): boolean;
  parse(payload: unknown, options?: Partial<MigrationOptions>): UniversalPage;
  serialize(page: UniversalPage, options?: Partial<MigrationOptions>): {
    rawData: any;
    wordpressPayload: WordPressPayload;
    warnings: MigrationWarning[];
  };
}

export interface InspectionReport {
  detectedBuilder: PageBuilderType;
  confidence: number;
  totalElements: number;
  elementCountsByType: Record<string, number>;
  hasCustomCss: boolean;
  fontsUsed: string[];
  colorsUsed: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  compatibility: {
    targetBuilder: PageBuilderType;
    estimatedFidelity: number;
    unsupportedFeatures: string[];
  }[];
}
