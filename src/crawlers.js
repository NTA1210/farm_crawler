'use strict';

const cheerio = require('cheerio');
const XLSX = require('xlsx');
const {
  cleanText, normalizeWebsite, normalizeProvince, classify, sha256, normalizeKey,
} = require('./core');

function firstText($, root, selectors) {
  for (const selector of selectors) {
    const value = cleanText(root.find(selector).first().text());
    if (value) return value;
  }
  return '';
}

function firstAttr($, root, selectors, attribute) {
  for (const selector of selectors) {
    const value = root.find(selector).first().attr(attribute);
    if (value) return value;
  }
  return '';
}

function extractEmail(text = '') { return (String(text).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0] || ''; }
function extractPhone(text = '') { return (String(text).match(/(?:\+?84|0)[\d\s().-]{7,15}/) || [])[0] || ''; }
function isLikelyCompany(name = '') {
  const key = normalizeKey(name);
  if (key.length < 3 || key.length > 220) return false;
  return !/^(stt|no|ten doanh nghiep|ten don vi|company|exhibitor|san pham|dia chi|website|email|dien thoai)$/.test(key);
}

function rowsFromTables($) {
  const rows = [];
  $('table').each((_, table) => {
    const headers = [];
    $(table).find('tr').first().find('th,td').each((__, cell) => headers.push(normalizeKey($(cell).text())));
    $(table).find('tr').slice(1).each((__, tr) => {
      const cells = $(tr).find('td,th').map((___, cell) => cleanText($(cell).text())).get();
      if (!cells.some(Boolean)) return;
      const links = $(tr).find('a[href]').map((___, a) => $(a).attr('href')).get();
      const images = $(tr).find('img').map((___, img) => $(img).attr('src') || $(img).attr('data-src')).get();
      rows.push({ headers, cells, links, images, text: cleanText($(tr).text()) });
    });
  });
  return rows;
}

function cellByHeader(row, patterns, fallbackIndex = -1) {
  const index = row.headers.findIndex((header) => patterns.some((pattern) => header.includes(pattern)));
  if (index >= 0) return row.cells[index] || '';
  return fallbackIndex >= 0 ? row.cells[fallbackIndex] || '' : '';
}

function makeRecord({ sourceName, sourceType, sourceUrl, rawStorageKey, raw, supplier, product = null, confidence = 0.45 }) {
  const text = [supplier.legalName, supplier.description, product?.name, product?.description].filter(Boolean).join(' ');
  const detected = classify(text, supplier.hintGroup, supplier.defaultEnvironment);
  return {
    supplier: {
      ...supplier,
      groups: [...new Set([...(supplier.groups || []), ...detected.groups])],
      environments: [...new Set([...(supplier.environments || []), ...detected.environments])],
      cropNames: [...new Set([...(supplier.cropNames || []), ...detected.cropNames])],
      categories: [...new Set([...(supplier.categories || []), ...detected.categories])],
      confidenceScore: confidence,
      verifiedStatus: sourceType === 'OFFICIAL_REGISTRY' ? 'OFFICIAL_SOURCE_VERIFIED' : 'UNVERIFIED',
      lastVerifiedAt: sourceType === 'OFFICIAL_REGISTRY' ? new Date().toISOString() : null,
    },
    product: product ? {
      ...product,
      environments: [...new Set([...(product.environments || []), ...detected.environments])],
      cropNames: [...new Set([...(product.cropNames || []), ...detected.cropNames])],
    } : null,
    evidence: {
      sourceName, sourceType, sourceUrl, sourceRecordId: raw.id || raw.recordId || raw.index || '',
      raw, rawStorageKey, contentHash: sha256(JSON.stringify(raw)), confidenceScore: confidence,
    },
  };
}

class BaseCrawler {
  constructor({ name, type, urls, http, storage, store, imageService, logger, config, options = {} }) {
    this.name = name; this.type = type; this.urls = urls; this.http = http; this.storage = storage;
    this.store = store; this.imageService = imageService; this.logger = logger; this.config = config; this.options = options;
  }

  async parsePage() { return { records: [], nextUrls: [] }; }

