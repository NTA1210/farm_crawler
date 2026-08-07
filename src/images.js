'use strict';

const cheerio = require('cheerio');
const { normalizeWebsite, sha256, safeJson } = require('./core');

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/gif': 'gif',
};

function detectMime(buffer, declared = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) return 'image/x-icon';
  if (buffer.length >= 6 && /^GIF8[79]a/.test(buffer.toString('ascii', 0, 6))) return 'image/gif';
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) return 'image/svg+xml';
  return null;
}

function addCandidate(list, value, pageUrl, type, score) {
  const url = normalizeWebsite(value, pageUrl);
  if (!url || !/^https?:/.test(url)) return;
  if (!list.some((item) => item.url === url)) list.push({ url, type, score });
}

function logoCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidates = [];

  $('script[type="application/ld+json"]').each((_, node) => {
    const data = safeJson($(node).text());
    const items = Array.isArray(data) ? data : data?.['@graph'] || [data];
    for (const item of items || []) {
      if (!item || typeof item !== 'object') continue;
      const logo = typeof item.logo === 'string' ? item.logo : item.logo?.url;
      addCandidate(candidates, logo, pageUrl, 'LOGO', 100);
      addCandidate(candidates, typeof item.image === 'string' ? item.image : item.image?.url, pageUrl, 'LOGO', 85);
    }
  });

  addCandidate(candidates, $('meta[property="og:logo"]').attr('content'), pageUrl, 'LOGO', 98);
  addCandidate(candidates, $('meta[property="og:image"]').attr('content'), pageUrl, 'LOGO', 70);
  addCandidate(candidates, $('meta[name="twitter:image"]').attr('content'), pageUrl, 'LOGO', 65);
  $('link[rel~="apple-touch-icon"],link[rel~="icon"],link[rel="shortcut icon"]').each((_, node) => {
    const rel = ($(node).attr('rel') || '').toLowerCase();
    addCandidate(candidates, $(node).attr('href'), pageUrl, rel.includes('apple') ? 'LOGO' : 'FAVICON', rel.includes('apple') ? 60 : 35);
  });
  $('img').each((_, node) => {
    const el = $(node); const marker = `${el.attr('class') || ''} ${el.attr('id') || ''} ${el.attr('alt') || ''}`.toLowerCase();
    if (/logo|brand|company/.test(marker) || el.closest('header,.header,.navbar,.site-header').length) {
      addCandidate(candidates, el.attr('src') || el.attr('data-src') || el.attr('data-lazy-src'), pageUrl, 'LOGO', /logo/.test(marker) ? 90 : 55);
    }
  });
  return candidates.sort((a, b) => b.score - a.score);
}

class ImageService {
  constructor({ http, storage, store, config, logger }) {
    this.http = http; this.storage = storage; this.store = store; this.config = config; this.logger = logger;
  }

  async save({ supplierId, productId = null, originalUrl, sourcePageUrl, sourceName, imageType = 'LOGO' }) {
    const url = normalizeWebsite(originalUrl, sourcePageUrl);
    if (!url) return null;
    try {
      const response = await this.http.request(url, {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        maxBytes: this.config.maxImageBytes,
      });
      if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);
      const mimeType = detectMime(response.body, response.contentType);
      if (!mimeType || !MIME_EXT[mimeType]) throw new Error(`Unsupported or invalid image (${response.contentType})`);
      const hash = sha256(response.body);
      const owner = supplierId ? `suppliers/${supplierId}` : productId ? `products/${productId}` : 'unassigned';
      const key = `${owner}/${imageType.toLowerCase()}/${hash}.${MIME_EXT[mimeType]}`;
      const saved = await this.storage.put(key, response.body, mimeType);
      this.store.saveImage({
        supplierId, productId, imageType, originalUrl: url, sourcePageUrl: sourcePageUrl || null,
        sourceName: sourceName || 'unknown', storageKey: saved.key, storageUrl: saved.url,
        contentHash: hash, mimeType, byteSize: response.body.length,
      });
      return { ...saved, hash, mimeType, originalUrl: url };
    } catch (error) {
      this.logger?.warn({ url, supplierId, error: error.message }, 'Image download skipped');
      return null;
    }
  }

  async enrichWebsiteLogo(supplier) {
    if (!supplier.website) return null;
    try {
      const page = await this.http.text(supplier.website);
      for (const candidate of logoCandidates(page.text, page.url)) {
        const result = await this.save({ supplierId: supplier.id, originalUrl: candidate.url, sourcePageUrl: page.url, sourceName: 'company-website', imageType: candidate.type });
        if (result && candidate.type === 'LOGO') return result;
      }
    } catch (error) {
      this.logger?.warn({ supplierId: supplier.id, website: supplier.website, error: error.message }, 'Website logo enrichment failed');
    }
    return null;
  }
}

module.exports = { ImageService, logoCandidates, detectMime };
