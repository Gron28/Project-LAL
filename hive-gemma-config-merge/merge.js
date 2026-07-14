/**
 * Deeply merges two objects.
 * - Objects are merged recursively.
 * - Arrays are replaced by the second one.
 * - Null values are preserved.
 * 
 * @param {Object} target The base object.
 * @param {Object} source The object to merge into the target.
 * @returns {Object} The merged object.
 */
function deepMerge(target, source) {
  if (source === null || typeof source !== 'object') {
    return source;
  }

  if (Array.isArray(source)) {
    return source;
  }

  const result = Object.assign({}, target);

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (sourceValue !== null && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
        // If it's an object and not an array, we need to merge recursively if the target is also an object
        result[key] = deepMerge(targetValue && typeof targetValue === 'object' ? targetValue : {}, sourceValue);
      } else if (Array.isArray(sourceValue)) {
        // If it's an array, replace the target value with the source value
        result[key] = sourceValue;
      } else {
        // For other types (including null and primitives), use the source value
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

module.exports = { deepMerge };
