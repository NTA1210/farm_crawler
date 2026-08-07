'use strict';

const {
  cleanText,
  normalizeKey,
  normalizeWebsite,
  normalizeProvince,
  classify,
  sha256,
} = require('../core');

/**
 * Return the first non-empty text found by a list of selectors.
 *
 * @param {import('cheerio').CheerioAPI} $ Cheerio API.
 * @param {import('cheerio').Cheerio<any>} root Root element.
 * @param {string[]} selectors Selectors in priority order.
 * @returns {string} Clean text or an empty string.
 */
function firstText($, root, selectors) {
  for (const selector of selectors) {
    const value = cleanText(root.find(selector).first().text());
    if (value) return value;
  }
  return '';
}

/**
 * Return the first non-empty attribute found by a list of selectors.
 *
 * @param {import('cheerio').CheerioAPI} $ Cheerio API.
 * @param {import('cheerio').Cheerio<any>} root Root element.
 * @param {string[]} selectors Selectors in priority order.
 * @param {string} attribute Attribute name.
 * @returns {string} Attribute value or an empty string.
 */
function firstAttr($, root, selectors, attribute) {
  for (const selector of selectors) {
    const value = root.find(selector).first().attr(attribute);
    if (value) return value;
  }
  return '';
}

/** Extract the first email address from unstructured text. */
function extractEmail(text = '') {
  return (String(text).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0] || '';
}

/** Extract the first likely Vietnamese phone number from unstructured text. */
function extractPhone(text = '') {
  return (String(text).match(/(?:\+?84|0)[\d\s().-]{7,15}/) || [])[0] || '';
}

/**
 * Reject table headers and obviously invalid company names before persistence.
 *
 * @param {string} name Candidate company name.
 * @returns {boolean} Whether the value is usable.
 */
function isLikelyCompany(name = '') {
  const key = normalizeKey(name);
  if (key.length < 3 || key.length > 220) return false;
  return !/^(stt|no|ten doanh nghiep|ten don vi|company|exhibitor|san pham|dia chi|website|email|dien thoai)$/.test(key);
}

/**
 * Convert every HTML table row to a generic structure shared by source parsers.
 *
 * @param {import('cheerio').CheerioAPI} $ Cheerio API.
 * @returns {{headers: string[], cells: string[], links: string[], images: string[], text: string}[]} Parsed rows.
 */
function rowsFromTables($) {
  const rows = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('tr').first().find('th,td').each((__, cell) => {
      headers.push(normalizeKey($(cell).text()));
    });

    $(table).find('tr').slice(1).each((__, tableRow) => {
      const cells = $(tableRow).find('td,th').map((___, cell) => cleanText($(cell).text())).get();
      if (!cells.some(Boolean)) return;

      const links = $(tableRow).find('a[href]').map((___, anchor) => $(anchor).attr('href')).get();
      const images = $(tableRow).find('img').map((___, image) => (
        $(image).attr('src') || $(image).attr('data-src') || $(image).attr('data-lazy-src')
      )).get();

      rows.push({
        headers,
        cells,
        links,
        images,
        text: cleanText($(tableRow).text()),
      });
    });
  });

  return rows;
}

/**
 * Read a table cell by flexible normalized header fragments.
 *
 * @param {{headers: string[], cells: string[]}} row Generic row.
 * @param {string[]} patterns Accepted header fragments.
 * @param {number} fallbackIndex Fallback column index or -1.
 * @returns {string} Cell value.
 */
function cellByHeader(row, patterns, fallbackIndex = -1) {
  const index = row.headers.findIndex((header) => patterns.some((pattern) => header.includes(pattern)));
  if (index >= 0) return row.cells[index] || '';
  return fallbackIndex >= 0 ? row.cells[fallbackIndex] || '' : '';
}

/**
 * Build the normalized record contract expected by `Store.saveRecord`.
 *
 * Classification is calculated from supplier and product text. Source evidence keeps
 * the original parsed row so later parser changes remain auditable.
 *
 * @param {Record<string, any>} input Record parts.
 * @returns {Record<string, any>} Complete crawler record.
 */
