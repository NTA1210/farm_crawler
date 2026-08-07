'use strict';

const express = require('express');
const path = require('node:path');
const { SOURCE_INFO } = require('./crawlers');

function adminGuard(config) {
  return (req, res, next) => {
    if (config.env === 'development' && !config.adminApiKey) return next();
    const token = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!config.adminApiKey || token !== config.adminApiKey) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  };
}

function booleanValue(value, fallback) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function createApp({ config, store, registry, imageService, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  if (config.storage.driver === 'local') app.use('/storage', express.static(path.resolve(config.storage.localDir), { fallthrough: false }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'farm-crawler', time: new Date().toISOString() }));
  app.get('/api/sources', (_req, res) => res.json(Object.entries(SOURCE_INFO).map(([name, description]) => ({ name, description }))));
  app.get('/api/suppliers', (req, res) => res.json(store.listSuppliers({
    search: req.query.search, province: req.query.province, group: req.query.group || req.query.productGroup,
    environment: req.query.environment, crop: req.query.crop || req.query.cropName,
    page: req.query.page, limit: req.query.limit,
  })));
  app.get('/api/suppliers/:id', (req, res) => {
    const supplier = store.getSupplier(Number(req.params.id));
    return supplier ? res.json(supplier) : res.status(404).json({ error: 'Supplier not found' });
  });
  app.get('/api/crawl-runs', (req, res) => res.json(store.recentRuns(req.query.limit)));

  app.post('/api/crawlers/:source/run', adminGuard(config), async (req, res, next) => {
    try {
      const names = req.params.source === 'all' ? Object.keys(registry) : [req.params.source];
      const unknown = names.filter((name) => !registry[name]);
      if (unknown.length) return res.status(404).json({ error: `Unknown source: ${unknown.join(', ')}`, available: Object.keys(registry) });
      const options = {
        maxPages: Number(req.body?.maxPages || config.crawler.maxPages),
        dryRun: booleanValue(req.body?.dryRun, false),
        downloadImages: booleanValue(req.body?.downloadImages, config.crawler.downloadImages),
      };
      const results = [];
      for (const name of names) results.push(await registry[name].run(options));
      return res.json({ results });
    } catch (error) { return next(error); }
  });

  app.post('/api/images/enrich', adminGuard(config), async (req, res, next) => {
    try {
      const suppliers = store.suppliersWithoutStoredLogo(Math.min(500, Number(req.body?.limit || 50)));
      let saved = 0;
      for (const row of suppliers) {
        const result = await imageService.enrichWebsiteLogo({ id: row.id, website: row.website });
        if (result) saved += 1;
      }
      return res.json({ checked: suppliers.length, saved });
    } catch (error) { return next(error); }
  });

  app.use((error, req, res, _next) => {
    logger.error({ method: req.method, path: req.path, error: error.message, stack: config.env === 'development' ? error.stack : undefined }, 'Request failed');
    res.status(500).json({ error: 'Internal server error', detail: config.env === 'development' ? error.message : undefined });
  });
  return app;
}

module.exports = { createApp };
