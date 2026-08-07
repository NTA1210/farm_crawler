# Vietnam Agriculture Supplier Crawler

A simple Node.js crawler and REST API for building a traceable database of agriculture suppliers in Vietnam.

The project focuses on three supplier groups:

- Plant varieties and seed/seedling providers, classified by crop when the source text allows it.
- Agricultural equipment, classified for `INDOOR`, `OUTDOOR`, and `GREENHOUSE` environments.
- Fertilizers, including NPK, organic, microbiological, foliar, slow-release, water-soluble and soil-conditioner categories.

It also discovers provider logos/icons, validates the real image format, stores the original source URL, and uploads the bytes either to local storage or Cloudflare R2.

## Important data note

This project builds a **high-coverage supplier database**, not a guaranteed complete registry of every provider in Vietnam. Official lists, business directories, exhibition lists and company websites serve different purposes. Every stored supplier therefore keeps source evidence, retrieval time and a confidence score.

Before running a large crawl or republishing source data commercially, review the source website's terms, copyright notice and robots policy. The crawler does not bypass CAPTCHA, login pages or access controls.

## Implemented sources

| Source | Key | Main use |
|---|---|---|
| Agri Vietnam exhibitor list | `agri-vietnam` | Active exhibitors and supplied product descriptions |
| HortEx Vietnam | `hortex` | Greenhouse, irrigation, seeds and crop-nutrition exhibitors |
| Cục Trồng trọt và Bảo vệ thực vật – seed records | `ppd-seeds` | Official seed circulation/recognition evidence |
| Cục Trồng trọt và Bảo vệ thực vật – fertilizer facilities | `ppd-fertilizers` | Official certified manufacturing facilities |
| Vietnam Yellow Pages – seeds | `yellow-pages-seeds` | Supplier discovery |
| Vietnam Yellow Pages – equipment | `yellow-pages-equipment` | Outdoor/agricultural equipment discovery |
| Vietnam Yellow Pages – greenhouse | `yellow-pages-greenhouse` | Greenhouse/net-house suppliers |
| Vietnam Yellow Pages – fertilizers | `yellow-pages-fertilizers` | Fertilizer manufacturers/distributors/dealers |

All starting URLs are configurable through environment variables because source paths and page structures can change.

## Technology

- Node.js 20
- Express
- Cheerio
- SQLite using `better-sqlite3`
- Native `fetch`
- `xlsx` for spreadsheet attachments
- Cloudflare R2 through the S3-compatible AWS SDK
- Node's built-in test runner

No Redis, NestJS, queue broker or microservice platform is required.

## Install

```bash
npm install
cp .env.example .env
npm run db:init
```

Start the API:

```bash
npm run dev
```

The server listens at `http://localhost:3000` by default.

## Crawl commands

Show available sources:

```bash
npm run sources
```

Run one source with a small page limit:

```bash
npm run crawl -- agri-vietnam --max-pages=1
npm run crawl -- hortex --max-pages=2
npm run crawl -- ppd-seeds --max-pages=3
npm run crawl -- yellow-pages-greenhouse --max-pages=2 --download-images=true
```

Run all configured sources sequentially:

```bash
npm run crawl:all -- --max-pages=2
```

Dry-run parsing without writing supplier records:

```bash
npm run crawl -- agri-vietnam --max-pages=1 --dry-run=true
```

Enrich missing provider logos from company websites:

```bash
npm run images:enrich -- --limit=100
```

Website enrichment is separate from source crawling so it can be rate-limited and reviewed independently.

## REST API

### Health

```http
GET /health
```

### Sources

```http
GET /api/sources
```

### Search suppliers

```http
GET /api/suppliers?group=SEED&crop=Cà%20chua&province=Lâm%20Đồng&page=1&limit=20
GET /api/suppliers?group=EQUIPMENT&environment=GREENHOUSE
GET /api/suppliers?group=FERTILIZER&search=NPK
```

Supported filters:

- `search`
- `group` or `productGroup`
- `environment`
- `crop` or `cropName`
- `province`
- `page`
- `limit` (maximum 100)

### Supplier detail and evidence

```http
GET /api/suppliers/:id
```

The response contains supplier information, products, source evidence and stored image metadata.

### Start a crawl

