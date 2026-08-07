'use strict';

const { Schema } = require('mongoose');

/**
 * Convert a Mongoose document to the public JSON shape used by the API.
 * MongoDB keeps `_id` and `__v` internally, while API clients receive a plain
 * string `id` and do not need to know about Mongoose's version field.
 *
 * @param {import('mongoose').Document} _document Original Mongoose document.
 * @param {Record<string, unknown>} returnedObject Mutable serialized object.
 * @returns {Record<string, unknown>} Clean API-friendly object.
 */
function transformDocument(_document, returnedObject) {
  returnedObject.id = returnedObject._id?.toString();
  delete returnedObject._id;
  delete returnedObject.__v;
  return returnedObject;
}

/**
 * Create the Supplier model on the provided connection.
 *
 * Supplier is the aggregate root for products, evidence and images. A factory is
 * used instead of the global `mongoose.model()` registry so tests and CLI commands
 * can create isolated connections without `OverwriteModelError`.
 *
 * @param {import('mongoose').Connection} connection Active MongoDB connection.
 * @returns {import('mongoose').Model} Supplier model bound to the connection.
 */
function createSupplierModel(connection) {
  const supplierSchema = new Schema({
    legalName: { type: String, required: true, trim: true, maxlength: 300 },
    normalizedName: { type: String, required: true, trim: true, maxlength: 300 },
    tradeName: { type: String, default: null, trim: true, maxlength: 300 },
    slug: { type: String, required: true, trim: true, maxlength: 160 },
    taxCode: { type: String, default: null, trim: true, maxlength: 32 },
    description: { type: String, default: null, maxlength: 10000 },
    website: { type: String, default: null, maxlength: 2048 },
    websiteDomain: { type: String, default: null, lowercase: true, trim: true, maxlength: 255 },
    emails: { type: [{ type: String, lowercase: true, trim: true, maxlength: 320 }], default: [] },
    phones: { type: [{ type: String, trim: true, maxlength: 32 }], default: [] },
    address: { type: String, default: null, maxlength: 2000 },
    province: { type: String, default: null, trim: true, maxlength: 120 },
    country: { type: String, default: 'Vietnam', trim: true, maxlength: 120 },
    roles: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
    groups: {
      type: [{ type: String, enum: ['SEED', 'EQUIPMENT', 'FERTILIZER'] }],
      default: [],
    },
    environments: {
      type: [{ type: String, enum: ['INDOOR', 'OUTDOOR', 'GREENHOUSE', 'MULTI_ENVIRONMENT'] }],
      default: [],
    },
    cropNames: { type: [{ type: String, trim: true, maxlength: 160 }], default: [] },
    categories: { type: [{ type: String, trim: true, maxlength: 160 }], default: [] },
    verifiedStatus: {
      type: String,
      enum: ['UNVERIFIED', 'AUTO_VERIFIED', 'OFFICIAL_SOURCE_VERIFIED', 'MANUALLY_VERIFIED', 'INACTIVE'],
      default: 'UNVERIFIED',
    },
    confidenceScore: { type: Number, default: 0.3, min: 0, max: 1 },
    logoOriginalUrl: { type: String, default: null, maxlength: 2048 },
    logoStorageUrl: { type: String, default: null, maxlength: 2048 },
    lastVerifiedAt: { type: Date, default: null },
  }, {
    collection: 'suppliers',
    timestamps: true,
    strict: true,
    toJSON: { transform: transformDocument },
    toObject: { transform: transformDocument },
  });

  // A slug is the stable human-readable identifier used in URLs and exports.
  supplierSchema.index({ slug: 1 }, { unique: true, name: 'supplier_slug_unique' });

  // A real tax code identifies a single legal entity. Null values are excluded
  // so MongoDB can still store suppliers whose tax code has not been found yet.
  supplierSchema.index(
    { taxCode: 1 },
    {
      unique: true,
      name: 'supplier_tax_code_unique',
      partialFilterExpression: { taxCode: { $type: 'string' } },
    },
  );

  // Lookup indexes support the deduplication order used by the Store class.
  supplierSchema.index({ websiteDomain: 1 }, { name: 'supplier_website_domain' });
  supplierSchema.index({ emails: 1 }, { name: 'supplier_emails' });
  supplierSchema.index({ phones: 1 }, { name: 'supplier_phones' });
  supplierSchema.index({ normalizedName: 1, province: 1 }, { name: 'supplier_name_province' });

  // MongoDB cannot create one compound index containing two array fields because
  // that would be a parallel-arrays multikey index. Separate indexes support the
  // same API filters safely.
  supplierSchema.index({ province: 1, groups: 1 }, { name: 'supplier_province_groups' });
  supplierSchema.index({ province: 1, environments: 1 }, { name: 'supplier_province_environments' });
  supplierSchema.index({ cropNames: 1 }, { name: 'supplier_crop_names' });
  supplierSchema.index({ updatedAt: -1 }, { name: 'supplier_updated_at' });

  // The text index helps search endpoints without changing the schema.
  supplierSchema.index(
    { legalName: 'text', tradeName: 'text', description: 'text', address: 'text' },
    { name: 'supplier_text_search', default_language: 'none' },
  );

  return connection.model('Supplier', supplierSchema);
}

module.exports = { createSupplierModel };
