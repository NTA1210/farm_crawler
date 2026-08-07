'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/db');

/**
 * Build an isolated database name so the test never touches development data.
 *
 * @returns {string} Unique MongoDB database name.
 */
function testDatabaseName() {
  return `farm_crawler_test_${process.pid}_${Date.now()}`;
}

test('stores evidence and merges suppliers by normalized website domain', async (context) => {
  const mongoUri = process.env.TEST_MONGODB_URI
    || process.env.MONGODB_URI
    || 'mongodb://127.0.0.1:27017';
  const store = await Store.connect({
    uri: mongoUri,
    dbName: testDatabaseName(),
    serverSelectionTimeoutMs: 10000,
    maxPoolSize: 2,
    autoIndex: true,
  });

  context.after(async () => {
    await store.dropDatabase();
    await store.close();
  });

  const first = await store.saveRecord({
    supplier: {
      legalName: 'Công ty TNHH Nông nghiệp ABC',
      website: 'https://abc.vn',
      province: 'Lâm Đồng',
      groups: ['SEED'],
      cropNames: ['Cà chua'],
    },
    product: {
      name: 'Hạt giống cà chua F1',
      productGroup: 'SEED',
      cropNames: ['Cà chua'],
    },
    evidence: {
      sourceName: 'fixture-a',
      sourceType: 'BUSINESS_DIRECTORY',
      sourceUrl: 'https://source.example/supplier/1',
      sourceRecordId: '1',
    },
  });
  assert.equal(first.action, 'inserted');
  assert.match(first.id, /^[a-f\d]{24}$/i);

  const second = await store.saveRecord({
    supplier: {
      legalName: 'ABC Agriculture Company',
      website: 'https://www.abc.vn/about',
      phone: '+84 912 345 678',
      groups: ['EQUIPMENT'],
      environments: ['GREENHOUSE'],
    },
    evidence: {
      sourceName: 'fixture-b',
      sourceType: 'EXHIBITION',
      sourceUrl: 'https://source.example/exhibitor/abc',
      sourceRecordId: 'abc',
    },
  });
  assert.equal(second.action, 'updated');
  assert.equal(second.id, first.id);

  const list = await store.listSuppliers({ limit: 10 });
  assert.equal(list.items.length, 1);
  assert.equal(list.total, 1);
  assert.deepEqual(new Set(list.items[0].groups), new Set(['SEED', 'EQUIPMENT']));
  assert.equal(list.items[0].phone, '0912345678');
  assert.deepEqual(list.items[0].phones, ['0912345678']);

  const detail = await store.getSupplier(first.id);
  assert.equal(detail.products.length, 1);
  assert.equal(detail.sources.length, 2);
  assert.ok(detail.environments.includes('GREENHOUSE'));
});
