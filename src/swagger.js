'use strict';

const { createSwaggerSpec: createBaseSwaggerSpec } = require('./swagger-base');

/**
 * Build the OpenAPI document and enforce the supplier-core contract in shared
 * schemas. Keeping the override in one place prevents route documentation and
 * Mongoose models from drifting apart.
 *
 * @param {Record<string, any>} config Application configuration.
 * @returns {Record<string, any>} OpenAPI 3 specification.
 */
function createSwaggerSpec(config) {
  const specification = createBaseSwaggerSpec(config);
  const schemas = specification.components?.schemas || {};

  for (const schemaName of ['Product', 'SourceEvidence', 'Image']) {
    const schema = schemas[schemaName];
    if (!schema) continue;

    schema.required = [...new Set([...(schema.required || []), 'supplierId'])];
    schema.description = [
      schema.description,
      'Supplier is the core entity; this resource cannot exist without supplierId.',
    ].filter(Boolean).join(' ');
  }

  if (schemas.Product?.properties?.supplierId) {
    schemas.Product.properties.supplierId.description = 'Required Supplier ObjectId. Products are never stored independently.';
  }
  if (schemas.SourceEvidence?.properties?.supplierId) {
    schemas.SourceEvidence.properties.supplierId.description = 'Required Supplier ObjectId that owns this evidence.';
  }
  if (schemas.Image?.properties?.supplierId) {
    schemas.Image.properties.supplierId.description = 'Required Supplier ObjectId that owns this logo, icon or product image.';
  }

  return specification;
}

module.exports = { createSwaggerSpec };
