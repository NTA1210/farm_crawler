'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSwaggerSpec } = require('../src/swagger');

test('generates OpenAPI documentation for every public and admin route', () => {
  const specification = createSwaggerSpec({
    env: 'test',
    swagger: { serverUrl: 'http://localhost:3000' },
  });

  assert.equal(specification.openapi, '3.0.3');
  assert.ok(specification.paths['/health']?.get);
  assert.ok(specification.paths['/api/sources']?.get);
  assert.ok(specification.paths['/api/suppliers']?.get);
  assert.ok(specification.paths['/api/suppliers/{id}']?.get);
  assert.ok(specification.paths['/api/crawl-runs']?.get);
  assert.ok(specification.paths['/api/crawlers/{source}/run']?.post);
  assert.ok(specification.paths['/api/images/enrich']?.post);
  assert.ok(specification.components.schemas.SupplierDetail);
  assert.ok(specification.components.securitySchemes.ApiKeyAuth);
});
