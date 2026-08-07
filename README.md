# Vietnam Agriculture Supplier Crawler

A Node.js crawler and REST API for building a traceable database of agriculture **suppliers in Vietnam**.

The crawler focuses on:

- Seed and plant-variety suppliers, classified by crop when source text is sufficient.
- Agricultural equipment suppliers for `INDOOR`, `OUTDOOR`, and `GREENHOUSE` environments.
- Fertilizer manufacturers/distributors, including NPK, organic, microbiological, foliar, slow-release, water-soluble and soil-conditioner categories.
- Provider logos/icons stored locally or in Cloudflare R2.
- Source evidence and raw snapshots for auditability.

## Supplier is the core entity

`Supplier` is the aggregate root of the database. The system never stores an orphan product, evidence record or image.

```text
Supplier
├── Product[]
├── SourceEvidence[]
└── Image[]
```

The following invariants are enforced in parser policy, the persistence service and Mongoose schemas:

1. A crawler record must contain a valid supplier name.
2. `Product.supplierId` is required.
3. `SourceEvidence.supplierId` is required.
4. `Image.supplierId` is required.
5. Placeholder suppliers such as `UNKNOWN`, `N/A` or `Chưa xác định` are rejected.
6. A variety/fertilizer row without an explicit supplier column is skipped instead of using the product name as a supplier fallback.

The raw source page is still stored before parsing, so skipped rows can be reviewed when a parser or source format changes. See [`docs/supplier-core.md`](docs/supplier-core.md).

## Data coverage note

This project builds a **high-coverage supplier database**, not a guaranteed complete registry of every provider in Vietnam. Official registries, business directories, exhibition lists and company websites serve different purposes. Every accepted supplier therefore keeps its source URL, retrieval time and confidence score.

Before large-scale crawling or commercial republication, review each source's terms, copyright notice and `robots.txt`. The crawler does not bypass CAPTCHA, login pages or access controls.

## Implemented sources

| Source | Key | Main use |
|---|---|---|
| Agri Vietnam exhibitor list | `agri-vietnam` | Active exhibitors and product descriptions |
| HortEx Vietnam | `hortex` | Greenhouse, irrigation, seed and crop-nutrition exhibitors |
| PPD seed records | `ppd-seeds` | Official plant-variety/seed evidence linked to registrants/owners |
| PPD fertilizer facilities | `ppd-fertilizers` | Official manufacturing facilities |
| Vietnam Yellow Pages – seeds | `yellow-pages-seeds` | Supplier discovery |
| Vietnam Yellow Pages – equipment | `yellow-pages-equipment` | Outdoor/agricultural equipment suppliers |
| Vietnam Yellow Pages – greenhouse | `yellow-pages-greenhouse` | Greenhouse/net-house suppliers |
| Vietnam Yellow Pages – fertilizers | `yellow-pages-fertilizers` | Fertilizer manufacturers/distributors/dealers |

All source URLs can be overridden through environment variables.

## Technology

- Node.js 20+
- Express 5
- Cheerio
- MongoDB 8
- Mongoose
- Native `fetch`
- `xlsx` for spreadsheet attachments
- Cloudflare R2 through the S3-compatible AWS SDK
- Swagger UI and OpenAPI 3
- Node's built-in test runner

No NestJS, Redis, queue broker or microservice platform is required.

## Quick start with Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Services:

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/api-docs`
- OpenAPI JSON: `http://localhost:3000/api-docs.json`
- MongoDB: `mongodb://127.0.0.1:27017/farm_crawler`

Stop while keeping MongoDB data:

```bash
docker compose down
```

Delete the MongoDB volume as well:

```bash
docker compose down -v
```

## Run without Docker

Start MongoDB locally, then:

```bash
npm install
cp .env.example .env
npm run db:init
npm run dev
```

Use `127.0.0.1` rather than `localhost` when a local MongoDB installation listens only on IPv4.

## MongoDB configuration

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/farm_crawler
MONGODB_DB_NAME=
MONGODB_SERVER_SELECTION_TIMEOUT_MS=10000
MONGODB_MAX_POOL_SIZE=10
MONGODB_AUTO_INDEX=true
```

For production, a common deployment configuration is:

```dotenv
NODE_ENV=production
MONGODB_AUTO_INDEX=false
```

Then synchronize indexes explicitly during deployment:

```bash
npm run db:init
```

Never commit a MongoDB URI containing credentials.

## MongoDB collections

### `suppliers`

Stores the root provider profile:

- Legal/trade name and slug
- Tax code
- Website/domain
- Email and phone arrays
- Address/province/country
- Supplier roles
- `SEED`, `EQUIPMENT`, `FERTILIZER` groups
- `INDOOR`, `OUTDOOR`, `GREENHOUSE` environments
- Crop names and fertilizer categories
- Verification/confidence values
- Original/stored logo URLs

Supplier deduplication order:

1. Tax code
2. Website domain
3. Email
4. Phone
5. Normalized company name plus province

### `products`

Stores products/services and always requires `supplierId`.

The idempotency key is:

```text
supplierId + name + productUrl
```

### `source_evidence`

Stores provenance for each accepted supplier-rooted row and always requires `supplierId`:

- Source name/type/URL
- Source record ID
- Parsed raw object
- Raw snapshot storage key
- Content hash
- Confidence and retrieval/check times

### `images`

Stores logo/favicon/product-image metadata and always requires `supplierId`. Binary bytes remain in local storage or Cloudflare R2.

### `crawl_runs`

Stores one audit record for every crawler execution, including status and page/record counters.

## Crawl commands

List configured sources:

```bash
npm run sources
```

Run one source:

```bash
npm run crawl -- agri-vietnam --max-pages=1
npm run crawl -- hortex --max-pages=2
npm run crawl -- ppd-seeds --max-pages=3
npm run crawl -- yellow-pages-greenhouse --max-pages=2 --download-images=true
```

Run all sources sequentially:

```bash
npm run crawl:all -- --max-pages=2
```

Dry-run parsing without supplier/product/evidence writes:

```bash
npm run crawl -- ppd-seeds --max-pages=2 --dry-run=true --download-images=false
```

A dry run still creates a `crawl_runs` audit entry because MongoDB is used to track execution status.

Enrich missing provider logos from company websites:

```bash
npm run images:enrich -- --limit=100
```

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
GET /api/suppliers?productGroup=SEED&cropName=Cà%20chua&province=Lâm%20Đồng&page=1&limit=20
GET /api/suppliers?productGroup=EQUIPMENT&environment=GREENHOUSE
GET /api/suppliers?productGroup=FERTILIZER&search=NPK
```