  async run(runOptions = {}) {
    const dryRun = Boolean(runOptions.dryRun);
    const downloadImages = runOptions.downloadImages ?? this.config.downloadImages;
    const maxPages = Math.max(1, Math.min(100, Number(runOptions.maxPages || this.config.maxPages)));
    const runId = this.store.startRun(this.name);
    const stats = { pages: 0, found: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 };
    const queue = [...this.urls]; const visited = new Set(); let fatalError = null;
    try {
      while (queue.length && stats.pages < maxPages) {
        const requestedUrl = queue.shift();
        if (!requestedUrl || visited.has(requestedUrl)) continue;
        visited.add(requestedUrl);
        try {
          const response = await this.http.request(requestedUrl);
          if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);
          const rawSaved = await this.storage.raw(this.name, response.url, response.body, response.contentType);
          const parsed = await this.parsePage({
            url: response.url, body: response.body, contentType: response.contentType,
            rawStorageKey: rawSaved.key, page: stats.pages + 1,
          });
          stats.pages += 1;
          for (const next of parsed.nextUrls || []) {
            const normalized = normalizeWebsite(next, response.url);
            if (normalized && !visited.has(normalized)) queue.push(normalized);
          }
          for (const record of parsed.records || []) {
            stats.found += 1;
            try {
              if (dryRun) { stats.skipped += 1; continue; }
              const result = this.store.saveRecord(record);
              stats[result.action] = (stats[result.action] || 0) + 1;
              const logoUrl = record.supplier.logoOriginalUrl;
              if (downloadImages && result.id && logoUrl) {
                await this.imageService.save({
                  supplierId: result.id, originalUrl: logoUrl, sourcePageUrl: record.evidence.sourceUrl,
                  sourceName: this.name, imageType: 'LOGO',
                });
              }
            } catch (error) {
              stats.failed += 1;
              this.logger.error({ source: this.name, url: response.url, error: error.message }, 'Record failed');
            }
          }
        } catch (error) {
          stats.failed += 1;
          fatalError ||= error;
          this.logger.error({ source: this.name, url: requestedUrl, error: error.message }, 'Page crawl failed');
        }
      }
    } finally {
      this.store.finishRun(runId, stats, stats.pages ? null : fatalError);
    }
    return { source: this.name, status: fatalError && !stats.pages ? 'FAILED' : stats.failed ? 'PARTIAL' : 'COMPLETED', ...stats };
  }
}

class AgriVietnamCrawler extends BaseCrawler {
  async parsePage({ url, body, rawStorageKey }) {
    const html = body.toString('utf8'); const $ = cheerio.load(html); const records = [];
    const tableRows = rowsFromTables($);
    for (const [index, row] of tableRows.entries()) {
      const name = cellByHeader(row, ['company', 'exhibitor', 'doanh nghiep', 'don vi', 'ten'], row.cells.length > 1 && /^\d+$/.test(row.cells[0]) ? 1 : 0);
      if (!isLikelyCompany(name)) continue;
      const description = cellByHeader(row, ['product', 'san pham', 'description', 'linh vuc'], row.cells.length > 2 ? 2 : -1);
      const country = cellByHeader(row, ['country', 'quoc gia'], -1) || 'Vietnam';
      const booth = cellByHeader(row, ['booth', 'gian hang'], -1);
      const href = row.links.map((item) => normalizeWebsite(item, url)).find(Boolean);
      const image = row.images.map((item) => normalizeWebsite(item, url)).find(Boolean);
      records.push(makeRecord({
        sourceName: this.name, sourceType: this.type, sourceUrl: href || url, rawStorageKey,
        raw: { id: `${url}#row-${index + 1}`, cells: row.cells, booth, country }, confidence: 0.62,
        supplier: { legalName: name, description, country, website: href, logoOriginalUrl: image, roles: ['EXHIBITOR'] },
        product: description ? { name: description.slice(0, 240), description, productUrl: href } : null,
      }));
    }

    if (!records.length) {
      const selectors = ['.exhibitor-item', '.exhibitor', '.company-item', '.elementor-post', 'article'];
      $(selectors.join(',')).each((index, node) => {
        const root = $(node);
        const name = firstText($, root, ['h2', 'h3', 'h4', '.title', '.company-name', 'strong']);
        if (!isLikelyCompany(name)) return;
        const description = firstText($, root, ['.description', '.content', '.excerpt', 'p']);
        const href = normalizeWebsite(firstAttr($, root, ['a[href]'], 'href'), url);
        const image = normalizeWebsite(firstAttr($, root, ['img'], 'src') || firstAttr($, root, ['img'], 'data-src'), url);
        records.push(makeRecord({
          sourceName: this.name, sourceType: this.type, sourceUrl: href || url, rawStorageKey,
          raw: { id: `${url}#card-${index + 1}`, text: cleanText(root.text()) }, confidence: 0.55,
          supplier: { legalName: name, description, website: href, logoOriginalUrl: image, roles: ['EXHIBITOR'] },
          product: description ? { name: description.slice(0, 240), description, productUrl: href } : null,
        }));
      });
    }
    return { records, nextUrls: [] };
  }
}

