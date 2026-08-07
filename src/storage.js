'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { sha256, slug } = require('./core');

/**
 * Storage adapter for local development files or Cloudflare R2 objects.
 */
class Storage {
  /**
   * @param {Record<string, any>} config Storage configuration.
   */
  constructor(config) {
    this.config = config;
    this.client = config.driver === 'r2'
      ? new S3Client({
        region: 'auto',
        endpoint: config.r2.endpoint,
        credentials: {
          accessKeyId: config.r2.accessKeyId,
          secretAccessKey: config.r2.secretAccessKey,
        },
      })
      : null;
  }

  /**
   * Ensure the configured local storage root exists.
   *
   * @returns {Promise<void>}
   */
  async ensureLocal() {
    await fs.mkdir(this.config.localDir, { recursive: true });
  }

  /**
   * Store bytes under a normalized object key.
   *
   * @param {string} key Object key relative to the storage root/bucket.
   * @param {Buffer|string} body Object bytes.
   * @param {string} contentType MIME type.
   * @returns {Promise<{key: string, url: string|null}>} Stored object metadata.
   */
  async put(key, body, contentType = 'application/octet-stream') {
    const normalizedKey = key.replace(/^\/+/, '').replace(/\\/g, '/');

    if (this.config.driver === 'r2') {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.r2.bucket,
        Key: normalizedKey,
        Body: body,
        ContentType: contentType,
        CacheControl: contentType.startsWith('image/')
          ? 'public,max-age=31536000,immutable'
          : undefined,
      }));

      return {
        key: normalizedKey,
        url: this.config.r2.publicUrl
          ? `${this.config.r2.publicUrl}/${normalizedKey}`
          : null,
      };
    }

    await this.ensureLocal();
    const target = path.join(this.config.localDir, normalizedKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    return { key: normalizedKey, url: `/storage/${normalizedKey}` };
  }

  /**
   * Store a raw crawler response before parsing it.
   *
   * @param {string} sourceName Registered source key.
   * @param {string} _url Source URL, retained for a stable method contract.
   * @param {Buffer} body Raw response bytes.
   * @param {string} contentType Response Content-Type.
   * @returns {Promise<{key: string, url: string|null}>} Stored snapshot.
   */
  async raw(sourceName, _url, body, contentType = 'text/html') {
    const date = new Date().toISOString().slice(0, 10);
    const extension = contentType.includes('json')
      ? 'json'
      : contentType.includes('sheet') || contentType.includes('excel')
        ? 'xlsx'
        : 'html';
    const hash = sha256(body);
    return this.put(`raw/${slug(sourceName)}/${date}/${hash}.${extension}`, body, contentType);
  }
}

module.exports = { Storage };
