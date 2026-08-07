'use strict';

const { Schema } = require('mongoose');

/** Read supplierId from a Mongoose update payload. */
function supplierIdFromUpdate(update) {
  return update?.$set?.supplierId
    ?? update?.$setOnInsert?.supplierId
    ?? update?.supplierId;
}

/**
 * Create the Image model for provider logos, favicons and product images.
 *
 * Supplier remains the root entity even for a product image. Requiring supplierId
 * prevents unassigned binary metadata from entering MongoDB and keeps every image
 * reachable from a supplier detail response.
 *
 * @param {import('mongoose').Connection} connection Active MongoDB connection.
 * @returns {import('mongoose').Model} Image model bound to the connection.
 */
function createImageModel(connection) {
  const imageSchema = new Schema({
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
    imageType: {
      type: String,
      enum: ['LOGO', 'FAVICON', 'PRODUCT', 'COMPANY_BANNER', 'UNKNOWN'],
      required: true,
    },
    originalUrl: { type: String, required: true, maxlength: 2048 },
    sourcePageUrl: { type: String, default: null, maxlength: 2048 },
    sourceName: { type: String, default: 'unknown', trim: true, maxlength: 120 },
    storageKey: { type: String, default: null, maxlength: 2048 },
    storageUrl: { type: String, default: null, maxlength: 2048 },
    contentHash: { type: String, required: true, maxlength: 128 },
    mimeType: { type: String, default: null, maxlength: 120 },
    byteSize: { type: Number, default: null, min: 0 },
  }, {
    collection: 'images',
    timestamps: true,
    strict: true,
  });

  imageSchema.pre('findOneAndUpdate', function validateSupplierRoot() {
    this.setOptions({ runValidators: true, context: 'query' });
    const supplierId = supplierIdFromUpdate(this.getUpdate());
    if (!supplierId) {
      throw new Error('Image requires supplierId because Supplier is the core entity');
    }
    // Scope the original query to the supplier so equal image bytes used by two
    // companies create two ownership/provenance records instead of reassigning one.
    this.setQuery({ ...this.getQuery(), supplierId });
  });

  imageSchema.index(
    { supplierId: 1, contentHash: 1, imageType: 1 },
    { unique: true, name: 'image_supplier_hash_type_unique' },
  );

  return connection.model('Image', imageSchema);
}

module.exports = { createImageModel, supplierIdFromUpdate };
