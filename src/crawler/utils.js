'use strict';

const {
  cleanText,
  normalizeKey,
  normalizeWebsite,
  normalizeProvince,
  classify,
  sha256,
} = require('../core');

// Only explicit supplier/organization columns may create the core Supplier entity.
// Product, variety or fertilizer columns are deliberately excluded from this list.
const SUPPLIER_HEADER_PATTERNS = Object.freeze([
  'ten don vi',
  'ten to chuc',
  'ten doanh nghiep',
  'ten co so',
  'co so san xuat',
  'don vi dang ky',
  'don vi de nghi',
  'chu so huu',
  'to chuc dang ky',
  'doanh nghiep',
  'company',
  'exhibitor',
]);

/** Return the first non-empty text found by selectors in priority order. */
function firstText($, root, selectors) {
  for (const selector of selectors) {
    const value = cleanText(root.find(selector).first().text());
    if (value) return value;
  }
  return '';
}

/** Return the first non-empty attribute found by selectors in priority order. */
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
 * Reject table headers, placeholders and obviously invalid supplier names.
 *
 * @param {string} name Candidate supplier/company name.
 * @returns {boolean} Whether the value can identify the core Supplier entity.
 */
function isLikelyCompany(name = '') {
  const key = normalizeKey(name);
  if (key.length < 3 || key.length > 220) return false;

  return !/^(stt|no|ten doanh nghiep|ten don vi|ten to chuc|ten co so|company|exhibitor|san pham|ten san pham|ten giong|giong cay|phan bon|dia chi|website|email|dien thoai|unknown|unknown supplier|no supplier|n a|khong ro|khong co|chua xac dinh)$/.test(key);
}

/** Convert every HTML table row to a generic structure shared by source parsers. */
function rowsFromTables($) {
  const rows = [];

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('tr').first().find('th,td').each((__, cell) => {
      headers.push(normalizeKey($(cell).text()));
    });

    $(table).find('tr').slice(1).each((__, tableRow) => {
      const cells = $(tableRow).find('td,th')
        .map((___, cell) => cleanText($(cell).text()))
        .get();
      if (!cells.some(Boolean)) return;

      const links = $(tableRow).find('a[href]')
        .map((___, anchor) => $(anchor).attr('href'))
        .get();
      const images = $(tableRow).find('img')
        .map((___, image) => (
          $(image).attr('src')
          || $(image).attr('data-src')
          || $(image).attr('data-lazy-src')
        ))
        .get();

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

/** Read a table cell by flexible normalized header fragments. */
function cellByHeader(row, patterns, fallbackIndex = -1) {
  const index = row.headers.findIndex((header) => (
    patterns.some((pattern) => header.includes(pattern))
  ));
  if (index >= 0) return row.cells[index] || '';
  return fallbackIndex >= 0 ? row.cells[fallbackIndex] || '' : '';
}

/**
 * Read the supplier name only from an explicitly supplier-related column.
 *
 * No positional fallback is allowed here. Without this rule a table such as
 * `STT | Tên giống | Quyết định` could incorrectly create a Supplier whose name is
 * actually a plant variety.
 *
 * @param {{headers: string[], cells: string[]}} row Generic table row.
 * @returns {string} Supplier name or an empty string when the source does not expose one.
 */
function supplierNameByHeader(row) {
  const index = row.headers.findIndex((header) => (
    SUPPLIER_HEADER_PATTERNS.some((pattern) => header.includes(pattern))
  ));
  return index >= 0 ? cleanText(row.cells[index]) : '';
}

/**
 * Build the normalized supplier-rooted record expected by `Store.saveRecord`.
 *
 * @param {Record<string, any>} input Record parts.
 * @returns {Record<string, any>} Complete crawler record.
 * @throws {Error} When the parser tries to create an orphan product/evidence record.
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
  if (!supplier || !isLikelyCompany(supplier.legalName || supplier.tradeName)) {
    throw new Error(`Supplier is required for source record: ${sourceName}`);
  }

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
 * Convert one official registry row to a supplier/product record.
 *
 * The row is skipped when the registry does not expose a valid supplier. This is
 * intentional: Supplier is the aggregate root and the crawler never invents an
 * `UNKNOWN` supplier for an otherwise valid variety or fertilizer row.
 *
 * @param {{headers: string[], cells: string[]}} row Generic row.
 * @param {'SEED'|'FERTILIZER'} kind Official registry kind.
 * @param {Record<string, any>} context Source metadata.
 * @returns {Record<string, any>|null} Supplier-rooted record or null.
 */
function mapOfficialRow(row, kind, context) {
  const cells = row.cells;
  const name = supplierNameByHeader(row);
  if (!isLikelyCompany(name)) return null;

  const address = cellByHeader(row, ['dia chi'], -1);
  const decision = cellByHeader(row, ['quyet dinh', 'so qd', 'giay chung nhan', 'so gcn'], -1);
  const productName = kind === 'SEED'
    ? cellByHeader(row, ['ten giong', 'giong cay', 'cay trong'], -1)
    : cellByHeader(row, ['ten san pham', 'san pham', 'loai phan', 'phan bon'], -1);
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
  SUPPLIER_HEADER_PATTERNS,
  firstText,
  firstAttr,
  extractEmail,
  extractPhone,
  isLikelyCompany,
  rowsFromTables,
  cellByHeader,
  supplierNameByHeader,
  makeRecord,
  mapOfficialRow,
};
