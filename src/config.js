'use strict';

require('dotenv').config();
const path = require('node:path');

function bool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function list(name, fallback = []) {
  const value = process.env[name];
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
}

const cwd = process.cwd();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';

const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  port: num('PORT', 3000, 1, 65535),
  logLevel: process.env.LOG_LEVEL || 'info',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  databasePath: process.env.DATABASE_PATH === ':memory:'
    ? ':memory:'
    : path.resolve(cwd, process.env.DATABASE_PATH || './data/farm-crawler.db'),
  crawler: {
    userAgent: process.env.CRAWLER_USER_AGENT || 'FarmCrawler/1.0 (+https://github.com/NTA1210/farm_crawler)',
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

function validateConfig() {
  if (!['local', 'r2'].includes(config.storage.driver)) throw new Error('STORAGE_DRIVER must be local or r2');
  if (config.storage.driver === 'r2') {
    const missing = ['endpoint', 'accessKeyId', 'secretAccessKey', 'bucket']
      .filter((key) => !config.storage.r2[key]);
    if (missing.length) throw new Error(`Missing R2 configuration: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig };
