'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  normalizeCompanyName, comparisonCompanyName, normalizePhone, normalizeEmail, normalizeWebsite,
  websiteDomain, normalizeProvince, slug,
} = require('./core');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legal_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  trade_name TEXT,
  slug TEXT NOT NULL UNIQUE,
  tax_code TEXT,
  description TEXT,
  website TEXT,
  website_domain TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  province TEXT,
  country TEXT NOT NULL DEFAULT 'Vietnam',
  roles_json TEXT NOT NULL DEFAULT '[]',
  groups_json TEXT NOT NULL DEFAULT '[]',
  environments_json TEXT NOT NULL DEFAULT '[]',
  crop_names_json TEXT NOT NULL DEFAULT '[]',
  categories_json TEXT NOT NULL DEFAULT '[]',
  verified_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  confidence_score REAL NOT NULL DEFAULT 0.3,
  logo_original_url TEXT,
  logo_storage_url TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suppliers_normalized_name ON suppliers(normalized_name);
CREATE INDEX IF NOT EXISTS idx_suppliers_domain ON suppliers(website_domain);
CREATE INDEX IF NOT EXISTS idx_suppliers_tax_code ON suppliers(tax_code);
CREATE INDEX IF NOT EXISTS idx_suppliers_province ON suppliers(province);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product_group TEXT,
  category TEXT,
  description TEXT,
  product_url TEXT,
  environments_json TEXT NOT NULL DEFAULT '[]',
  crop_names_json TEXT NOT NULL DEFAULT '[]',
  image_original_url TEXT,
  image_storage_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, name, product_url)
);

