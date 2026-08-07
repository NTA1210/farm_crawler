'use strict';

const { Schema } = require('mongoose');

/** Read supplierId from a Mongoose update payload. */
function supplierIdFromUpdate(update) {
  return update?.$set?.supplierId
    ?? update?.$setOnInsert?.supplierId
    ?? update?.supplierId;
}

/**
 * Create the SourceEvidence model that keeps traceability for every crawled row.
 *
 * Supplier is the root entity of this project. Evidence is therefore never stored
 * as an orphan: every evidence document must reference an existing Supplier. A
 * product reference remains optional because a source may describe only a company.
 *
 * @param {import('mongoose').Connection} connection Active MongoDB connection.
 * @returns {import('mongoose').Model} SourceEvidence model.
 */
function createSourceEvidenceModel(connection) {
  const sourceEvidenceSchema = new Schema({
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      index: true,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
      index: true,
    },
    sourceName: { type: String, required: true, trim: true, maxlength: 120 },
    sourceType: {
      type: String,
      enum: ['OFFICIAL_REGISTRY', 'BUSINESS_DIRECTORY', 'EXHIBITION', 'COMPANY_WEBSITE', 'OTHER'],
      default: 'OTHER',
    },
    sourceUrl: { type: String, required: true, maxlength: 2048 },
    sourceRecordId: { type: String, default: '', maxlength: 2048 },
    raw: { type: Schema.Types.Mixed, default: null },
    rawStorageKey: { type: String, default: null, maxlength: 2048 },
    contentHash: { type: String, default: null, maxlength: 128 },
    confidenceScore: { type: Number, default: 0.3, min: 0, max: 1 },
    retrievedAt: { type: Date, default: Date.now },
    lastCheckedAt: { type: Date, default: Date.now },
  }, {
    collection: 'source_evidence',
    timestamps: true,
    strict: true,
  });

  // Query middleware makes the aggregate-root rule hold for all upserts, even if
  // a future caller omits `runValidators`. It also scopes the query to supplierId,
  // preventing evidence from one supplier being reassigned to another supplier.
  sourceEvidenceSchema.pre('findOneAndUpdate', function validateSupplierRoot() {
    this.setOptions({ runValidators: true, context: 'query' });
    const supplierId = supplierIdFromUpdate(this.getUpdate());
    if (!supplierId) {
      throw new Error('SourceEvidence requires supplierId because Supplier is the core entity');
    }
    this.setQuery({ ...this.getQuery(), supplierId });
  });

  sourceEvidenceSchema.index(
    { supplierId: 1, sourceName: 1, sourceUrl: 1, sourceRecordId: 1 },
    { unique: true, name: 'source_evidence_supplier_identity_unique' },
  );
  sourceEvidenceSchema.index(
    { supplierId: 1, lastCheckedAt: -1 },
    { name: 'source_evidence_supplier' },
  );

  return connection.model('SourceEvidence', sourceEvidenceSchema);
}

module.exports = { createSourceEvidenceModel, supplierIdFromUpdate };
