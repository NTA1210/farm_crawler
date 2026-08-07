'use strict';

const { createSupplierModel } = require('./supplier.model');
const { createProductModel } = require('./product.model');
const { createSourceEvidenceModel } = require('./source-evidence.model');
const { createImageModel } = require('./image.model');
const { createCrawlRunModel } = require('./crawl-run.model');

/**
 * Register every application model on one MongoDB connection.
 *
 * Keeping registration in one function makes the database layer easy to test
 * and ensures all refs (`Supplier`, `Product`, and related collections) resolve
 * on the same Mongoose connection.
 *
 * @param {import('mongoose').Connection} connection Active MongoDB connection.
 * @returns {{Supplier: import('mongoose').Model, Product: import('mongoose').Model, SourceEvidence: import('mongoose').Model, Image: import('mongoose').Model, CrawlRun: import('mongoose').Model}}
 */
function createModels(connection) {
  return {
    Supplier: createSupplierModel(connection),
    Product: createProductModel(connection),
    SourceEvidence: createSourceEvidenceModel(connection),
    Image: createImageModel(connection),
    CrawlRun: createCrawlRunModel(connection),
  };
}

module.exports = { createModels };
