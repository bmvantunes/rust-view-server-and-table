// native/src/schema.rs::valid_name admits at most 64 ASCII characters.
// Keep logical names exact: the suffix consumes part of that runtime bound.
export const RUNTIME_SCHEMA_NAME_LIMIT = 64;
export function schemaId(logicalId, version, context) {
  const suffix = `_v${version}`;
  const max = RUNTIME_SCHEMA_NAME_LIMIT - suffix.length;
  if (typeof logicalId !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(logicalId)
      || ['rowId', 'constructor', 'prototype', '__proto__'].includes(logicalId)) {
    throw Error(`Invalid (view.schema_id) ${JSON.stringify(logicalId)} on ${context}; use an ASCII letter followed by letters, digits or underscores, excluding reserved names.`);
  }
  if (logicalId.length > max) {
    throw Error(`(view.schema_id) ${JSON.stringify(logicalId)} on ${context} has ${logicalId.length} characters; maximum ${max}: runtime schema IDs allow ${RUNTIME_SCHEMA_NAME_LIMIT} characters including the ${JSON.stringify(suffix)} suffix. Choose a shorter logical ID before first use; existing IDs cannot be truncated or renamed compatibly.`);
  }
  return logicalId + suffix;
}