function makeRecord({
  sourceName,
  sourceType,
  sourceUrl,
  rawStorageKey,
  raw,
  supplier,
  product = null,
  confidence = 0.45,
}) {
  const text = [
    supplier.legalName,
    supplier.description,
    product?.name,
    product?.description,
  ].filter(Boolean).join(' ');
  const detected = classify(text, supplier.hintGroup, supplier.defaultEnvironment);

  return {
    supplier: {
      ...supplier,
      groups: [...new Set([...(supplier.groups || []), ...detected.groups])],
      environments: [...new Set([...(supplier.environments || []), ...detected.environments])],
      cropNames: [...new Set([...(supplier.cropNames || []), ...detected.cropNames])],
      categories: [...new Set([...(supplier.categories || []), ...detected.categories])],
      confidenceScore: confidence,
      verifiedStatus: sourceType === 'OFFICIAL_REGISTRY'
        ? 'OFFICIAL_SOURCE_VERIFIED'
        : 'UNVERIFIED',
      lastVerifiedAt: sourceType === 'OFFICIAL_REGISTRY' ? new Date().toISOString() : null,
    },
    product: product ? {
      ...product,
      environments: [...new Set([...(product.environments || []), ...detected.environments])],
      cropNames: [...new Set([...(product.cropNames || []), ...detected.cropNames])],
    } : null,
    evidence: {
      sourceName,
      sourceType,
      sourceUrl,
      sourceRecordId: raw.id || raw.recordId || raw.index || '',
      raw,
      rawStorageKey,
      contentHash: sha256(JSON.stringify(raw)),
      confidenceScore: confidence,
    },
  };
}

/**
 * Convert one generic official registry row to a supplier/product record.
 *
 * @param {{headers: string[], cells: string[]}} row Generic row.
 * @param {'SEED'|'FERTILIZER'} kind Official registry kind.
 * @param {Record<string, any>} context Source metadata.
 * @returns {Record<string, any>|null} Mapped record or null for invalid rows.
 */
function mapOfficialRow(row, kind, context) {
  const cells = row.cells;
  const fallbackNameIndex = cells.length > 1 && /^\d+$/.test(cells[0]) ? 1 : 0;
  const name = cellByHeader(
    row,
    ['ten don vi', 'to chuc', 'doanh nghiep', 'co so', 'don vi dang ky', 'chu so huu'],
    fallbackNameIndex,
  );
  if (!isLikelyCompany(name)) return null;

  const address = cellByHeader(row, ['dia chi'], -1);
  const decision = cellByHeader(row, ['quyet dinh', 'so qd', 'giay chung nhan', 'so gcn'], -1);
  const productName = kind === 'SEED'
    ? cellByHeader(row, ['ten giong', 'giong cay', 'cay trong'], cells.length > 2 ? 2 : -1)
    : cellByHeader(row, ['san pham', 'loai phan', 'phan bon'], -1);
  const description = cleanText([productName, decision, address].filter(Boolean).join(' | '));

  return makeRecord({
    sourceName: context.name,
    sourceType: context.type,
    sourceUrl: context.url,
    rawStorageKey: context.rawStorageKey,
    raw: { id: `${context.url}#${context.index}`, cells, decision },
    confidence: 0.9,
    supplier: {
      legalName: name,
      address,
      province: normalizeProvince(address),
      description,
      roles: kind === 'SEED' ? ['BREEDER_OR_REGISTRANT'] : ['MANUFACTURER'],
      groups: [kind],
    },
    product: productName ? {
      name: productName,
      productGroup: kind,
      category: kind === 'SEED' ? 'PLANT_VARIETY' : 'FERTILIZER',
      description,
    } : null,
  });
}

module.exports = {
  firstText,
  firstAttr,
  extractEmail,
  extractPhone,
  isLikelyCompany,
  rowsFromTables,
  cellByHeader,
  makeRecord,
  mapOfficialRow,
};
