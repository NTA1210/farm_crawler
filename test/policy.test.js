'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTargetRecord, isVietnamCountry, hasCoreSupplier } = require('../src/policy');

test('accepts named target agriculture suppliers from Vietnam', () => {
  assert.equal(isVietnamCountry('VIETNAM'), true);
  assert.equal(isVietnamCountry('Việt Nam'), true);
  assert.equal(isVietnamCountry('Hà Lan / Việt Nam'), true);

  assert.equal(isTargetRecord({
    supplier: {
      legalName: 'Công ty Phân bón Việt Nam',
      country: 'VIETNAM',
      groups: ['FERTILIZER'],
    },
  }, { vietnamOnly: true }), true);

  assert.equal(isTargetRecord({
    supplier: {
      legalName: 'Công ty Thiết bị Nông nghiệp ABC',
      country: 'VIETNAM',
      groups: ['EQUIPMENT'],
    },
  }, { vietnamOnly: true }), true);
});

test('filters supplier-less, unrelated, placeholder and foreign-only records', () => {
  assert.equal(hasCoreSupplier({ product: { name: 'NPK 16-16-8' } }), false);

  assert.equal(isTargetRecord({
    supplier: { legalName: 'Công ty Thực phẩm ABC', country: 'VIETNAM', groups: [] },
  }, { vietnamOnly: true }), false);

  assert.equal(isTargetRecord({
    supplier: { legalName: 'Unknown Supplier', country: 'VIETNAM', groups: ['FERTILIZER'] },
  }, { vietnamOnly: true }), false);

  assert.equal(isTargetRecord({
    supplier: { legalName: 'India Fertilizer Ltd.', country: 'INDIA', groups: ['FERTILIZER'] },
  }, { vietnamOnly: true }), false);

  assert.equal(isTargetRecord({
    supplier: { legalName: 'India Fertilizer Ltd.', country: 'INDIA', groups: ['FERTILIZER'] },
  }, { vietnamOnly: false }), true);
});
