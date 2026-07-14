import { test } from 'node:test';
import assert from 'node:assert';
import { reverseWords } from './index.js';

test('reverses a simple sentence', () => {
  assert.strictEqual(reverseWords('hello world'), 'world hello');
});

test('reverses a multi-word sentence', () => {
  assert.strictEqual(reverseWords('the quick brown fox'), 'fox brown quick the');
});

test('handles single word', () => {
  assert.strictEqual(reverseWords('hello'), 'hello');
});

test('handles empty string', () => {
  assert.strictEqual(reverseWords(''), '');
});
