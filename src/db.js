'use strict';

const mongoose = require('mongoose');
const {
  normalizeCompanyName,
  comparisonCompanyName,
  normalizePhone,
  normalizeEmail,
  normalizeWebsite,
  websiteDomain,
  normalizeProvince,
  slug,
  cleanText,
} = require('./core');
const { createModels } = require('./models');

/**
 * Remove empty values and duplicates from a list while preserving insertion order.
 *
 * @param {unknown[]} values Candidate values.
 * @returns {string[]} Normalized unique strings.
 */
function uniqueList(values = []) {
  return [...new Set((values || []).map((value) => cleanText(value)).filter(Boolean))];
}

/**
 * Escape user-controlled text before it is used in a MongoDB regular expression.
 *
 * @param {unknown} value Search text.
 * @returns {string} Regex-safe text.
 */
function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Test whether a value is a valid MongoDB ObjectId.
 *
 * @param {unknown} value Candidate identifier.
 * @returns {boolean} True when valid.
 */
function isValidObjectId(value) {
  return mongoose.isValidObjectId(value);
}

/**
 * Convert a lean Mongoose document to a stable API object.
 * Internal MongoDB fields are removed and reference identifiers become strings.
 *
 * @param {Record<string, any>|null} document Lean Mongoose document.
 * @returns {Record<string, any>|null} API-friendly object.
 */
function publicDocument(document) {
  if (!document) return null;
  const result = { ...document, id: String(document._id || document.id) };
  if (result.supplierId) result.supplierId = String(result.supplierId);
  if (result.productId) result.productId = String(result.productId);
  delete result._id;
  delete result.__v;
  return result;
}

/**
 * Convert a supplier document to the API contract.
 *
 * Arrays remain arrays, while comma-separated `email` and `phone` compatibility
 * fields are also provided for older consumers of the original SQLite version.
 *
 * @param {Record<string, any>|null} document Lean supplier document.
 * @returns {Record<string, any>|null} Public supplier object.
 */
function publicSupplier(document) {
  if (!document) return null;
  const emails = uniqueList(document.emails);
  const phones = uniqueList(document.phones);
  return {
    ...publicDocument(document),
    email: emails.join(','),
    phone: phones.join(','),
    emails,
    phones,
  };
}

/**
 * Build a unique human-readable slug without depending on a MongoDB duplicate-key
 * exception for the normal collision path.
 *
 * @param {import('mongoose').Model} Supplier Supplier model.
 * @param {string} legalName Supplier legal name.
 * @returns {Promise<string>} Unique slug.
 */
async function createUniqueSlug(Supplier, legalName) {
  const base = slug(legalName).slice(0, 120);
  let candidate = base;
  let suffix = 1;

  while (await Supplier.exists({ slug: candidate })) {
    suffix += 1;
    candidate = `${base.slice(0, 115)}-${suffix}`;
  }
  return candidate;
}

/**
 * MongoDB/Mongoose persistence facade shared by crawlers, image processing and API
 * routes. Source adapters never import Mongoose models directly; this class is the
 * only persistence contract they need to know.
 */
class Store {
  /**
   * @param {import('mongoose').Connection} connection Active Mongoose connection.
   * @param {Record<string, import('mongoose').Model>} models Registered models.
   * @param {import('pino').Logger|null} logger Optional structured logger.
   */
  constructor(connection, models, logger = null) {
    this.connection = connection;
    this.models = models;
    this.logger = logger;
  }

  /**
   * Establish an isolated Mongoose connection and register project models.
   *
   * A dedicated connection is used instead of the global Mongoose singleton so test
   * databases and CLI invocations can be opened and closed independently.
   *
   * @param {{uri: string, dbName?: string, serverSelectionTimeoutMs?: number, maxPoolSize?: number, autoIndex?: boolean, logger?: import('pino').Logger}} options Connection options.
   * @returns {Promise<Store>} Ready store.
   */
  static async connect(options) {
    const connection = mongoose.createConnection(options.uri, {
      dbName: options.dbName || undefined,
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMs || 10000,
      maxPoolSize: options.maxPoolSize || 10,
      autoIndex: options.autoIndex ?? true,
    });

    await connection.asPromise();
    const store = new Store(connection, createModels(connection), options.logger || null);
    if (options.autoIndex) await store.syncIndexes();
    return store;
  }

  /**
   * Synchronize all indexes declared by Mongoose schemas.
   * In production, call this explicitly during deployment with `npm run db:init`.
   *
   * @returns {Promise<void>}
   */
  async syncIndexes() {
    await Promise.all(Object.values(this.models).map((Model) => Model.syncIndexes()));
  }

  /**
   * Check MongoDB connectivity and return the active database name.
   *
   * @returns {Promise<{ok: boolean, database: string}>} Health result.
   */
  async ping() {
    const result = await this.connection.db.admin().ping();
    return { ok: result.ok === 1, database: this.connection.name };
  }

