const { test } = require('node:test');
const fs = require('fs');
const { parse } = require('jsonc-parser');
const workflowValidator = require('./index.js').workflowValidator;

const validWorkflow = {
  nodes: [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: ['c'] },
    { id: 'c' }
  ]
};

const duplicateWorkflow = {
  nodes: [
    { id: 'a', dependencies: ['b'] },
    { id: 'a', dependencies: ['c'] }
  ]
};

const missingDependencyWorkflow = {
  nodes: [
    { id: 'a', dependencies: ['b'] },
    { id: 'b' }
  ]
};

const cyclicWorkflow = {
  nodes: [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: ['a'] }
  ]
};

const invalidWorkflow = {
  nodes: [
    { id: 'a', dependencies: ['b'] },
    { id: 'b', dependencies: ['c'] },
    { id: 'c', dependencies: ['d'] }
  ]
};

const validOrder = ['c', 'b', 'a'];
const duplicateOrder = ['a', 'b'];
const missingDependencyOrder = ['b', 'a'];
const cyclicOrder = ['a', 'b'];
const invalidOrder = ['a', 'b', 'c', 'd'];

test('valid workflow', () => {
  const result = workflowValidator(validWorkflow);
  expect(result).toEqual(validOrder);
});

test('duplicate node IDs', () => {
  const result = workflowValidator(duplicateWorkflow);
  expect(result).toEqual(duplicateOrder);
});

test('missing dependency', () => {
  const result = workflowValidator(missingDependencyWorkflow);
  expect(result).toEqual(missingDependencyOrder);
});

test('cyclic workflow', () => {
  const result = workflowValidator(cyclicWorkflow);
  expect(result).toEqual(cyclicOrder);
});

test('invalid workflow', () => {
  const result = workflowValidator(invalidWorkflow);
  expect(result).toEqual(invalidOrder);
});

function workflowValidator(workflow) {
  const visited = new Set();
  const order = [];

  function dfs(node) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    for (const dep of node.dependencies || []) {
      dfs(dep);
    }

    order.unshift(node.id);
  }

  dfs(workflow);

  return order;
}
  const visited = new Set();
  const order = [];

  function dfs(node) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    for (const dep of node.dependencies || []) {
      dfs(dep);
    }

    order.unshift(node.id);
  }

  dfs(workflow);

  return order;
}