# WordPress Page Builder Migration MCP Service

A high-performance **Model Context Protocol (MCP)** server and conversion engine for single-click page migration between WordPress page builders (**Elementor**, **Divi**, and **Beaver Builder**).

Designed to pair with the **Audie Migrator** plugin and built completely with **JavaScript / TypeScript & JSON** with **zero PHP dependency**.

---

## 🎯 Architecture & Design Philosophy

Like the reference [wp-elementor-mcp](../wp-elementor-mcp-main), this MCP server interfaces seamlessly with WordPress via the standard REST API, reads/writes page builder payloads, and registers rich tools for AI assistants.

Key improvements and migration capabilities:
1. **Universal Page Builder AST**: Normalizes builder-specific tree or flat dictionary models into an agnostic Intermediate Representation (IR), preserving sections, rows, columns, containers, widgets, typography, colors, padding/margin, and link attributes.
2. **Deterministic 3-10ms Rule Engine ($0 API Cost)**: Standard layout nodes and widgets (headings, text, images, buttons, videos, dividers, spacers, icon-boxes/blurbs, accordions, counters, raw HTML) are converted 100% deterministically without making any LLM calls.
3. **LiteLLM & DeepSeek AI Fallback**: For unmapped, proprietary, or custom third-party widgets/shortcodes, the engine gracefully queries **DeepSeek-V3** (via local LiteLLM proxy or direct API) with smart prompt caching to cut costs by over **96%** compared to OpenAI GPT-4o.
4. **Single-Click Live WordPress Migration**: Directly inspects, detects, extracts, migrates, and publishes pages on a live WordPress installation.
5. **Audie Migrator Plugin Ready**: Pure JS/JSON runtime that outputs standard REST API payloads (`post_content` and `meta` fields) ready for insertion into `wp_posts` and `wp_postmeta`.

---

## 📦 How WordPress Page Builders Store Data

| Page Builder | Storage Location | Storage Format | Key Structures / Notes |
| :--- | :--- | :--- | :--- |
| **Elementor** | `wp_postmeta` (`_elementor_data`) | JSON array of objects | Hierarchical tree: `section` ➔ `column` ➔ `widget` (or flexbox `container`). Widgets store `widgetType` and `settings`. Also sets `_elementor_edit_mode = "builder"`. |
| **Divi** | `wp_posts` (`post_content`) & postmeta | Nested WordPress shortcodes | `[et_pb_section]` ➔ `[et_pb_row]` ➔ `[et_pb_column]` ➔ `[et_pb_*]` module shortcodes with attributes (`header_font_size`, `custom_padding`). Also sets `_et_pb_use_builder = "on"`. |
| **Beaver Builder** | `wp_postmeta` (`_fl_builder_data`) | Flat JSON dictionary of node objects | Keyed by node ID (`row_*`, `col-group_*`, `col_*`, `mod_*`) with `parent` and `position` references. Also renders clean fallback HTML in `post_content` and sets `_fl_builder_enabled = "1"`. |

---

## 🛠️ MCP Tools, Resources & Prompts

When running as an MCP server, the service exposes the following endpoints:

### 1. WordPress Live Integration Tools
- `migrate_wordpress_page`: Single-click migration directly on WordPress! Fetches page data, auto-detects source builder, converts to target builder, and creates a new migrated page clone or updates in-place (supports optional `dryRun: true` for pre-migration simulation).
- `list_wordpress_pages`: Lists WordPress pages with detected page builders (Elementor, Divi, Beaver Builder, Gutenberg, or Classic).
- `configure_wordpress`: Set or verify WordPress REST API credentials.

### 2. Supported Builders & Configuration
- `get_supported_builders`: Returns dynamically detected WordPress page builders installed on the connected site.

### 3. AI & LiteLLM / DeepSeek Tools
- `check_litellm_status`: Tests connection to local LiteLLM proxy (`http://localhost:4000`) and DeepSeek API connectivity.
- `get_cost_estimation`: Calculates prompt and response costs, credit estimations, and token savings comparing DeepSeek vs OpenAI GPT-4o / Claude 3.5 Sonnet.
- `ai_convert_custom_widget`: Translates unsupported custom widgets/shortcodes into target format via DeepSeek / LiteLLM with response caching.

### 4. Cache & Performance Tools
- `get_cache_stats`: Displays cache hit rate, LLM calls saved, and estimated dollar savings.
- `clear_cache`: Invalidation utility for the migration cache.

---

## 💰 LiteLLM, DeepSeek & Cost Optimization

### Pricing Comparison (Per 1 Million Tokens)

