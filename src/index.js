'use strict';

const pino = require('pino');
const { config, validateConfig } = require('./config');
const { Store } = require('./db');
const { HttpClient } = require('./http');
const { Storage } = require('./storage');
const { ImageService } = require('./images');
const { createRegistry, SOURCE_INFO } = require('./crawlers');
const { applyRecordPolicy } = require('./policy');
const { createApp } = require('./app');

/**
 * Parse positional arguments and `--key=value` flags used by crawler scripts.
 *
 * @param {string[]} argv Command-line arguments without `node` and script path.
 * @returns {{positional: string[], flags: Record<string, string>}} Parsed arguments.
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }

    const [key, value = 'true'] = argument.slice(2).split('=');
    flags[key] = value;
  }

  return { positional, flags };
}

/**
 * Parse a CLI boolean flag.
 *
 * @param {unknown} value Candidate flag value.
 * @param {boolean} fallback Default when missing.
 * @returns {boolean} Parsed boolean.
 */
function toBoolean(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Construct application services and establish the MongoDB connection.
 *
 * @param {{syncIndexes?: boolean}} options Build options.
 * @returns {Promise<{logger: import('pino').Logger, store: Store, storage: Storage, http: HttpClient, imageService: ImageService, registry: Record<string, any>}>} Application services.
 */
async function build(options = {}) {
  validateConfig();

  const logger = pino({ level: config.logLevel });
  const store = await Store.connect({
    uri: config.mongodb.uri,
    dbName: config.mongodb.dbName,
    serverSelectionTimeoutMs: config.mongodb.serverSelectionTimeoutMs,
    maxPoolSize: config.mongodb.maxPoolSize,
    autoIndex: config.mongodb.autoIndex || Boolean(options.syncIndexes),
    logger,
  });
  const storage = new Storage(config.storage);
  const http = new HttpClient(config.crawler, logger);
  const imageService = new ImageService({ http, storage, store, config: config.crawler, logger });
  const registry = applyRecordPolicy(
    createRegistry({ config, http, storage, store, imageService, logger }),
    config.crawler,
    logger,
  );

  return { logger, store, storage, http, imageService, registry };
}

/**
 * Register graceful shutdown handlers for the HTTP server and MongoDB pool.
 *
 * @param {import('node:http').Server} server Running HTTP server.
 * @param {{logger: import('pino').Logger, store: Store}} services Services to stop.
 * @returns {void}
 */
function registerShutdown(server, services) {
  let stopping = false;

  /**
   * Stop accepting requests, close MongoDB, and then exit cleanly.
   *
   * @param {string} signal Operating-system signal.
   * @returns {Promise<void>}
   */
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    services.logger.info({ signal }, 'Stopping farm crawler');

    const forcedExit = setTimeout(() => process.exit(1), 10000);
    forcedExit.unref();

    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await services.store.close();
      clearTimeout(forcedExit);
      process.exit(0);
    } catch (error) {
      services.logger.error({ error: error.message }, 'Graceful shutdown failed');
      process.exit(1);
    }
  }

  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

/**
 * Execute the selected API or CLI command.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'serve';

  // Listing configured sources does not require a database connection.
  if (command === 'sources') {
    console.table(Object.entries(SOURCE_INFO).map(([name, description]) => ({ name, description })));
    return;
  }

  const services = await build({ syncIndexes: command === 'db:init' });

  if (command === 'serve') {
    const app = createApp({ config, ...services });
    const server = app.listen(config.port, () => {
      services.logger.info({
        port: config.port,
        swagger: config.swagger.enabled ? config.swagger.path : null,
        database: services.store.connection.name,
      }, 'Farm crawler API listening');
    });
    registerShutdown(server, services);
    return;
  }

  try {
    if (command === 'db:init') {
      // Store.connect() synchronizes indexes because syncIndexes=true above.
      console.log(`MongoDB initialized: ${services.store.connection.name}`);
      return;
    }

    if (command === 'crawl') {
      const source = positional[1] || 'all';
      const names = source === 'all' ? Object.keys(services.registry) : [source];

      for (const name of names) {
        if (!services.registry[name]) {
          throw new Error(`Unknown source "${name}". Run npm run sources.`);
        }

        const result = await services.registry[name].run({
          maxPages: Number(flags['max-pages'] || config.crawler.maxPages),
          dryRun: toBoolean(flags['dry-run'], false),
          downloadImages: toBoolean(flags['download-images'], config.crawler.downloadImages),
        });

        console.log(JSON.stringify(result, null, 2));
        if (result.status === 'FAILED') process.exitCode = 1;
      }
      return;
    }

    if (command === 'images') {
      const limit = Math.min(1000, Number(flags.limit || 100));
      const suppliers = await services.store.suppliersWithoutStoredLogo(limit);
      let saved = 0;

      for (const supplier of suppliers) {
        if (await services.imageService.enrichWebsiteLogo(supplier)) saved += 1;
      }

      console.log(JSON.stringify({ checked: suppliers.length, saved }, null, 2));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await services.store.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { build, parseArgs, toBoolean, registerShutdown, main };
