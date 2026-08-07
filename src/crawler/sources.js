'use strict';

const cheerio = require('cheerio');
const XLSX = require('xlsx');
const { BaseCrawler } = require('./base');
const {
  cleanText,
  normalizeKey,
  normalizeWebsite,
  normalizeProvince,
} = require('../core');
const {
  firstText,
  firstAttr,
  extractEmail,
  extractPhone,
  isLikelyCompany,
  rowsFromTables,
  cellByHeader,
  makeRecord,
  mapOfficialRow,
} = require('./utils');

/**
 * Parse Agri Vietnam-style exhibitor tables and cards.
 */
class ExhibitionCrawler extends BaseCrawler {
  /**
   * @param {{url: string, body: Buffer, rawStorageKey: string}} context Downloaded page.
   * @returns {Promise<{records: any[], nextUrls: string[]}>} Exhibitor records.
   */
  async parsePage({ url, body, rawStorageKey }) {
    const $ = cheerio.load(body.toString('utf8'));
    const records = [];
    const tableRows = rowsFromTables($);

    for (const [index, row] of tableRows.entries()) {
      const fallbackNameIndex = row.cells.length > 1 && /^\d+$/.test(row.cells[0]) ? 1 : 0;
      const name = cellByHeader(
        row,
        ['company', 'exhibitor', 'doanh nghiep', 'don vi', 'ten'],
        fallbackNameIndex,
      );
      if (!isLikelyCompany(name)) continue;

      const description = cellByHeader(
        row,
        ['product', 'san pham', 'description', 'linh vuc'],
        row.cells.length > 2 ? 2 : -1,
      );
      const country = cellByHeader(row, ['country', 'quoc gia'], -1) || 'Vietnam';
      const booth = cellByHeader(row, ['booth', 'gian hang'], -1);
      const href = row.links.map((item) => normalizeWebsite(item, url)).find(Boolean);
      const image = row.images.map((item) => normalizeWebsite(item, url)).find(Boolean);

      records.push(makeRecord({
        sourceName: this.name,
        sourceType: this.type,
        sourceUrl: href || url,
        rawStorageKey,
        raw: { id: `${url}#row-${index + 1}`, cells: row.cells, booth, country },
        confidence: 0.62,
        supplier: {
          legalName: name,
          description,
          country,
          website: href,
          logoOriginalUrl: image,
          roles: ['EXHIBITOR'],
        },
        product: description ? {
          name: description.slice(0, 240),
          description,
          productUrl: href,
        } : null,
      }));
    }

    // Some exhibition pages use cards rather than tables. Cards are parsed only when
    // the table parser found nothing to avoid duplicate records from nested layouts.
    if (!records.length) {
      const selectors = ['.exhibitor-item', '.exhibitor', '.company-item', '.elementor-post', 'article'];
      $(selectors.join(',')).each((index, node) => {
        const root = $(node);
        const name = firstText($, root, ['h2', 'h3', 'h4', '.title', '.company-name', 'strong']);
        if (!isLikelyCompany(name)) return;

        const description = firstText($, root, ['.description', '.content', '.excerpt', 'p']);
        const href = normalizeWebsite(firstAttr($, root, ['a[href]'], 'href'), url);
        const image = normalizeWebsite(
          firstAttr($, root, ['img'], 'src') || firstAttr($, root, ['img'], 'data-src'),
          url,
        );

        records.push(makeRecord({
          sourceName: this.name,
          sourceType: this.type,
          sourceUrl: href || url,
          rawStorageKey,
          raw: { id: `${url}#card-${index + 1}`, text: cleanText(root.text()) },
          confidence: 0.55,
          supplier: {
            legalName: name,
            description,
            website: href,
            logoOriginalUrl: image,
            roles: ['EXHIBITOR'],
          },
          product: description ? {
            name: description.slice(0, 240),
            description,
            productUrl: href,
          } : null,
        }));
      });
    }

    return { records, nextUrls: [] };
  }
}

/**
 * HortEx adapter. It reuses the exhibition parser and additionally discovers links
 * to event-platform exhibitor/floor-plan pages and embedded frames.
 */
