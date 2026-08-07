'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

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

const COMPANY_PREFIXES = [
  'cong ty trach nhiem huu han', 'cong ty tnhh', 'cong ty co phan', 'cong ty cp', 'doanh nghiep tu nhan',
  'hop tac xa', 'chi nhanh', 'van phong dai dien', 'company limited', 'limited company', 'joint stock company', 'jsc', 'ltd',
];

function stripDiacritics(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd');
}

function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value = '') {
  return stripDiacritics(cleanText(value)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeCompanyName(value = '') {
  return cleanText(value).replace(/^[\s|,:;.-]+|[\s|,:;.-]+$/g, '');
}

function comparisonCompanyName(value = '') {
  let result = normalizeKey(value);
  for (const prefix of COMPANY_PREFIXES) result = result.replace(new RegExp(`^${prefix}\\s+`), '');
  return result.replace(/\b(viet nam|vietnam|vn)\b/g, '').replace(/\s+/g, ' ').trim();
}

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

function normalizeEmail(value = '') {
  const emails = String(value).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  return [...new Set(emails.filter((email) => !/example\.(com|org)|email@|your@/.test(email)))].join(',');
}

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
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach((key) => url.searchParams.delete(key));
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname === '/') url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function websiteDomain(value = '') {
  try { return new URL(normalizeWebsite(value)).hostname.replace(/^www\./, ''); } catch { return null; }
}

function normalizeProvince(value = '') {
  const key = normalizeKey(value)
    .replace(/^(tinh|thanh pho|tp)\s+/, '')
    .replace(/\s+(province|city)$/, '');
  for (const [candidate, province] of OLD_TO_CURRENT_PROVINCE) {
    if (key === candidate || key.includes(candidate)) return province;
  }
  return cleanText(value) || null;
}

function slug(value = '') {
  return normalizeKey(value).replace(/\s+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || crypto.randomUUID();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

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

  if (/nha kinh|nha mang|nha luoi|greenhouse|cooling pad|luoi con trung|mang nha kinh|fertigation/.test(value)) environments.add('GREENHOUSE');
  if (/indoor|vertical farm|grow light|den trong cay|ke trong|hvac|hut am|thuy canh trong nha/.test(value)) environments.add('INDOOR');
  if (/may cay|may xoi|may gieo|may phun|drone|may thu hoach|may cat co|tram thoi tiet|outdoor/.test(value)) environments.add('OUTDOOR');

  const crops = {
    'Lúa': ['lua', 'rice'], 'Ngô': ['ngo', 'bap', 'corn'], 'Cà chua': ['ca chua', 'tomato'], 'Dưa leo': ['dua leo', 'dua chuot', 'cucumber'],
    'Ớt': ['ot', 'chili'], 'Cà phê': ['ca phe', 'coffee'], 'Hồ tiêu': ['ho tieu', 'pepper'], 'Điều': ['hat dieu', 'cay dieu', 'cashew'],
    'Cao su': ['cao su', 'rubber'], 'Chè': ['che', 'tea'], 'Thanh long': ['thanh long', 'dragon fruit'], 'Sầu riêng': ['sau rieng', 'durian'],
    'Bơ': ['cay bo', 'qua bo', 'avocado'], 'Chuối': ['chuoi', 'banana'], 'Khoai tây': ['khoai tay', 'potato'], 'Mía': ['cay mia', 'sugarcane'],
  };
  for (const [crop, terms] of Object.entries(crops)) if (terms.some((term) => value.includes(term))) cropNames.add(crop);

  if (/npk/.test(value)) categories.add('NPK');
  if (/huu co vi sinh|organic microbiological/.test(value)) categories.add('ORGANIC_MICROBIOLOGICAL');
  else if (/huu co|organic/.test(value)) categories.add('ORGANIC');
  if (/vi sinh|microbial/.test(value)) categories.add('MICROBIOLOGICAL');
  if (/phan bon la|foliar/.test(value)) categories.add('FOLIAR');
  if (/tan cham|slow release/.test(value)) categories.add('SLOW_RELEASE');
  if (/hoa tan|water soluble/.test(value)) categories.add('WATER_SOLUBLE');
  if (/cai tao dat|soil conditioner/.test(value)) categories.add('SOIL_CONDITIONER');

  return { groups: [...groups], environments: [...environments], cropNames: [...cropNames], categories: [...categories] };
}

function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', 'localhost.localdomain', '0.0.0.0'].includes(host) || host.endsWith('.local')) return true;
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  return false;
}

function assertSafeHttpUrl(value, allowPrivateNetwork = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported protocol: ${url.protocol}`);
  if (!allowPrivateNetwork && isPrivateHost(url.hostname)) throw new Error(`Private network URL blocked: ${url.hostname}`);
  return url;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = {
  cleanText, normalizeKey, normalizeCompanyName, comparisonCompanyName, normalizePhone, normalizeEmail,
  normalizeWebsite, websiteDomain, normalizeProvince, slug, sha256, classify, assertSafeHttpUrl, sleep, safeJson,
};
