#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { runStdio } from './transports/stdio.js';
import { runHttp } from './transports/http.js';

/**
 * Entry point. Reads the environment, then runs the configured transport:
 *   - stdio (default)        for Claude Desktop and Claude Code
 *   - Streamable HTTP        for remote clients such as ChatGPT's developer-mode connectors
 *
 * See the README for copy-paste configuration for each client.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`tmanage-mcp: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (config.transport === 'http') {
    await runHttp(config);
  } else {
    await runStdio(config);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `tmanage-mcp: fatal: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
