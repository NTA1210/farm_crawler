'use strict';

const { Schema } = require('mongoose');

/**
 * Read supplierId from a direct document/update payload.
 *
 * @param {Record<string, any>|null|undefined} update Mongoose update payload.
 * @returns {unknown} Candidate supplier identifier.
 */
function supplierIdFromUpdate(update) {
  return update?.$set?.supplierId
    ?? update?.$setOnInsert?.supplierId
    ?? update?.supplierId;
}

/**
 * Create the Product model used for products/services discovered for a supplier.
 *
 * Product is a child of Supplier, never an independent aggregate. The schema and
 * query middleware both reject orphan products, including upserts where Mongoose
 * validators could otherwise be skipped accidentally.
 *
 * @param {import('mongoose').Connection} connection Active MongoDB connection.
 * @returns {import('mongoose').Model} Product model bound to the connection.
 */
function createProductModel(connection) {
  const productSchema = new Schema({
    supplierId: {
      type: Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 500 },
    productGroup: {
      type: String,
      enum: ['SEED', 'EQUIPMENT', 'FERTILIZER', null],
      default: null,
    },
    category: { type: String, default: null, trim: true, maxlength: 200 },
    description: { type: String, default: null, maxlength: 10000 },
    productUrl: { type: String, default: '', maxlength: 2048 },
    environments: {
      type: [{ type: String, enum: ['INDOOR', 'OUTDOOR', 'GREENHOUSE', 'MULTI_ENVIRONMENT'] }],
      default: [],
    },
    cropNames: { type: [{ type: String, trim: true, maxlength: 160 }], default: [] },
    imageOriginalUrl: { type: String, default: null, maxlength: 2048 },
    imageStorageUrl: { type: String, default: null, maxlength: 2048 },
  }, {
    collection: 'products',
    timestamps: true,
    strict: true,
  });

  // Upserts must carry a supplier even when a caller forgets `runValidators`.
  productSchema.pre('findOneAndUpdate', function validateSupplierRoot() {
    this.setOptions({ runValidators: true, context: 'query' });
    if (!supplierIdFromUpdate(this.getUpdate())) {
      throw new Error('Product requires supplierId because Supplier is the core entity');
    }
  });

  // The same supplier/product/source URL combination is updated rather than
  // duplicated every time a scheduled crawl revisits the source page.
  productSchema.index(
    { supplierId: 1, name: 1, productUrl: 1 },
    { unique: true, name: 'product_supplier_name_url_unique' },
  );
  productSchema.index(
    { productGroup: 1, environments: 1, cropNames: 1 },
    { name: 'product_filters' },
  );

  return connection.model('Product', productSchema);
}

module.exports = { createProductModel, supplierIdFromUpdate };
