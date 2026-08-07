'use strict';

const path = require('node:path');
const swaggerJsdoc = require('swagger-jsdoc');

/**
 * Build the OpenAPI document consumed by Swagger UI and `/api-docs.json`.
 *
 * Route-specific operations are kept beside the Express routes in `app.js`,
 * while shared schemas and security definitions live here to avoid duplicating
 * large response objects in every JSDoc block.
 *
 * @param {Record<string, any>} config Application configuration.
 * @returns {Record<string, any>} OpenAPI 3 specification.
 */
function createSwaggerSpec(config) {
  return swaggerJsdoc({
    failOnErrors: true,
    definition: {
      openapi: '3.0.3',
      info: {
        title: 'Vietnam Agriculture Supplier Crawler API',
        version: '1.1.0',
        description: [
          'REST API for crawling and searching Vietnamese agriculture suppliers.',
          '',
          'The database covers seeds/plant varieties, agricultural equipment, fertilizers, provider logos,',
          'and source evidence. Data is traceable but is not claimed to be a complete registry of every supplier.',
        ].join('\n'),
      },
      servers: [
        {
          url: config.swagger.serverUrl,
          description: config.env === 'production' ? 'Configured API server' : 'Local development server',
        },
      ],
      tags: [
        { name: 'System', description: 'Health and API documentation endpoints.' },
        { name: 'Sources', description: 'Configured crawler sources.' },
        { name: 'Suppliers', description: 'Search and inspect normalized suppliers.' },
        { name: 'Crawlers', description: 'Run crawlers and inspect run history.' },
        { name: 'Images', description: 'Enrich provider logos and icons.' },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'Administrative API key configured through ADMIN_API_KEY.',
          },
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'API key',
            description: 'Alternative way to send the ADMIN_API_KEY value.',
          },
        },
        schemas: {
          ErrorResponse: {
            type: 'object',
            required: ['error'],
            properties: {
              error: { type: 'string', example: 'Supplier not found' },
              detail: { type: 'string', nullable: true, example: 'Detailed development-only error message' },
              available: { type: 'array', items: { type: 'string' }, nullable: true },
            },
          },
          HealthResponse: {
            type: 'object',
            required: ['ok', 'service', 'time', 'database'],
            properties: {
              ok: { type: 'boolean', example: true },
              service: { type: 'string', example: 'farm-crawler' },
              time: { type: 'string', format: 'date-time' },
              database: {
                type: 'object',
                required: ['ok', 'name'],
                properties: {
                  ok: { type: 'boolean', example: true },
                  name: { type: 'string', example: 'farm_crawler' },
                },
              },
            },
          },
          Source: {
            type: 'object',
            required: ['name', 'description'],
            properties: {
              name: { type: 'string', example: 'ppd-seeds' },
              description: { type: 'string', example: 'Official PPD seed circulation/recognition records' },
            },
          },
          Supplier: {
            type: 'object',
            required: ['id', 'legalName', 'slug', 'country', 'roles', 'groups', 'environments', 'cropNames', 'categories'],
            properties: {
              id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$', example: '66b2f7dc0ed9c017a114d111' },
              legalName: { type: 'string', example: 'CÔNG TY TNHH NÔNG NGHIỆP ABC' },
              tradeName: { type: 'string', nullable: true, example: 'ABC Agriculture' },
              slug: { type: 'string', example: 'nong-nghiep-abc' },
              taxCode: { type: 'string', nullable: true, example: '0312345678' },
              description: { type: 'string', nullable: true },
              website: { type: 'string', format: 'uri', nullable: true },
              email: { type: 'string', description: 'Comma-separated compatibility field.', example: 'hello@abc.vn' },
              emails: { type: 'array', items: { type: 'string', format: 'email' } },
              phone: { type: 'string', description: 'Comma-separated compatibility field.', example: '0912345678' },
              phones: { type: 'array', items: { type: 'string' } },
              address: { type: 'string', nullable: true },
              province: { type: 'string', nullable: true, example: 'Lâm Đồng' },
              country: { type: 'string', example: 'Vietnam' },
              roles: { type: 'array', items: { type: 'string' }, example: ['MANUFACTURER'] },
              groups: {
                type: 'array',
                items: { type: 'string', enum: ['SEED', 'EQUIPMENT', 'FERTILIZER'] },
              },
              environments: {
                type: 'array',
                items: { type: 'string', enum: ['INDOOR', 'OUTDOOR', 'GREENHOUSE', 'MULTI_ENVIRONMENT'] },
              },
              cropNames: { type: 'array', items: { type: 'string' }, example: ['Cà chua'] },
              categories: { type: 'array', items: { type: 'string' }, example: ['NPK'] },
              verifiedStatus: {
                type: 'string',
                enum: ['UNVERIFIED', 'AUTO_VERIFIED', 'OFFICIAL_SOURCE_VERIFIED', 'MANUALLY_VERIFIED', 'INACTIVE'],
              },
              confidenceScore: { type: 'number', format: 'float', minimum: 0, maximum: 1, example: 0.9 },
              logoOriginalUrl: { type: 'string', format: 'uri', nullable: true },
              logoStorageUrl: { type: 'string', nullable: true },
              lastVerifiedAt: { type: 'string', format: 'date-time', nullable: true },
              createdAt: { type: 'string', format: 'date-time', nullable: true },
              updatedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          Product: {
            type: 'object',
            required: ['id', 'supplierId', 'name', 'environments', 'cropNames'],
            properties: {
              id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
              supplierId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
              name: { type: 'string' },
              productGroup: { type: 'string', enum: ['SEED', 'EQUIPMENT', 'FERTILIZER'], nullable: true },
              category: { type: 'string', nullable: true },
              description: { type: 'string', nullable: true },
              productUrl: { type: 'string', format: 'uri', nullable: true },
              environments: { type: 'array', items: { type: 'string' } },
              cropNames: { type: 'array', items: { type: 'string' } },
              imageOriginalUrl: { type: 'string', format: 'uri', nullable: true },
              imageStorageUrl: { type: 'string', nullable: true },
              createdAt: { type: 'string', format: 'date-time', nullable: true },
              updatedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          SourceEvidence: {
            type: 'object',
            required: ['id', 'sourceName', 'sourceType', 'sourceUrl'],
            properties: {
              id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
              sourceName: { type: 'string' },
              sourceType: {
                type: 'string',
                enum: ['OFFICIAL_REGISTRY', 'BUSINESS_DIRECTORY', 'EXHIBITION', 'COMPANY_WEBSITE', 'OTHER'],
              },
              sourceUrl: { type: 'string', format: 'uri' },
              confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
              retrievedAt: { type: 'string', format: 'date-time' },
              lastCheckedAt: { type: 'string', format: 'date-time' },
            },
          },
          Image: {
            type: 'object',
            required: ['id', 'imageType', 'originalUrl'],
            properties: {
              id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
              imageType: { type: 'string', enum: ['LOGO', 'FAVICON', 'PRODUCT', 'COMPANY_BANNER', 'UNKNOWN'] },
              originalUrl: { type: 'string', format: 'uri' },
              storageUrl: { type: 'string', nullable: true },
              mimeType: { type: 'string', nullable: true },
              byteSize: { type: 'integer', nullable: true },
              sourcePageUrl: { type: 'string', format: 'uri', nullable: true },
              createdAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          SupplierDetail: {
            allOf: [
              { $ref: '#/components/schemas/Supplier' },
              {
                type: 'object',
                required: ['products', 'sources', 'images'],
                properties: {
                  products: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
                  sources: { type: 'array', items: { $ref: '#/components/schemas/SourceEvidence' } },
                  images: { type: 'array', items: { $ref: '#/components/schemas/Image' } },
                },
              },
            ],
          },
          SupplierListResponse: {
            type: 'object',
            required: ['page', 'limit', 'total', 'totalPages', 'items'],
            properties: {
              page: { type: 'integer', minimum: 1, example: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 100, example: 20 },
              total: { type: 'integer', minimum: 0, example: 125 },
              totalPages: { type: 'integer', minimum: 0, example: 7 },
              items: { type: 'array', items: { $ref: '#/components/schemas/Supplier' } },
            },
          },
          CrawlRun: {
            type: 'object',
            required: ['id', 'sourceName', 'status', 'pages', 'found', 'inserted', 'updated', 'skipped', 'failed'],
            properties: {
              id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
              sourceName: { type: 'string', example: 'ppd-seeds' },
              status: { type: 'string', enum: ['PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'] },
              startedAt: { type: 'string', format: 'date-time' },
              finishedAt: { type: 'string', format: 'date-time', nullable: true },
              pages: { type: 'integer', minimum: 0 },
              found: { type: 'integer', minimum: 0 },
              inserted: { type: 'integer', minimum: 0 },
              updated: { type: 'integer', minimum: 0 },
              skipped: { type: 'integer', minimum: 0 },
              failed: { type: 'integer', minimum: 0 },
              errorMessage: { type: 'string', nullable: true },
            },
          },
          CrawlRequest: {
            type: 'object',
            properties: {
              maxPages: { type: 'integer', minimum: 1, maximum: 100, default: 3 },
              dryRun: { type: 'boolean', default: false },
              downloadImages: { type: 'boolean', default: true },
            },
          },
          CrawlResult: {
            type: 'object',
            required: ['source', 'status', 'pages', 'found', 'inserted', 'updated', 'skipped', 'failed'],
            properties: {
              source: { type: 'string' },
              status: { type: 'string', enum: ['COMPLETED', 'PARTIAL', 'FAILED'] },
              pages: { type: 'integer' },
              found: { type: 'integer' },
              inserted: { type: 'integer' },
              updated: { type: 'integer' },
              skipped: { type: 'integer' },
              failed: { type: 'integer' },
            },
          },
          CrawlResponse: {
            type: 'object',
            required: ['results'],
            properties: {
              results: { type: 'array', items: { $ref: '#/components/schemas/CrawlResult' } },
            },
          },
          ImageEnrichmentRequest: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            },
          },
          ImageEnrichmentResponse: {
            type: 'object',
            required: ['checked', 'saved'],
            properties: {
              checked: { type: 'integer', minimum: 0 },
              saved: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    apis: [path.join(__dirname, 'app.js')],
  });
}

module.exports = { createSwaggerSpec };
