import { test } from 'node:test';
import { parse, stringify } from 'json5';
import { parse, stringify } from 'json5';
const { readFileSync, writeFileSync } = require('fs');

const merge = (obj1, obj2) => {
  const result = { ...obj1 };
  for (const key in obj2) {
    if (obj1[key] === null) {
      result[key] = obj2[key];
    } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      result[key] = merge(obj1[key], obj2[key]);
    } else if (Array.isArray(obj1[key]) && Array.isArray(obj2[key])) {
      result[key] = obj2[key];
    } else {
      result[key] = obj2[key];
    }
  }
  return result;
};

const testMerge = (file1, file2, outputFile, expected) => {
  const data1 = parse(readFileSync(file1, 'utf-8'));
  const data2 = parse(readFileSync(file2, 'utf-8'));
  const merged = merge(data1, data2);

  if (outputFile) {
    writeFileSync(outputFile, stringify(merged, null, 2));
    const actual = readFileSync(outputFile, 'utf-8');
    test.strictEqual(actual, expected);
  } else {
    const actual = stringify(merged, null, 2);
    test.strictEqual(actual, expected);
  }
};

test('Merge recursive objects', () => {
  testMerge('test/recursive1.json', 'test/recursive2.json', 'test/recursive-output.json', '{"a":{"b":{"c":1}}');
});

test('Merge arrays', () => {
  testMerge('test/array1.json', 'test/array2.json', 'test/array-output.json', '[1, 2, 3]');
});

test('Merge null', () => {
  testMerge('test/null1.json', 'test/null2.json', 'test/null-output.json', '{"a":null}');
});

test('Invalid JSON', () => {
  try {
    testMerge('test/invalid1.json', 'test/invalid2.json', 'test/invalid-output.json', '');
  } catch (error) {
    test.strictEqual(error.message, 'Error merging configurations: Unexpected token in JSON at position 0');
  }
});

test('File output', () => {
  testMerge('test/file1.json', 'test/file2.json', 'test/file-output.json', '{"a":1, "b":2}');
});