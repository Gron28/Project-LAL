const { deepMerge } = require('./deep-merge');

const config1 = {
  a: 1,
  b: {
    c: 2,
    d: [3, 4]
  }
};

const config2 = {
  b: {
    d: [5, 6]
  },
  e: 7
};

const merged = deepMerge(config1, config2);
console.log(merged);