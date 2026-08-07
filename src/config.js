'use strict';

require('dotenv').config();
const path = require('node:path');

/**
 * Read a boolean environment variable with a fallback value.
 *
 * @param {string} name Environment variable name.
 * @param {boolean} fallback Default when the variable is absent.
 * @returns {boolean} Parsed value.
 */
function bool(name, fallback) {
  const value = process.env[name];
  if (value === null || value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Read and clamp a numeric environment variable.
 *
 * @param {string} name Environment variable name.
 * @param {number} fallback Default value.
 * @param {number} minimum Inclusive minimum.
 * @param {number} maximum Inclusive maximum.
 * @returns {number} Safe numeric value.
 */
function num(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Read a comma-separated environment variable as a trimmed string array.
 *
 * @param {string} name Environment variable name.
 * @param {string[]} fallback Default list.
 * @returns {string[]} Parsed values.
 */
function list(name, fallback = []) {
  const value = process.env[name];
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
}

const cwd = process.cwd();
const environment = process.env.NODE_ENV || 'development';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';

// Central immutable configuration object shared by the API, crawlers, storage
// service and MongoDB layer. Every secret remains in environment variables.
const config = Object.freeze({
  env: environment,
  port: num('PORT', 3000, 1, 65535),
  logLevel: process.env.LOG_LEVEL || 'info',
  adminApiKey: process.env.ADMIN_API_KEY || '',

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/farm_crawler',
    dbName: process.env.MONGODB_DB_NAME || '',
    serverSelectionTimeoutMs: num('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 10000, 1000, 120000),
    maxPoolSize: num('MONGODB_MAX_POOL_SIZE', 10, 1, 100),
    autoIndex: bool('MONGODB_AUTO_INDEX', environment !== 'production'),
  },

  swagger: {
    enabled: bool('SWAGGER_ENABLED', true),
    path: process.env.SWAGGER_PATH || '/api-docs',
    jsonPath: process.env.SWAGGER_JSON_PATH || '/api-docs.json',
    serverUrl: process.env.SWAGGER_SERVER_URL || `http://localhost:${num('PORT', 3000, 1, 65535)}`,
  },

  crawler: {
    userAgent: process.env.CRAWLER_USER_AGENT || 'FarmCrawler/1.1 (+https://github.com/NTA1210/farm_crawler)',
    delayMs: num('CRAWLER_DELAY_MS', 1500, 250, 60000),
    timeoutMs: num('CRAWLER_TIMEOUT_MS', 30000, 1000, 120000),
    maxRetries: num('CRAWLER_MAX_RETRIES', 3, 0, 8),
    maxPages: num('CRAWLER_MAX_PAGES', 3, 1, 100),
    maxPageBytes: num('CRAWLER_MAX_PAGE_BYTES', 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    maxImageBytes: num('MAX_IMAGE_BYTES', 5 * 1024 * 1024, 1024, 25 * 1024 * 1024),
    respectRobots: bool('RESPECT_ROBOTS_TXT', true),
    allowPrivateNetwork: bool('ALLOW_PRIVATE_NETWORK', false),
    downloadImages: bool('DOWNLOAD_IMAGES', true),
    enrichWebsiteLogo: bool('ENRICH_PROVIDER_WEBSITE_LOGO', false),
    vietnamOnly: bool('VIETNAM_ONLY', true),
  },

  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local').toLowerCase(),
    localDir: path.resolve(cwd, process.env.LOCAL_STORAGE_DIR || './storage'),
    r2: {
      accountId,
      endpoint: process.env.CLOUDFLARE_R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''),
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
      bucket: process.env.CLOUDFLARE_R2_BUCKET || '',
      publicUrl: (process.env.CLOUDFLARE_R2_PUBLIC_URL || '').replace(/\/$/, ''),
    },
  },

  sources: {
    agri: process.env.AGRI_VIETNAM_START_URL || 'https://agri-vietnam.com.vn/exhibitor-list-2026/',
    hortex: process.env.HORTEX_START_URL || 'https://hortex-exhibitions.com/visiting/',
    ppdSeeds: list('PPD_SEEDS_START_URLS', [
      'https://www.ppd.gov.vn/tin-moi-nhat-289/danh-sach-giong-cay-trong-cac-loai-duoc-cong-nhan-chinh-thuc-cap-quyet-dinh-luu-hanh.html',
    ]),
    ppdFertilizers: process.env.PPD_FERTILIZERS_START_URL || 'https://www.ppd.gov.vn/ds-co-so-san-xuat-phan-bon-duoc-cap-giay-chung-nhan-du-dieu-kien.html',
    yellowSeeds: process.env.YELLOW_PAGES_SEEDS_URL || 'https://www.yellowpages.vn/cls/487594/hat-giong-nong-san.html',
    yellowEquipment: process.env.YELLOW_PAGES_EQUIPMENT_URL || 'https://www.yellowpages.vn/cls/12360/nong-nghiep-may-moc-va-thiet-bi-nong-nghiep.html',
    yellowGreenhouse: process.env.YELLOW_PAGES_GREENHOUSE_URL || 'https://www.yellowpages.vn/cls/492871/nha-kinh-nha-luoi-thiet-bi-va-vat-tu-nha-kinh-nha-luoi.html',
    yellowFertilizers: process.env.YELLOW_PAGES_FERTILIZERS_URL || 'https://www.yellowpages.vn/cls/99160/phan-bon-cong-ty-phan-bon-san-xuat-va-ban-buon.html',
  },
});

/**
 * Validate configuration that cannot safely fall back at runtime.
 *
 * @throws {Error} When MongoDB, Swagger or R2 settings are invalid.
 * @returns {void}
 */
function validateConfig() {
  if (!/^mongodb(?:\+srv)?:\/\//i.test(config.mongodb.uri)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }

  if (!config.swagger.path.startsWith('/') || !config.swagger.jsonPath.startsWith('/')) {
    throw new Error('SWAGGER_PATH and SWAGGER_JSON_PATH must start with /');
  }

  if (!['local', 'r2'].includes(config.storage.driver)) {
    throw new Error('STORAGE_DRIVER must be local or r2');
  }

  if (config.storage.driver === 'r2') {
    const missing = ['endpoint', 'accessKeyId', 'secretAccessKey', 'bucket']
      .filter((key) => !config.storage.r2[key]);
    if (missing.length) throw new Error(`Missing R2 configuration: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig, bool, num, list };
