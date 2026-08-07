'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectMime, logoCandidates } = require('../src/images');

test('detects PNG by magic bytes rather than extension', () => {
  const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.equal(detectMime(buffer, 'text/plain'), 'image/png');
});

test('extracts structured-data logo before favicon', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Organization","logo":"/brand.png"}</script>
    <link rel="icon" href="/favicon.ico">
  </head></html>`;
  const candidates = logoCandidates(html, 'https://supplier.vn/about');
  assert.equal(candidates[0].url, 'https://supplier.vn/brand.png');
  assert.equal(candidates[0].type, 'LOGO');
});
