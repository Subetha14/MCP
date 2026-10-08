#!/usr/bin/env node
import { runStdioServer } from './server.js';

runStdioServer().catch((error) => {
  console.error('Fatal error running MCP Server:', error);
  process.exit(1);
});
