'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCompanyName, comparisonCompanyName, normalizePhone, normalizeEmail,
  normalizeWebsite, normalizeProvince, classify, assertSafeHttpUrl,
} = require('../src/core');

test('normalizes supplier identity fields', () => {
  assert.equal(normalizeCompanyName('  CÔNG TY TNHH ABC  '), 'CÔNG TY TNHH ABC');
  assert.equal(comparisonCompanyName('Công ty TNHH Nông Nghiệp ABC Việt Nam'), 'nong nghiep abc');
  assert.equal(normalizePhone('+84 912 345 678'), '0912345678');
  assert.equal(normalizeEmail('Sales@ABC.VN; invalid'), 'sales@abc.vn');
  assert.equal(normalizeWebsite('www.abc.vn/?utm_source=x'), 'https://www.abc.vn');
});

test('maps former provinces to the current provincial-level unit', () => {
  assert.equal(normalizeProvince('Bình Dương'), 'Thành phố Hồ Chí Minh');
  assert.equal(normalizeProvince('Bình Định'), 'Gia Lai');
  assert.equal(normalizeProvince('Long An'), 'Tây Ninh');
});

test('classifies seeds, equipment environments and fertilizer categories', () => {
  const seed = classify('Hạt giống cà chua F1 chất lượng cao');
  assert.ok(seed.groups.includes('SEED'));
  assert.ok(seed.cropNames.includes('Cà chua'));

  const equipment = classify('Grow light và hệ thống HVAC cho vertical farm indoor');
  assert.ok(equipment.groups.includes('EQUIPMENT'));
  assert.ok(equipment.environments.includes('INDOOR'));

  const fertilizer = classify('Phân bón hữu cơ vi sinh NPK cho cây cà phê');
  assert.ok(fertilizer.groups.includes('FERTILIZER'));
  assert.ok(fertilizer.categories.includes('NPK'));
  assert.ok(fertilizer.categories.includes('ORGANIC_MICROBIOLOGICAL'));
  assert.ok(fertilizer.cropNames.includes('Cà phê'));
});

test('blocks localhost and private IP URLs', () => {
  assert.throws(() => assertSafeHttpUrl('http://127.0.0.1/a'), /Private network/);
  assert.throws(() => assertSafeHttpUrl('http://192.168.1.10/a'), /Private network/);
  assert.equal(assertSafeHttpUrl('https://example.com/a').hostname, 'example.com');
});
