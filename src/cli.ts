#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import dotenv from 'dotenv';
import { MigrationEngine, PageBuilderType, globalMigrationCache } from './core/index.js';
import { WordPressClient } from './wordpress/client.js';
import { globalLiteLLMClient } from './ai/litellm.js';
import { CostEstimator } from './ai/cost-estimator.js';

dotenv.config();

function printHelp() {
  console.log(`
WordPress Page Builder Migrator CLI
Supported builders: Elementor, Divi, Beaver Builder

Usage:
  page-builder-migrator migrate --to <target> [options]
  page-builder-migrator inspect --input <file>
  page-builder-migrator detect --input <file>
  page-builder-migrator wp-list
  page-builder-migrator wp-migrate --id <pageId> --to <target>
  page-builder-migrator litellm-check
  page-builder-migrator cost-estimate [--tokens <count> | --input <file>]
  page-builder-migrator cache-stats

Commands & Options:
  migrate
    --from <builder>     Source builder: elementor, divi, beaver-builder (optional, auto-detected)
    --to <builder>       Target builder: elementor, divi, beaver-builder (required)
    --input <file|str>   Path to file or raw string containing page data (required)
    --output <file>      Path to output converted file (optional, defaults to stdout)
    --title <title>      Page title (optional)

  wp-list                Lists pages from the configured WordPress instance and detects active builders
  
  wp-migrate
    --id <pageId>        WordPress Page ID to migrate (e.g. 49)
    --to <builder>       Target builder: elementor, divi, beaver-builder
    --title <title>      Optional title for the new page clone
    --status <status>    'publish' or 'draft' (default: 'publish')

  litellm-check          Probes local LiteLLM proxy (http://localhost:4000) and DeepSeek status

  cost-estimate          Calculates API prompt & response costs comparing DeepSeek vs OpenAI GPT-4o
    --tokens <count>     Number of input tokens to estimate
    --input <file>       File path to estimate tokens from

  inspect
    --input <file|str>   Inspects page data structure, widgets, colors, fonts, and compatibility

  detect
    --input <file|str>   Detects which page builder created the input data

  cache-stats            Displays migration cache hits and estimated LLM dollar savings
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1]) {
      return args[idx + 1];
    }
    return undefined;
  };

  const engine = new MigrationEngine();

  const loadInput = (inputVal?: string): any => {
    if (!inputVal) {
      console.error('Error: --input is required');
      process.exit(1);
    }
    try {
      const content = readFileSync(inputVal, 'utf-8');
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    } catch {
      try {
        return JSON.parse(inputVal);
      } catch {
        return inputVal;
      }
    }
  };

  switch (command) {
    case 'detect': {
      const input = loadInput(getArg('input'));
      const detection = engine.detectBuilder(input);
      console.log('\n--- Detection Result ---');
      console.log(`Detected Builder: ${detection.builder.toUpperCase()}`);
      console.log(`Confidence:       ${Math.round(detection.confidence * 100)}%`);
      console.log(`Reason:           ${detection.reason}\n`);
      break;
    }

    case 'inspect': {
      const input = loadInput(getArg('input'));
      const report = engine.inspect(input);
      console.log('\n--- Page Inspection Report ---');
      console.log(`Detected Builder: ${report.detectedBuilder}`);
      console.log(`Complexity:       ${report.complexity.toUpperCase()}`);
      console.log(`Total Elements:   ${report.totalElements}`);
      console.log('Element Breakdown:', report.elementCountsByType);
      console.log('Fonts Used:       ', report.fontsUsed);
      console.log('Colors Used:      ', report.colorsUsed);
      console.log('\nCompatibility Matrix:');
      for (const c of report.compatibility) {
        console.log(`  -> ${c.targetBuilder.padEnd(16)}: Estimated Fidelity ${c.estimatedFidelity}%`);
      }
      console.log('');
      break;
    }

    case 'migrate': {
      const to = getArg('to') as PageBuilderType;
      if (!to) {
        console.error('Error: --to <targetBuilder> is required (elementor, divi, beaver-builder)');
        process.exit(1);
      }
      const from = getArg('from') as PageBuilderType | undefined;
      const title = getArg('title');
      const input = loadInput(getArg('input'));
      const outputFile = getArg('output');

      const result = engine.migrate(input, {
        sourceBuilder: from,
        targetBuilder: to,
        pageTitle: title
      });

      console.error('\n--- Migration Completed Successfully ---');
      console.error(`From:           ${result.sourceBuilder}`);
      console.error(`To:             ${result.targetBuilder}`);
      console.error(`Fidelity Score: ${result.stats.fidelityScore}%`);
      console.error(`Total Elements: ${result.stats.totalElements}`);
      console.error(`Converted:      ${result.stats.convertedElements}`);
      console.error(`Time:           ${result.stats.processingTimeMs}ms`);
      console.error(`Cache Hit:      ${result.cached ? 'YES' : 'NO'}`);
      if (result.warnings.length > 0) {
        console.error(`Warnings (${result.warnings.length}):`);
        for (const w of result.warnings) {
          console.error(`  - [${w.code}] ${w.message}`);
        }
      }
      console.error('----------------------------------------\n');

      const outputData = typeof result.targetData === 'string'
        ? result.targetData
        : JSON.stringify(result.targetData, null, 2);

      if (outputFile) {
        writeFileSync(outputFile, outputData, 'utf-8');
        console.error(`Result saved to ${outputFile}`);
      } else {
        console.log(outputData);
      }
      break;
    }

    case 'wp-list': {
      const wp = new WordPressClient();
      console.log('\n--- Fetching WordPress Pages ---');
      const pages = await wp.listPages(30, 1);
      console.log(`Found ${pages.length} pages:\n`);
      for (const p of pages) {
        const badge = p.detectedBuilder.toUpperCase().padEnd(15);
        console.log(`[${badge}] ID #${String(p.id).padEnd(4)} : ${p.title} (${p.status})`);
      }
      console.log('');
      break;
    }

    case 'wp-migrate': {
      const pageId = parseInt(getArg('id') || '', 10);
      const to = getArg('to') as PageBuilderType;
      const title = getArg('title');
      const status = (getArg('status') || 'publish') as 'publish' | 'draft';

      if (!pageId || isNaN(pageId)) {
        console.error('Error: --id <pageId> is required (e.g. --id 49)');
        process.exit(1);
      }
      if (!to) {
        console.error('Error: --to <targetBuilder> is required (elementor, divi, beaver-builder)');
        process.exit(1);
      }

      const wp = new WordPressClient();
      console.log(`\n--- Starting Live WordPress Migration for Page #${pageId} -> ${to} ---`);
      const result = await wp.migrateLivePage(engine, {
        pageId,
        targetBuilder: to,
        createNewPage: true,
        newPageTitle: title,
        status
      });

      console.log('✓ Migration Completed Successfully!');
      console.log(`Source Page:    #${result.sourcePageId} "${result.sourceTitle}" (${result.sourceBuilder})`);
      console.log(`Target Page:    #${result.targetPageId} "${result.targetTitle}" (${result.targetBuilder})`);
      console.log(`Fidelity Score: ${result.fidelityScore}%`);
      console.log(`Target URL:     ${result.targetPageUrl}`);
      console.log(`Time:           ${result.migrationStats?.processingTimeMs}ms\n`);
      break;
    }

    case 'wp-builders': {
      const wp = new WordPressClient();
      console.log('\n--- Detecting Active Page Builders on WordPress ---');
      const report = await wp.getActivePageBuilders();
      console.log(`Site: ${report.siteUrl}`);
      console.log(`Active Builders:   ${report.activeBuilders.join(', ').toUpperCase() || 'None'}`);
      console.log(`Inactive Builders: ${report.inactiveBuilders.join(', ').toUpperCase() || 'None'}\n`);
      console.log('Installed Builders on Site:');
      for (const [key, b] of Object.entries(report.builders)) {
        if (!b.installed) continue; // Only show installed builders (active or inactive)
        const statusBadge = b.active ? '✅ ACTIVE' : '⚠️ INSTALLED (INACTIVE)';
        console.log(`  ${b.name.padEnd(16)} : ${statusBadge.padEnd(25)} (${b.notes})`);
      }
      console.log('');
      break;
    }

    case 'litellm-check': {
      console.log('\n--- Checking LiteLLM & DeepSeek Status ---');
      const status = await globalLiteLLMClient.checkLocalLiteLLM();
      console.log(`Running Locally: ${status.running ? 'YES' : 'NO'}`);
      console.log(`Endpoint:        ${status.url}`);
      console.log(`Status:          ${status.statusText}`);
      console.log(`Recommendation:  ${status.recommendation}\n`);
      break;
    }

    case 'cost-estimate': {
      const tokenArg = getArg('tokens');
      const inputArg = getArg('input');

      let tokens = tokenArg ? parseInt(tokenArg, 10) : 0;
      if (!tokens && inputArg) {
        const text = readFileSync(inputArg, 'utf-8');
        tokens = CostEstimator.estimateTokens(text);
      }
      if (!tokens) tokens = 2500;

      const comp = CostEstimator.compare(tokens, Math.ceil(tokens * 0.5));
      console.log('\n' + CostEstimator.formatReport(comp) + '\n');
      break;
    }

    case 'cache-stats': {
      const stats = globalMigrationCache.getMetrics();
      console.log('\n--- Migration Cache & LLM Cost Reduction ---');
      console.log(`Total Requests:         ${stats.totalRequests}`);
      console.log(`Cache Hits:             ${stats.hits}`);
      console.log(`Cache Misses:           ${stats.misses}`);
      console.log(`Hit Rate:               ${stats.hitRatePercent}%`);
      console.log(`Estimated LLM Calls Saved: ${stats.estimatedLlmCallsSaved}`);
      console.log(`Estimated API Savings:  $${stats.estimatedDollarsSaved} USD\n`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
