function deepMerge(target, source) {
  if (source === null || source === undefined) return target;
  if (target === null || target === undefined) return source;
  if (Array.isArray(target)) {
    if (Array.isArray(source)) {
      return target.map((item, index) => {
        if (index < source.length) {
          return deepMerge(item, source[index]);
        }
        return item;
      });
    }
    return target;
  }
  if (typeof target === 'object') {
    const result = Object.create(null);
    for (const key in target) {
      result[key] = deepMerge(target[key], source[key]);
    }
    for (const key in source) {
      if (target[key] === undefined) {
        result[key] = source[key];
      }
    }
    return result;
  }
  return source;
}

module.exports = { deepMerge };