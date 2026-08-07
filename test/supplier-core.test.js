'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { mapOfficialRow } = require('../src/crawler/utils');
const { hasCoreSupplier, isTargetRecord } = require('../src/policy');
const { createProductModel } = require('../src/models/product.model');
const { createSourceEvidenceModel } = require('../src/models/source-evidence.model');
const { createImageModel } = require('../src/models/image.model');
const { createSwaggerSpec } = require('../src/swagger');

/** Build the source context shared by official-row parser tests. */
function officialContext(index = 1) {
  return {
    name: 'ppd-seeds',
    type: 'OFFICIAL_REGISTRY',
    url: 'https://ppd.example/seed-registry',
    rawStorageKey: 'raw/ppd/test.html',
    index,
  };
}

test('official product row without an explicit supplier column is skipped', () => {
  const row = {
    headers: ['stt', 'ten giong', 'quyet dinh'],
    cells: ['1', 'Cà chua Ruby F1', '123/QĐ-TT'],
  };

  assert.equal(mapOfficialRow(row, 'SEED', officialContext()), null);
});

test('official product row is accepted only when a supplier is present', () => {
  const row = {
    headers: ['stt', 'ten giong', 'don vi dang ky', 'quyet dinh'],
    cells: ['1', 'Cà chua Ruby F1', 'Công ty TNHH Giống cây ABC', '123/QĐ-TT'],
  };

  const record = mapOfficialRow(row, 'SEED', officialContext());
  assert.equal(record.supplier.legalName, 'Công ty TNHH Giống cây ABC');
  assert.equal(record.product.name, 'Cà chua Ruby F1');
  assert.equal(record.product.productGroup, 'SEED');
});

test('policy rejects product-only and placeholder-supplier records', () => {
  assert.equal(hasCoreSupplier({ product: { name: 'NPK 16-16-8' } }), false);
  assert.equal(isTargetRecord({
    supplier: { legalName: 'Unknown Supplier', country: 'Vietnam', groups: ['FERTILIZER'] },
    product: { name: 'NPK 16-16-8' },
  }, { vietnamOnly: true }), false);
});

test('Mongoose child models require supplierId', async () => {
  const connection = mongoose.createConnection();
  const Product = createProductModel(connection);
  const SourceEvidence = createSourceEvidenceModel(connection);
  const Image = createImageModel(connection);

  await assert.rejects(
    new Product({ name: 'Hạt giống cà chua', productGroup: 'SEED' }).validate(),
    /supplierId/i,
  );
  await assert.rejects(
    new SourceEvidence({
      sourceName: 'fixture',
      sourceUrl: 'https://source.example/1',
    }).validate(),
    /supplierId/i,
  );
  await assert.rejects(
    new Image({
      imageType: 'LOGO',
      originalUrl: 'https://source.example/logo.png',
      contentHash: 'abc',
    }).validate(),
    /supplierId/i,
  );

  await connection.destroy();
});

test('OpenAPI marks every supplier child resource as supplier-rooted', () => {
  const specification = createSwaggerSpec({
    env: 'test',
    swagger: { serverUrl: 'http://localhost:3000' },
  });

  for (const schemaName of ['Product', 'SourceEvidence', 'Image']) {
    assert.ok(
      specification.components.schemas[schemaName].required.includes('supplierId'),
      `${schemaName} must require supplierId`,
    );
  }
});
