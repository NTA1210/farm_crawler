'use strict';

const { normalizeWebsite } = require('../core');

/**
 * Shared crawl loop used by every source adapter.
 *
 * Subclasses implement only `parsePage()`. This class handles page queues, raw
 * snapshots, conservative sequential requests, idempotent MongoDB persistence,
 * optional logo downloads and crawl-run statistics.
 */
class BaseCrawler {
  /**
   * @param {{name: string, type: string, urls: string[], http: import('../http').HttpClient, storage: import('../storage').Storage, store: import('../db').Store, imageService: import('../images').ImageService, logger: import('pino').Logger, config: Record<string, any>, options?: Record<string, any>}} dependencies Crawler dependencies.
   */
  constructor({ name, type, urls, http, storage, store, imageService, logger, config, options = {} }) {
    this.name = name;
    this.type = type;
    this.urls = urls || [];
    this.http = http;
    this.storage = storage;
    this.store = store;
    this.imageService = imageService;
    this.logger = logger;
    this.config = config || {};
    this.options = options;
  }

  /**
   * Parse one downloaded page. Source subclasses must override this method.
   *
   * @returns {Promise<{records: any[], nextUrls: string[]}>} Empty default result.
   */
  async parsePage() {
    return { records: [], nextUrls: [] };
  }

  /**
   * Run the crawler sequentially and return final counters.
   *
   * @param {{dryRun?: boolean, downloadImages?: boolean, maxPages?: number}} runOptions Runtime options.
   * @returns {Promise<Record<string, any>>} Crawl summary.
   */
  async run(runOptions = {}) {
    const dryRun = Boolean(runOptions.dryRun);
    const downloadImages = runOptions.downloadImages ?? this.config.downloadImages;
    const maxPages = Math.max(1, Math.min(100, Number(runOptions.maxPages || this.config.maxPages || 3)));
    const runId = await this.store.startRun(this.name);
    const stats = { pages: 0, found: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 };
    const queue = [...this.urls];
    const visited = new Set();
    let fatalError = null;

    try {
      while (queue.length && stats.pages < maxPages) {
        const requestedUrl = queue.shift();
        if (!requestedUrl || visited.has(requestedUrl)) continue;
        visited.add(requestedUrl);

        try {
          const response = await this.http.request(requestedUrl);
          if (response.status < 200 || response.status >= 400) {
            throw new Error(`HTTP ${response.status}`);
          }

          // Raw bytes are persisted before parsing so parser changes can be audited.
          const rawSaved = await this.storage.raw(
            this.name,
            response.url,
            response.body,
            response.contentType,
          );
          const parsed = await this.parsePage({
            url: response.url,
            body: response.body,
            contentType: response.contentType,
            rawStorageKey: rawSaved.key,
            page: stats.pages + 1,
          });
          stats.pages += 1;

          for (const candidate of parsed.nextUrls || []) {
            const normalized = normalizeWebsite(candidate, response.url);
            if (normalized && !visited.has(normalized)) queue.push(normalized);
          }

          for (const record of parsed.records || []) {
            stats.found += 1;

            try {
              if (dryRun) {
                stats.skipped += 1;
                continue;
              }

              const result = await this.store.saveRecord(record);
              stats[result.action] = (stats[result.action] || 0) + 1;

              const logoUrl = record.supplier.logoOriginalUrl;
              if (downloadImages && result.id && logoUrl) {
                await this.imageService.save({
                  supplierId: result.id,
                  originalUrl: logoUrl,
                  sourcePageUrl: record.evidence.sourceUrl,
                  sourceName: this.name,
                  imageType: 'LOGO',
                });
              }
            } catch (error) {
              stats.failed += 1;
              this.logger.error({
                source: this.name,
                url: response.url,
                error: error.message,
              }, 'Crawler record failed');
            }
          }
        } catch (error) {
          stats.failed += 1;
          fatalError ||= error;
          this.logger.error({
            source: this.name,
            url: requestedUrl,
            error: error.message,
          }, 'Crawler page failed');
        }
      }
    } finally {
      await this.store.finishRun(runId, stats, stats.pages ? null : fatalError);
    }

    return {
      source: this.name,
      status: fatalError && !stats.pages
        ? 'FAILED'
        : stats.failed
          ? 'PARTIAL'
          : 'COMPLETED',
      ...stats,
    };
  }
}

module.exports = { BaseCrawler };