class HortexCrawler extends ExhibitionCrawler {
  /**
   * @param {Record<string, any>} context Downloaded page.
   * @returns {Promise<{records: any[], nextUrls: string[]}>} Records and platform URLs.
   */
  async parsePage(context) {
    const base = await super.parsePage(context);
    const $ = cheerio.load(context.body.toString('utf8'));
    const nextUrls = [];

    $('iframe[src],a[href]').each((_, node) => {
      const value = $(node).attr('src') || $(node).attr('href');
      const href = normalizeWebsite(value, context.url);
      if (
        href
        && /exhibitor|floorplan|expoplatform|event/i.test(href)
        && href !== context.url
      ) {
        nextUrls.push(href);
      }
    });

    return {
      records: base.records,
      nextUrls: [...new Set(nextUrls)].slice(0, 10),
    };
  }
}

/**
 * Parser for official PPD HTML tables and XLS/XLSX attachments.
 */
class PpdCrawler extends BaseCrawler {
  /** @param {Record<string, any>} input Crawler dependencies. */
  constructor(input) {
    super(input);
    this.kind = input.options.kind;
  }

  /**
   * Parse every worksheet in an official spreadsheet attachment.
   *
   * @param {Buffer} buffer Workbook bytes.
   * @param {string} url Source URL.
   * @param {string} rawStorageKey Stored raw key.
   * @returns {Record<string, any>[]} Official records.
   */
  recordsFromWorkbook(buffer, url, rawStorageKey) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const records = [];

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
      if (rows.length < 2) continue;

      const headerIndex = rows.findIndex((row) => row.filter((cell) => cleanText(cell)).length >= 2);
      const headers = (rows[headerIndex] || []).map((cell) => normalizeKey(cell));

      for (let index = headerIndex + 1; index < rows.length; index += 1) {
        const cells = rows[index].map((cell) => cleanText(
          cell instanceof Date ? cell.toISOString().slice(0, 10) : cell,
        ));
        if (!cells.some(Boolean)) continue;

        const record = mapOfficialRow({ headers, cells }, this.kind, {
          name: this.name,
          type: this.type,
          url,
          rawStorageKey,
          index: `${sheetName}-${index + 1}`,
        });
        if (record) records.push(record);
      }
    }

    return records;
  }

  /**
   * Parse an official HTML page or spreadsheet attachment.
   *
   * @param {{url: string, body: Buffer, contentType: string, rawStorageKey: string}} context Downloaded response.
   * @returns {Promise<{records: any[], nextUrls: string[]}>} Official records and attachments.
   */
  async parsePage({ url, body, contentType, rawStorageKey }) {
    const isWorkbook = /sheet|excel|spreadsheet|octet-stream/i.test(contentType)
      || /\.xlsx?(?:$|\?)/i.test(url);

    if (isWorkbook) {
      return {
        records: this.recordsFromWorkbook(body, url, rawStorageKey),
        nextUrls: [],
      };
    }

    const $ = cheerio.load(body.toString('utf8'));
    const records = [];

    for (const [index, row] of rowsFromTables($).entries()) {
      const record = mapOfficialRow(row, this.kind, {
        name: this.name,
        type: this.type,
        url,
        rawStorageKey,
        index: index + 1,
      });
      if (record) records.push(record);
    }

    const nextUrls = [];
    $('a[href]').each((_, node) => {
      const href = normalizeWebsite($(node).attr('href'), url);
      const text = normalizeKey($(node).text());
      if (
        href
        && (/\.(xlsx?|csv)(?:$|\?)/i.test(href)
          || /tai ve|download|danh sach|xem them|trang sau/.test(text))
      ) {
        nextUrls.push(href);
      }
    });

    return {
      records,
      nextUrls: [...new Set(nextUrls)].slice(0, 30),
    };
  }
}

/**
 * Vietnam Yellow Pages adapter for supplier cards, tables and pagination.
 */