class HortexCrawler extends AgriVietnamCrawler {
  async parsePage(context) {
    const base = await super.parsePage(context);
    const $ = cheerio.load(context.body.toString('utf8'));
    const nextUrls = [];
    $('iframe[src],a[href]').each((_, node) => {
      const value = $(node).attr('src') || $(node).attr('href');
      const href = normalizeWebsite(value, context.url);
      if (href && /exhibitor|floorplan|expoplatform|event/.test(href.toLowerCase()) && href !== context.url) nextUrls.push(href);
    });
    return { records: base.records, nextUrls: [...new Set(nextUrls)].slice(0, 10) };
  }
}

function mapOfficialRow(row, kind, context) {
  const cells = row.cells;
  const name = cellByHeader(row, ['ten don vi', 'to chuc', 'doanh nghiep', 'co so', 'don vi dang ky', 'chu so huu'], cells.length > 1 && /^\d+$/.test(cells[0]) ? 1 : 0);
  if (!isLikelyCompany(name)) return null;
  const address = cellByHeader(row, ['dia chi'], -1);
  const decision = cellByHeader(row, ['quyet dinh', 'so qd', 'giay chung nhan', 'so gcn'], -1);
  const productName = kind === 'SEED'
    ? cellByHeader(row, ['ten giong', 'giong cay', 'cay trong'], cells.length > 2 ? 2 : -1)
    : cellByHeader(row, ['san pham', 'loai phan', 'phan bon'], -1);
  const description = cleanText([productName, decision, address].filter(Boolean).join(' | '));
  return makeRecord({
    sourceName: context.name, sourceType: context.type, sourceUrl: context.url, rawStorageKey: context.rawStorageKey,
    raw: { id: `${context.url}#${context.index}`, cells, decision }, confidence: 0.9,
    supplier: {
      legalName: name, address, province: normalizeProvince(address), description,
      roles: kind === 'SEED' ? ['BREEDER_OR_REGISTRANT'] : ['MANUFACTURER'], groups: [kind],
    },
    product: productName ? {
      name: productName, productGroup: kind, category: kind === 'SEED' ? 'PLANT_VARIETY' : 'FERTILIZER', description,
    } : null,
  });
}

class PpdCrawler extends BaseCrawler {
  constructor(input) { super(input); this.kind = input.options.kind; }

