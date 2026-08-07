'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

// Former province names are accepted because directory and registry pages may
// contain historical addresses. Values are normalized to the current 34-unit
// provincial structure used by this project.
const OLD_TO_CURRENT_PROVINCE = new Map(Object.entries({
  'ha noi': 'Hà Nội', 'hai phong': 'Hải Phòng', 'ho chi minh': 'Thành phố Hồ Chí Minh', 'tp hcm': 'Thành phố Hồ Chí Minh',
  'sai gon': 'Thành phố Hồ Chí Minh', 'da nang': 'Đà Nẵng', 'can tho': 'Cần Thơ', 'hue': 'Huế',
  'cao bang': 'Cao Bằng', 'dien bien': 'Điện Biên', 'lai chau': 'Lai Châu', 'son la': 'Sơn La', 'lang son': 'Lạng Sơn',
  'quang ninh': 'Quảng Ninh', 'thanh hoa': 'Thanh Hóa', 'nghe an': 'Nghệ An', 'ha tinh': 'Hà Tĩnh',
  'tuyen quang': 'Tuyên Quang', 'ha giang': 'Tuyên Quang', 'lao cai': 'Lào Cai', 'yen bai': 'Lào Cai',
  'thai nguyen': 'Thái Nguyên', 'bac kan': 'Thái Nguyên', 'phu tho': 'Phú Thọ', 'vinh phuc': 'Phú Thọ', 'hoa binh': 'Phú Thọ',
  'bac ninh': 'Bắc Ninh', 'bac giang': 'Bắc Ninh', 'hung yen': 'Hưng Yên', 'thai binh': 'Hưng Yên',
  'ninh binh': 'Ninh Bình', 'ha nam': 'Ninh Bình', 'nam dinh': 'Ninh Bình',
  'quang tri': 'Quảng Trị', 'quang binh': 'Quảng Trị', 'quang ngai': 'Quảng Ngãi', 'kon tum': 'Quảng Ngãi',
  'gia lai': 'Gia Lai', 'binh dinh': 'Gia Lai', 'khanh hoa': 'Khánh Hòa', 'ninh thuan': 'Khánh Hòa',
  'lam dong': 'Lâm Đồng', 'dak nong': 'Lâm Đồng', 'binh thuan': 'Lâm Đồng', 'dak lak': 'Đắk Lắk', 'phu yen': 'Đắk Lắk',
  'dong nai': 'Đồng Nai', 'binh phuoc': 'Đồng Nai', 'tay ninh': 'Tây Ninh', 'long an': 'Tây Ninh',
  'dong thap': 'Đồng Tháp', 'tien giang': 'Đồng Tháp', 'vinh long': 'Vĩnh Long', 'ben tre': 'Vĩnh Long', 'tra vinh': 'Vĩnh Long',
  'an giang': 'An Giang', 'kien giang': 'An Giang', 'ca mau': 'Cà Mau', 'bac lieu': 'Cà Mau',
  'quang nam': 'Đà Nẵng', 'ba ria vung tau': 'Thành phố Hồ Chí Minh', 'binh duong': 'Thành phố Hồ Chí Minh',
  'hau giang': 'Cần Thơ', 'soc trang': 'Cần Thơ',
}));

// Legal prefixes are removed only from comparison keys. The original legal
// name remains unchanged in MongoDB and API responses.
const COMPANY_PREFIXES = [
  'cong ty trach nhiem huu han', 'cong ty tnhh', 'cong ty co phan', 'cong ty cp', 'doanh nghiep tu nhan',
  'hop tac xa', 'chi nhanh', 'van phong dai dien', 'company limited', 'limited company', 'joint stock company', 'jsc', 'ltd',
];

/**
 * Remove Vietnamese diacritics for matching and keyword classification.
 *
 * @param {unknown} value Input value.
 * @returns {string} ASCII-like text.
 */
function stripDiacritics(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd');
}

/**
 * Collapse whitespace and non-breaking spaces.
 *
 * @param {unknown} value Input value.
 * @returns {string} Clean text.
 */
function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Produce a lowercase accent-free key for matching.
 *
 * @param {unknown} value Input value.
 * @returns {string} Normalized key.
 */
