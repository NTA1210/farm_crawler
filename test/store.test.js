'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/db');

test('stores evidence and merges suppliers by normalized website domain', () => {
  const store = new Store(':memory:');
  try {
    const first = store.saveRecord({
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

    const second = store.saveRecord({
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

    const list = store.listSuppliers({ limit: 10 });
    assert.equal(list.items.length, 1);
    assert.deepEqual(new Set(list.items[0].groups), new Set(['SEED', 'EQUIPMENT']));
    assert.equal(list.items[0].phone, '0912345678');

    const detail = store.getSupplier(first.id);
    assert.equal(detail.products.length, 1);
    assert.equal(detail.sources.length, 2);
    assert.ok(detail.environments.includes('GREENHOUSE'));
  } finally {
    store.close();
  }
});