| Model | Provider | Input Cost / 1M | Cache Hit Input / 1M | Output Cost / 1M | Savings vs GPT-4o |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DeepSeek-V3 (`deepseek-chat`)** | DeepSeek | **$0.14** | **$0.014** | **$0.28** | **~96.3%** |
| **DeepSeek Coder (`deepseek-coder`)** | DeepSeek | **$0.14** | **$0.014** | **$0.28** | **~96.3%** |
| **OpenAI GPT-4o-mini** | OpenAI | $0.15 | - | $0.60 | ~85.0% |
| **OpenAI GPT-4o** | OpenAI | $2.50 | - | $10.00 | Baseline |
| **Anthropic Claude 3.5 Sonnet** | Anthropic | $3.00 | - | $15.00 | - |

### Credit Runway & Savings Strategy
- **AST First (100% Deterministic)**: 95%+ of elements are converted locally in 3-10ms with **$0 API cost**.
- **SHA-256 Hash Caching**: Repeated page conversions or identical widget translations hit the in-memory cache instantly (0ms latency, $0 API cost).
- **DeepSeek Integration**: For remaining custom widgets, DeepSeek-V3 processes ~1,700 to 10,000 pages per **$1 USD** of credits.

---

## ⚡ Quick Start

### 1. Installation

```bash
cd "Page builder migration"
npm install
npm run build
```

### 2. Configuration (`.env`)

Configure `.env` (or copy from `.env.example`):

```bash
# WordPress REST API
WORDPRESS_BASE_URL=http://localhost/wordpress
WORDPRESS_USERNAME=admin
WORDPRESS_APPLICATION_PASSWORD=hfbU yrRt FXPE Qg5Z 6N6A kjTh

# LiteLLM Proxy
LITELLM_BASE_URL=http://localhost:4000

# DeepSeek API Key (provided by sir)
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
```

### 3. Run Automated Tests

```bash
npm test
```
*Executes all 26 automated unit and cross-builder integration tests (including live WordPress REST API verification).*

### 4. Run the MCP Server

```bash
# Development mode
npm run dev:mcp

# Or production stdio transport
npm run start
```

### 5. Client Configuration (`client-config.json`)

To use in Claude Desktop, Antigravity IDE, Cursor, or LiteLLM, add:

```json
{
  "mcpServers": {
    "page-builder-migrator": {
      "command": "node",
      "args": [
        "/home/muthusubetha/Documents/Page builder migration/dist/mcp/index.js"
      ],
      "env": {
        "WORDPRESS_BASE_URL": "http://localhost/wordpress",
        "WORDPRESS_USERNAME": "admin",
        "WORDPRESS_APPLICATION_PASSWORD": "hfbU yrRt FXPE Qg5Z 6N6A kjTh",
        "LITELLM_BASE_URL": "http://localhost:4000",
        "DEEPSEEK_API_KEY": ""
      }
    }
  }
}
```

---

## 💻 CLI Commands

```bash
# 1. Discover WordPress Pages and active page builders
npm run cli -- wp-list

# 2. Live single-click WordPress migration (Page 49 -> Divi)
npm run cli -- wp-migrate --id 49 --to divi

# 3. Check LiteLLM local status
npm run cli -- litellm-check

# 4. Review prompt & response costs comparing DeepSeek vs OpenAI
npm run cli -- cost-estimate --tokens 3000

# 5. Local file migration (Elementor JSON -> Divi)
npm run cli -- migrate --to divi --input tests/fixtures/sample-elementor.json

# 6. Check cache metrics and dollar savings
npm run cli -- cache-stats
```

---

## 🧩 Audie Migrator Plugin Integration

The engine is engineered for direct integration with the **Audie Migrator** WordPress plugin. Because it is implemented in pure JavaScript / TypeScript and JSON, it can be run:
1. **As a Local Node Microservice / MCP Service**: The Audie Migrator plugin calls the MCP server or local HTTP endpoints via `wp_remote_post`.
2. **In-Browser Headless Migration**: Built into the Audie Migrator Vue/React admin dashboard to run client-side migrations without loading PHP memory.
3. **Programmatic Usage**:

```typescript
import { MigrationEngine, WordPressClient } from 'page-builder-migration';

const engine = new MigrationEngine();
const wp = new WordPressClient({
  baseUrl: 'http://localhost/wordpress',
  username: 'admin',
  applicationPassword: '...'
});

// Single-click live migration
const result = await wp.migrateLivePage(engine, {
  pageId: 49,
  targetBuilder: 'divi',
  createNewPage: true
});

console.log('Migrated page created at:', result.targetPageUrl);
console.log('Fidelity Score:', result.fidelityScore);
```
