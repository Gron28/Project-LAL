const { deepMerge } = require('./deep-merge');

const testCases = [
  {
    name: 'Merge objects recursively',
    input1: { a: 1, b: { c: 2 } },
    input2: { b: { d: 3 }, e: 4 },
    expected: { a: 1, b: { c: 2, d: 3 }, e: 4 }
  },
  {
    name: 'Replace arrays',
    input1: { a: [1, 2] },
    input2: { a: [3, 4] },
    expected: { a: [3, 4] }
  },
  {
    name: 'Preserve null',
    input1: { a: null },
    input2: { a: 1 },
    expected: { a: 1 }
  },
  {
    name: 'Preserve undefined',
    input1: { a: undefined },
    input2: { a: 1 },
    expected: { a: 1 }
  }
];

for (const { name, input1, input2, expected } of testCases) {
  const result = deepMerge(input1, input2);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    console.error(`Test failed: ${name}`);
    console.error('Expected:', expected);
    console.error('Got:', result);
    process.exit(1);
  }
}

console.log('All tests passed');