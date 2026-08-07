'use strict';

const express = require('express');
const path = require('node:path');
const swaggerUi = require('swagger-ui-express');
const { SOURCE_INFO } = require('./crawlers');
const { createSwaggerSpec } = require('./swagger');

/**
 * Build middleware that protects administrative write endpoints.
 *
 * In local development the guard may be disabled by leaving ADMIN_API_KEY
 * empty. In every other environment a key must be sent through `X-API-Key` or
 * a Bearer Authorization header.
 *
 * @param {Record<string, any>} config Application configuration.
 * @returns {import('express').RequestHandler} Express authorization middleware.
 */
function adminGuard(config) {
  return (req, res, next) => {
    if (config.env === 'development' && !config.adminApiKey) return next();

    const token = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!config.adminApiKey || token !== config.adminApiKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
  };
}

/**
 * Parse booleans accepted from JSON bodies and CLI-style string values.
 *
 * @param {unknown} value Candidate value.
 * @param {boolean} fallback Default when the value is missing.
 * @returns {boolean} Parsed boolean.
 */
function booleanValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Wrap an async route so errors are forwarded to the shared error middleware.
 * This also makes the expected error flow explicit for readers who are not yet
 * familiar with Express 5's native Promise handling.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} handler Async route handler.
 * @returns {import('express').RequestHandler} Safe Express handler.
 */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * Create and configure the Express application.
 *
 * @param {{config: Record<string, any>, store: import('./db').Store, registry: Record<string, any>, imageService: import('./images').ImageService, logger: import('pino').Logger}} dependencies Application services.
 * @returns {import('express').Express} Configured Express app.
 */