  /**
   * Create the audit record for a crawler execution.
   *
   * @param {string} sourceName Registered source key.
   * @returns {Promise<string>} Crawl-run ObjectId.
   */
  async startRun(sourceName) {
    const run = await this.models.CrawlRun.create({
      sourceName,
      status: 'RUNNING',
      startedAt: new Date(),
    });
    return String(run._id);
  }

  /**
   * Finish a crawler run and persist all counters even when a page failed.
   *
   * @param {string} id Crawl-run ObjectId.
   * @param {Record<string, number>} stats Run counters.
   * @param {Error|null} fatalError Optional fatal error.
   * @returns {Promise<void>}
   */
  async finishRun(id, stats, fatalError = null) {
    if (!isValidObjectId(id)) return;
    const status = fatalError && !stats.pages
      ? 'FAILED'
      : stats.failed > 0
        ? 'PARTIAL'
        : 'COMPLETED';

    await this.models.CrawlRun.findByIdAndUpdate(id, {
      $set: {
        status,
        finishedAt: new Date(),
        pages: stats.pages || 0,
        found: stats.found || 0,
        inserted: stats.inserted || 0,
        updated: stats.updated || 0,
        skipped: stats.skipped || 0,
        failed: stats.failed || 0,
        errorMessage: fatalError?.message || null,
      },
    });
  }

  /**
   * Prepare parser output for schema validation and deterministic deduplication.
   *
   * @param {Record<string, any>} input Parsed supplier values.
   * @returns {Record<string, any>} Normalized supplier document.
   */
  prepareSupplier(input = {}) {
    const legalName = normalizeCompanyName(input.legalName || input.tradeName || '');
    const website = normalizeWebsite(input.website);
    const emails = uniqueList(normalizeEmail(input.emails || input.email).split(','));
    const phones = uniqueList(normalizePhone(input.phones || input.phone).split(','));

    return {
      legalName,
      normalizedName: comparisonCompanyName(legalName),
      tradeName: cleanText(input.tradeName) || null,
      taxCode: cleanText(input.taxCode).replace(/\D/g, '') || null,
      description: cleanText(input.description) || null,
      website,
      websiteDomain: website ? websiteDomain(website) : null,
      emails,
      phones,
      address: cleanText(input.address) || null,
      province: normalizeProvince(input.province || input.address),
      country: cleanText(input.country) || 'Vietnam',
      roles: uniqueList(input.roles),
      groups: uniqueList(input.groups),
      environments: uniqueList(input.environments),
      cropNames: uniqueList(input.cropNames),
      categories: uniqueList(input.categories),
      verifiedStatus: input.verifiedStatus || 'UNVERIFIED',
      confidenceScore: Math.min(1, Math.max(0, Number(input.confidenceScore ?? 0.3))),
      logoOriginalUrl: normalizeWebsite(input.logoOriginalUrl),
      logoStorageUrl: cleanText(input.logoStorageUrl) || null,
      lastVerifiedAt: input.lastVerifiedAt ? new Date(input.lastVerifiedAt) : null,
    };
  }

  /**
   * Find a matching supplier in priority order: tax code, website domain, email,
   * phone, then normalized company name plus province.
   *
   * @param {Record<string, any>} candidate Prepared supplier values.
   * @returns {Promise<Record<string, any>|null>} Existing lean supplier.
   */
  async findSupplier(candidate) {
    const { Supplier } = this.models;

    if (candidate.taxCode) {
      const match = await Supplier.findOne({ taxCode: candidate.taxCode }).lean();
      if (match) return match;
    }
    if (candidate.websiteDomain) {
      const match = await Supplier.findOne({ websiteDomain: candidate.websiteDomain }).lean();
      if (match) return match;
    }
    for (const email of candidate.emails || []) {
      const match = await Supplier.findOne({ emails: email }).lean();
      if (match) return match;
    }
    for (const phone of candidate.phones || []) {
      const match = await Supplier.findOne({ phones: phone }).lean();
      if (match) return match;
    }
    if (candidate.normalizedName) {
      return Supplier.findOne({
        normalizedName: candidate.normalizedName,
        province: candidate.province || null,
      }).lean();
    }
    return null;
  }