CREATE TABLE IF NOT EXISTS source_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_record_id TEXT,
  raw_json TEXT,
  raw_storage_key TEXT,
  content_hash TEXT,
  confidence_score REAL NOT NULL DEFAULT 0.3,
  retrieved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_name, source_url, source_record_id)
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  image_type TEXT NOT NULL,
  original_url TEXT NOT NULL,
  source_page_url TEXT,
  source_name TEXT,
  storage_key TEXT,
  storage_url TEXT,
  content_hash TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(content_hash, image_type)
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
`;

function uniq(values = []) { return [...new Set(values.filter(Boolean))]; }
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}
function parseArray(value) {
  try { return Array.isArray(value) ? value : JSON.parse(value || '[]'); } catch { return []; }
}
function mergeJson(existing, incoming) { return JSON.stringify(uniq([...parseArray(existing), ...asArray(incoming)])); }
function now() { return new Date().toISOString(); }

class Store {
  constructor(databasePath) {
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.prepare();
  }

  prepare() {
    this.findByTax = this.db.prepare('SELECT * FROM suppliers WHERE tax_code = ? LIMIT 1');
    this.findByDomain = this.db.prepare('SELECT * FROM suppliers WHERE website_domain = ? LIMIT 1');
    this.findByEmail = this.db.prepare("SELECT * FROM suppliers WHERE email <> '' AND instr(',' || email || ',', ',' || ? || ',') > 0 LIMIT 1");
    this.findByPhone = this.db.prepare("SELECT * FROM suppliers WHERE phone <> '' AND instr(',' || phone || ',', ',' || ? || ',') > 0 LIMIT 1");
    this.findByNameProvince = this.db.prepare('SELECT * FROM suppliers WHERE normalized_name = ? AND coalesce(province, \'\') = coalesce(?, \'\') LIMIT 1');
    this.insertSupplier = this.db.prepare(`
      INSERT INTO suppliers (
        legal_name, normalized_name, trade_name, slug, tax_code, description, website, website_domain,
        email, phone, address, province, country, roles_json, groups_json, environments_json, crop_names_json,
        categories_json, verified_status, confidence_score, logo_original_url, logo_storage_url, last_verified_at
      ) VALUES (
        @legalName, @normalizedName, @tradeName, @slug, @taxCode, @description, @website, @websiteDomain,
        @email, @phone, @address, @province, @country, @rolesJson, @groupsJson, @environmentsJson, @cropNamesJson,
        @categoriesJson, @verifiedStatus, @confidenceScore, @logoOriginalUrl, @logoStorageUrl, @lastVerifiedAt
      )
    `);
    this.updateSupplier = this.db.prepare(`
      UPDATE suppliers SET legal_name=@legalName, trade_name=@tradeName, tax_code=@taxCode, description=@description,
        website=@website, website_domain=@websiteDomain, email=@email, phone=@phone, address=@address,
        province=@province, country=@country, roles_json=@rolesJson, groups_json=@groupsJson,
        environments_json=@environmentsJson, crop_names_json=@cropNamesJson, categories_json=@categoriesJson,
        verified_status=@verifiedStatus, confidence_score=@confidenceScore, logo_original_url=@logoOriginalUrl,
        logo_storage_url=@logoStorageUrl, last_verified_at=@lastVerifiedAt, updated_at=@updatedAt WHERE id=@id
    `);
    this.insertProduct = this.db.prepare(`
      INSERT INTO products (supplier_id, name, product_group, category, description, product_url, environments_json,
        crop_names_json, image_original_url, image_storage_url)
      VALUES (@supplierId, @name, @productGroup, @category, @description, @productUrl, @environmentsJson,
        @cropNamesJson, @imageOriginalUrl, @imageStorageUrl)
      ON CONFLICT(supplier_id, name, product_url) DO UPDATE SET
        product_group=excluded.product_group, category=excluded.category, description=excluded.description,
        environments_json=excluded.environments_json, crop_names_json=excluded.crop_names_json,
        image_original_url=coalesce(excluded.image_original_url, products.image_original_url),
        image_storage_url=coalesce(excluded.image_storage_url, products.image_storage_url), updated_at=CURRENT_TIMESTAMP
      RETURNING id
    `);
    this.insertEvidence = this.db.prepare(`
      INSERT INTO source_evidence (supplier_id, product_id, source_name, source_type, source_url, source_record_id,
        raw_json, raw_storage_key, content_hash, confidence_score)
      VALUES (@supplierId, @productId, @sourceName, @sourceType, @sourceUrl, @sourceRecordId,
        @rawJson, @rawStorageKey, @contentHash, @confidenceScore)
      ON CONFLICT(source_name, source_url, source_record_id) DO UPDATE SET
        supplier_id=excluded.supplier_id, product_id=excluded.product_id, raw_json=excluded.raw_json,
        raw_storage_key=excluded.raw_storage_key, content_hash=excluded.content_hash,
        confidence_score=excluded.confidence_score, last_checked_at=CURRENT_TIMESTAMP
    `);
    this.insertImage = this.db.prepare(`
      INSERT INTO images (supplier_id, product_id, image_type, original_url, source_page_url, source_name,
        storage_key, storage_url, content_hash, mime_type, byte_size)
      VALUES (@supplierId, @productId, @imageType, @originalUrl, @sourcePageUrl, @sourceName,
        @storageKey, @storageUrl, @contentHash, @mimeType, @byteSize)
      ON CONFLICT(content_hash, image_type) DO UPDATE SET
        supplier_id=coalesce(images.supplier_id, excluded.supplier_id),
        product_id=coalesce(images.product_id, excluded.product_id), storage_url=excluded.storage_url
      RETURNING id
    `);
  }

  normalizeSupplier(input) {
    const legalName = normalizeCompanyName(input.legalName || input.name || '');
    const website = normalizeWebsite(input.website, input.sourceUrl);
    const province = normalizeProvince(input.province || input.address);
    return {
      legalName,
      normalizedName: comparisonCompanyName(legalName),
      tradeName: input.tradeName || null,
      slug: slug(legalName),
      taxCode: input.taxCode ? String(input.taxCode).replace(/\D/g, '') : null,
      description: input.description || null,
      website,
      websiteDomain: websiteDomain(website),
      email: normalizeEmail(input.email),
      phone: normalizePhone(input.phone),
      address: input.address || null,
      province,
      country: input.country || 'Vietnam',
      rolesJson: JSON.stringify(uniq(asArray(input.roles))),
      groupsJson: JSON.stringify(uniq(asArray(input.groups))),
      environmentsJson: JSON.stringify(uniq(asArray(input.environments))),
      cropNamesJson: JSON.stringify(uniq(asArray(input.cropNames))),
      categoriesJson: JSON.stringify(uniq(asArray(input.categories))),
      verifiedStatus: input.verifiedStatus || 'UNVERIFIED',
      confidenceScore: Number(input.confidenceScore || 0.3),
      logoOriginalUrl: input.logoOriginalUrl || null,
      logoStorageUrl: input.logoStorageUrl || null,
      lastVerifiedAt: input.lastVerifiedAt || null,
    };
  }

  findDuplicate(supplier) {
    if (supplier.taxCode) {
      const found = this.findByTax.get(supplier.taxCode); if (found) return { row: found, score: 1 };
    }
    if (supplier.websiteDomain) {
      const found = this.findByDomain.get(supplier.websiteDomain); if (found) return { row: found, score: 0.95 };
    }
    for (const email of supplier.email.split(',').filter(Boolean)) {
      const found = this.findByEmail.get(email); if (found) return { row: found, score: 0.9 };
    }
    for (const phone of supplier.phone.split(',').filter(Boolean)) {
      const found = this.findByPhone.get(phone); if (found) return { row: found, score: 0.9 };
    }
    if (supplier.normalizedName) {
      const found = this.findByNameProvince.get(supplier.normalizedName, supplier.province);
      if (found) return { row: found, score: 0.75 };
    }
    return null;
  }

  upsertSupplier(input) {
    const supplier = this.normalizeSupplier(input);
    if (!supplier.legalName || supplier.legalName.length < 2) return { id: null, action: 'skipped' };
    const duplicate = this.findDuplicate(supplier);
    if (!duplicate) {
      let uniqueSlug = supplier.slug;
      let suffix = 1;
      while (this.db.prepare('SELECT 1 FROM suppliers WHERE slug=?').get(uniqueSlug)) uniqueSlug = `${supplier.slug}-${++suffix}`;
      const result = this.insertSupplier.run({ ...supplier, slug: uniqueSlug });
      return { id: Number(result.lastInsertRowid), action: 'inserted' };
    }
    const old = duplicate.row;
    const merged = {
      ...supplier,
      id: old.id,
      legalName: old.legal_name || supplier.legalName,
      tradeName: supplier.tradeName || old.trade_name,
      taxCode: supplier.taxCode || old.tax_code,
      description: supplier.description || old.description,
      website: supplier.website || old.website,
      websiteDomain: supplier.websiteDomain || old.website_domain,
      email: uniq([...(old.email || '').split(','), ...supplier.email.split(',')]).join(','),
      phone: uniq([...(old.phone || '').split(','), ...supplier.phone.split(',')]).join(','),
      address: supplier.address || old.address,
      province: supplier.province || old.province,
      country: supplier.country || old.country,
      rolesJson: mergeJson(old.roles_json, JSON.parse(supplier.rolesJson)),
      groupsJson: mergeJson(old.groups_json, JSON.parse(supplier.groupsJson)),
      environmentsJson: mergeJson(old.environments_json, JSON.parse(supplier.environmentsJson)),
      cropNamesJson: mergeJson(old.crop_names_json, JSON.parse(supplier.cropNamesJson)),
      categoriesJson: mergeJson(old.categories_json, JSON.parse(supplier.categoriesJson)),
      verifiedStatus: old.verified_status === 'OFFICIAL_SOURCE_VERIFIED' ? old.verified_status : supplier.verifiedStatus,
      confidenceScore: Math.max(Number(old.confidence_score || 0), supplier.confidenceScore, duplicate.score),
      logoOriginalUrl: supplier.logoOriginalUrl || old.logo_original_url,
      logoStorageUrl: supplier.logoStorageUrl || old.logo_storage_url,
      lastVerifiedAt: supplier.lastVerifiedAt || old.last_verified_at,
      updatedAt: now(),
    };
    this.updateSupplier.run(merged);
    return { id: old.id, action: 'updated' };
  }

  saveRecord(record) {
    return this.db.transaction((value) => {
      const result = this.upsertSupplier(value.supplier);
      if (!result.id) return result;
      let productId = null;
      if (value.product?.name) {
        const product = value.product;
        const row = this.insertProduct.get({
          supplierId: result.id, name: product.name, productGroup: product.productGroup || null,
          category: product.category || null, description: product.description || null,
          productUrl: normalizeWebsite(product.productUrl, value.evidence?.sourceUrl) || '',
          environmentsJson: JSON.stringify(uniq(asArray(product.environments))),
          cropNamesJson: JSON.stringify(uniq(asArray(product.cropNames))),
          imageOriginalUrl: product.imageOriginalUrl || null, imageStorageUrl: product.imageStorageUrl || null,
        });
        productId = row?.id || null;
      }
      if (value.evidence) this.insertEvidence.run({
        supplierId: result.id, productId, sourceName: value.evidence.sourceName,
        sourceType: value.evidence.sourceType || 'OTHER', sourceUrl: value.evidence.sourceUrl,
        sourceRecordId: value.evidence.sourceRecordId || '', rawJson: JSON.stringify(value.evidence.raw || value),
        rawStorageKey: value.evidence.rawStorageKey || null, contentHash: value.evidence.contentHash || null,
        confidenceScore: Number(value.evidence.confidenceScore || value.supplier.confidenceScore || 0.3),
      });
      return { ...result, productId };
    })(record);
  }

  saveImage(image) {
    const row = this.insertImage.get(image);
    if (image.supplierId && image.imageType === 'LOGO') {
      this.db.prepare('UPDATE suppliers SET logo_original_url=?, logo_storage_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(image.originalUrl, image.storageUrl, image.supplierId);
    }
    return row?.id;
  }

  startRun(sourceName) {
    const result = this.db.prepare('INSERT INTO crawl_runs(source_name) VALUES (?)').run(sourceName);
    return Number(result.lastInsertRowid);
  }

  finishRun(id, stats, error = null) {
    this.db.prepare(`UPDATE crawl_runs SET status=?, finished_at=CURRENT_TIMESTAMP, pages=?, found=?, inserted=?,
      updated=?, skipped=?, failed=?, error_message=? WHERE id=?`).run(
      error ? (stats.found ? 'PARTIAL' : 'FAILED') : 'COMPLETED', stats.pages, stats.found, stats.inserted,
      stats.updated, stats.skipped, stats.failed, error ? String(error.message || error).slice(0, 2000) : null, id,
    );
  }

  listSuppliers(filters = {}) {
    const where = []; const params = {};
    if (filters.search) { where.push('(legal_name LIKE @search OR description LIKE @search OR address LIKE @search)'); params.search = `%${filters.search}%`; }
    if (filters.province) { where.push('province = @province'); params.province = normalizeProvince(filters.province); }
    if (filters.group) { where.push('groups_json LIKE @group'); params.group = `%${String(filters.group).toUpperCase()}%`; }
    if (filters.environment) { where.push('environments_json LIKE @environment'); params.environment = `%${String(filters.environment).toUpperCase()}%`; }
    if (filters.crop) { where.push('crop_names_json LIKE @crop'); params.crop = `%${filters.crop}%`; }
    const limit = Math.min(100, Math.max(1, Number(filters.limit || 20)));
    const page = Math.max(1, Number(filters.page || 1)); params.limit = limit; params.offset = (page - 1) * limit;
    const sql = `SELECT * FROM suppliers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all(params).map(this.formatSupplier);
    return { page, limit, items: rows };
  }

  getSupplier(id) {
    const supplier = this.db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
    if (!supplier) return null;
    return {
      ...this.formatSupplier(supplier),
      products: this.db.prepare('SELECT * FROM products WHERE supplier_id=? ORDER BY id DESC').all(id).map((row) => ({
        ...row, environments: parseArray(row.environments_json), cropNames: parseArray(row.crop_names_json),
      })),
      sources: this.db.prepare('SELECT source_name, source_type, source_url, confidence_score, retrieved_at, last_checked_at FROM source_evidence WHERE supplier_id=? ORDER BY last_checked_at DESC').all(id),
      images: this.db.prepare('SELECT image_type, original_url, storage_url, mime_type, byte_size, source_page_url FROM images WHERE supplier_id=? ORDER BY id DESC').all(id),
    };
  }

  formatSupplier(row) {
    return {
      id: row.id, legalName: row.legal_name, tradeName: row.trade_name, slug: row.slug, taxCode: row.tax_code,
      description: row.description, website: row.website, email: row.email, phone: row.phone, address: row.address,
      province: row.province, country: row.country, roles: parseArray(row.roles_json), groups: parseArray(row.groups_json),
      environments: parseArray(row.environments_json), cropNames: parseArray(row.crop_names_json),
      categories: parseArray(row.categories_json), verifiedStatus: row.verified_status,
      confidenceScore: row.confidence_score, logoOriginalUrl: row.logo_original_url,
      logoStorageUrl: row.logo_storage_url, lastVerifiedAt: row.last_verified_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  recentRuns(limit = 20) { return this.db.prepare('SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?').all(Math.min(100, Number(limit))); }
  suppliersWithoutStoredLogo(limit = 100) { return this.db.prepare("SELECT * FROM suppliers WHERE website IS NOT NULL AND website <> '' AND logo_storage_url IS NULL LIMIT ?").all(limit); }
  close() { this.db.close(); }
}

module.exports = { Store, SCHEMA };
