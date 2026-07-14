const fs = require('fs');
const { parse } = require('jsonc-parser');

const workflow = parse(readFileSync('example.json', 'utf-8'));

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

console.log(order.join(' '));