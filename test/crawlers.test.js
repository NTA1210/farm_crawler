'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgriVietnamCrawler, YellowPagesCrawler } = require('../src/crawlers');
const { isTargetRecord } = require('../src/policy');

test('parses an Agri Vietnam exhibitor table and retains only in-scope Vietnam suppliers', async () => {
  const html = `
    <table>
      <tr><th>Company Name</th><th>Product/Profile</th><th>Country</th><th>Booth No</th></tr>
      <tr><td><img src="/logos/farm.png"> FARM VN CO., LTD.</td><td>Organic fertilizer and NPK</td><td>VIETNAM</td><td>A10</td></tr>
      <tr><td>FOREIGN IRRIGATION LTD.</td><td>Drip irrigation and greenhouse equipment</td><td>INDIA</td><td>A11</td></tr>
      <tr><td>FOOD VN CO., LTD.</td><td>Dried fruit snacks</td><td>VIETNAM</td><td>A12</td></tr>
    </table>`;
  const crawler = new AgriVietnamCrawler({ name: 'agri-vietnam', type: 'EXHIBITION' });
  const parsed = await crawler.parsePage({
    url: 'https://agri.example/exhibitors', body: Buffer.from(html), rawStorageKey: 'raw/test.html',
  });
  assert.equal(parsed.records.length, 3);
  const accepted = parsed.records.filter((record) => isTargetRecord(record, { vietnamOnly: true }));
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].supplier.legalName, 'FARM VN CO., LTD.');
  assert.ok(accepted[0].supplier.groups.includes('FERTILIZER'));
  assert.equal(accepted[0].supplier.logoOriginalUrl, 'https://agri.example/logos/farm.png');
});

test('parses a Yellow Pages supplier card with configured equipment scope', async () => {
  const html = `
    <article class="company-item">
      <h3 class="company-name">CÔNG TY TNHH NHÀ KÍNH ABC</h3>
      <div class="address">Đà Lạt, Lâm Đồng</div>
      <p class="description">Thi công nhà kính, cooling pad và hệ thống tưới nhỏ giọt.</p>
      <a class="website" href="https://nhakinhabc.vn">Website</a>
      <img src="/images/abc-logo.png" alt="ABC logo">
    </article>`;
  const crawler = new YellowPagesCrawler({
    name: 'yellow-pages-greenhouse', type: 'BUSINESS_DIRECTORY',
    options: { hintGroup: 'EQUIPMENT', category: 'GREENHOUSE', defaultEnvironment: 'GREENHOUSE' },
  });
  const parsed = await crawler.parsePage({
    url: 'https://yellow.example/list', body: Buffer.from(html), rawStorageKey: 'raw/yellow.html',
  });
  assert.equal(parsed.records.length, 1);
  const record = parsed.records[0];
  assert.ok(record.supplier.groups.includes('EQUIPMENT'));
  assert.ok(record.supplier.environments.includes('GREENHOUSE'));
  assert.equal(record.supplier.province, 'Lâm Đồng');
  assert.equal(record.supplier.logoOriginalUrl, 'https://yellow.example/images/abc-logo.png');
});
