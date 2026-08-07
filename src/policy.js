'use strict';

const { normalizeKey } = require('./core');

const TARGET_GROUPS = new Set(['SEED', 'EQUIPMENT', 'FERTILIZER']);

function isVietnamCountry(value) {
  const key = normalizeKey(value);
  if (!key) return true;
  return key === 'vietnam' || key === 'viet nam' || key.includes('vietnam') || key.includes('viet nam');
}

function isTargetRecord(record, config) {
  const supplier = record?.supplier;
  if (!supplier) return false;
  if (config.vietnamOnly && !isVietnamCountry(supplier.country)) return false;
  return (supplier.groups || []).some((group) => TARGET_GROUPS.has(String(group).toUpperCase()));
}

function applyRecordPolicy(registry, config, logger) {
  for (const crawler of Object.values(registry)) {
    const parsePage = crawler.parsePage.bind(crawler);
    crawler.parsePage = async (context) => {
      const result = await parsePage(context);
      const records = result.records || [];
      const accepted = records.filter((record) => isTargetRecord(record, config));
      if (accepted.length !== records.length) {
        logger?.debug({
          source: crawler.name,
          accepted: accepted.length,
          filtered: records.length - accepted.length,
        }, 'Filtered out non-target or non-Vietnam supplier records');
      }
      return { ...result, records: accepted };
    };
  }
  return registry;
}

module.exports = { applyRecordPolicy, isTargetRecord, isVietnamCountry, TARGET_GROUPS };
