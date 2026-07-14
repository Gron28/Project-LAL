const { exec } = require('child_process');

const validateWorkflow = (workflow) => {
  const nodes = new Set();
  const dependencies = new Map();
  const inEdges = new Map();
  const outEdges = new Map();

  for (const node of workflow) {
    if (nodes.has(node.id)) {
      throw new Error(`Duplicate node ID: ${node.id}`);
    }
    nodes.add(node.id);

    dependencies.set(node.id, []);
    inEdges.set(node.id, []);
    outEdges.set(node.id, []);

    for (const dep of node.dependencies) {
      if (!nodes.has(dep)) {
        throw new Error(`Missing dependency: ${dep}`);
      }
      dependencies.get(node.id).push(dep);
      inEdges.get(dep).push(node.id);
      outEdges.get(node.id).push(dep);
    }
  }

  const visited = new Set();
  const order = [];

  const dfs = (node) => {
    if (visited.has(node)) return;
    visited.add(node);

    for (const dep of dependencies.get(node)) {
      dfs(dep);
    }

    order.unshift(node);
  };

  for (const node of workflow) {
    dfs(node.id);
  }

  return order;
};

const workflow = [
  { id: 'a', dependencies: ['b'] },
  { id: 'b', dependencies: ['c'] },
  { id: 'c', dependencies: [] }
];

const order = validateWorkflow(workflow);
console.log('Topological order:', order);

const invalidWorkflow1 = [
  { id: 'a', dependencies: ['b'] },
  { id: 'b', dependencies: ['a'] }
];

try {
  validateWorkflow(invalidWorkflow1);
} catch (e) {
  console.error('Invalid workflow 1:', e.message);
}

const invalidWorkflow2 = [
  { id: 'a', dependencies: ['b'] },
  { id: 'b', dependencies: ['c'] },
  { id: 'c', dependencies: ['d'] },
  { id: 'd', dependencies: ['a'] }
];

try {
  validateWorkflow(invalidWorkflow2);
} catch (e) {
  console.error('Invalid workflow 2:', e.message);
}

const invalidWorkflow3 = [
  { id: 'a', dependencies: ['b'] },
  { id: 'b', dependencies: ['c'] },
  { id: 'c', dependencies: ['d'] }
];

try {
  validateWorkflow(invalidWorkflow3);
} catch (e) {
  console.error('Invalid workflow 3:', e.message);
}