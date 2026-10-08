import { randomBytes } from 'crypto';
import {
  UniversalNode,
  UniversalPage,
  UniversalNodeType,
  PageBuilderType,
  SpacingUnit,
  BorderStyle,
  UniversalStyles
} from './types.js';

// =============================================================================
// ID GENERATORS
// =============================================================================

export function generateShortId(length = 7): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

export function generateNodeId(prefix = 'node'): string {
  return `${prefix}_${generateShortId(6)}`;
}

export function generateElementorId(): string {
  return generateShortId(7);
}

export function generateBeaverId(type: 'row' | 'col-group' | 'col' | 'mod'): string {
  return `${type}_${generateShortId(8)}`;
}

export function generateDiviId(): string {
  return generateShortId(6);
}

// =============================================================================
// CSS & SPACING HELPERS
// =============================================================================

export function normalizeColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const trimmed = color.trim();
  if (!trimmed) return undefined;
  if (/^[0-9a-fA-F]{3}$/.test(trimmed) || /^[0-9a-fA-F]{6}$/.test(trimmed) || /^[0-9a-fA-F]{8}$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  return trimmed;
}

export function stripColorHash(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return color.replace(/^#/, '');
}

export function isDarkColor(color: string | undefined): boolean {
  if (!color) return false;
  const trimmed = color.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent' || trimmed === 'inherit') return false;

  let hex = trimmed.replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  if (hex.length >= 6) {
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness < 128;
    }
  }

  const rgbMatch = trimmed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness < 128;
  }

  if (['black', 'navy', 'darkblue', 'midnightblue', 'slate', 'darkslategray'].includes(trimmed)) {
    return true;
  }

  return false;
}

export function parseDiviSpacing(val: string | undefined): SpacingUnit | undefined {
  if (!val) return undefined;
  const parts = val.split('|');
  const clean = (p: string | undefined) => {
    if (!p) return undefined;
    const match = p.match(/^([0-9.-]+)([a-zA-Z%]*)$/);
    if (match) return match[1];
    return p;
  };
  const unitMatch = parts[0]?.match(/([a-zA-Z%]+)$/);
  const unit = (unitMatch ? unitMatch[1] : 'px') as SpacingUnit['unit'];

  return {
    top: clean(parts[0]),
    right: clean(parts[1]),
    bottom: clean(parts[2]),
    left: clean(parts[3]),
    unit: unit || 'px'
  };
}

export function formatDiviSpacing(spacing: SpacingUnit | undefined): string | undefined {
  if (!spacing) return undefined;
  const unit = spacing.unit || 'px';
  const top = spacing.top !== undefined && spacing.top !== '' ? `${spacing.top}${unit}` : '';
  const right = spacing.right !== undefined && spacing.right !== '' ? `${spacing.right}${unit}` : '';
  const bottom = spacing.bottom !== undefined && spacing.bottom !== '' ? `${spacing.bottom}${unit}` : '';
  const left = spacing.left !== undefined && spacing.left !== '' ? `${spacing.left}${unit}` : '';

  if (!top && !right && !bottom && !left) return undefined;
  return `${top}|${right}|${bottom}|${left}|false|false`;
}