function normalizeKey(value = '') {
  return stripDiacritics(cleanText(value)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Preserve a legal company name while removing surrounding punctuation.
 *
 * @param {unknown} value Raw company name.
 * @returns {string} Clean legal name.
 */
function normalizeCompanyName(value = '') {
  return cleanText(value).replace(/^[\s|,:;.-]+|[\s|,:;.-]+$/g, '');
}

/**
 * Create a comparison-only company key for deduplication.
 *
 * @param {unknown} value Company name.
 * @returns {string} Prefix-free comparison key.
 */
function comparisonCompanyName(value = '') {
  let result = normalizeKey(value);
  for (const prefix of COMPANY_PREFIXES) {
    result = result.replace(new RegExp(`^${prefix}\\s+`), '');
  }
  return result.replace(/\b(viet nam|vietnam|vn)\b/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize Vietnamese and international phone forms to local digits.
 * Multiple values are returned as a comma-separated compatibility string.
 *
 * @param {unknown} value Raw phone text.
 * @returns {string} Normalized phone values.
 */
function normalizePhone(value = '') {
  const parts = String(value).split(/[;,|/]/).map((item) => item.trim()).filter(Boolean);
  const normalized = parts.map((part) => {
    let digits = part.replace(/[^\d+]/g, '');
    if (digits.startsWith('+84')) digits = `0${digits.slice(3)}`;
    if (digits.startsWith('84') && digits.length >= 10) digits = `0${digits.slice(2)}`;
    return digits.replace(/\D/g, '');
  }).filter((item) => item.length >= 8 && item.length <= 12);
  return [...new Set(normalized)].join(',');
}

/**
 * Extract and normalize one or more email addresses.
 *
 * @param {unknown} value Raw email text.
 * @returns {string} Comma-separated valid emails.
 */
function normalizeEmail(value = '') {
  const emails = String(value).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  return [...new Set(emails.filter((email) => !/example\.(com|org)|email@|your@/.test(email)))].join(',');
}

/**
 * Normalize an absolute/relative website URL and remove tracking parameters.
 *
 * @param {unknown} value Raw URL.
 * @param {string} [baseUrl] Optional base for relative URLs.
 * @returns {string|null} Safe normalized HTTP(S) URL.
 */
function normalizeWebsite(value = '', baseUrl) {
  const raw = cleanText(value);
  if (!raw) return null;

  try {
    const hasProtocol = /^[a-z][a-z\d+.-]*:/i.test(raw);
    const looksLikeDomain = /^(?:www\.)?[a-z\d.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw);
    const prepared = hasProtocol
      ? raw
      : baseUrl && !looksLikeDomain
        ? new URL(raw, baseUrl).toString()
        : `https://${raw}`;
    const url = new URL(prepared);

    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']
      .forEach((key) => url.searchParams.delete(key));
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname === '/') url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Extract a canonical hostname for supplier deduplication.
 *
 * @param {unknown} value Website URL.
 * @returns {string|null} Hostname without `www`.
 */
function websiteDomain(value = '') {
  try {
    return new URL(normalizeWebsite(value)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Normalize province names found inside addresses.
 *
 * @param {unknown} value Province or address text.
 * @returns {string|null} Current province name or original clean value.
 */
function normalizeProvince(value = '') {
  const key = normalizeKey(value)
    .replace(/^(tinh|thanh pho|tp)\s+/, '')
    .replace(/\s+(province|city)$/, '');

  for (const [candidate, province] of OLD_TO_CURRENT_PROVINCE) {
    if (key === candidate || key.includes(candidate)) return province;
  }

  return cleanText(value) || null;
}

/**
 * Create a URL-safe slug.
 *
 * @param {unknown} value Source text.
 * @returns {string} Slug or UUID when no usable text remains.
 */
function slug(value = '') {
  return normalizeKey(value).replace(/\s+/g, '-').replace(/^-|-$/g, '').slice(0, 120)
    || crypto.randomUUID();
}

/**
 * Calculate a SHA-256 content hash.
 *
 * @param {crypto.BinaryLike} value Content.
 * @returns {string} Hex digest.
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Classify supplier/product text into agriculture groups, environments, crops
 * and fertilizer categories using deterministic keyword rules.
 *
 * @param {unknown} text Source text.
 * @param {string|null} hintGroup Optional source-specific group.
 * @param {string|null} defaultEnvironment Optional source-specific environment.
 * @returns {{groups: string[], environments: string[], cropNames: string[], categories: string[]}} Classification.
 */
function classify(text = '', hintGroup = null, defaultEnvironment = null) {
  const value = normalizeKey(text);
  const groups = new Set();
  const environments = new Set(defaultEnvironment ? [defaultEnvironment] : []);
  const cropNames = new Set();
  const categories = new Set();

  const seedTerms = ['hat giong', 'cay giong', 'giong lua', 'giong ngo', 'giong rau', 'cay mo', 'cay ghep', 'hom giong', 'cu giong', 'seed', 'seedling'];
  const fertilizerTerms = ['phan bon', 'npk', 'phan huu co', 'phan vi sinh', 'phan bon la', 'fertilizer', 'soil conditioner', 'biostimulant'];
  const equipmentTerms = ['may nong nghiep', 'thiet bi nong nghiep', 'nha kinh', 'nha mang', 'nha luoi', 'tuoi nho giot', 'fertigation', 'grow light', 'vertical farm', 'drone nong nghiep', 'may cay', 'may xoi', 'irrigation', 'greenhouse'];

  if (seedTerms.some((term) => value.includes(term))) groups.add('SEED');
  if (fertilizerTerms.some((term) => value.includes(term))) groups.add('FERTILIZER');
  if (equipmentTerms.some((term) => value.includes(term))) groups.add('EQUIPMENT');
  if (!groups.size && hintGroup) groups.add(hintGroup);

  if (/nha kinh|nha mang|nha luoi|greenhouse|cooling pad|luoi con trung|mang nha kinh|fertigation/.test(value)) {
    environments.add('GREENHOUSE');
  }
  if (/indoor|vertical farm|grow light|den trong cay|ke trong|hvac|hut am|thuy canh trong nha/.test(value)) {
    environments.add('INDOOR');
  }
  if (/may cay|may xoi|may gieo|may phun|drone|may thu hoach|may cat co|tram thoi tiet|outdoor/.test(value)) {
    environments.add('OUTDOOR');
  }

  const crops = {
    'Lúa': ['lua', 'rice'], 'Ngô': ['ngo', 'bap', 'corn'], 'Cà chua': ['ca chua', 'tomato'], 'Dưa leo': ['dua leo', 'dua chuot', 'cucumber'],
    'Ớt': ['ot', 'chili'], 'Cà phê': ['ca phe', 'coffee'], 'Hồ tiêu': ['ho tieu', 'pepper'], 'Điều': ['hat dieu', 'cay dieu', 'cashew'],
    'Cao su': ['cao su', 'rubber'], 'Chè': ['che', 'tea'], 'Thanh long': ['thanh long', 'dragon fruit'], 'Sầu riêng': ['sau rieng', 'durian'],
    'Bơ': ['cay bo', 'qua bo', 'avocado'], 'Chuối': ['chuoi', 'banana'], 'Khoai tây': ['khoai tay', 'potato'], 'Mía': ['cay mia', 'sugarcane'],
  };
  for (const [crop, terms] of Object.entries(crops)) {
    if (terms.some((term) => value.includes(term))) cropNames.add(crop);
  }

  if (/npk/.test(value)) categories.add('NPK');
  if (/huu co vi sinh|organic microbiological/.test(value)) categories.add('ORGANIC_MICROBIOLOGICAL');
  else if (/huu co|organic/.test(value)) categories.add('ORGANIC');
  if (/vi sinh|microbial/.test(value)) categories.add('MICROBIOLOGICAL');
  if (/phan bon la|foliar/.test(value)) categories.add('FOLIAR');
  if (/tan cham|slow release/.test(value)) categories.add('SLOW_RELEASE');
  if (/hoa tan|water soluble/.test(value)) categories.add('WATER_SOLUBLE');
  if (/cai tao dat|soil conditioner/.test(value)) categories.add('SOIL_CONDITIONER');

  return {
    groups: [...groups],
    environments: [...environments],
    cropNames: [...cropNames],
    categories: [...categories],
  };
}

/**
 * Detect local/private hosts that must be blocked from crawler/image requests.
 *
 * @param {unknown} hostname Hostname or IP.
 * @returns {boolean} Whether it belongs to a private/local range.
 */
function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', 'localhost.localdomain', '0.0.0.0'].includes(host) || host.endsWith('.local')) return true;

  const version = net.isIP(host);
  if (version === 4) {
    const [first, second] = host.split('.').map(Number);
    return first === 10
      || first === 127
      || first === 0
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (version === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

/**
 * Validate that a crawler URL uses HTTP(S) and does not target private hosts.
 *
 * @param {string} value URL string.
 * @param {boolean} allowPrivateNetwork Explicit development override.
 * @returns {URL} Parsed safe URL.
 * @throws {Error} For unsupported protocols or blocked hosts.
 */
function assertSafeHttpUrl(value, allowPrivateNetwork = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (!allowPrivateNetwork && isPrivateHost(url.hostname)) {
    throw new Error(`Private network URL blocked: ${url.hostname}`);
  }
  return url;
}

/**
 * Wait for a duration without blocking the event loop.
 *
 * @param {number} milliseconds Duration.
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Parse JSON without throwing.
 *
 * @param {unknown} value JSON text.
 * @param {unknown} fallback Value returned when parsing fails.
 * @returns {unknown} Parsed value or fallback.
 */
function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  cleanText,
  normalizeKey,
  normalizeCompanyName,
  comparisonCompanyName,
  normalizePhone,
  normalizeEmail,
  normalizeWebsite,
  websiteDomain,
  normalizeProvince,
  slug,
  sha256,
  classify,
  isPrivateHost,
  assertSafeHttpUrl,
  sleep,
  safeJson,
  stripDiacritics,
  OLD_TO_CURRENT_PROVINCE,
  COMPANY_PREFIXES,
};
