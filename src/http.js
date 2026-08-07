'use strict';

const { assertSafeHttpUrl, sleep } = require('./core');

/**
 * Parse the subset of robots.txt rules needed by this crawler.
 *
 * @param {string} text robots.txt content.
 * @param {string} userAgent Configured crawler User-Agent.
 * @returns {{type: 'allow'|'disallow', path: string}[]} Applicable rules.
 */
function parseRobots(text, userAgent) {
  const target = userAgent.toLowerCase().split(/[\s/]/)[0];
  const groups = [];
  let current = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || !line.includes(':')) continue;

    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      if (!current || current.hasRule) {
        current = { agents: [], rules: [], hasRule: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.hasRule = true;
      if (value) current.rules.push({ type: key, path: value });
    }
  }

  const matches = groups.filter((group) => (
    group.agents.some((agent) => agent === '*' || target.includes(agent))
  ));
  const specific = matches.filter((group) => !group.agents.includes('*'));
  return (specific.length ? specific : matches).flatMap((group) => group.rules);
}

/**
 * Decide whether a URL path is allowed by parsed robots.txt rules.
 * The longest matching rule wins, matching common robots.txt behavior.
 *
 * @param {{type: 'allow'|'disallow', path: string}[]} rules Parsed rules.
 * @param {string} pathname URL path and query.
 * @returns {boolean} Whether crawling is permitted.
 */
function robotsAllows(rules, pathname) {
  const matched = rules
    .filter((rule) => pathname.startsWith(rule.path))
    .sort((left, right) => right.path.length - left.path.length);
  return !matched.length || matched[0].type === 'allow';
}

/**
 * Conservative HTTP client with robots checks, host throttling, retries,
 * response-size limits, redirect validation and private-network blocking.
 */
class HttpClient {
  /**
   * @param {Record<string, any>} config Crawler HTTP configuration.
   * @param {import('pino').Logger} logger Application logger.
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.robotsCache = new Map();
    this.lastRequestAt = new Map();
  }

  /**
   * Enforce the configured delay independently for each hostname.
   *
   * @param {string} hostname Target host.
   * @returns {Promise<void>}
   */
  async throttle(hostname) {
    const lastRequest = this.lastRequestAt.get(hostname) || 0;
    const waitTime = this.config.delayMs - (Date.now() - lastRequest);
    if (waitTime > 0) await sleep(waitTime);
    this.lastRequestAt.set(hostname, Date.now());
  }

  /**
   * Download and cache robots.txt rules for an origin.
   *
   * @param {URL} url Target URL.
   * @returns {Promise<{type: string, path: string}[]>} Applicable rules.
   */
  async loadRobots(url) {
    const cacheKey = url.origin;
    if (this.robotsCache.has(cacheKey)) return this.robotsCache.get(cacheKey);

    try {
      const response = await this.request(`${url.origin}/robots.txt`, {
        respectRobots: false,
        maxBytes: 512 * 1024,
        retries: 1,
      });
      const rules = response.status >= 200 && response.status < 300
        ? parseRobots(response.body.toString('utf8'), this.config.userAgent)
        : [];
      this.robotsCache.set(cacheKey, rules);
      return rules;
    } catch {
      // A missing/unreachable robots file is treated as no explicit rules. The
      // crawler still applies its normal delay, size and page limits.
      this.robotsCache.set(cacheKey, []);
      return [];
    }
  }

  /**
   * Throw when robots.txt disallows the requested path.
   *
   * @param {URL} url Target URL.
   * @returns {Promise<void>}
   */
  async ensureAllowed(url) {
    if (!this.config.respectRobots) return;
    const rules = await this.loadRobots(url);
    if (!robotsAllows(rules, `${url.pathname}${url.search}`)) {
      throw new Error(`Blocked by robots.txt: ${url}`);
    }
  }

  /**
   * Execute an HTTP request and return the response as a bounded Buffer.
   *
   * @param {string} input Target URL.
   * @param {Record<string, any>} options Request overrides.
   * @returns {Promise<{url: string, status: number, contentType: string, body: Buffer, headers: Headers}>} Response.
   */
  async request(input, options = {}) {
    const url = assertSafeHttpUrl(input, this.config.allowPrivateNetwork);
    if (options.respectRobots !== false) await this.ensureAllowed(url);

    const maxBytes = options.maxBytes || this.config.maxPageBytes;
    const retries = options.retries ?? this.config.maxRetries;
    const redirectCount = Number(options.redirectCount || 0);
    let attempt = 0;

    while (true) {
      try {
        await this.throttle(url.hostname);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.config.timeoutMs);
        let response;

        try {
          response = await fetch(url, {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'user-agent': this.config.userAgent,
              accept: options.accept || 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'vi,en;q=0.8',
            },
          });
        } finally {
          clearTimeout(timer);
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirectCount >= 10) throw new Error(`Too many redirects: ${url}`);
          const location = response.headers.get('location');
          if (!location) throw new Error(`Redirect without Location: ${url}`);
          const nextUrl = assertSafeHttpUrl(
            new URL(location, url).toString(),
            this.config.allowPrivateNetwork,
          );
          return this.request(nextUrl.toString(), {
            ...options,
            retries: Math.max(0, retries - attempt),
            redirectCount: redirectCount + 1,
          });
        }

        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > maxBytes) {
          throw new Error(`Response too large: ${declaredLength} bytes`);
        }

        const reader = response.body?.getReader();
        const chunks = [];
        let totalBytes = 0;

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              await reader.cancel();
              throw new Error(`Response exceeded ${maxBytes} bytes`);
            }
            chunks.push(Buffer.from(value));
          }
        }

        return {
          url: response.url || url.toString(),
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          body: Buffer.concat(chunks),
          headers: response.headers,
        };
      } catch (error) {
        if (attempt >= retries) throw error;
        attempt += 1;
        const retryDelay = Math.min(10000, 500 * (2 ** (attempt - 1)))
          + Math.floor(Math.random() * 250);
        this.logger?.warn({
          url: url.toString(),
          attempt,
          error: error.message,
        }, 'HTTP request failed; retrying');
        await sleep(retryDelay);
      }
    }
  }

  /**
   * Download a successful response and decode it as UTF-8 text.
   *
   * @param {string} url Target URL.
   * @param {Record<string, any>} options Request options.
   * @returns {Promise<Record<string, any>>} Response with a `text` field.
   */
  async text(url, options = {}) {
    const response = await this.request(url, options);
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return { ...response, text: response.body.toString('utf8') };
  }
}

module.exports = { HttpClient, parseRobots, robotsAllows };
