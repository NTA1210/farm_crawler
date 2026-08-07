'use strict';

const { Schema } = require('mongoose');

/**
 * Create the CrawlRun model used to audit each crawler execution.
 *
 * @param {import('mongoose').Connection} connection Active MongoDB connection.
 * @returns {import('mongoose').Model} CrawlRun model bound to the connection.
 */
function createCrawlRunModel(connection) {
  const crawlRunSchema = new Schema({
    sourceName: { type: String, required: true, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ['PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'],
      default: 'RUNNING',
    },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    pages: { type: Number, default: 0, min: 0 },
    found: { type: Number, default: 0, min: 0 },
    inserted: { type: Number, default: 0, min: 0 },
    updated: { type: Number, default: 0, min: 0 },
    skipped: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    errorMessage: { type: String, default: null, maxlength: 5000 },
  }, {
    collection: 'crawl_runs',
    timestamps: true,
    strict: true,
  });

  crawlRunSchema.index({ startedAt: -1 }, { name: 'crawl_run_started_at' });
  crawlRunSchema.index({ sourceName: 1, startedAt: -1 }, { name: 'crawl_run_source_started_at' });

  return connection.model('CrawlRun', crawlRunSchema);
}

module.exports = { createCrawlRunModel };
