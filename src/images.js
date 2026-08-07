'use strict';

const cheerio = require('cheerio');
const { normalizeWebsite, sha256, safeJson } = require('./core');

// Storage extension is chosen from verified bytes, never only from a URL suffix.
const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/gif': 'gif',
});

/**
 * Detect a supported image MIME type from the file signature/content.
 *
 * @param {Buffer} buffer Downloaded bytes.
 * @param {string} _declared Declared Content-Type, retained for API compatibility.
 * @returns {string|null} Verified MIME type or null for unsupported content.
 */
function detectMime(buffer, _declared = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) {
    return 'image/x-icon';
  }
  if (buffer.length >= 6 && /^GIF8[79]a/.test(buffer.toString('ascii', 0, 6))) {
    return 'image/gif';
  }

  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) return 'image/svg+xml';
  return null;
}

/**
 * Add a normalized and deduplicated logo candidate.
 *
 * @param {{url: string, type: string, score: number}[]} list Candidate list.
 * @param {string|undefined} value Candidate URL.
 * @param {string} pageUrl Page used to resolve relative URLs.
 * @param {'LOGO'|'FAVICON'} type Image type.
 * @param {number} score Priority score.
 * @returns {void}
 */
function addCandidate(list, value, pageUrl, type, score) {
  const url = normalizeWebsite(value, pageUrl);
  if (!url || !/^https?:/.test(url)) return;
  if (!list.some((item) => item.url === url)) list.push({ url, type, score });
}

/**
 * Discover logo and favicon candidates from a provider website.
 *
 * Priority order: JSON-LD logo, Open Graph, logo-like header images, Apple
 * Touch Icon, and finally favicon.
 *
 * @param {string} html Website HTML.
 * @param {string} pageUrl Final page URL.
 * @returns {{url: string, type: string, score: number}[]} Sorted candidates.
 */
function logoCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidates = [];

  $('script[type="application/ld+json"]').each((_, node) => {
    const data = safeJson($(node).text());
    const items = Array.isArray(data) ? data : data?.['@graph'] || [data];

    for (const item of items || []) {
      if (!item || typeof item !== 'object') continue;
      const logo = typeof item.logo === 'string' ? item.logo : item.logo?.url;
      const image = typeof item.image === 'string' ? item.image : item.image?.url;
      addCandidate(candidates, logo, pageUrl, 'LOGO', 100);
      addCandidate(candidates, image, pageUrl, 'LOGO', 85);
    }
  });

  addCandidate(candidates, $('meta[property="og:logo"]').attr('content'), pageUrl, 'LOGO', 98);
  addCandidate(candidates, $('meta[property="og:image"]').attr('content'), pageUrl, 'LOGO', 70);
  addCandidate(candidates, $('meta[name="twitter:image"]').attr('content'), pageUrl, 'LOGO', 65);

  $('link[rel~="apple-touch-icon"],link[rel~="icon"],link[rel="shortcut icon"]').each((_, node) => {
    const rel = ($(node).attr('rel') || '').toLowerCase();
    const isAppleIcon = rel.includes('apple');
    addCandidate(
      candidates,
      $(node).attr('href'),
      pageUrl,
      isAppleIcon ? 'LOGO' : 'FAVICON',
      isAppleIcon ? 60 : 35,
    );
  });

  $('img').each((_, node) => {
    const element = $(node);
    const marker = `${element.attr('class') || ''} ${element.attr('id') || ''} ${element.attr('alt') || ''}`.toLowerCase();
    const appearsInHeader = element.closest('header,.header,.navbar,.site-header').length > 0;

    if (/logo|brand|company/.test(marker) || appearsInHeader) {
      addCandidate(
        candidates,
        element.attr('src') || element.attr('data-src') || element.attr('data-lazy-src'),
        pageUrl,
        'LOGO',
        /logo/.test(marker) ? 90 : 55,
      );
    }
  });

  return candidates.sort((left, right) => right.score - left.score);
}

/**
 * Download, validate, store and persist provider image metadata.
 */
class ImageService {
  /**
   * @param {{http: import('./http').HttpClient, storage: import('./storage').Storage, store: import('./db').Store, config: Record<string, any>, logger: import('pino').Logger}} dependencies Service dependencies.
   */
  constructor({ http, storage, store, config, logger }) {
    this.http = http;
    this.storage = storage;
    this.store = store;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Download one image, verify its bytes, upload it and save MongoDB metadata.
   *
   * @param {{supplierId?: string|null, productId?: string|null, originalUrl: string, sourcePageUrl?: string|null, sourceName?: string|null, imageType?: string}} input Image request.
   * @returns {Promise<Record<string, any>|null>} Stored image result or null when skipped.
   */
  async save({
    supplierId = null,
    productId = null,
    originalUrl,
    sourcePageUrl,
    sourceName,
    imageType = 'LOGO',
  }) {
    const url = normalizeWebsite(originalUrl, sourcePageUrl);
    if (!url) return null;

    try {
      const response = await this.http.request(url, {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        maxBytes: this.config.maxImageBytes,
      });
      if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);

      const mimeType = detectMime(response.body, response.contentType);
      if (!mimeType || !MIME_EXT[mimeType]) {
        throw new Error(`Unsupported or invalid image (${response.contentType})`);
      }

      const hash = sha256(response.body);
      const ownerPath = supplierId
        ? `suppliers/${supplierId}`
        : productId
          ? `products/${productId}`
          : 'unassigned';
      const key = `${ownerPath}/${imageType.toLowerCase()}/${hash}.${MIME_EXT[mimeType]}`;
      const saved = await this.storage.put(key, response.body, mimeType);

      await this.store.saveImage({
        supplierId,
        productId,
        imageType,
        originalUrl: url,
        sourcePageUrl: sourcePageUrl || null,
        sourceName: sourceName || 'unknown',
        storageKey: saved.key,
        storageUrl: saved.url,
        contentHash: hash,
        mimeType,
        byteSize: response.body.length,
      });

      return { ...saved, hash, mimeType, originalUrl: url };
    } catch (error) {
      this.logger?.warn({ url, supplierId, error: error.message }, 'Image download skipped');
      return null;
    }
  }

  /**
   * Fetch a provider website and save the highest-priority valid logo candidate.
   *
   * @param {{id: string, website: string}} supplier Minimal supplier object.
   * @returns {Promise<Record<string, any>|null>} Saved logo result.
   */
  async enrichWebsiteLogo(supplier) {
    if (!supplier.website) return null;

    try {
      const page = await this.http.text(supplier.website);
      for (const candidate of logoCandidates(page.text, page.url)) {
        const result = await this.save({
          supplierId: supplier.id,
          originalUrl: candidate.url,
          sourcePageUrl: page.url,
          sourceName: 'company-website',
          imageType: candidate.type,
        });
        if (result && candidate.type === 'LOGO') return result;
      }
    } catch (error) {
      this.logger?.warn({
        supplierId: supplier.id,
        website: supplier.website,
        error: error.message,
      }, 'Website logo enrichment failed');
    }

    return null;
  }
}

module.exports = { ImageService, logoCandidates, detectMime, addCandidate, MIME_EXT };
