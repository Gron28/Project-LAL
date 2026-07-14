const { getGroundHeight } = require('../src/lib/math.js');

const obstacles = [
  { x: 0, y: 2, z: 0, width: 5, depth: 5 },
  { x: 10, y: 5, z: 10, width: 2, depth: 2 }
];

const h1 = getGroundHeight(0, 0, obstacles);
console.log(`Test 1 (at 0,0): Expected 2, got ${h1}`);
if (h1 !== 2) process.exit(1);

const h2 = getGroundHeight(10, 10, obstacles);
console.log(`Test 2 (at 10,10): Expected 5, got ${h2}`);
if (h2 !== 5) process.exit(1);

const h3 = getGroundHeight(20, 20, obstacles);
console.log(`Test 3 (at 20,20): Expected 0, got ${h3}`);
if (h3 !== 0) process.exit(1);

console.log('All tests passed!');
