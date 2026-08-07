'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTargetRecord, isVietnamCountry } = require('../src/policy');

test('accepts target agriculture supplier groups from Vietnam', () => {
  assert.equal(isVietnamCountry('VIETNAM'), true);
  assert.equal(isVietnamCountry('Việt Nam'), true);
  assert.equal(isVietnamCountry('Hà Lan / Việt Nam'), true);
  assert.equal(isTargetRecord({ supplier: { country: 'VIETNAM', groups: ['FERTILIZER'] } }, { vietnamOnly: true }), true);
  assert.equal(isTargetRecord({ supplier: { country: 'VIETNAM', groups: ['EQUIPMENT'] } }, { vietnamOnly: true }), true);
});

test('filters unrelated exhibitors and foreign-only suppliers by default', () => {
  assert.equal(isTargetRecord({ supplier: { country: 'VIETNAM', groups: [] } }, { vietnamOnly: true }), false);
  assert.equal(isTargetRecord({ supplier: { country: 'INDIA', groups: ['FERTILIZER'] } }, { vietnamOnly: true }), false);
  assert.equal(isTargetRecord({ supplier: { country: 'INDIA', groups: ['FERTILIZER'] } }, { vietnamOnly: false }), true);
});
