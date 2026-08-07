'use strict';

const { BaseCrawler } = require('./crawler/base');
const {
  ExhibitionCrawler,
  HortexCrawler,
  PpdCrawler,
  YellowPagesCrawler,
} = require('./crawler/sources');
const utils = require('./crawler/utils');

/**
 * Instantiate every supported source adapter with shared HTTP, storage, database,
 * image and logging services.
 *
 * @param {Record<string, any>} dependencies Application services and config.
 * @returns {Record<string, BaseCrawler>} Crawler registry keyed by source name.
 */
function createRegistry(dependencies) {
  const common = { ...dependencies, config: dependencies.config.crawler };
  const sources = dependencies.config.sources;

  return {
    'agri-vietnam': new ExhibitionCrawler({
      ...common,
      name: 'agri-vietnam',
      type: 'EXHIBITION',
      urls: [sources.agri],
    }),
    hortex: new HortexCrawler({
      ...common,
      name: 'hortex',
      type: 'EXHIBITION',
      urls: [sources.hortex],
    }),
    'ppd-seeds': new PpdCrawler({
      ...common,
      name: 'ppd-seeds',
      type: 'OFFICIAL_REGISTRY',
      urls: sources.ppdSeeds,
      options: { kind: 'SEED' },
    }),
    'ppd-fertilizers': new PpdCrawler({
      ...common,
      name: 'ppd-fertilizers',
      type: 'OFFICIAL_REGISTRY',
      urls: [sources.ppdFertilizers],
      options: { kind: 'FERTILIZER' },
    }),
    'yellow-pages-seeds': new YellowPagesCrawler({
      ...common,
      name: 'yellow-pages-seeds',
      type: 'BUSINESS_DIRECTORY',
      urls: [sources.yellowSeeds],
      options: { hintGroup: 'SEED', category: 'SEEDS' },
    }),
    'yellow-pages-equipment': new YellowPagesCrawler({
      ...common,
      name: 'yellow-pages-equipment',
      type: 'BUSINESS_DIRECTORY',
      urls: [sources.yellowEquipment],
      options: {
        hintGroup: 'EQUIPMENT',
        category: 'AGRICULTURAL_EQUIPMENT',
        defaultEnvironment: 'OUTDOOR',
      },
    }),
    'yellow-pages-greenhouse': new YellowPagesCrawler({
      ...common,
      name: 'yellow-pages-greenhouse',
      type: 'BUSINESS_DIRECTORY',
      urls: [sources.yellowGreenhouse],
      options: {
        hintGroup: 'EQUIPMENT',
        category: 'GREENHOUSE',
        defaultEnvironment: 'GREENHOUSE',
      },
    }),
    'yellow-pages-fertilizers': new YellowPagesCrawler({
      ...common,
      name: 'yellow-pages-fertilizers',
      type: 'BUSINESS_DIRECTORY',
      urls: [sources.yellowFertilizers],
      options: { hintGroup: 'FERTILIZER', category: 'FERTILIZERS' },
    }),
  };
}

/** Human-readable source metadata reused by CLI, API and Swagger descriptions. */
const SOURCE_INFO = Object.freeze({
  'agri-vietnam': 'Agri Vietnam exhibitor list',
  hortex: 'HortEx Vietnam exhibitor pages',
  'ppd-seeds': 'Official PPD seed circulation/recognition records',
  'ppd-fertilizers': 'Official PPD fertilizer manufacturing facilities',
  'yellow-pages-seeds': 'Vietnam Yellow Pages seed suppliers',
  'yellow-pages-equipment': 'Vietnam Yellow Pages agricultural equipment suppliers',
  'yellow-pages-greenhouse': 'Vietnam Yellow Pages greenhouse/net-house suppliers',
  'yellow-pages-fertilizers': 'Vietnam Yellow Pages fertilizer suppliers',
});

module.exports = {
  BaseCrawler,
  AgriVietnamCrawler: ExhibitionCrawler,
  ExhibitionCrawler,
  HortexCrawler,
  PpdCrawler,
  YellowPagesCrawler,
  createRegistry,
  SOURCE_INFO,
  ...utils,
};
