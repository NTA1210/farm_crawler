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

function parseArgs(argv) {
  const positional = []; const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) positional.push(arg);
    else {
      const [key, value = 'true'] = arg.slice(2).split('='); flags[key] = value;
    }
  }
  return { positional, flags };
}

function toBoolean(value, fallback) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function build() {
  validateConfig();
  const logger = pino({ level: config.logLevel });
  const store = new Store(config.databasePath);
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

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'serve';
  const services = build();

  if (command === 'serve') {
    const app = createApp({ config, ...services });
    const server = app.listen(config.port, () => services.logger.info({ port: config.port }, 'Farm crawler API listening'));
    const stop = (signal) => {
      services.logger.info({ signal }, 'Stopping');
      server.close(() => { services.store.close(); process.exit(0); });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }

  if (command === 'db:init') {
    console.log(`Database initialized: ${config.databasePath}`);
  } else if (command === 'sources') {
    console.table(Object.entries(SOURCE_INFO).map(([name, description]) => ({ name, description })));
  } else if (command === 'crawl') {
    const source = positional[1] || 'all';
    const names = source === 'all' ? Object.keys(services.registry) : [source];
    for (const name of names) {
      if (!services.registry[name]) throw new Error(`Unknown source "${name}". Run npm run sources.`);
      const result = await services.registry[name].run({
        maxPages: Number(flags['max-pages'] || config.crawler.maxPages),
        dryRun: toBoolean(flags['dry-run'], false),
        downloadImages: toBoolean(flags['download-images'], config.crawler.downloadImages),
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (command === 'images') {
    const limit = Math.min(1000, Number(flags.limit || 100));
    const suppliers = services.store.suppliersWithoutStoredLogo(limit);
    let saved = 0;
    for (const supplier of suppliers) if (await services.imageService.enrichWebsiteLogo(supplier)) saved += 1;
    console.log(JSON.stringify({ checked: suppliers.length, saved }, null, 2));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  services.store.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { build, parseArgs };
