import { test } from 'node:test';
import assert from 'node:assert';
import { slugify } from './index.js';

test('slugify basic text', () => {
  assert.strictEqual(slugify('Hello World'), 'hello-world');
});

test('slugify with mixed casing and special characters', () => {
  assert.strictEqual(slugify('Hello @World! #2023'), 'hello-world-2023');
});

test('slugify with multiple spaces and hyphens', () => {
  assert.strictEqual(slugify('  multiple   spaces---and---hyphens  '), 'multiple-spaces-and-hyphens');
});

test('slugify with leading/trailing non-alphanumeric characters', () => {
  assert.strictEqual(slugify('---hello world---'), 'hello-world');
});

test('slugify with numbers and underscores', () => {
  assert.strictEqual(slugify('version_1.0_beta'), 'version-1-0-beta');
});

test('slugify with empty string or non-string input', () => {
  assert.strictEqual(slugify(''), '');
  assert.strictEqual(slugify(null), '');
  assert.strictEqual(slugify(undefined), '');
});
