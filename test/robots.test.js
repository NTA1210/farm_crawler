'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRobots, robotsAllows } = require('../src/http');

test('robots parser applies longest matching rule', () => {
  const rules = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
`, 'FarmCrawler/1.0');
  assert.equal(robotsAllows(rules, '/private/data'), false);
  assert.equal(robotsAllows(rules, '/private/public/file'), true);
  assert.equal(robotsAllows(rules, '/open'), true);
});