```http
POST /api/crawlers/agri-vietnam/run
Content-Type: application/json
X-API-Key: <ADMIN_API_KEY>

{
  "maxPages": 2,
  "dryRun": false,
  "downloadImages": true
}
```

Use `all` as the source to run every configured crawler sequentially:

```http
POST /api/crawlers/all/run
```

In production, set `ADMIN_API_KEY`. Write endpoints reject requests without it. In development only, the guard is disabled when the key is empty.

### Crawl history

```http
GET /api/crawl-runs
```

### Enrich company website logos

```http
POST /api/images/enrich
Content-Type: application/json
X-API-Key: <ADMIN_API_KEY>

{ "limit": 50 }
```

## Cloudflare R2

Create an R2 bucket and an API token with object read/write permission. Configure:

```dotenv
STORAGE_DRIVER=r2
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_BUCKET=farm-crawler
CLOUDFLARE_R2_PUBLIC_URL=https://assets.example.com
CLOUDFLARE_R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

Never commit `.env` or access keys.

When `STORAGE_DRIVER=local`, raw pages and images are written below `./storage` and exposed through `/storage/*` by the development server.

## Logo and image handling

Logo candidates are evaluated in this order:

1. JSON-LD organization logo
2. Open Graph logo/image
3. Header or image elements containing `logo`, `brand` or `company`
4. Apple touch icon
5. Favicon

The image downloader:

- Applies the same robots and request-delay rules as page crawling.
- Blocks localhost/private-network URLs by default to reduce SSRF risk.
- Follows redirects manually and validates every destination.
- Limits the response size.
- Verifies PNG, JPEG, WebP, GIF, ICO or SVG from file signatures/content instead of trusting the URL extension.
- Deduplicates images by SHA-256.
- Retains `original_url`, `source_page_url`, `source_name`, MIME type and byte size.

Provider logos remain the property of their respective owners. Stored images are for supplier identification and provenance, not a transfer of ownership.

## Database

SQLite tables:

- `suppliers`
- `products`
- `source_evidence`
- `images`
- `crawl_runs`

Supplier deduplication prioritizes:

1. Tax code
2. Website domain
3. Email
4. Phone
5. Normalized company name plus province

The original evidence is not deleted when suppliers are merged.

Province names are normalized to Vietnam's current 34 provincial-level units while accepting former province names such as Bình Dương, Bình Định or Long An in older source records.

## Raw snapshots

Each fetched page or spreadsheet is stored before parsing:

```text
storage/raw/<source>/<yyyy-mm-dd>/<sha256>.<extension>
```

The corresponding storage key and content hash are saved in `source_evidence`. This makes parser changes auditable and allows data to be reprocessed later.

## Safety and crawl policy

Defaults are deliberately conservative:

- Minimum request delay: 250 ms; default: 1.5 seconds
- Per-host throttling
- Retry with exponential backoff
- Request timeout and response-size limit
- `robots.txt` checking enabled
- No CAPTCHA, login or anti-bot bypass
- No access to private IP ranges unless explicitly enabled
- Sequential crawling rather than high-concurrency scraping

Do not set `ALLOW_PRIVATE_NETWORK=true` on a public API server.

## Tests

```bash
npm run check
npm test
```

Tests cover normalization, current province mapping, category/environment classification, private-network blocking, robots rules, image signature validation and logo extraction.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

SQLite and local image/raw storage are mounted from the host.

## Adding another source

1. Extend `BaseCrawler` in `src/crawlers.js`.
2. Implement `parsePage({ url, body, contentType, rawStorageKey })`.
3. Return `{ records, nextUrls }`.
4. Register it in `createRegistry` and add its description to `SOURCE_INFO`.
5. Keep source URL, raw record and confidence in every returned record.
6. Add fixture-based parser tests before increasing the crawl page limit.

## Known limitations

- Website HTML and CSS selectors can change at any time; parsers must be monitored.
- Some exhibition platforms render data entirely in JavaScript or require a public data endpoint; this MVP does not bypass access controls and does not ship a headless browser.
- PDF attachments are stored as raw evidence but are not parsed in this version.
- Old binary `.xls` files are handled on a best-effort basis; `.xlsx` is preferred.
- A Yellow Pages listing is a discovery lead, not proof that the business is currently active or officially licensed.
- Crop-level classification is keyword-based and should be manually reviewed for ambiguous products.
