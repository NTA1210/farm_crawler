'use strict';

const { assertSafeHttpUrl, sleep } = require('./core');

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
      if (!current || current.hasRule) { current = { agents: [], rules: [], hasRule: false }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.hasRule = true;
      if (value) current.rules.push({ type: key, path: value });
    }
  }
  const matches = groups.filter((group) => group.agents.some((agent) => agent === '*' || target.includes(agent)));
  const specific = matches.filter((group) => !group.agents.includes('*'));
  return (specific.length ? specific : matches).flatMap((group) => group.rules);
}

function robotsAllows(rules, pathname) {
  const matched = rules.filter((rule) => pathname.startsWith(rule.path)).sort((a, b) => b.path.length - a.path.length);
  return !matched.length || matched[0].type === 'allow';
}

class HttpClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.robotsCache = new Map();
    this.lastRequestAt = new Map();
  }

  async throttle(hostname) {
    const last = this.lastRequestAt.get(hostname) || 0;
    const wait = this.config.delayMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt.set(hostname, Date.now());
  }

  async loadRobots(url) {
    const key = url.origin;
    if (this.robotsCache.has(key)) return this.robotsCache.get(key);
    try {
      const response = await this.request(`${url.origin}/robots.txt`, {
        respectRobots: false, maxBytes: 512 * 1024, retries: 1,
      });
      const rules = response.status >= 200 && response.status < 300
        ? parseRobots(response.body.toString('utf8'), this.config.userAgent) : [];
      this.robotsCache.set(key, rules);
      return rules;
    } catch {
      this.robotsCache.set(key, []);
      return [];
    }
  }

  async ensureAllowed(url) {
    if (!this.config.respectRobots) return;
    const rules = await this.loadRobots(url);
    if (!robotsAllows(rules, `${url.pathname}${url.search}`)) throw new Error(`Blocked by robots.txt: ${url}`);
  }

  async request(input, options = {}) {
    let url = assertSafeHttpUrl(input, this.config.allowPrivateNetwork);
    if (options.respectRobots !== false) await this.ensureAllowed(url);
    const maxBytes = options.maxBytes || this.config.maxPageBytes;
    const retries = options.retries ?? this.config.maxRetries;
    let attempt = 0;
    while (true) {
      try {
        await this.throttle(url.hostname);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.config.timeoutMs);
        let response;
        try {
          response = await fetch(url, {
            redirect: 'manual', signal: controller.signal,
            headers: {
              'user-agent': this.config.userAgent,
              'accept': options.accept || 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'vi,en;q=0.8',
            },
          });
        } finally { clearTimeout(timer); }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error(`Redirect without Location: ${url}`);
          const next = assertSafeHttpUrl(new URL(location, url).toString(), this.config.allowPrivateNetwork);
          return this.request(next.toString(), { ...options, retries: Math.max(0, retries - attempt) });
        }

        const length = Number(response.headers.get('content-length') || 0);
        if (length > maxBytes) throw new Error(`Response too large: ${length} bytes`);
        const reader = response.body?.getReader();
        const chunks = []; let total = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) { await reader.cancel(); throw new Error(`Response exceeded ${maxBytes} bytes`); }
            chunks.push(Buffer.from(value));
          }
        }
        return {
          url: response.url || url.toString(), status: response.status,
          contentType: response.headers.get('content-type') || '',
          body: Buffer.concat(chunks), headers: response.headers,
        };
      } catch (error) {
        if (attempt >= retries) throw error;
        attempt += 1;
        const delay = Math.min(10000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
        this.logger?.warn({ url: url.toString(), attempt, error: error.message }, 'HTTP request failed; retrying');
        await sleep(delay);
      }
    }
  }

  async text(url, options = {}) {
    const response = await this.request(url, options);
    if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}: ${url}`);
    return { ...response, text: response.body.toString('utf8') };
  }
}

module.exports = { HttpClient, parseRobots, robotsAllows };
