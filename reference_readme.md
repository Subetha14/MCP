# 📘 Beginner's Guide & Project Reference: WordPress Page Builder Migration

Welcome to the **WordPress Page Builder Migration Engine & MCP Service**! 

If you are new to this project, this document explains **everything from scratch** in clear, simple terms: what this project does, why it exists, how it works under the hood, what has been completed, and how you can run and use it.

---

## 🧭 Table of Contents
1. [What is This Project? (The Big Picture)](#1-what-is-this-project-the-big-picture)
2. [Why is Page Builder Migration Difficult?](#2-why-is-page-builder-migration-difficult)
3. [How WordPress Page Builders Store Data Under the Hood](#3-how-wordpress-page-builders-store-data-under-the-hood)
4. [How Our Engine Solves It: The Universal AST Architecture](#4-how-our-engine-solves-it-the-universal-ast-architecture)
5. [Project Structure Walkthrough](#5-project-structure-walkthrough)
6. [Supported Widgets & Features](#6-supported-widgets--features)
7. [Everything Completed So Far (Changelog & Key Fixes)](#7-everything-completed-so-far-changelog--key-fixes)
8. [How to Run and Use the Project (Step-by-Step)](#8-how-to-run-and-use-the-project-step-by-step)
9. [Key Concepts & FAQs for Beginners](#9-key-concepts--faqs-for-beginners)

---

## 1. What is This Project? (The Big Picture)

WordPress powers over 40% of the web. Millions of websites are built using visual page builder plugins such as:
- **Elementor**
- **Beaver Builder**
- **Divi**
- **Gutenberg (WordPress Core Block Editor)**

### The Problem
When a website owner wants to switch from one builder to another (for example, moving from Beaver Builder to Elementor, or Divi to Gutenberg), **there is normally no automated way to do it**. 
- Website owners are often forced to manually rebuild hundreds or thousands of pages by hand, copying and pasting headings, paragraphs, buttons, colors, and layout widths.
- This manual process takes weeks and costs thousands of dollars.

### The Solution
This project is an **automated, single-click page builder migration engine**. 
- It takes a page designed in one page builder (like Beaver Builder) and converts it into another page builder (like Elementor or Divi).
- It preserves **layout structures** (rows, columns, exact width percentages), **widgets** (headings, images, buttons, videos, audio, counters, accordions), and **visual styles** (font sizes, colors, alignments, margins).
- It exposes these capabilities as an **MCP (Model Context Protocol)** server so AI assistants (like Claude, Cursor, Antigravity) and web dashboards can run migrations on live WordPress websites.

---

## 2. Why is Page Builder Migration Difficult?

Each page builder uses a completely different philosophy and file format to save page designs inside the WordPress database:

1. **Hierarchy Differences**:
   - Elementor uses a nested tree structure (`Section` ➔ `Column` ➔ `Widget`).
   - Beaver Builder uses a flat dictionary of nodes linked by `parent` and `position` IDs (`row` ➔ `column-group` ➔ `column` ➔ `module`).
   - Divi uses nested text shortcodes (`[et_pb_section]` ➔ `[et_pb_row]` ➔ `[et_pb_column]` ➔ `[et_pb_text]`).
   - Gutenberg uses HTML comments (`<!-- wp:group -->` ➔ `<!-- wp:columns -->` ➔ `<!-- wp:paragraph -->`).

2. **Style Storage Differences**:
   - One builder stores colors as hex (`#1e293b`), another as RGB (`rgb(44, 102, 160)`), and another inherits from CSS classes.
   - One builder stores typography as `{ font_size: { length: "24", unit: "px" } }`, another as `typography_number_font_size: { size: 24, unit: "px" }`, and another as shortcode attributes `number_font_size="24px"`.

3. **Database Guardrails**:
   - WordPress blocks plugins from updating certain protected metadata fields via the default REST API (like Beaver Builder's `_fl_builder_data`), requiring automated synchronization via WP-CLI.

---

## 3. How WordPress Page Builders Store Data Under the Hood

| Page Builder | Database Table & Field | Format | How It Looks in Database |
| :--- | :--- | :--- | :--- |
| **Elementor** | `wp_postmeta` ➔ `_elementor_data` | JSON Array (Tree) | `[ { "id": "1", "elType": "section", "elements": [ { "id": "2", "elType": "column", "elements": [ { "widgetType": "heading", "settings": { "title": "Hello" } } ] } ] } ]` |
| **Beaver Builder** | `wp_postmeta` ➔ `_fl_builder_data` | JSON Object (Flat Map) | `{ "row_1": { "type": "row" }, "col_1": { "type": "column", "parent": "row_1" }, "mod_1": { "type": "module", "settings": { "type": "heading" } } }` |
| **Divi** | `wp_posts` ➔ `post_content` | Nested Shortcodes | `[et_pb_section][et_pb_row][et_pb_column][et_pb_text]Hello[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]` |
| **Gutenberg** | `wp_posts` ➔ `post_content` | HTML Block Comments | `<!-- wp:group --><div class="wp-block-group"><!-- wp:heading --><h2>Hello</h2><!-- /wp:heading --></div><!-- /wp:group -->` |

---

## 4. How Our Engine Solves It: The Universal AST Architecture

Instead of writing custom direct converters for every combination (Elementor ➔ Divi, Beaver ➔ Elementor, Divi ➔ Beaver, etc., which would require dozens of fragile converters), this engine uses an **Intermediate Representation** called the **Universal AST (Abstract Syntax Tree)**.

Think of it like a language translator:
```
[Beaver Builder JSON]  ──────────┐
[Divi Shortcodes]      ──────────┼──► [ Universal AST ] ──► Elementor JSON
[Gutenberg Blocks]     ──────────┤          (IR)        ──► Beaver Builder JSON
[Elementor JSON]       ──────────┘                      ──► Divi Shortcodes
                                                        ──► Gutenberg Blocks
```

### The 3 Steps of Every Migration:
1. **Parse (Source ➔ Universal AST)**:
   The engine reads the raw builder data and converts it into standard JavaScript objects:
   - Root Node ➔ Sections ➔ Columns ➔ Content Widgets.
   - Extracts properties (titles, URLs, button links) and styles (font sizes, alignments, colors, margins).
2. **Transform & Optimize**:
   The engine validates the structure, cleans colors (converts named colors or RGB to standard formats), preserves column widths (e.g., 8% / 92% split), and normalizes typography.
3. **Serialize (Universal AST ➔ Target Builder)**:
   The engine generates the exact data format expected by the target builder:
   - Elementor: JSON ready for `_elementor_data`.
   - Beaver: Dictionary ready for `_fl_builder_data` + rendered HTML fallback.
   - Divi: Clean shortcodes for `post_content`.
   - Gutenberg: Valid block HTML for `post_content`.

---

## 5. Project Structure Walkthrough

Here is a map of the folders in this codebase:

```
Page builder migration/
├── src/
│   ├── core/                      # The Conversion Brain
│   │   ├── types.ts               # Definitions of UniversalNode, Styles, Builder types
│   │   ├── adapter.ts             # Parser and Serializer for all 4 builders (4,400+ lines)
│   │   ├── engine.ts              # MigrationEngine: coordinates parse, transform, and cache
│   │   ├── cache.ts               # Cryptographic SHA-256 caching of migration results
│   │   ├── utils.ts               # Color converters, spacing parsers, layout utilities
│   │   └── index.ts               # Public exports for the core package
│   ├── wordpress/                 # WordPress Connection
│   │   └── client.ts              # REST API client, WP-CLI bridge, and CSS cache flush
│   ├── mcp/                       # Model Context Protocol (MCP) Service
│   │   ├── server.ts              # MCP tools registration for AI agents
│   │   └── index.ts               # Entry point for running the MCP server
│   ├── ai/                        # AI Fallback for Unsupported/Custom Widgets
│   │   ├── litellm.ts             # LiteLLM proxy client connecting to DeepSeek
│   │   └── cost-estimator.ts      # Token counter and cost comparison ($ vs GPT-4o)
│   ├── scripts/                   # Demo & Testing Scripts
│   │   ├── create-elementor-demo-page.ts
│   │   ├── create-beaver-demo-page.ts
│   │   └── migrate-338-to-342.ts
│   ├── cli.ts                     # Terminal Command Line Interface (CLI)
│   └── index.ts                   # Main project entry point
├── tests/                         # Vitest Automated Test Suite
│   ├── cross-builder-migration.test.ts  # Cross-builder fidelity tests
│   ├── beaver-adapter.test.ts           # Beaver Builder tests
│   ├── elementor-adapter.test.ts        # Elementor tests
│   ├── active-builders.test.ts          # WordPress environment tests
│   ├── cache-and-mcp.test.ts            # Caching and MCP tests
│   ├── ai-and-costs.test.ts             # AI fallback & token cost tests
│   └── wordpress-client.test.ts         # Live WordPress REST API tests
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript compiler settings
└── README.md                      # General documentation
```

---

## 6. Supported Widgets & Features

The rule-based conversion engine supports all common website components **deterministically** (in under 10 milliseconds, with **zero LLM cost**):

| Widget Type | Beaver Builder | Elementor | Divi | Gutenberg |
| :--- | :--- | :--- | :--- | :--- |
| **Heading** | `heading` | `heading` | `et_pb_text` (h1-h6) | `core/heading` |
| **Rich Text / Paragraph** | `rich-text` | `text-editor` | `et_pb_text` | `core/paragraph` |
| **Button** | `button` | `button` | `et_pb_button` | `core/button` |
| **Image** | `photo` | `image` | `et_pb_image` | `core/image` |
| **Video** | `video` | `video` | `et_pb_video` | `core/video` |
| **Audio** | `audio` | `html` (HTML5 `<audio>`) | `et_pb_audio` | `core/audio` |
| **Counter / Numbers** | `numbers` | `counter` | `et_pb_number_counter` | `wp-block-counter` |
| **Icon Box / Blurb** | `callout` / `cta` | `icon-box` | `et_pb_blurb` | `wp-block-columns` |
| **Accordion / FAQ** | `accordion` | `accordion` | `et_pb_accordion` | `core/details` |
| **Divider** | `separator` | `divider` | `et_pb_divider` | `core/separator` |
| **Spacer** | `spacer` | `spacer` | `et_pb_divider` (height) | `core/spacer` |
| **Star Rating** | `star-rating` | `star-rating` | `et_pb_star_rating` | `wp-block-star-rating` |
| **Social Follow** | `social-icons` | `social-icons` | `et_pb_social_media_follow` | `core/social-links` |
| **Google Maps** | `map` | `google-maps` | `et_pb_map` | `core/html` |
| **Raw HTML / Code** | `html` | `html` / `shortcode` | `et_pb_code` | `core/html` |

---

## 7. Everything Completed So Far (Changelog & Key Fixes)

Here is a summary of major capabilities implemented and issues resolved in this project:

### 1. Multi-Builder Bidirectional Engine
- Fully supports conversion between **Elementor**, **Beaver Builder**, **Divi**, and **Gutenberg**.
- Implemented AST normalization that handles tree structures (Elementor), flat dictionaries (Beaver), and shortcodes (Divi).

### 2. Multi-Row & Column Layout Fidelity
- **Problem**: Previously, when converting multi-row pages, rows were getting collapsed or merged into single 50%/50% columns.
- **Fix**: The engine now preserves distinct sections and rows, computing exact column percentage widths (e.g. 8% icon column + 92% heading column, or 33.3% 3-column rows).

### 3. Number Counter Styling Fidelity Fix
- **Problem**: When migrating Beaver Builder's `numbers` module to Elementor, the numbers exploded from 24px dark text to 69px neon cyan (`#6ec1e4`), and often displayed `1%` instead of `100%`.
- **Why It Happened**: Beaver Builder stores counter typography under `number_typography` and color under `number_color`. The adapter was not extracting these fields, causing Elementor to apply its global fallback styles (`widget-counter.min.css` default 69px, and global primary color cyan).
- **Fix**:
  1. Updated Beaver parser to extract `s.number_typography` and `s.number_color`.
  2. Updated Elementor serializer to output `typography_number_typography: 'custom'`, `typography_number_font_size: { size: 24, unit: 'px' }`, and `number_color: '#1e293b'`.
  3. Updated Divi and Gutenberg serializers to preserve dynamic font sizes rather than hardcoded 48px.

### 4. Audio Widget Standardization
- Migrated audio players to render standard native HTML5 `<audio controls>` wrappers across builders, eliminating broken dark-skin players with zeroed playback counters.

### 5. Live WordPress Database Sync
- Developed `WordPressClient` in [`src/wordpress/client.ts`](file:///home/muthusubetha/Documents/Page%20builder%20migration/src/wordpress/client.ts).
- Solved protected post meta limitations by adding automatic WP-CLI synchronization (`syncBeaverBuilderMeta`) and cache regeneration (`wp elementor flush-css`).

### 6. MCP Server Optimization & Tool Cleanup
- Exposes tools via `@modelcontextprotocol/sdk`.
- Removed duplicate and redundant tools (such as standalone `preview_wordpress_migration`), consolidating simulation into `migrate_wordpress_page` with an optional `dryRun: true` parameter.

### 7. AI Fallback with LiteLLM & DeepSeek
- Integrated LiteLLM proxy support to handle rare, custom third-party widgets.
- Added prompt cost analysis comparing DeepSeek ($0.14/1M tokens) against OpenAI GPT-4o ($2.50/1M tokens), yielding >94% cost savings.

### 8. Automated Test Suite
- Comprehensive suite of **35 automated vitest tests** covering:
  - Cache hits and cryptographic SHA-256 keys.
  - Cross-builder layout and widget fidelity.
  - Live WordPress REST API interactions.
  - Active builder detection on WordPress.
  - Token cost estimation.

---

## 8. How to Run and Use the Project (Step-by-Step)

### Prerequisites
- **Node.js** (v18 or higher)
- **Local WordPress site** (optional, needed only for live migrations: `http://localhost/wordpress`)
- **WP-CLI** (optional, for direct database metadata sync)

### Step 1: Install Dependencies
```bash
cd "Page builder migration"
npm install
```

### Step 2: Build the TypeScript Code
```bash
npm run build
```
This compiles the TypeScript files in `src/` into JavaScript in `dist/`.

### Step 3: Run the Test Suite
```bash
npm test
```
Runs all 35 tests across 7 test files with Vitest to ensure everything works properly.

### Step 4: Run a Migration in Code
Here is how you can use the engine in your own script:

```typescript
import { MigrationEngine } from './dist/core/index.js';

const engine = new MigrationEngine();

// Source data (e.g., from Beaver Builder)
const beaverData = {
  row1: { node: 'row1', type: 'row', cols: ['col1'] },
  col1: { node: 'col1', type: 'column', parent: 'row1', modules: ['mod1'] },
  mod1: {
    node: 'mod1',
    type: 'heading',
    parent: 'col1',
    settings: { heading: 'Hello World', tag: 'h2' }
  }
};

// Migrate to Elementor
const result = engine.migrate(beaverData, {
  sourceBuilder: 'beaver-builder',
  targetBuilder: 'elementor',
  pageTitle: 'My Migrated Page'
});

console.log('Success:', result.success);
console.log('Fidelity Score:', result.stats.fidelityScore);
console.log('Elementor Output:', JSON.stringify(result.targetData, null, 2));
```

### Step 5: Run the MCP Server (For AI Assistants)
To connect the migration tools to Claude Desktop, Cursor, or Antigravity:

```bash
npm run dev:mcp
```
Or directly:
```bash
node dist/mcp/index.js
```

---

## 9. Key Concepts & FAQs for Beginners

### Q: What is an AST?
**AST** stands for *Abstract Syntax Tree*. In this project, it is a neutral tree of JavaScript objects representing the page structure (Sections, Columns, Widgets) independent of any specific builder plugin.

### Q: Why does the engine use caching?
Calculating conversions and parsing deep trees takes computation. The engine generates a SHA-256 cryptographic hash of the input data and target parameters. If you migrate the same page twice, it serves the cached result in under 1 millisecond.

### Q: What is a Fidelity Score?
The `fidelityScore` (0 to 100%) represents how much of the original page was successfully converted into native widgets without resorting to raw HTML fallbacks. Standard pages achieve 95%–100% fidelity.

### Q: What is MCP?
**Model Context Protocol (MCP)** is an open standard developed by Anthropic that allows AI agents to interact with external tools and databases. Our MCP server lets AI assistants directly inspect pages, detect builders, and execute migrations on live WordPress sites.

### Q: What if a builder has a custom widget not in the standard list?
The engine first tries standard rule-based conversion. If an unrecognized custom widget is encountered, it gracefully falls back to either rendering clean standard HTML or delegating translation to LiteLLM / DeepSeek.

---

*This guide was generated for the WordPress Page Builder Migration project. If you have questions or add new features, keep this document updated!*