class YellowPagesCrawler extends BaseCrawler {
  /**
   * @param {{url: string, body: Buffer, rawStorageKey: string}} context Downloaded page.
   * @returns {Promise<{records: any[], nextUrls: string[]}>} Supplier records and page/detail URLs.
   */
  async parsePage({ url, body, rawStorageKey }) {
    const $ = cheerio.load(body.toString('utf8'));
    const records = [];
    const nextUrls = [];
    const blocks = $('.company-item,.listing-item,.yp-listing,.companylistings,.content-listing,article,.row_listing');

    blocks.each((index, node) => {
      const root = $(node);
      const name = firstText($, root, ['h2', 'h3', 'h4', '.company-name', '.name', '.title', 'strong']);
      if (!isLikelyCompany(name)) return;

      const text = cleanText(root.text());
      const detailUrl = normalizeWebsite(firstAttr($, root, ['a[href]'], 'href'), url);
      const website = normalizeWebsite(
        firstAttr($, root, ['a[href^="http"]', 'a.website', '.website a'], 'href')
          || (detailUrl && !detailUrl.includes('yellowpages.vn') ? detailUrl : ''),
        url,
      );
      const logo = normalizeWebsite(
        firstAttr($, root, ['img'], 'src') || firstAttr($, root, ['img'], 'data-src'),
        url,
      );
      const address = firstText($, root, ['.address', '.diachi', '[class*="address"]']);
      const description = firstText($, root, ['.description', '.nganhnghe', '.products', '.content', 'p'])
        || text.slice(0, 1200);

      records.push(makeRecord({
        sourceName: this.name,
        sourceType: this.type,
        sourceUrl: detailUrl || url,
        rawStorageKey,
        raw: { id: `${url}#company-${index + 1}`, text },
        confidence: 0.5,
        supplier: {
          legalName: name,
          description,
          website,
          email: extractEmail(text),
          phone: extractPhone(text),
          address,
          province: normalizeProvince(address),
          logoOriginalUrl: logo,
          roles: ['SUPPLIER'],
          hintGroup: this.options.hintGroup,
          defaultEnvironment: this.options.defaultEnvironment,
        },
        product: description ? {
          name: this.options.category || description.slice(0, 180),
          productGroup: this.options.hintGroup,
          category: this.options.category,
          description,
          productUrl: detailUrl || website,
          environments: this.options.defaultEnvironment
            ? [this.options.defaultEnvironment]
            : [],
        } : null,
      }));

      if (detailUrl && detailUrl.includes('yellowpages.vn') && detailUrl !== url) {
        nextUrls.push(detailUrl);
      }
    });

    // Fallback for Yellow Pages layouts rendered as ordinary HTML tables.
    if (!records.length) {
      for (const [index, row] of rowsFromTables($).entries()) {
        const fallbackNameIndex = row.cells.length > 1 && /^\d+$/.test(row.cells[0]) ? 1 : 0;
        const name = cellByHeader(row, ['company', 'cong ty', 'doanh nghiep', 'ten'], fallbackNameIndex);
        if (!isLikelyCompany(name)) continue;

        const text = row.text;
        const detailUrl = row.links.map((item) => normalizeWebsite(item, url)).find(Boolean);
        records.push(makeRecord({
          sourceName: this.name,
          sourceType: this.type,
          sourceUrl: detailUrl || url,
          rawStorageKey,
          raw: { id: `${url}#row-${index + 1}`, cells: row.cells },
          confidence: 0.45,
          supplier: {
            legalName: name,
            description: text,
            website: detailUrl,
            email: extractEmail(text),
            phone: extractPhone(text),
            roles: ['SUPPLIER'],
            hintGroup: this.options.hintGroup,
            defaultEnvironment: this.options.defaultEnvironment,
          },
          product: {
            name: this.options.category,
            productGroup: this.options.hintGroup,
            category: this.options.category,
            description: text,
          },
        }));
      }
    }

    // Pagination links are bounded by BaseCrawler.maxPages and per-host throttling.
    $('a[href]').each((_, node) => {
      const text = normalizeKey($(node).text());
      const href = normalizeWebsite($(node).attr('href'), url);
      if (
        href
        && href.includes('yellowpages.vn')
        && (/trang sau|next|page|xem tiep/.test(text) || /[?&]page=\d+/.test(href))
      ) {
        nextUrls.push(href);
      }
    });

    return {
      records,
      nextUrls: [...new Set(nextUrls)].slice(0, 50),
    };
  }
}

module.exports = {
  ExhibitionCrawler,
  HortexCrawler,
  PpdCrawler,
  YellowPagesCrawler,
};