export function parseShortcodeAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrStr) return attrs;
  const regex = /([a-zA-Z0-9_-]+)=["'](.*?)["']/g;
  let match;
  while ((match = regex.exec(attrStr)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

export function parseDiviColumnSpan(typeStr: string | undefined): number {
  if (!typeStr) return 100;
  const map: Record<string, number> = {
    '4_4': 100,
    '1_1': 100,
    '1_2': 50,
    '1_3': 33,
    '2_3': 67,
    '1_4': 25,
    '3_4': 75,
    '1_5': 20,
    '2_5': 40,
    '3_5': 60,
    '4_5': 80,
    '1_6': 16,
    '5_6': 84
  };
  return map[typeStr] || 100;
}

export function formatDiviColumnType(colSpan: number | undefined): string {
  if (!colSpan || colSpan >= 90) return '4_4';
  if (colSpan <= 28) return '1_4';
  if (colSpan <= 40) return '1_3';
  if (colSpan <= 60) return '1_2';
  if (colSpan <= 72) return '2_3';
  if (colSpan <= 85) return '3_4';
  return '4_4';
}

export function formatDiviRowColumns(columnSpans: number[]): string[] {
  if (columnSpans.length <= 1) return ['4_4'];
  if (columnSpans.length === 2) {
    const [c1, c2] = columnSpans;
    if (c1 <= 28) return ['1_4', '3_4'];
    if (c1 >= 72) return ['3_4', '1_4'];
    if (c1 <= 40) return ['1_3', '2_3'];
    if (c1 >= 60) return ['2_3', '1_3'];
    return ['1_2', '1_2'];
  }
  if (columnSpans.length === 3) {
    const [c1, c2, c3] = columnSpans;
    if (c2 >= 45) return ['1_4', '1_2', '1_4'];
    if (c1 >= 45) return ['1_2', '1_4', '1_4'];
    if (c3 >= 45) return ['1_4', '1_4', '1_2'];
    return ['1_3', '1_3', '1_3'];
  }
  if (columnSpans.length === 4) {
    return ['1_4', '1_4', '1_4', '1_4'];
  }
  return columnSpans.map((span) => formatDiviColumnType(span));
}

export function parseElementorSpacing(obj: any): SpacingUnit | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const top = obj.top;
  const right = obj.right;
  const bottom = obj.bottom;
  const left = obj.left;
  const unit = obj.unit || 'px';

  if (top === undefined && right === undefined && bottom === undefined && left === undefined) {
    return undefined;
  }
  return { top, right, bottom, left, unit };
}

export function formatElementorSpacing(spacing: SpacingUnit | undefined): Record<string, any> | undefined {
  if (!spacing) return undefined;
  return {
    top: spacing.top !== undefined ? String(spacing.top) : '',
    right: spacing.right !== undefined ? String(spacing.right) : '',
    bottom: spacing.bottom !== undefined ? String(spacing.bottom) : '',
    left: spacing.left !== undefined ? String(spacing.left) : '',
    unit: spacing.unit || 'px',
    isLinked: false
  };
}

export function parseDimension(dim: string | number | undefined): { size: number; unit: string } | undefined {
  if (dim === undefined || dim === null || dim === '') return undefined;
  if (typeof dim === 'number') return { size: dim, unit: 'px' };
  const match = String(dim).trim().match(/^([0-9.-]+)\s*([a-zA-Z%]*)$/);
  if (!match) return undefined;
  return {
    size: parseFloat(match[1]),
    unit: match[2] || 'px'
  };
}

export function parseInlineCss(styleStr: string | undefined): UniversalStyles {
  const styles: UniversalStyles = {};
  if (!styleStr) return styles;

  const declarations = styleStr.split(';');
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();
    if (!val) continue;

    if (val.includes('gradient')) {
      const colors = val.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/g);
      const angleMatch = val.match(/([0-9]+)deg/);
      const angle = angleMatch ? parseInt(angleMatch[1], 10) : 135;
      if (colors && colors.length >= 1) {
        styles.backgroundColor = normalizeColor(colors[0]);
        styles.gradient = {
          type: 'linear',
          angle,
          colorA: normalizeColor(colors[0]),
          colorB: normalizeColor(colors[1] || colors[0])
        };
      }
    } else if (prop === 'background-color' || (prop === 'background' && (val.startsWith('#') || val.startsWith('rgb')))) {
      styles.backgroundColor = normalizeColor(val);
    } else if (prop === 'color') {
      styles.color = normalizeColor(val);
    } else if (prop === 'text-align') {
      if (['left', 'center', 'right', 'justify'].includes(val)) {
        styles.alignment = val as any;
      }
    } else if (prop === 'padding') {
      const parts = val.split(/\s+/).map((p) => p.replace('px', '').trim());
      if (parts.length === 1) {
        styles.padding = { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0], unit: 'px' };
      } else if (parts.length === 2) {
        styles.padding = { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1], unit: 'px' };
      } else if (parts.length === 3) {
        styles.padding = { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1], unit: 'px' };
      } else if (parts.length >= 4) {
        styles.padding = { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3], unit: 'px' };
      }
    } else if (prop === 'border-radius') {
      const rad = val.replace('px', '').trim();
      styles.border = styles.border || {};
      styles.border.radius = { top: rad, right: rad, bottom: rad, left: rad, unit: 'px' };
    } else if (prop === 'font-size') {
      const dim = parseDimension(val);
      if (dim) {
        styles.typography = styles.typography || {};
        styles.typography.fontSize = dim.size;
        styles.typography.fontSizeUnit = dim.unit;
      }
    } else if (prop === 'font-family') {
      styles.typography = styles.typography || {};
      styles.typography.fontFamily = val.replace(/['"]/g, '').split(',')[0].trim();
    } else if (prop === 'font-weight') {
      styles.typography = styles.typography || {};
      styles.typography.fontWeight = val.trim();
    } else if (prop === 'line-height') {
      styles.typography = styles.typography || {};
      styles.typography.lineHeight = val.trim();
    } else if (prop === 'letter-spacing') {
      styles.typography = styles.typography || {};
      styles.typography.letterSpacing = val.trim();
    } else if (prop === 'text-transform') {
      if (['none', 'capitalize', 'uppercase', 'lowercase'].includes(val.toLowerCase())) {
        styles.typography = styles.typography || {};
        styles.typography.textTransform = val.toLowerCase() as any;
      }
    } else if (prop === 'margin') {
      const parts = val.split(/\s+/).map((p) => p.replace('px', '').trim());
      if (parts.length === 1) {
        styles.margin = { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0], unit: 'px' };
      } else if (parts.length === 2) {
        styles.margin = { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1], unit: 'px' };
      } else if (parts.length === 3) {
        styles.margin = { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1], unit: 'px' };
      } else if (parts.length >= 4) {
        styles.margin = { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3], unit: 'px' };
      }
    } else if (prop === 'border') {
      styles.border = styles.border || {};
      const widthMatch = val.match(/([0-9.]+)(px|em|rem)?/);
      if (widthMatch) styles.border.width = widthMatch[1];
      const styleMatch = val.match(/\b(solid|dashed|dotted|double|none)\b/i);
      if (styleMatch) styles.border.style = styleMatch[1].toLowerCase() as any;
      const colorMatch = val.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/);
      if (colorMatch) styles.border.color = normalizeColor(colorMatch[0]);
    } else if (prop === 'border-color') {
      styles.border = styles.border || {};
      styles.border.color = normalizeColor(val);
    } else if (prop === 'border-width') {
      styles.border = styles.border || {};
      styles.border.width = val.replace('px', '').trim();
    } else if (prop === 'border-style') {
      styles.border = styles.border || {};
      styles.border.style = val.toLowerCase() as any;
    } else if (prop === 'max-width') {
      styles.maxWidth = val.trim();
    } else if (prop === 'width') {
      styles.width = val.trim();
    } else if (prop === 'min-height' || prop === 'height') {
      styles.minHeight = val.trim();
    }
  }

  return styles;
}

