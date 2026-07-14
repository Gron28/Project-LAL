const assert = require('assert');
const { deepMerge } = require('./merge');

function runTests() {
  console.log('Running tests...');

  // Test 1: Basic merge of flat objects
  const obj1 = { a: 1, b: 2 };
  const obj2 = { c: 3, d: 4 };
  assert.deepStrictEqual(deepMerge(obj1, obj2), { a: 1, b: 2, c: 3, d: 4 }, 'Basic merge failed');

  // Test 2: Overwrite primitive values
  const obj3 = { a: 1 };
  const obj4 = { a: 2 };
  assert.deepStrictEqual(deepMerge(obj3, obj4), { a: 2 }, 'Overwriting primitive failed');

  // Test 3: Recursive merge of nested objects
  const obj5 = { a: { b: 1 } };
  const obj6 = { a: { c: 2 } };
  assert.deepStrictEqual(deepMerge(obj5, obj6), { a: { b: 1, c: 2 } }, 'Recursive merge failed');

  // Test 4: Array replacement (not merging)
  const obj7 = { a: [1, 2] };
  const obj8 = { a: [3, 4] };
  assert.deepStrictEqual(deepMerge(obj7, obj8), { a: [3, 4] }, 'Array replacement failed');

  // Test 5: Null preservation
  const obj9 = { a: null };
  const obj10 = { b: null };
  assert.deepStrictEqual(deepMerge(obj9, obj10), { a: null, b: null }, 'Null preservation failed');

  // Test 6: Deep nested merge with mixed types
  const obj11 = {
    a: {
      b: 1,
      c: [1, 2]
    },
    d: "hello"
  };
  const obj12 = {
    a: {
      b: 2,
      c: [3, 4]
    },
    e: "world"
  };
  assert.deepStrictEqual(deepMerge(obj11, obj12), {
    a: {
      b: 2,
      c: [3, 4]
    },
    d: "hello",
    e: "world"
  }, 'Complex merge failed');

  console.log('All tests passed!');
}

try {
  runTests();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