function createApp({ config, store, registry, imageService, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Local files are exposed only when local storage is selected. R2 objects are
  // served by the configured R2 public/custom domain instead.
  if (config.storage.driver === 'local') {
    app.use('/storage', express.static(path.resolve(config.storage.localDir), { fallthrough: false }));
  }

  // Generate the OpenAPI specification once during startup so every request
  // receives the same validated document.
  const swaggerSpec = config.swagger.enabled ? createSwaggerSpec(config) : null;
  if (swaggerSpec) {
    app.get(config.swagger.jsonPath, (_req, res) => res.json(swaggerSpec));
    app.use(
      config.swagger.path,
      swaggerUi.serve,
      swaggerUi.setup(swaggerSpec, {
        explorer: true,
        customSiteTitle: 'Farm Crawler API Docs',
        swaggerOptions: { persistAuthorization: true },
      }),
    );
  }

  /**
   * @openapi
   * /health:
   *   get:
   *     tags: [System]
   *     summary: Check API and MongoDB health
   *     operationId: getHealth
   *     responses:
   *       '200':
   *         description: API and MongoDB are ready.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/HealthResponse'
   *       '503':
   *         description: MongoDB is unavailable.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get('/health', asyncRoute(async (_req, res) => {
    try {
      const database = await store.ping();
      return res.json({
        ok: true,
        service: 'farm-crawler',
        time: new Date().toISOString(),
        database: { ok: database.ok, name: database.database },
      });
    } catch (error) {
      logger.error({ error: error.message }, 'MongoDB health check failed');
      return res.status(503).json({ error: 'Database unavailable' });
    }
  }));

  /**
   * @openapi
   * /api-docs.json:
   *   get:
   *     tags: [System]
   *     summary: Download the OpenAPI document
   *     operationId: getOpenApiDocument
   *     responses:
   *       '200':
   *         description: OpenAPI 3 document.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   */
  // The actual path is configurable. The JSDoc operation documents the default
  // path used by `.env.example` and Docker Compose.

  /**
   * @openapi
   * /api/sources:
   *   get:
   *     tags: [Sources]
   *     summary: List configured crawler sources
   *     operationId: listSources
   *     responses:
   *       '200':
   *         description: Registered source keys and descriptions.
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Source'
   */
  app.get('/api/sources', (_req, res) => {
    const sources = Object.entries(SOURCE_INFO).map(([name, description]) => ({ name, description }));
    return res.json(sources);
  });

  /**
   * @openapi
   * /api/suppliers:
   *   get:
   *     tags: [Suppliers]
   *     summary: Search and paginate suppliers
   *     operationId: listSuppliers
   *     parameters:
   *       - in: query
   *         name: search
   *         schema: { type: string, maxLength: 120 }
   *         description: Case-insensitive search in name, description and address.
   *       - in: query
   *         name: productGroup
   *         schema: { type: string, enum: [SEED, EQUIPMENT, FERTILIZER] }
   *         description: The group query parameter is accepted as an alias.
   *       - in: query
   *         name: environment
   *         schema: { type: string, enum: [INDOOR, OUTDOOR, GREENHOUSE, MULTI_ENVIRONMENT] }
   *       - in: query
   *         name: cropName
   *         schema: { type: string }
   *         description: The crop query parameter is accepted as an alias.
   *       - in: query
   *         name: province
   *         schema: { type: string }
   *       - in: query
   *         name: page
   *         schema: { type: integer, minimum: 1, default: 1 }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
   *     responses:
   *       '200':
   *         description: Paginated supplier results.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SupplierListResponse'
   */
  app.get('/api/suppliers', asyncRoute(async (req, res) => {
    const result = await store.listSuppliers({
      search: req.query.search,
      province: req.query.province,
      group: req.query.group || req.query.productGroup,
      environment: req.query.environment,
      crop: req.query.crop || req.query.cropName,
      page: req.query.page,
      limit: req.query.limit,
    });
    return res.json(result);
  }));

  /**
   * @openapi
   * /api/suppliers/{id}:
   *   get:
   *     tags: [Suppliers]
   *     summary: Get supplier details and evidence
   *     operationId: getSupplier
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string, pattern: '^[a-fA-F0-9]{24}$' }
   *         description: MongoDB ObjectId.
   *     responses:
   *       '200':
   *         description: Supplier, products, evidence and images.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SupplierDetail'
   *       '404':
   *         description: Supplier does not exist or the ID is invalid.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get('/api/suppliers/:id', asyncRoute(async (req, res) => {
    const supplier = await store.getSupplier(req.params.id);
    return supplier
      ? res.json(supplier)
      : res.status(404).json({ error: 'Supplier not found' });
  }));

  /**
   * @openapi
   * /api/crawl-runs:
   *   get:
   *     tags: [Crawlers]
   *     summary: List recent crawler runs
   *     operationId: listCrawlRuns
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
   *     responses:
   *       '200':
   *         description: Newest crawler runs first.
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/CrawlRun'
   */
  app.get('/api/crawl-runs', asyncRoute(async (req, res) => {
    const runs = await store.recentRuns(req.query.limit);
    return res.json(runs);
  }));

  /**
   * @openapi
   * /api/crawlers/{source}/run:
   *   post:
   *     tags: [Crawlers]
   *     summary: Run one crawler or all crawlers
   *     operationId: runCrawler
   *     security:
   *       - ApiKeyAuth: []
   *       - BearerAuth: []
   *     parameters:
   *       - in: path
   *         name: source
   *         required: true
   *         schema: { type: string, example: ppd-seeds }
   *         description: Registered source key or all.
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CrawlRequest'
   *     responses:
   *       '200':
   *         description: Crawler execution results.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/CrawlResponse'
   *       '401':
   *         description: Missing or invalid administrative API key.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: Unknown crawler source.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post('/api/crawlers/:source/run', adminGuard(config), asyncRoute(async (req, res) => {
    const names = req.params.source === 'all' ? Object.keys(registry) : [req.params.source];
    const unknown = names.filter((name) => !registry[name]);

    if (unknown.length) {
      return res.status(404).json({
        error: `Unknown source: ${unknown.join(', ')}`,
        available: Object.keys(registry),
      });
    }

    const options = {
      maxPages: Number(req.body?.maxPages || config.crawler.maxPages),
      dryRun: booleanValue(req.body?.dryRun, false),
      downloadImages: booleanValue(req.body?.downloadImages, config.crawler.downloadImages),
    };
    const results = [];

    // Sources run sequentially to respect conservative request rates and avoid
    // several crawlers writing the same supplier at the same time.
    for (const name of names) results.push(await registry[name].run(options));

    return res.json({ results });
  }));

  /**
   * @openapi
   * /api/images/enrich:
   *   post:
   *     tags: [Images]
   *     summary: Discover and store missing provider logos
   *     operationId: enrichProviderLogos
   *     security:
   *       - ApiKeyAuth: []
   *       - BearerAuth: []
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ImageEnrichmentRequest'
   *     responses:
   *       '200':
   *         description: Number of suppliers checked and logos saved.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ImageEnrichmentResponse'
   *       '401':
   *         description: Missing or invalid administrative API key.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.post('/api/images/enrich', adminGuard(config), asyncRoute(async (req, res) => {
    const suppliers = await store.suppliersWithoutStoredLogo(Math.min(500, Number(req.body?.limit || 50)));
    let saved = 0;

    for (const supplier of suppliers) {
      const result = await imageService.enrichWebsiteLogo(supplier);
      if (result) saved += 1;
    }

    return res.json({ checked: suppliers.length, saved });
  }));

  // Return a consistent JSON response for unknown application routes.
  app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));

  // Central error middleware prevents stack traces from leaking in production
  // while preserving actionable details during local development.
  app.use((error, req, res, _next) => {
    logger.error({
      method: req.method,
      path: req.path,
      error: error.message,
      stack: config.env === 'development' ? error.stack : undefined,
    }, 'Request failed');

    return res.status(500).json({
      error: 'Internal server error',
      detail: config.env === 'development' ? error.message : undefined,
    });
  });

  return app;
}

module.exports = { createApp, adminGuard, booleanValue, asyncRoute };