export function formatCssSpacing(spacing: SpacingUnit | undefined): string | undefined {
  if (!spacing) return undefined;
  const unit = spacing.unit || 'px';
  const top = spacing.top ?? 0;
  const right = spacing.right ?? 0;
  const bottom = spacing.bottom ?? 0;
  const left = spacing.left ?? 0;
  return `${top}${unit} ${right}${unit} ${bottom}${unit} ${left}${unit}`;
}

export function formatCssRadius(radius: SpacingUnit | string | number | undefined): string | undefined {
  if (!radius) return undefined;
  if (typeof radius === 'object') {
    const unit = radius.unit || 'px';
    return `${radius.top || 0}${unit} ${radius.right || 0}${unit} ${radius.bottom || 0}${unit} ${radius.left || 0}${unit}`;
  }
  return typeof radius === 'number' || !isNaN(Number(radius)) ? `${radius}px` : String(radius);
}

export function formatCssBorder(border: BorderStyle | undefined): string | undefined {
  if (!border) return undefined;
  const width = border.width ? (typeof border.width === 'number' || !isNaN(Number(border.width)) ? `${border.width}px` : border.width) : '1px';
  const style = border.style || 'solid';
  const color = border.color || '#cccccc';
  return `${width} ${style} ${color}`;
}

