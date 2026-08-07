'use strict';

const { normalizeKey, cleanText } = require('./core');

// Supplier is the aggregate root. A seed, equipment item, fertilizer, evidence or
// image is accepted only when the parser has identified a real supplier first.
const TARGET_GROUPS = new Set(['SEED', 'EQUIPMENT', 'FERTILIZER']);

/**
 * Determine whether a country label represents Vietnam.
 * Empty labels are accepted because many local directories omit the country.
 *
 * @param {unknown} value Country label.
 * @returns {boolean} Whether the record is considered Vietnamese.
 */
function isVietnamCountry(value) {
  const key = normalizeKey(value);
  if (!key) return true;
  return key === 'vietnam'
    || key === 'viet nam'
    || key.includes('vietnam')
    || key.includes('viet nam');
}

/**
 * Verify that a parsed record contains the supplier identity required by the
 * supplier-core data model.
 *
 * A product-only row is not converted into an artificial `UNKNOWN` supplier. It is
 * rejected and can be investigated later from the retained raw page snapshot.
 *
 * @param {Record<string, any>|null|undefined} record Parsed crawler record.
 * @returns {boolean} Whether the record contains a usable supplier.
 */
function hasCoreSupplier(record) {
  const supplier = record?.supplier;
  if (!supplier || typeof supplier !== 'object') return false;

  const legalName = cleanText(supplier.legalName || supplier.tradeName);
  if (legalName.length < 3) return false;

  // Reject common placeholders so unrelated records are not merged under a fake
  // supplier entity.
  const key = normalizeKey(legalName);
  return ![
    'unknown',
    'unknown supplier',
    'no supplier',
    'n a',
    'khong ro',
    'khong co',
    'chua xac dinh',
  ].includes(key);
}

/**
 * Apply project scope rules to one parsed supplier-rooted record.
 *
 * @param {Record<string, any>} record Parsed record.
 * @param {Record<string, any>} config Crawler policy configuration.
 * @returns {boolean} Whether the record should be persisted.
 */
function isTargetRecord(record, config) {
  if (!hasCoreSupplier(record)) return false;

  const supplier = record.supplier;
  if (config.vietnamOnly && !isVietnamCountry(supplier.country)) return false;

  return (supplier.groups || []).some((group) => (
    TARGET_GROUPS.has(String(group).toUpperCase())
  ));
}

/**
 * Wrap every parser so supplier-less, foreign-only and out-of-scope rows are
 * removed before crawl counters, MongoDB writes or image downloads occur.
 *
 * @param {Record<string, any>} registry Crawler registry.
 * @param {Record<string, any>} config Policy configuration.
 * @param {import('pino').Logger} logger Application logger.
 * @returns {Record<string, any>} Same registry with wrapped parsers.
 */
function applyRecordPolicy(registry, config, logger) {
  for (const crawler of Object.values(registry)) {
    const parsePage = crawler.parsePage.bind(crawler);

    crawler.parsePage = async (context) => {
      const result = await parsePage(context);
      const records = result.records || [];
      const accepted = records.filter((record) => isTargetRecord(record, config));
      const missingSupplier = records.filter((record) => !hasCoreSupplier(record)).length;

      if (accepted.length !== records.length) {
        logger?.debug({
          source: crawler.name,
          accepted: accepted.length,
          filtered: records.length - accepted.length,
          missingSupplier,
        }, 'Filtered crawler records before supplier persistence');
      }

      return { ...result, records: accepted };
    };
  }

  return registry;
}

module.exports = {
  applyRecordPolicy,
  isTargetRecord,
  isVietnamCountry,
  hasCoreSupplier,
  TARGET_GROUPS,
};