  recordsFromWorkbook(buffer, url, rawStorageKey) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const records = [];
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
      if (rows.length < 2) continue;
      const headerIndex = rows.findIndex((row) => row.filter((cell) => cleanText(cell)).length >= 2);
      const headers = (rows[headerIndex] || []).map((cell) => normalizeKey(cell));
      for (let index = headerIndex + 1; index < rows.length; index += 1) {
        const cells = rows[index].map((cell) => cleanText(cell instanceof Date ? cell.toISOString().slice(0, 10) : cell));
        if (!cells.some(Boolean)) continue;
        const record = mapOfficialRow({ headers, cells }, this.kind, {
          name: this.name, type: this.type, url, rawStorageKey, index: `${sheetName}-${index + 1}`,
        });
        if (record) records.push(record);
      }
    }
    return records;
  }

  async parsePage({ url, body, contentType, rawStorageKey }) {
    if (/sheet|excel|spreadsheet|octet-stream/.test(contentType) || /\.xlsx?(?:$|\?)/i.test(url)) {
      if (/\.xls(?:$|\?)/i.test(url) && !/\.xlsx/i.test(url)) this.logger.warn({ url }, 'Legacy XLS parsing is best effort');
      return { records: this.recordsFromWorkbook(body, url, rawStorageKey), nextUrls: [] };
    }
    const $ = cheerio.load(body.toString('utf8')); const records = [];
    for (const [index, row] of rowsFromTables($).entries()) {
      const record = mapOfficialRow(row, this.kind, { name: this.name, type: this.type, url, rawStorageKey, index: index + 1 });
      if (record) records.push(record);
    }
    const nextUrls = [];
    $('a[href]').each((_, node) => {
      const href = normalizeWebsite($(node).attr('href'), url);
      const text = normalizeKey($(node).text());
      if (href && (/\.(xlsx?|csv)(?:$|\?)/i.test(href) || /tai ve|download|danh sach|xem them|trang sau/.test(text))) nextUrls.push(href);
    });
    return { records, nextUrls: [...new Set(nextUrls)].slice(0, 30) };
  }
}

class YellowPagesCrawler extends BaseCrawler {
  async parsePage({ url, body, rawStorageKey }) {
    const $ = cheerio.load(body.toString('utf8')); const records = []; const nextUrls = [];
    const blocks = $('.company-item,.listing-item,.yp-listing,.companylistings,.content-listing,article,.row_listing');
    blocks.each((index, node) => {
      const root = $(node);
      const name = firstText($, root, ['h2', 'h3', 'h4', '.company-name', '.name', '.title', 'strong']);
      if (!isLikelyCompany(name)) return;
      const text = cleanText(root.text());
      const href = normalizeWebsite(firstAttr($, root, ['a[href]'], 'href'), url);
      const website = normalizeWebsite(
        firstAttr($, root, ['a[href^="http"]', 'a.website', '.website a'], 'href') || (href && !href.includes('yellowpages.vn') ? href : ''),
        url,
      );
      const logo = normalizeWebsite(firstAttr($, root, ['img'], 'src') || firstAttr($, root, ['img'], 'data-src'), url);
      const address = firstText($, root, ['.address', '.diachi', '[class*="address"]']);
      const description = firstText($, root, ['.description', '.nganhnghe', '.products', '.content', 'p']) || text.slice(0, 1200);
      records.push(makeRecord({
        sourceName: this.name, sourceType: this.type, sourceUrl: href || url, rawStorageKey,
        raw: { id: `${url}#company-${index + 1}`, text }, confidence: 0.5,
        supplier: {
          legalName: name, description, website, email: extractEmail(text), phone: extractPhone(text), address,
          province: normalizeProvince(address), logoOriginalUrl: logo, roles: ['SUPPLIER'],
          hintGroup: this.options.hintGroup, defaultEnvironment: this.options.defaultEnvironment,
        },
        product: description ? {
          name: this.options.category || description.slice(0, 180), productGroup: this.options.hintGroup,
          category: this.options.category, description, productUrl: href || website,
          environments: this.options.defaultEnvironment ? [this.options.defaultEnvironment] : [],
        } : null,
      }));
      if (href && href.includes('yellowpages.vn') && href !== url) nextUrls.push(href);
    });

    if (!records.length) {
      for (const [index, row] of rowsFromTables($).entries()) {
        const name = cellByHeader(row, ['company', 'cong ty', 'doanh nghiep', 'ten'], row.cells.length > 1 && /^\d+$/.test(row.cells[0]) ? 1 : 0);
        if (!isLikelyCompany(name)) continue;
        const text = row.text;
        const href = row.links.map((item) => normalizeWebsite(item, url)).find(Boolean);
        records.push(makeRecord({
          sourceName: this.name, sourceType: this.type, sourceUrl: href || url, rawStorageKey,
          raw: { id: `${url}#row-${index + 1}`, cells: row.cells }, confidence: 0.45,
          supplier: {
            legalName: name, description: text, website: href, email: extractEmail(text), phone: extractPhone(text),
            roles: ['SUPPLIER'], hintGroup: this.options.hintGroup, defaultEnvironment: this.options.defaultEnvironment,
          },
          product: { name: this.options.category, productGroup: this.options.hintGroup, category: this.options.category, description: text },
        }));
      }
    }

    $('a[href]').each((_, node) => {
      const text = normalizeKey($(node).text()); const href = normalizeWebsite($(node).attr('href'), url);
      if (href && href.includes('yellowpages.vn') && (/trang sau|next|page|xem tiep/.test(text) || /[?&]page=\d+/.test(href))) nextUrls.push(href);
    });
    return { records, nextUrls: [...new Set(nextUrls)].slice(0, 50) };
  }
}