  /**
   * Merge fresh parser values into an existing supplier.
   * Scalar values are refreshed only when non-empty; arrays are unioned.
   *
   * @param {Record<string, any>} existing Existing lean supplier.
   * @param {Record<string, any>} incoming Prepared supplier.
   * @returns {Record<string, any>} MongoDB update payload.
   */
  mergeSupplier(existing, incoming) {
    const merged = { ...existing };
    const arrayFields = ['emails', 'phones', 'roles', 'groups', 'environments', 'cropNames', 'categories'];

    for (const field of arrayFields) {
      merged[field] = uniqueList([...(existing[field] || []), ...(incoming[field] || [])]);
    }
    for (const [field, value] of Object.entries(incoming)) {
      if (arrayFields.includes(field)) continue;
      if (value !== null && value !== undefined && value !== '') merged[field] = value;
    }

    merged.confidenceScore = Math.max(
      Number(existing.confidenceScore || 0),
      Number(incoming.confidenceScore || 0),
    );
    if (existing.verifiedStatus === 'OFFICIAL_SOURCE_VERIFIED') {
      merged.verifiedStatus = existing.verifiedStatus;
    }

    delete merged._id;
    delete merged.__v;
    delete merged.createdAt;
    delete merged.updatedAt;
    return merged;
  }