Supported filters:

- `search`
- `group` or `productGroup`
- `environment`
- `crop` or `cropName`
- `province`
- `page`
- `limit` (maximum 100)

### Supplier detail

```http
GET /api/suppliers/{mongoObjectId}
```

Returns the supplier plus its products, evidence and image metadata.

### Start a crawler

```http
POST /api/crawlers/ppd-seeds/run
Content-Type: application/json
X-API-Key: <ADMIN_API_KEY>

{
  "maxPages": 2,
  "dryRun": false,
  "downloadImages": true
}
```

Use `all` to run all configured sources sequentially:

```http
POST /api/crawlers/all/run
```

### Crawl history

```http
GET /api/crawl-runs?limit=20
```

### Enrich provider logos

```http
POST /api/images/enrich
Content-Type: application/json
X-API-Key: <ADMIN_API_KEY>

{
  "limit": 50
}
```

In production, configure `ADMIN_API_KEY`. Write endpoints reject requests without it. In development only, the guard is disabled when the key is empty.

## Swagger/OpenAPI

Swagger is enabled by default:

```dotenv
SWAGGER_ENABLED=true
SWAGGER_PATH=/api-docs
SWAGGER_JSON_PATH=/api-docs.json
SWAGGER_SERVER_URL=http://localhost:3000
```

Swagger documents:

- Query/path/body parameters
- MongoDB ObjectId parameters
- Supplier, product, evidence, image and crawl-run schemas
- Supplier-core `supplierId` requirements
- Success and error responses
- `X-API-Key` and Bearer authentication for administrative routes
- Example crawler and image-enrichment payloads

## Cloudflare R2

```dotenv
STORAGE_DRIVER=r2
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_R2_BUCKET=farm-crawler
CLOUDFLARE_R2_PUBLIC_URL=https://assets.example.com
CLOUDFLARE_R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

When `STORAGE_DRIVER=local`, raw pages and images are written below `./storage` and exposed through `/storage/*` by the development server.

## Logo and image handling

Candidate priority:

1. JSON-LD organization logo
2. Open Graph logo/image
3. Header/logo-like image elements
4. Apple Touch Icon
5. Favicon

The downloader:

- Uses the same robots and request-delay rules as page crawling
- Blocks localhost/private-network URLs by default
- Validates every redirect destination
- Limits response size
- Verifies PNG, JPEG, WebP, GIF, ICO or SVG from bytes/content
- Deduplicates by supplier, SHA-256 and image type
- Retains original URL, source page URL, source name, MIME type and byte size

Provider logos remain the property of their respective owners. Stored images are used for supplier identification and provenance, not as a transfer of ownership.

## Raw snapshots

Every fetched page or spreadsheet is stored before parsing:

```text
storage/raw/<source>/<yyyy-mm-dd>/<sha256>.<extension>
```

This means a row rejected because it has no supplier is not inserted into MongoDB, but the downloaded source remains available for parser review.

## Safety and crawl policy

Defaults are conservative:

- Minimum request delay: 250 ms; default: 1.5 seconds
- Per-host throttling
- Exponential-backoff retries
- Timeout and response-size limits
- Maximum 10 validated redirects
- `robots.txt` checking enabled
- No CAPTCHA, login or anti-bot bypass
- Private IP ranges blocked unless explicitly enabled
- Source URL and evidence retained for every accepted record

## Tests

Start MongoDB, then run:

```bash
npm install
npm run check
npm test
```

The suite covers:

- Data normalization and classification
- Parser fixtures
- `robots.txt` behavior
- Image signature detection and logo candidates
- MongoDB/Mongoose supplier deduplication and evidence persistence
- Supplier-core invariants for products, evidence and images
- Official rows without supplier columns being skipped
- OpenAPI generation and route coverage

GitHub Actions starts an isolated MongoDB 8 service before running syntax checks and tests.

## SQLite migration note

Version 1.1 uses MongoDB/Mongoose only. The former SQLite file is not read and no automatic SQLite-to-MongoDB import is included. An existing deployed SQLite database requires a separate export/import script; a new environment can rerun the crawlers to rebuild supplier data and evidence.