function createRegistry(deps) {
  const common = { ...deps, config: deps.config.crawler };
  const sources = deps.config.sources;
  const registry = {
    'agri-vietnam': new AgriVietnamCrawler({ ...common, name: 'agri-vietnam', type: 'EXHIBITION', urls: [sources.agri] }),
    'hortex': new HortexCrawler({ ...common, name: 'hortex', type: 'EXHIBITION', urls: [sources.hortex] }),
    'ppd-seeds': new PpdCrawler({ ...common, name: 'ppd-seeds', type: 'OFFICIAL_REGISTRY', urls: sources.ppdSeeds, options: { kind: 'SEED' } }),
    'ppd-fertilizers': new PpdCrawler({ ...common, name: 'ppd-fertilizers', type: 'OFFICIAL_REGISTRY', urls: [sources.ppdFertilizers], options: { kind: 'FERTILIZER' } }),
    'yellow-pages-seeds': new YellowPagesCrawler({ ...common, name: 'yellow-pages-seeds', type: 'BUSINESS_DIRECTORY', urls: [sources.yellowSeeds], options: { hintGroup: 'SEED', category: 'SEEDS' } }),
    'yellow-pages-equipment': new YellowPagesCrawler({ ...common, name: 'yellow-pages-equipment', type: 'BUSINESS_DIRECTORY', urls: [sources.yellowEquipment], options: { hintGroup: 'EQUIPMENT', category: 'AGRICULTURAL_EQUIPMENT', defaultEnvironment: 'OUTDOOR' } }),
    'yellow-pages-greenhouse': new YellowPagesCrawler({ ...common, name: 'yellow-pages-greenhouse', type: 'BUSINESS_DIRECTORY', urls: [sources.yellowGreenhouse], options: { hintGroup: 'EQUIPMENT', category: 'GREENHOUSE', defaultEnvironment: 'GREENHOUSE' } }),
    'yellow-pages-fertilizers': new YellowPagesCrawler({ ...common, name: 'yellow-pages-fertilizers', type: 'BUSINESS_DIRECTORY', urls: [sources.yellowFertilizers], options: { hintGroup: 'FERTILIZER', category: 'FERTILIZERS' } }),
  };
  return registry;
}

const SOURCE_INFO = {
  'agri-vietnam': 'Agri Vietnam exhibitor list',
  hortex: 'HortEx Vietnam exhibitor pages',
  'ppd-seeds': 'Official PPD seed circulation/recognition records',
  'ppd-fertilizers': 'Official PPD fertilizer manufacturing facilities',
  'yellow-pages-seeds': 'Vietnam Yellow Pages seed suppliers',
  'yellow-pages-equipment': 'Vietnam Yellow Pages agricultural equipment suppliers',
  'yellow-pages-greenhouse': 'Vietnam Yellow Pages greenhouse/net-house suppliers',
  'yellow-pages-fertilizers': 'Vietnam Yellow Pages fertilizer suppliers',
};

module.exports = {
  BaseCrawler, AgriVietnamCrawler, HortexCrawler, PpdCrawler, YellowPagesCrawler,
  createRegistry, SOURCE_INFO, rowsFromTables, makeRecord,
};