  /**
   * Upsert one product/service attached to a supplier.
   *
   * @param {string} supplierId Supplier ObjectId.
   * @param {Record<string, any>} product Parsed product values.
   * @returns {Promise<string|null>} Product ObjectId or null.
   */
  async upsertProduct(supplierId, product = {}) {
    const name = cleanText(product.name);
    if (!name) return null;

    const productUrl = normalizeWebsite(product.productUrl) || '';
    const update = {
      supplierId,
      name,
      productGroup: product.productGroup || null,
      category: cleanText(product.category) || null,
      description: cleanText(product.description) || null,
      productUrl,
      environments: uniqueList(product.environments),
      cropNames: uniqueList(product.cropNames),
      imageOriginalUrl: normalizeWebsite(product.imageOriginalUrl),
      imageStorageUrl: cleanText(product.imageStorageUrl) || null,
    };

    const document = await this.models.Product.findOneAndUpdate(
      { supplierId, name, productUrl },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return String(document._id);
  }

  /**
   * Upsert traceable source evidence for a parsed supplier/product row.
   *
   * @param {string|null} supplierId Supplier ObjectId.
   * @param {string|null} productId Product ObjectId.
   * @param {Record<string, any>} evidence Parsed evidence.
   * @returns {Promise<void>}
   */
  async upsertEvidence(supplierId, productId, evidence = {}) {
    const sourceName = cleanText(evidence.sourceName) || 'unknown';
    const sourceUrl = normalizeWebsite(evidence.sourceUrl) || 'https://invalid.local';
    const sourceRecordId = cleanText(evidence.sourceRecordId) || '';
    const now = new Date();

    await this.models.SourceEvidence.findOneAndUpdate(
      { sourceName, sourceUrl, sourceRecordId },
      {
        $set: {
          supplierId: supplierId || null,
          productId: productId || null,
          sourceType: evidence.sourceType || 'OTHER',
          raw: evidence.raw || null,
          rawStorageKey: cleanText(evidence.rawStorageKey) || null,
          contentHash: cleanText(evidence.contentHash) || null,
          confidenceScore: Math.min(1, Math.max(0, Number(evidence.confidenceScore ?? 0.3))),
          lastCheckedAt: now,
        },
        $setOnInsert: { retrievedAt: now },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }

  /**
   * Idempotently save one parsed crawler record and its evidence.
   *
   * @param {Record<string, any>} record Normalized crawler record.
   * @returns {Promise<{id: string, action: 'inserted'|'updated'}>} Save result.
   */
  async saveRecord(record = {}) {
    const prepared = this.prepareSupplier(record.supplier);
    if (!prepared.legalName) throw new Error('Missing supplier legal name');

    const existing = await this.findSupplier(prepared);
    const action = existing ? 'updated' : 'inserted';
    let supplierDocument;

    if (existing) {
      supplierDocument = await this.models.Supplier.findByIdAndUpdate(
        existing._id,
        { $set: this.mergeSupplier(existing, prepared) },
        { new: true, runValidators: true },
      );
    } else {
      prepared.slug = await createUniqueSlug(this.models.Supplier, prepared.legalName);
      supplierDocument = await this.models.Supplier.create(prepared);
    }

    const supplierId = String(supplierDocument._id);
    const productId = record.product
      ? await this.upsertProduct(supplierId, record.product)
      : null;
    await this.upsertEvidence(supplierId, productId, record.evidence || {});

    return { id: supplierId, action };
  }

  /**
   * Save validated image metadata and update the related supplier/product URL.
   * Binary bytes remain in local storage or Cloudflare R2, not MongoDB.
   *
   * @param {Record<string, any>} image Validated image metadata.
   * @returns {Promise<void>}
   */
  async saveImage(image = {}) {
    const supplierId = isValidObjectId(image.supplierId) ? image.supplierId : null;
    const productId = isValidObjectId(image.productId) ? image.productId : null;

    await this.models.Image.findOneAndUpdate(
      { contentHash: image.contentHash, imageType: image.imageType || 'UNKNOWN' },
      {
        $set: {
          supplierId,
          productId,
          imageType: image.imageType || 'UNKNOWN',
          originalUrl: image.originalUrl,
          sourcePageUrl: image.sourcePageUrl || null,
          sourceName: image.sourceName || 'unknown',
          storageKey: image.storageKey || null,
          storageUrl: image.storageUrl || null,
          contentHash: image.contentHash,
          mimeType: image.mimeType || null,
          byteSize: Number(image.byteSize ?? 0),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (supplierId && image.imageType === 'LOGO') {
      await this.models.Supplier.findByIdAndUpdate(supplierId, {
        $set: {
          logoOriginalUrl: image.originalUrl,
          logoStorageUrl: image.storageUrl || null,
        },
      });
    }
    if (productId && image.imageType === 'PRODUCT') {
      await this.models.Product.findByIdAndUpdate(productId, {
        $set: {
          imageOriginalUrl: image.originalUrl,
          imageStorageUrl: image.storageUrl || null,
        },
      });
    }
  }

  /**
   * Search suppliers using bounded regex filters and safe pagination.
   *
   * @param {Record<string, any>} filters API query filters.
   * @returns {Promise<{page: number, limit: number, total: number, totalPages: number, items: Record<string, any>[]}>} Page result.
   */
  async listSuppliers(filters = {}) {
    const page = Math.max(1, Number(filters.page || 1));
    const limit = Math.max(1, Math.min(100, Number(filters.limit || 20)));
    const query = {};

    if (filters.province) query.province = { $regex: escapeRegex(cleanText(filters.province)), $options: 'i' };
    if (filters.group) query.groups = String(filters.group).toUpperCase();
    if (filters.environment) query.environments = String(filters.environment).toUpperCase();
    if (filters.crop) query.cropNames = { $regex: escapeRegex(cleanText(filters.crop)), $options: 'i' };
    if (filters.search) {
      const regex = { $regex: escapeRegex(cleanText(filters.search).slice(0, 120)), $options: 'i' };
      query.$or = [
        { legalName: regex },
        { tradeName: regex },
        { description: regex },
        { address: regex },
      ];
    }

    const [total, documents] = await Promise.all([
      this.models.Supplier.countDocuments(query),
      this.models.Supplier.find(query)
        .sort({ updatedAt: -1, legalName: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      items: documents.map(publicSupplier),
    };
  }

  /**
   * Return one supplier together with products, evidence and image metadata.
   *
   * @param {string} id Supplier ObjectId.
   * @returns {Promise<Record<string, any>|null>} Supplier detail.
   */
  async getSupplier(id) {
    if (!isValidObjectId(id)) return null;
    const supplier = await this.models.Supplier.findById(id).lean();
    if (!supplier) return null;

    const [products, sources, images] = await Promise.all([
      this.models.Product.find({ supplierId: id }).sort({ updatedAt: -1 }).lean(),
      this.models.SourceEvidence.find({ supplierId: id }).sort({ lastCheckedAt: -1 }).lean(),
      this.models.Image.find({ supplierId: id }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      ...publicSupplier(supplier),
      products: products.map(publicDocument),
      sources: sources.map(publicDocument),
      images: images.map(publicDocument),
    };
  }

  /**
   * List suppliers with a website but without a stored logo URL.
   *
   * @param {number|string} limit Maximum records.
   * @returns {Promise<Record<string, any>[]>} Suppliers requiring enrichment.
   */
  async suppliersWithoutStoredLogo(limit = 100) {
    const documents = await this.models.Supplier.find({
      website: { $type: 'string', $ne: '' },
      $or: [
        { logoStorageUrl: null },
        { logoStorageUrl: '' },
        { logoStorageUrl: { $exists: false } },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(Math.max(1, Math.min(1000, Number(limit) || 100)))
      .lean();
    return documents.map(publicSupplier);
  }

  /**
   * Return recent crawler runs, newest first.
   *
   * @param {number|string} limit Maximum records.
   * @returns {Promise<Record<string, any>[]>} Crawl runs.
   */
  async recentRuns(limit = 20) {
    const documents = await this.models.CrawlRun.find({})
      .sort({ startedAt: -1 })
      .limit(Math.max(1, Math.min(100, Number(limit) || 20)))
      .lean();
    return documents.map(publicDocument);
  }

  /** Close this store's dedicated Mongoose connection. */
  async close() {
    if (this.connection.readyState !== 0) await this.connection.close();
  }

  /** Drop the active database. Intended only for isolated tests/tools. */
  async dropDatabase() {
    await this.connection.dropDatabase();
  }
}

module.exports = {
  Store,
  uniqueList,
  publicSupplier,
  publicDocument,
  isValidObjectId,
};