// AST HELPERS
// =============================================================================

export function createDefaultPage(title = 'Page', sourceBuilder: PageBuilderType = 'unknown'): UniversalPage {
  return {
    title,
    version: '1.0.0',
    sourceBuilder,
    root: {
      id: generateNodeId('page'),
      type: 'page',
      properties: { title },
      styles: {},
      children: []
    }
  };
}

export function createNode(
  type: UniversalNodeType,
  properties: Record<string, any> = {},
  styles: Record<string, any> = {},
  children: UniversalNode[] = [],
  metadata?: Record<string, any>
): UniversalNode {
  return {
    id: generateNodeId(type),
    type,
    properties,
    styles,
    children,
    metadata
  };
}

export function traverseAst(
  root: UniversalNode,
  callback: (node: UniversalNode, parent?: UniversalNode, depth?: number) => void,
  parent?: UniversalNode,
  depth = 0
): void {
  callback(root, parent, depth);
  for (const child of root.children || []) {
    traverseAst(child, callback, root, depth + 1);
  }
}

export function countElements(page: UniversalPage): {
  total: number;
  layouts: number;
  modules: number;
  byType: Record<string, number>;
} {
  let total = 0;
  let layouts = 0;
  let modules = 0;
  const byType: Record<string, number> = {};

  traverseAst(page.root, (node) => {
    if (node.type === 'page') return;
    total++;
    byType[node.type] = (byType[node.type] || 0) + 1;

    if (node.type === 'section' || node.type === 'row' || node.type === 'column' || node.type === 'container') {
      layouts++;
    } else {
      modules++;
    }
  });

  return { total, layouts, modules, byType };
}

export function collectUsedStyles(page: UniversalPage): {
  fonts: string[];
  colors: string[];
  hasCustomCss: boolean;
} {
  const fontSet = new Set<string>();
  const colorSet = new Set<string>();
  let hasCustomCss = false;

  traverseAst(page.root, (node) => {
    if (node.styles.typography?.fontFamily) fontSet.add(node.styles.typography.fontFamily);
    if (node.styles.color) colorSet.add(node.styles.color);
    if (node.styles.backgroundColor) colorSet.add(node.styles.backgroundColor);
    if (node.styles.border?.color) colorSet.add(node.styles.border.color);
    if (node.styles.customCss) hasCustomCss = true;
  });

  return {
    fonts: Array.from(fontSet),
    colors: Array.from(colorSet),
    hasCustomCss
  };
}

export function calculateFidelityScore(
  sourceElementCount: number,
  unsupportedCount: number,
  warningCount: number
): number {
  if (sourceElementCount === 0) return 100;
  const lostWeight = (unsupportedCount / sourceElementCount) * 70;
  const warningWeight = Math.min((warningCount / sourceElementCount) * 30, 30);
  const score = Math.max(0, 100 - lostWeight - warningWeight);
  return Number(score.toFixed(1));
}

export function summarizeAst(page: UniversalPage): string {
  const counts = countElements(page);
  return `Universal AST: ${counts.total} nodes (${counts.layouts} containers, ${counts.modules} widgets). Source: ${page.sourceBuilder || 'unknown'}`;
}
